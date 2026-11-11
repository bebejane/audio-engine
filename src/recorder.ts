import { normalize, trim } from './utils';
import type { ProcessSampleOptions } from './types';
import { createRecordWorker, createEncoderWorker } from './workers';
import moment from 'moment';
import { EventEmitter } from 'events';

const defaults = {
	name: 'rec',
	sampleRate: 44100,
	numChannels: 1,
	sampler: false,
	processSample: {
		trim: true,
		normalize: true,
		fade: true,
	},
};
interface RecorderOptions extends Record<string, any> {
	name?: string;
	sampleRate?: number;
	numChannels?: number;
	sampler?: boolean;
	processSample?: boolean | ProcessSampleOptions;
}

/** A pending record()/encode() promise's resolve/reject pair. */
interface Deferred<T = unknown> {
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

/**
 * Globally-unique, monotonically increasing recording id.
 *
 * Recordings are persisted by consumers (the app keys them in IndexedDB), so a
 * per-recorder counter that restarts at 0 on every page load collides with takes
 * from earlier sessions. Seeding on the wall clock keeps ids unique across
 * sessions while the +1 guard keeps two takes finished in the same millisecond
 * apart. Ids are always larger than the small legacy counter ids already stored.
 */
let _lastRecordingId = 0;
function nextRecordingId(): number {
	return (_lastRecordingId = Math.max(Date.now(), _lastRecordingId + 1));
}

type RejectableWorker = Worker & { reject?: (err?: unknown) => void };

/** One capture request: its promise and the grid id it was started for. */
type Take = { promise: Deferred | null; id: string | number | undefined };

/**
 * Records audio from an AudioNode (master mix) or, in sampler mode, from a
 * MediaStream (microphone) and produces a WAV Blob + Float32 buffer.
 *
 * Capture runs in an AudioWorklet (`record/worklet.ts`) that forwards PCM to a
 * worker (`record/worker.ts`) which accumulates and packs it. The engine owns
 * two instances: `masterRecorder` (mixdown) and `sampleRecorder` (mic input).
 * Emits `recording`/`sampling`, `progress`, `sampleprocess` and
 * `encodingprogress`; `record()` resolves with the finished recording object.
 */
class Recorder extends EventEmitter {
	context: AudioContext;
	_name: string;
	_sampleRate: number;
	_numChannels: number;
	_sampler: boolean;
	_node: AudioNode | null;
	_silentSink: GainNode | null;
	_recording: boolean;
	_processing: boolean;
	_rectime: number;
	_processSample: ProcessSampleOptions | false;
	_recordingId: number;
	worker: Worker | null;
	encoderWorker: RejectableWorker | null;
	_processor: AudioWorkletNode | null;
	_outputStream: MediaStreamAudioDestinationNode | null;
	_inputPoint: GainNode | null;
	_realAudioInput: MediaStreamAudioSourceNode | null;
	_splitter: ChannelSplitterNode | null;
	_merger: ChannelMergerNode | null;
	_id: string | number | undefined;
	_promise: Deferred | null;
	_duration: number;
	_elapsed: number;
	_error: unknown;
	recordingProgress: ReturnType<typeof setInterval> | null;
	rectime: number;
	/** Takes stopped/cancelled but not yet answered by the worker, in order. */
	_takes: Take[];
	/** record() has been called and is waiting for the worklet to be ready. */
	_starting: boolean;
	_processorReady: Promise<void>;

	constructor(context: AudioContext, opt: RecorderOptions = {}) {
		super();
		opt = { ...defaults, ...opt };
		this.context = context;
		this._name = opt.name;
		this._sampleRate = opt.sampleRate;
		this._numChannels = opt.numChannels;
		this._sampler = opt.sampler;
		this._node = null;
		this._silentSink = null;
		this._recording = false;
		this._processing = false;
		this._rectime = 0;
		this._processSample = typeof opt.processSample === 'object' ? opt.processSample : false;
		this._recordingId = 0;
		this.worker = null;
		this.encoderWorker = null;
		this._takes = [];
		this._starting = false;
		this.init();
	}
	/** Spawn the record worker, wire its messages and load the worklet. */
	init() {
		this.worker = createRecordWorker();
		this._processorReady = this.initProcessor();
		this.worker.addEventListener('error', (err: unknown) => {
			console.error('error record worker', err);
			this.emit('error', err);
		});
		this.worker.addEventListener('message', (event: MessageEvent) => {
			// the worker answers takes in the order they were stopped/cancelled, so
			// each reply settles its own take, not whichever take is current now
			const take = this._takes.shift() ?? this._takeNow();
			if (event.data.cancelled) {
				console.log('Worker: CANCELLED');
				this._clearProgress();
				return this._handleError('CANCELLED', 0, take);
			}
			console.log('DONE sAMPLER');
			const blob = event.data.blob;
			const buffer = event.data.buffer;
			this._duration = buffer[0].length / this._sampleRate;
			this._processing = true;

			if (!this._processSample)
				return this._handleFinish(take, blob, buffer, this._duration);

			console.log('processing sample', take.id, this._duration);
			this._process(buffer, take.id)
				.then((data: { blob: Blob; buffer: Float32Array[] }) => {
					this._handleFinish(take, data.blob, data.buffer, this._duration);
				})
				.catch((err: unknown) => {
					console.error(err);
					this._handleError(err, this._duration, take);
				})
				.then(() => {
					// no disconnect here: a newer take may be live by now
					this._clearProgress();

					console.log('Worker: DONE!');
				});
		});
		this.worker.addEventListener('error', (err: unknown) => {
			this._disconnect();
			this._handleError(err);
		});
	}
	/**
	 * Load the recorder AudioWorklet module and create the processing node.
	 * Async by nature (module load over the network); recording is guarded on
	 * this._processor being ready (it almost always is by the time the user
	 * hits record).
	 */
	async initProcessor() {
		try {
			// register the worklet once per AudioContext: the engine owns two
			// Recorder instances (master + sampler) on the same context, and a
			// second addModule would re-register 'recorder'
			const { ensureRecorderWorklet } = await import('./record/worklet');
			await ensureRecorderWorklet(this.context);
			this._processor = new AudioWorkletNode(this.context, 'recorder', {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				channelCount: Math.max(1, this._numChannels),
			});
			this._processor.port.onmessage = (event: MessageEvent) => {
				this.worker.postMessage({ buffer: event.data.buffer });
			};
		} catch (err) {
			console.error('error initializing recorder worklet', err);
			this._processor = null;
		}
	}
	/**
	 * Start recording from `node`. Optionally associates the take with a grid
	 * `id` (sampler mode). Resolves with `{ id, url, blob, buffer, mimeType,
	 * filename, name, duration }`; rejects with 'RECORDING' if already busy.
	 */
	record(node: AudioNode, id?: string | number) {
		if (this._recording || this._starting) return Promise.reject('RECORDING');
		this._id = id;
		this._node = node;
		this._starting = true;
		return new Promise((resolve, reject) => {
			this._promise = { resolve, reject };
			// the worklet loads asynchronously: wait for it rather than rejecting a
			// press that lands in the first moments after boot
			this._processorReady.then(() => {
				this._starting = false;
				this._start();
			});
		});
	}
	/** The take that is current (being captured, or the last one requested). */
	_takeNow(): Take {
		return { promise: this._promise, id: this._id };
	}
	/**
	 * Stop capturing and ask the worker to pack the take to a WAV. The take's
	 * promise travels with the request, so a take started while this one is
	 * still encoding can never receive this take's result.
	 */
	stop() {
		if (!this._recording) return;
		this._takes.push(this._takeNow());
		this._promise = null;
		this._processing = true;
		this._disconnect();
		this.worker.postMessage({ stop: true });
	}
	/** Discard the current take (worker replies `{ cancelled: true }`). */
	cancel() {
		if (!this._recording) return;
		this._takes.push(this._takeNow());
		this._promise = null;
		this._disconnect();
		this.worker.postMessage({ cancel: true });
	}
	/** Connect the source to the worklet (and output stream) and start capture. */
	_start() {
		if (!this._processor) {
			if (this._promise) this._promise.reject('recorder not ready');
			return;
		}
		this._outputStream = this.context.createMediaStreamDestination();

		if (this._sampler) {
			this._node.connect(this._outputStream);
			this._inputPoint = this._outputStream.context.createGain();
			this._realAudioInput = (this._outputStream.context as AudioContext).createMediaStreamSource(
				this._outputStream.stream,
			);
			this._realAudioInput.connect(this._inputPoint);
			this._inputPoint.connect(this._processor);
		} else {
			this._node.connect(this._outputStream);
			this._node.connect(this._processor);
		}

		this._rectime = Date.now();
		this._recording = true;
		// The worklet passes its input through to its output, so connecting it
		// to the speakers would play the recorded signal a second time (the
		// master mix got louder) and monitor the mic while sampling. A muted
		// sink keeps the node pulled/processed without any audible output.
		if (!this._silentSink) {
			this._silentSink = this.context.createGain();
			this._silentSink.gain.value = 0;
			this._silentSink.connect(this.context.destination);
		}
		this._processor.connect(this._silentSink);
		this.worker.postMessage({ numChannels: this._numChannels, start: true });
		this.recordingProgress = setInterval(() => this._emitProgress(), 100);

		if (this._sampler) this.emit('sampling', this._id, true);
		else this.emit('recording', true);
	}
	/** Emit the sampler/recording-off event and reject the pending promise. */
	_handleError(err: unknown, duration = 0, take: Take = this._takeNow()) {
		//this.emit('progress', this._recordingId, {error:err, start:this.rectime, elapsed:duration, duration:duration, recording:false, processing:false})
		this._error = err;

		// only report "not recording" when no newer take has started
		if (!this._recording) {
			if (this._sampler) this.emit('sampling', take.id, false);
			else this.emit('recording', false);
		}
		if (take.promise) take.promise.reject(err);

		this._clearProgress();
	}
	/** Build the recording descriptor, resolve the take's promise and emit progress. */
	_handleFinish(take: Take, blob: Blob, buffer: Float32Array[], duration: number) {
		const name = `${this._name} #${this._recordingId + 1} ${moment().format('MMM DD HH:mm:ss').toLowerCase()}`;
		this._recordingId++;
		const recording = {
			id: nextRecordingId(),
			url: URL.createObjectURL(blob),
			blob: blob,
			buffer: buffer,
			mimeType: 'audio/wav',
			filename: name + '.wav',
			name: name,
			duration: duration,
		};

		if (!this._recording) {
			if (this._sampler) this.emit('sampling', take.id, false);
			else this.emit('recording', false);
		}

		if (take.promise) take.promise.resolve(recording);

		this.emit('progress', this._recordingId, {
			start: this._rectime,
			elapsed: duration,
			duration: 0,
			recording: false,
			processing: false,
		});
	}
	/** Disconnect the source/worklet/output and clear the busy flags. */
	_disconnect() {
		if (this._recording) {
			if (this._sampler) this._inputPoint.disconnect(this._processor);
			else this._node.disconnect(this._processor);

			this._processor.disconnect();
			this._outputStream.disconnect();
			console.log('disconnected input stream');
		}
		this._recording = false;
		this._processing = false;
		this._rectime = 0;
	}
	/** Reserved hook (progress is emitted from _emitProgress instead). */
	_checkProgress() {}

	/** Trim/normalize a captured buffer, then re-encode it to a WAV Blob. */
	_process(buffer: Float32Array[], id?: string | number) {
		// only called when _processSample is truthy (see init message handler)
		const ps = this._processSample as ProcessSampleOptions;
		const trimOpt = ps.trim;

		this.emit('sampleprocess', this._id, true);
		console.time('processsample');

		return new Promise((resolve, reject) => {
			let data = buffer;
			if (trimOpt)
				data = trim(
					buffer,
					typeof trimOpt === 'object' ? trimOpt : { level: 0.01, trimLeft: true, trimRight: false },
				);

			if (!data || !data[0].length) return reject("I didn't hear what u said. Speak louder!");

			if (ps.normalize) data = normalize(data);

			if (ps.fade) {
				//data = fade(data, 1000)
			}

			return this._encodeAudio(data, 'wav', {
				sampleRate: this._sampleRate,
				numChannels: data.length,
			}).then((b: Blob) => {
				const blob = new Blob([b], { type: 'audio/wav' });
				resolve({ blob: blob, buffer: data });
			});
		}).then((data) => {
			this.emit('sampleprocess', this._id, false);
			console.timeEnd('processsample');
			return data;
		});
	}
	/**
	 * Encode `buffer` in a short-lived encoder worker; forwards progress as
	 * `encodingprogress` and resolves with the Blob.
	 */
	_encodeAudio(buffer: Float32Array[], format: string, opt: Record<string, unknown>) {
		this._processing = true;
		return new Promise((resolve, reject) => {
			// each encode keeps its own worker and resolve/reject pair: takes can
			// finish back to back, and a shared slot would strand the earlier one
			const worker = createEncoderWorker() as RejectableWorker;
			this.encoderWorker = worker;
			worker.reject = reject;
			worker.addEventListener('message', (event: MessageEvent) => {
				if (event.data.progress) return this.emit('encodingprogress', event.data.progress);

				worker.terminate();
				if (this.encoderWorker === worker) this.encoderWorker = null;
				this._processing = false;
				resolve(event.data);
			});
			worker.addEventListener('error', (err: unknown) => {
				worker.terminate();
				if (this.encoderWorker === worker) this.encoderWorker = null;
				this._processing = false;
				console.error('terminated encoding worker wit error', err);
				reject(err);
			});

			worker.postMessage({ buffer, format, options: opt });
		});
	}
	/** Emit a `progress` event describing recording/processing state. */
	_emitProgress() {
		if (this._recording) {
			this._elapsed = (Date.now() - this._rectime) / 1000;
			this._duration = this._elapsed;
		}

		const prog = {
			recording: this._recording,
			processing: this._processing,
			start: this._rectime,
			elapsed: this._elapsed,
			duration: this._duration,
		};

		if (this._sampler) this.emit('progress', this._id, prog);
		else this.emit('progress', prog);
	}
	/** Stop the progress timer, clear flags and emit a final progress frame. */
	_clearProgress() {
		// a newer take owns the progress timer and the recording flag: leave them be
		if (this._recording) return;
		clearInterval(this.recordingProgress);
		this._processing = false;
		this._emitProgress();
	}
	/** Disconnect and terminate both workers (called by the engine's destroy). */
	destroy() {
		try {
			this._disconnect();
		} catch (err) {
			console.log(err);
		}

		this.worker.terminate();
		if (this.encoderWorker) this.encoderWorker.terminate();
	}
}
export default Recorder;
