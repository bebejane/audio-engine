import { normalize, trim } from './utils';
import type { ProcessSampleOptions } from './types';
import { createRecordWorker, createEncoderWorker } from './workers';
import moment from 'moment';
import { EventEmitter } from 'events';
const defaults = {
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

type RejectableWorker = Worker & { reject?: (err?: unknown) => void };

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
	_encoderPromise: Deferred<Blob> | null;

	constructor(context: AudioContext, opt: RecorderOptions = {}) {
		super();
		opt = { ...defaults, ...opt };
		this.context = context;
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
		this.init();
	}
	/** Spawn the record worker, wire its messages and load the worklet. */
	init() {
		this.worker = createRecordWorker();
		this.initProcessor();
		this.worker.addEventListener('error', (err: unknown) => {
			console.error('error record worker', err);
			this.emit('error', err);
		});
		this.worker.addEventListener('message', (event: MessageEvent) => {
			if (event.data.cancelled) {
				console.log('Worker: CANCELLED');
				this._clearProgress();
				this._disconnect();
				return this._handleError('CANCELLED');
			}
			console.log('DONE sAMPLER');
			const blob = event.data.blob;
			const buffer = event.data.buffer;
			this._duration = buffer[0].length / this._sampleRate;
			this._processing = true;

			if (!this._processSample) return this._handleFinish(blob, buffer, this._duration);

			console.log('processing sample', this._id, this._duration);
			this._process(buffer, this._id)
				.then((data: { blob: Blob; buffer: Float32Array[] }) => {
					this._handleFinish(data.blob, data.buffer, this._duration);
				})
				.catch((err: unknown) => {
					console.error(err);
					this._handleError(err, this._duration);
				})
				.then(() => {
					this._disconnect();

					if (this._sampler) this.emit('sampling', this._id, false);
					else this.emit('recording', false);

					this._clearProgress();

					console.log('Worker: DONE!');
				});
		});
		this.worker.addEventListener('error', (err: unknown) => {
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
		if (this._recording) return Promise.reject('RECORDING');
		this._id = id;
		this._node = node;
		return new Promise((resolve, reject) => {
			this._promise = { resolve, reject };
			this._start();
		});
	}
	/** Stop capturing and ask the worker to pack the take to a WAV. */
	stop() {
		this._processing = true;
		this._disconnect();
		this.worker.postMessage({ stop: true });
	}
	/** Discard the current take (worker replies `{ cancelled: true }`). */
	cancel() {
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
	_handleError(err: unknown, duration = 0) {
		//this.emit('progress', this._recordingId, {error:err, start:this.rectime, elapsed:duration, duration:duration, recording:false, processing:false})
		this._error = err;

		if (this._sampler) this.emit('sampling', this._id, false);
		else this.emit('recording', false);
		if (this._promise) this._promise.reject(err);

		this._clearProgress();
	}
	/** Build the recording descriptor, resolve the promise and emit progress. */
	_handleFinish(blob: Blob, buffer: Float32Array[], duration: number) {
		const name = 'Rec #' + (this._recordingId + 1) + ' ' + moment().format('MMM DD HH:mm:ss');
		const recording = {
			id: this._recordingId++,
			url: URL.createObjectURL(blob),
			blob: blob,
			buffer: buffer,
			mimeType: 'audio/wav',
			filename: name + '.wav',
			name: name,
			duration: duration,
		};

		if (this._sampler) this.emit('sampling', this._id, false);
		else this.emit('recording', false);

		if (this._promise) this._promise.resolve(recording);

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
			this._encoderPromise = { resolve, reject };
			this.encoderWorker = createEncoderWorker();
			this.encoderWorker.reject = reject;
			this.encoderWorker.addEventListener('message', (event: MessageEvent) => {
				if (event.data.progress) return this.emit('encodingprogress', event.data.progress);

				if (this.encoderWorker) this.encoderWorker.terminate();
				this.encoderWorker = null;
				this._processing = false;
				this._encoderPromise.resolve(event.data);
			});
			this.encoderWorker.addEventListener('error', (err: unknown) => {
				if (this.encoderWorker && this.encoderWorker.terminate) {
					this.encoderWorker.terminate();
					this.encoderWorker = null;
					this._processing = false;
					console.error('terminated encoding worker wit error', err);
				}
				this._encoderPromise.reject(err);
			});

			this.encoderWorker.postMessage({ buffer, format, options: opt });
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
		clearInterval(this.recordingProgress);
		this._recording = false;
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
