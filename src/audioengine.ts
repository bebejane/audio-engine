import Master from './master';
import { extractPeaks, slice } from './utils';
import Sound from './sound';
import { WebMidi } from 'webmidi';
import type { NoteMessageEvent } from 'webmidi';
import { createEncoderWorker } from './workers';
import Recorder from './recorder';
import Analyser from './analyser';
import { EFFECTS, createEffect } from './effects';
import { ensureEffectsWorklet } from './effects/worklet';
import type { EqBand, EqBandOptions } from './types';
import { EventEmitter } from 'events';
import ModelManager from './model';
import Automation from './automation';
import type { Effect } from './effects/core';
import type { EffectDefinition } from './effects';
import type {
	AudioEngineOptions,
	InitOptions,
	InitResult,
	InputInitStatus,
	MediaDeviceInfoLike,
	MidiDeviceInfoLike,
	MidiInitStatus,
	ProcessSampleOptions,
} from './types';

/** Result of initInputDevices(): the inputs and the one actually opened. */
type InputInitResult = { devices: MediaDeviceInfoLike[]; selected: string };

/** A live sound entry as stored in engine.sounds / engine.get(id). */
interface SoundItem {
	id: string;
	url: string | null;
	filename: string | null;
	sound: Sound;
	peaks?: unknown;
	_peaksCache?: Map<string, unknown>;
}

const defaultOptions: AudioEngineOptions = {
	channels: 2,
	volume: 0.2,
	electron: false,
	enableAnalysers: false,
	enableLoops: false,
	enableElapsed: false,
	preloadPitch: true,
	pitchBlockMs: 40,
	processSample: false,
	modelsPath: '/models',
	audioPath: '/audio',
};

/**
 * The audio engine: owns the AudioContext, master gain, the
 * sound grid, input/MIDI devices, recording, effect construction, analysis and
 * model/preset I/O.
 *
 * Everything the app does goes through an instance of this class (or the
 * `engine.master` / `engine.automation` helpers it owns). Events are emitted
 * through Node's EventEmitter; per-column events are suffixed with the sound
 * id (`state<id>`, `load<id>`, `loop<id>`, …).
 */
class AudioEngine extends EventEmitter {
	context: AudioContext;
	sampleRate: number;
	modelsPath: string;
	audioPath: string;
	sounds: SoundItem[];
	soundMap: Record<string, SoundItem>;
	midiMap: Record<number, string[]>;
	meters: Record<string, unknown>;
	analysers: Analyser[];
	analyserMap: Record<string, Analyser>;
	_volume: number;
	channels: number;
	electron: boolean;
	effects: EffectDefinition[];
	EFFECTS: EffectDefinition[];
	inputStream: MediaStream | null;
	inputStreamSource: MediaStreamAudioSourceNode | null;
	inputMeter: unknown;
	outputStream: MediaStreamAudioDestinationNode | null;
	recordingId: number;
	trimThreshold: number;
	masterGain: GainNode;
	outputAnalyser: Analyser;
	inputAnalyser: Analyser | null;
	masterRecorder: Recorder;
	sampleRecorder: Recorder;
	master: Master;
	modelManager: ModelManager;
	automation: Automation;
	encoderPromise: Promise<Blob> | null;
	worker: (Worker & { reject?: (err?: unknown) => void }) | null;
	inputDevices: MediaDeviceInfoLike[];
	inputDeviceId: string;
	midiDevices: MidiDeviceInfoLike[];
	midiDevice: (typeof WebMidi.inputs)[number] | null;
	recording: boolean;
	sampling: string | boolean;
	processSample: boolean | ProcessSampleOptions;
	enableAnalysers: boolean;
	enableLoops: boolean;
	enableElapsed: boolean;
	/** Warm the pitch shifter at startup (see AudioEngineOptions.preloadPitch). */
	preloadPitch: boolean;
	/**
	 * Signalsmith Stretch block size in ms, passed to every Sound's shifter (see
	 * AudioEngineOptions.pitchBlockMs). Equal to the shifter's round-trip latency.
	 */
	pitchBlockMs: number;
	_onDeviceChange: (() => void) | null;
	/** In-flight bootstrap promise, so concurrent init() calls share one run. */
	_bootstrap: Promise<InitResult> | null;
	/** Last successful input init (reused so init() never re-prompts). */
	_inputStatus: InputInitStatus | null;
	/** Last successful MIDI init (reused so init() never re-prompts). */
	_midiStatus: MidiInitStatus | null;

	/**
	 * Build the engine: merge options over defaults, create the AudioContext
	 * (honoring `sampleRate` when given), wire the master gain/analysers, the
	 * two recorders, the Master/ModelManager/Automation helpers and register the
	 * effects worklet.
	 */
	constructor(opt: AudioEngineOptions) {
		super();
		const o = { ...defaultOptions, ...opt };
		// the grid adds one listener per column (e.g. 'solo'), which exceeds
		// the EventEmitter default of 10 — the "possible memory leak" warning
		// is a false positive here, so lift the cap
		this.setMaxListeners(0);
		// honor the requested sample rate (Studio passes 44100); fall back to
		// the device default when none is given
		this.context =
			o.sampleRate && Number.isFinite(o.sampleRate)
				? new AudioContext({ sampleRate: o.sampleRate })
				: new AudioContext();
		this.sampleRate = this.context.sampleRate;
		this.enableAnalysers = o.enableAnalysers;
		this.enableLoops = o.enableLoops;
		this.enableElapsed = o.enableElapsed;
		this.preloadPitch = !!o.preloadPitch;
		this.pitchBlockMs =
			Number.isFinite(o.pitchBlockMs) && (o.pitchBlockMs as number) > 0
				? (o.pitchBlockMs as number)
				: 40;
		this.processSample = o.processSample;
		this.modelsPath = o.modelsPath || '/models';
		this.audioPath = o.audioPath || '/audio';
		this.sounds = [];
		this.soundMap = {};
		this.midiMap = {};
		this.meters = {};
		this.analysers = [];
		this.analyserMap = {};
		this._volume = o.volume;
		this.channels = o.channels;
		this.electron = o.electron;
		this.effects = EFFECTS;
		this.EFFECTS = EFFECTS;
		this.inputStream = null;
		this.inputStreamSource = null;
		this.inputMeter = null;
		this.outputStream = null;
		this.recordingId = 0;
		this.trimThreshold = 0.05;
		this._bootstrap = null;
		this._inputStatus = null;
		this._midiStatus = null;
		this.onMidiNoteOn = this.onMidiNoteOn.bind(this);
		this.onMidiNoteOff = this.onMidiNoteOff.bind(this);
		this.masterGain = this.context.createGain();
		this.masterGain.gain.value = this._volume;
		this.masterGain.connect(this.context.destination);
		this.outputAnalyser = new Analyser('output', this.context, this.masterGain);
		this.inputAnalyser = null;

		this.masterRecorder = new Recorder(this.context, {
			numChannels: 2,
			sampleRate: this.sampleRate,
			sampler: false,
		})
			.on('recording', (on) => {
				this.emitMasterState({
					recording: on,
				});
				this.emit('recording', on);
			})
			.on('progress', (prog) => {
				this.emit('recordingprogress', prog);
			});
		this.sampleRecorder = new Recorder(this.context, {
			numChannels: 2,
			sampleRate: this.sampleRate,
			sampler: true,
			processSample: this.processSample || false,
		})
			.on('sampling', (id, on) => {
				this.emitMasterState({
					sampling: on,
				});
				this.get(id).sound.sampling(on);
				this.emit('sampling', id, on);
			})
			.on('processing', (on) => {
				//this.emitMasterState({sampling:on})
			})
			.on('progress', (id, prog) => {
				this.emit('samplingprogress', id, prog);
				//this.emitMasterState({sampling:on})
			});

		this.master = new Master(this, this._volume);

		// Model/preset I/O (load/save/download .zip + settings snapshots).
		// Kept in a separate class so AudioEngine stays focused on the audio graph.
		this.modelManager = new ModelManager(this);

		// Records engine state changes (sound params, effects, transport) and
		// loops them back — driven by the R / L keyboard shortcuts.
		this.automation = new Automation(this);
		this.automation.install();

		// Effects run on an AudioWorklet: register their processors early so
		// the first addEffect() (even during model load) can create a node
		// without waiting for a lazy module load.
		ensureEffectsWorklet(this.context);

		// Warm the pitch shifter MODULE once per engine when preloading is
		// enabled — so a sound's first pitch change doesn't pay the dynamic
		// module fetch/parse. Per-sound Stretch nodes stay lazy: creating one
		// per Sound up front garbles audio on some setups (many concurrent
		// WASM worklet instances). Headless has no window; the rejection is
		// ignored.
		if (this.preloadPitch) {
			import('./pitch/stretch')
				.then(({ default: loadSignalsmithStretch }) => loadSignalsmithStretch())
				.catch(() => {});
		}

		// keep the handler so destroy() can detach it (was leaking per engine)
		this._onDeviceChange = () => {
			this.listDevices().then((devices) => {
				this.emit('inputdevices', devices);
			});
		};
		if (navigator.mediaDevices && navigator.mediaDevices.addEventListener)
			navigator.mediaDevices.addEventListener('devicechange', this._onDeviceChange);
	}
	/**
	 * Merge a partial state patch into `master.state` and emit `masterstate`
	 * (the second argument is the patch itself; no-op for an empty patch).
	 */
	emitMasterState(opt = {}) {
		if (!Object.keys(opt).length) return;
		this.master.state = { ...this.master.state, ...opt };
		this.emit('masterstate', this.master.state, opt);
	}
	/**
	 * Initialize the engine in one call. Features are opt-in — `input`/`midi`
	 * default to `false`, so nothing prompts unless asked — and isolated: a
	 * denied or unsupported capability resolves with a per-feature `status`
	 * instead of rejecting the whole call.
	 *
	 * Concurrent calls share one bootstrap (React StrictMode double-invokes),
	 * and a feature that already came up is reused rather than prompted again.
	 * Call `init()` once at startup; use the granular methods to switch devices
	 * later.
	 *
	 * @param options - which capabilities to bring up; see {@link InitOptions}.
	 * @returns per-feature {@link InitResult}.
	 */
	init(options: InitOptions = {}): Promise<InitResult> {
		if (this._bootstrap) return this._bootstrap;
		const run = this._bootstrapInit(options);
		this._bootstrap = run;
		// clear once settled so a later call can bring up other features
		const clear = () => {
			if (this._bootstrap === run) this._bootstrap = null;
		};
		run.then(clear, clear);
		return run;
	}
	/** Run the requested init features independently and assemble the result. */
	_bootstrapInit(options: InitOptions): Promise<InitResult> {
		const restore = options.restore !== false;
		const wantInput = options.input !== undefined && options.input !== false;
		const wantMidi = options.midi !== undefined && options.midi !== false;
		const result: InitResult = {
			context: { state: this.context.state, resumed: this.context.state === 'running' },
		};

		const jobs: Promise<void>[] = [];
		if (wantInput) {
			// an input that is already open stays open — never re-prompt
			if (this._inputStatus && this._inputStatus.status === 'ok') result.input = this._inputStatus;
			else
				jobs.push(
					this._initInputFeature(options, restore).then((status) => {
						this._inputStatus = status;
						result.input = status;
					}),
				);
		}
		if (wantMidi) {
			if (this._midiStatus && this._midiStatus.status === 'ok') result.midi = this._midiStatus;
			else
				jobs.push(
					this._initMidiFeature(options, restore).then((status) => {
						this._midiStatus = status;
						result.midi = status;
					}),
				);
		}

		return Promise.all(jobs).then(async () => {
			if (options.resume) await this.resume();
			result.context = {
				state: this.context.state,
				resumed: this.context.state === 'running',
			};
			this.emit('masterstate', this.master.state);
			return result;
		});
	}
	/** Bring up the microphone input and report the outcome (never rejects). */
	_initInputFeature(options: InitOptions, restore: boolean): Promise<InputInitStatus> {
		const requested = typeof options.input === 'object' ? options.input.deviceId : undefined;
		const deviceId =
			requested || (restore ? this._readStored('lastInputDevice') : null) || undefined;
		return this.initInputDevices(deviceId).then(
			({ devices, selected }) => ({ status: 'ok', devices, selected }) as InputInitStatus,
			(err) => {
				const status =
					err === 'NOTSUPPORTED' ? 'unsupported' : err === 'NOTALLOWED' ? 'denied' : 'error';
				return { status, devices: this.inputDevices || [], error: err } as InputInitStatus;
			},
		);
	}
	/** Bring up MIDI (and attach note handlers) and report the outcome. */
	_initMidiFeature(options: InitOptions, restore: boolean): Promise<MidiInitStatus> {
		const requested = typeof options.midi === 'object' ? options.midi.deviceId : undefined;
		return this.initMidiDevices().then(
			(devices) => {
				const stored = restore ? this._readStored('lastMidiDevice') : null;
				const preferred = [requested, stored].find(
					(id) => id && devices.some((d) => d.deviceId === id),
				);
				const selected = (preferred ? devices.find((d) => d.deviceId === preferred) : devices[0])
					?.deviceId;
				if (!selected) return { status: 'ok', devices } as MidiInitStatus;
				return this.initMidiSource(selected).then(
					() => ({ status: 'ok', devices, selected }) as MidiInitStatus,
					(err) => ({ status: 'error', devices, selected, error: err }) as MidiInitStatus,
				);
			},
			(err) => ({ status: 'unsupported', devices: [], error: err }) as MidiInitStatus,
		);
	}
	/**
	 * Resume the AudioContext if it is suspended. Browsers only honor this from
	 * a user gesture; if refused, the promise still resolves and the returned
	 * state stays `'suspended'`, so callers can retry from a click handler.
	 *
	 * @returns the resulting AudioContext state.
	 */
	resume(): Promise<AudioContextState> {
		if (this.context.state !== 'suspended') return Promise.resolve(this.context.state);
		// resolve (not reject) even when the browser refuses; state stays suspended
		return this.context.resume().then(
			() => this.context.state,
			() => this.context.state,
		);
	}
	/** Read a localStorage key defensively (private mode / SSR can throw). */
	_readStored(key: string): string | null {
		try {
			return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
		} catch (err) {
			return null;
		}
	}
	/** Write a localStorage key defensively (private mode / SSR can throw). */
	_writeStored(key: string, value: string): void {
		try {
			if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
		} catch (err) {}
	}
	/**
	 * Request the microphone (preferring `lastDeviceId`), enumerate the input
	 * devices and create the input source. Falls back to the default device when
	 * the exact one is denied/unavailable.
	 *
	 * @returns the device list and the id actually selected.
	 * @throws 'NOTSUPPORTED' without mediaDevices, or 'NOTALLOWED' when denied.
	 */
	initInputDevices(lastDeviceId?: string | null): Promise<InputInitResult> {
		if (!navigator.mediaDevices) return Promise.reject('NOTSUPPORTED');

		// `sampleSize` isn't a real getUserMedia constraint (always ignored);
		// baseConstraints doubles as the fallback when the exact device fails
		const baseConstraints = {
			audio: {
				autoGainControl: false,
				echoCancellation: false,
				noiseSuppression: false,
			},
		};
		const constraints = lastDeviceId
			? { audio: { ...baseConstraints.audio, deviceId: { exact: lastDeviceId } } }
			: baseConstraints;

		return new Promise((resolve, reject) => {
			navigator.mediaDevices
				.getUserMedia(constraints)
				.then((stream) => {
					return this.listDevices().then((devices) => {
						const label = stream.getTracks()[0].label;
						const device = devices.filter((d) => d.label === label)[0];
						this.createInputSource(stream, device.deviceId);
						resolve({
							devices,
							selected: device.deviceId,
						});
					});
				})
				.catch((err) => {
					const notAllowed =
						err.toString().toLowerCase().indexOf('permission denied') > -1 ||
						err.name === 'NotAllowedError' ||
						err.name === 'OverconstrainedError';
					if (notAllowed) {
						navigator.mediaDevices
							.getUserMedia(baseConstraints)
							.then((stream) => {
								const label = stream.getTracks()[0].label;
								return this.listDevices().then((devices) => {
									const deviceId = devices.filter((d) => d.label === label)[0].deviceId;
									this.createInputSource(stream, deviceId);
									resolve({
										devices,
										selected: deviceId,
									});
								});
							})
							.catch((err) => {
								const notAllowed =
									err.toString().toLowerCase().indexOf('permission denied') > -1 ||
									err.name === 'NotAllowedError';
								reject(notAllowed ? 'NOTALLOWED' : err);
							});
					} else reject(err);
				});
		});
	}
	/** Enumerate audio input devices, store and emit them as `inputdevices`. */
	listDevices(): Promise<MediaDeviceInfoLike[]> {
		return new Promise((resolve, reject) => {
			navigator.mediaDevices
				.enumerateDevices()
				.then((devices) => {
					this.inputDevices = devices
						.filter((d) => d.kind === 'audioinput')
						.map((d) => {
							return {
								deviceId: d.deviceId,
								groupId: d.groupId,
								kind: d.kind,
								label: d.label,
							};
						});

					this.emit('inputdevices', this.inputDevices);
					resolve(this.inputDevices);
				})
				.catch((err) => reject(err));
		});
	}
	listMidiDevices(): Promise<MidiDeviceInfoLike[]> {
		return new Promise((resolve, reject) => {
			this.midiDevices = WebMidi.inputs.map((d) => {
				return {
					deviceId: d.id,
					name: d.name,
					connection: d.connection,
					state: d.state,
					manufacturer: d.manufacturer,
				};
			});

			this.emit('mididevices', this.midiDevices);
			resolve(this.midiDevices);
		});
	}
	/** Re-open the input stream for one enumerated device id (closing the old one). */
	initInputSource(deviceId: string): Promise<void> {
		const device = this.inputDevices.filter((i) => i.deviceId === deviceId)[0];
		this.closeInputStream();
		return new Promise<void>((resolve, reject) => {
			navigator.mediaDevices
				.getUserMedia({
					audio: {
						deviceId: {
							exact: deviceId,
						},
					},
				})
				.then((stream) => {
					this.createInputSource(stream, deviceId);
					resolve();
				})
				.catch((err) => reject(err));
		});
	}
	/**
	 * Adopt a MediaStream as the engine's audio input: remembers the device,
	 * builds/re-points the input analyser and persists the choice as
	 * `lastInputDevice` in localStorage.
	 */
	createInputSource(stream: MediaStream, deviceId: string): void {
		this.closeInputStream();

		const device = this.inputDevices.filter((i) => i.deviceId === deviceId)[0];
		this.inputStream = stream;
		this.inputStreamSource = this.context.createMediaStreamSource(this.inputStream);
		if (!this.inputAnalyser)
			this.inputAnalyser = new Analyser('input', this.context, this.inputStreamSource);
		else this.inputAnalyser.setNode(this.inputStreamSource);
		this.inputDeviceId = deviceId;
		this._writeStored('lastInputDevice', deviceId);
	}
	/** Stop all tracks of the current input stream (if any). */
	closeInputStream() {
		if (this.inputStream) this.inputStream.getAudioTracks().forEach((t) => t.stop());
	}
	/** Switch to the first enumerated input whose label contains `label` (case-insensitive). */
	initInput(label: string): void {
		const device = this.inputDevices.filter(
			(d) => d.label.toLowerCase().indexOf(label.toLowerCase()) > -1,
		)[0];
		if (device) this.initInputSource(device.deviceId);
	}
	/**
	 * Build a Sound and subscribe to all of its events, translating them into
	 * engine-level events (`state<id>`, `load<id>`, `loop<id>`, `ended<id>`, …)
	 * and keeping the master state/analysers in sync. Does not register it in
	 * `sounds` (that is `add()`).
	 */
	createSound(
		id: string,
		url: string | null,
		filename: string | null,
		opt: Record<string, any> = {},
	): Sound {
		const sound = new Sound(id, url, this, {
			filename: filename,
			local: this.electron,
			enableLoops: this.enableLoops,
			enableElapsed: this.enableElapsed,
			pitchBlockMs: this.pitchBlockMs,
			...opt,
		});
		// Sound.emitState only ever emits 'state' (never 'state<id>'), so this is
		// the single forwarder that turns it into the per-column engine event
		sound
			.on('state', (state, updated) => {
				this.emit('state' + id, state, updated);
				// keep the slot being edited in sync with live changes
				this.modelManager._syncCurrentPreset();
			})
			.on('effectparams', (id, type, opt) => {
				this.emit('effectparams', id, type, opt);
			})
			.on('load', () => {
				this.onLoad(id);
				this.master._updateDuration();
			})
			.on('change', () => {
				this.emit('change' + id, sound.duration());
				this.emit('change', id, sound.duration());
				this.master._updateDuration();
			})
			.on('ready', (id) => {
				const status = {
					total: this.sounds.length,
					ready: this.ready(),
				};
				this.emit('ready', id, status);
			})
			.on('rate', () => {
				if (this.enableElapsed) this.master._updateDuration();
			})
			.on('playing', (sid, on) => {
				const isPlaying = this.master.isPlaying();
				this.emitMasterState({
					playing: isPlaying,
				});
				// let the master meter settle rather than hard-pausing it, so a
				// delay/reverb tail still shows after the last sound stops
				this.outputAnalyser.setActive(isPlaying);
				this.setAnalysersActive(sid, on === true);
			})
			.on('stop', () => {
				const isPlaying = this.master.isPlaying();
				this.emitMasterState({
					playing: this.master.isPlaying(),
				});
				this.outputAnalyser.setActive(isPlaying);
				this.setAnalysersActive(id, false);
			})
			.on('elapsed', (elapsed) => {
				this.emit('elapsed' + id, elapsed);
			})
			.on('eq', (sid, band, settings) => {
				this.emit('eq' + id, band, settings);
			})
			.on('muted', (on) => {})
			.on('loopend', (on) => {
				this.emit('loopend' + id, on);
			})
			.on('loaderror', (err) => {
				this.emit('loaderror', err, id);
				this.onLoad(id);
			})
			.on('loop', (on) => {
				this.emit('loop', id, on);
				this.emit('loop' + id, {
					loop: on,
					loopStart: sound._loopStart,
					loopEnd: sound._loopEnd,
				});
				this.master._updateDuration();
			})
			.on('ended', () => {
				this.emit('ended', sound.id);
				this.emit('ended' + sound.id);
				const isPlaying = this.master.isPlaying();
				this.emitMasterState({
					playing: isPlaying,
				});
				this.outputAnalyser.setActive(isPlaying);
			})
			.on('solo', (on) => {
				this.emit('solo', sound.id, on);
				this.emitMasterState({
					solo: this.master.solo(),
				});
			});
		this.emit('create', id, sound);
		return sound;
	}
	/**
	 * Add a new sound to the grid under `id` (fetching `url` when given).
	 * @throws when the id is already taken.
	 */
	add(
		id: string,
		url: string | null,
		filename: string | null,
		opt?: Record<string, unknown>,
	): SoundItem {
		if (this.soundMap[id]) throw new Error('ID ' + id + ' already exists');

		const sound = this.createSound(id, url, filename, opt);
		const item = {
			id: id,
			url: url,
			filename: filename,
			sound: sound,
		};
		this.sounds.push(item);
		this.soundMap[id] = item;
		console.log('emit aadd');
		this.emit('add', item.sound.id, item.sound);
		sound.emitState('add', id);

		return item;
	}
	/** Destroy and unregister one sound (no-op for an unknown id). */
	remove(id: string): void {
		const item = this.soundMap[id];
		if (!item) return;
		item.sound.destroy();
		delete this.soundMap[id];
		this.sounds = this.sounds.filter((s) => s.id !== id);
		this.emit('remove', id);
	}
	/** Remove every sound from the grid. */
	removeAll() {
		this.sounds.forEach((s) => this.remove(s.id));
	}
	/**
	 * Swap a cell's audio file: unloads first, then re-creates the Sound with the
	 * previous save state (and effect chain), or `add()`s it when the cell is new.
	 * Re-points the analysers at the replacement node.
	 */
	replace(id: string, url: string, filename: string): void {
		this.unload(id);
		const has = this.sounds.some((i) => i.id === id);
		console.log({ has });
		if (!has) {
			// uploading into a column that has no sound yet (e.g. a freshly
			// created empty model) → create it AND load it, otherwise the buffer
			// is never decoded and the cell stays silent
			console.log('replace > adding', id);
			this.add(id, url, filename).sound.load();
			return;
		}
		const sounds = this.sounds.map((i, idx) => {
			if (i.id !== id) return i;
			const effectParams = i.sound._currentEffectParams();
			i.sound = this.createSound(id, url, filename);
			i.sound.load();
			// the sound now owns a brand-new audio node — re-point its
			// analysers, otherwise the meters keep reading the discarded one
			// (e.g. after sampling or uploading into a channel)
			this.setAnalysersNode(id, i.sound.node);
			if (effectParams && effectParams.length)
				effectParams.forEach((e) => this.addEffect(id, e.type, !e.bypassed, e.params));
			return i;
		});

		this.sounds = sounds;
		// broadcast the swap (same (id, sound) shape as 'add') so views that
		// listen for sound-level changes (the standalone Mixer) stay in sync
		this.emit('replace', id, this.soundMap[id].sound);
	}
	/**
	 * Duplicate a loaded sound's PCM under a new id, optionally cropped to a
	 * `{ start, end }` second range.
	 */
	copy(id: string, newId: string, opt: { start?: number; end?: number } = {}): SoundItem {
		const sound = this.get(id).sound;
		const buffer = sound.buffer;
		let data: Float32Array[] =
			buffer.numberOfChannels === 1
				? [buffer.getChannelData(0)]
				: [buffer.getChannelData(0), buffer.getChannelData(1)];

		if (opt.start || opt.end) {
			// start/end are seconds; `end` used to reference an undefined
			// identifier, and numberOfChannels used buffer.length (sample
			// frames) instead of buffer.numberOfChannels
			const start = Math.floor((opt.start || 0) * this.sampleRate);
			const end = Math.floor((opt.end || buffer.duration) * this.sampleRate);
			const length = data[0].length;
			const cropped = slice(data, start, end > length - 1 ? length - 1 : end);
			const copy = new AudioBuffer({
				length: cropped[0].length,
				numberOfChannels: buffer.numberOfChannels,
				sampleRate: this.sampleRate,
			});
			cropped.forEach((channelData, idx) => {
				copy.copyToChannel(channelData as never, idx);
			});
			data = cropped;
		}
		const objURL = URL.createObjectURL(
			new Blob([data as unknown as BlobPart], { type: sound._mimeType }),
		);
		const newSound = this.add(newId, objURL, sound._filename);
		return newSound;
	}
	/** True when a sound is registered under `id`. */
	exist(id: string): boolean {
		return this.soundMap[id] !== undefined;
	}
	/** Reset one sound to its defaults. */
	reset(id: string): void {
		this.get(id).sound.reset();
	}
	/** Count of sounds whose buffer has finished loading. */
	ready(): number {
		return this.sounds.filter((s) => s.sound._ready).length;
	}
	/** Load one sound (by id) or all sounds when omitted. */
	load(id?: string): void {
		if (id) this.get(id).sound.load();
		else this.get().forEach((s) => s.sound.load());
	}
	/** Invoke `fn(sound, id)` for one id, or for every sound when id is omitted. */
	soundForEach(id: string | undefined, fn: (sound: Sound, id: string) => void): void {
		if (id) {
			const item = this.soundMap[id];
			if (item) fn(item.sound, id);
		} else {
			this.get().forEach((item) => fn(item.sound, item.id));
		}
	}
	/** Release a sound's decoded buffer/object URL (stops it first if playing). */
	unload(id?: string): void {
		if (!id) return this.get().forEach((s) => this.unload(s.id));

		const s = this.soundMap[id];
		if (!s) return;
		if (s.sound.source) this.stop(id);

		URL.revokeObjectURL(s.url);
		s.sound.buffer = null;
		s.sound._buffer = null;
		s.sound.source = null;
	}
	/** Play one sound (by id) with optional play options. */
	play(id: string, opt?: Record<string, unknown>): void {
		this.soundForEach(id, (sound) => sound.play(opt));
	}
	/** Stop one sound, or every sound when `id` is omitted. */
	stop(id?: string): void {
		this.soundForEach(id, (sound) => sound.stop());
	}
	/** Pause/resume one sound, or all sounds when `id` is omitted. */
	pause(id?: string, on?: boolean): boolean | void {
		if (id) {
			return this.get(id).sound.pause(on);
		}
		this.get().forEach((s) => s.sound.pause(on));
		return on;
	}
	/** Resume a paused sound (delegates to Sound.pause(false)). */
	unpause(id: string): void {
		// Sound has no `unpause`; resuming is `pause(false)` (this engine method
		// previously called a non-existent Sound.unpause and would have thrown)
		this.soundForEach(id, (sound) => sound.pause(false));
	}
	/** Get the loop flag (no id/unset) or set looping with optional bounds. */
	loop(id?: string, on?: boolean, offset?: { start?: number; end?: number }): boolean | void {
		if (id) {
			return this.get(id).sound.loop(on, offset);
		} else {
			this.sounds.forEach((s) => {
				s.sound.loop(on, offset);
				if (!on) this.stop(s.id);
			});
		}
	}
	/** Loop start of one sound, in seconds. */
	loopStart(id: string, offset?: number): number {
		return this.get(id).sound._loopStart;
	}
	/** Loop end of one sound, in seconds. */
	loopEnd(id: string, offset?: number): number {
		return this.get(id).sound._loopEnd;
	}
	/** Get one sound's volume (no `vol`) or set it, or set all when id is omitted. */
	volume(id?: string, vol?: number): number | void {
		if (vol === undefined) {
			const s = this._sound(id);
			return s ? s.volume() : undefined;
		}
		if (!Number.isFinite(vol)) return;

		// No muted guard here: Sound.volume() is mute-safe (its gain target is
		// 0 while muted), so writing the level while muted is inaudible but
		// leaves the stored volume ready for the next unmute. The old guard
		// silently dropped fader moves on muted channels, so they snapped back.
		if (id) {
			const s = this._sound(id);
			if (s) s.volume(vol);
		} else {
			this.get().forEach((s) => s.sound.volume(vol));
		}
	}
	/**
	 * Get or set one sound's 4-band channel EQ (applied in the channel
	 * processor, after the effects and before the panner).
	 *
	 * - `eq(id)` → all four bands (a copy).
	 * - `eq(id, band)` → one band (0–3).
	 * - `eq(id, band, options)` → merge the given fields into one band.
	 */
	eq(id: string, band?: number, options?: EqBandOptions): EqBand | EqBand[] | undefined {
		const s = this._sound(id);
		return s ? s.eq(band, options) : undefined;
	}
	/** Get one sound's channel gain trim in dB (no `gain`) or set it (−24 … +24). */
	gain(id: string, gain?: number): number | void {
		if (id) {
			const s = this._sound(id);
			return s && s.gain(gain);
		}
		this.get().forEach((s) => s.sound.gain(gain));
	}
	/** Set playback rate on one sound, or all sounds when id is omitted. */
	rate(id?: string, rate?: number): void {
		this.soundForEach(id, (sound) => sound.rate(rate));
	}
	/** Tempo-preserving pitch shift, in semitones (0 = original). */
	pitch(id: string, pitch: number): void {
		this.soundForEach(id, (sound) => sound.pitch(pitch));
	}
	/** Mute one sound (or all, and optional state) via Sound.mute. */
	mute(id: string, on = true): void {
		this.soundForEach(id, (sound) => sound.mute(on));
	}
	/** Unmute one sound (Sound.mute(false)). */
	unmute(id: string): void {
		// Sound has no `unmute`; unmuting is mute(false)
		this.soundForEach(id, (sound) => sound.mute(false));
	}
	/** Pan one sound (degrees); returns the computed panner position. */
	pan(id: string, deg: number): unknown {
		const s = this._sound(id);
		return s ? s.pan(deg) : undefined;
	}
	/** Raw buffer duration of one sound, in seconds. */
	duration(id: string): number {
		return this.get(id).sound._duration;
	}
	/** Jump one sound to `sec` seconds. */
	jump(id: string, sec: number): unknown {
		return this.get(id).sound.jump(sec);
	}
	/**
	 * Solo one sound. With `multi`, other sounds keep their own solo state and
	 * muted ones are handled accordingly; without it, only `id` is soloed.
	 */
	solo(id: string, on: boolean, multi = true): void {
		this.sounds.forEach((s) => {
			if (s.id === id) s.sound.solo(on, false);
			else s.sound.solo(multi ? s.sound._solo : false, multi ? !s.sound._solo : on);
		});
	}
	/** Get one sound's lock flag (no `on`) or set it, or set all when id is omitted. */
	lock(id?: string, on?: boolean): boolean | void {
		if (id) {
			const s = this._sound(id);
			return s ? s.lock(on) : undefined;
		}
		this.get().forEach((s) => s.sound.lock(on));
	}
	/** Reverse (or un-reverse) one sound's buffer. */
	reverse(id: string, on: boolean): void {
		this.get(id).sound.reverse(on);
	}
	/** Crop one sound to the `[start, end]` second range. */
	crop(id: string, start: number, end: number): void {
		this.get(id).sound.crop(start, end);
	}
	/** True while one sound is playing. */
	playing(id: string): boolean {
		return this.get(id).sound._playing;
	}
	/** Pause if playing else play, for one sound or (when id is omitted) the grid. */
	toggleplay(id?: string): void {
		if (id) this.get(id).sound._playing ? this.pause(id) : this.play(id);
		else
			this.get().forEach((s) => {
				if (s.sound._playing) this.pause(id);
				else this.play(s.id);
			});
	}
	/** Unmute if muted else mute, for one sound or (when id is omitted) the grid. */
	togglemute(id?: string): void {
		if (id) this.get(id).sound.mute() ? this.mute(id) : this.unmute(id);
		else
			this.get().forEach((s) => {
				if (s.sound.mute()) this.unmute(id);
				else this.mute(s.id);
			});
	}
	/** Emit the engine-level load events for one sound (`load`, `load<id>`). */
	onLoad(id: string): void {
		this.emit('load', id);
		this.emit('load' + id, id, true);
	}
	// safe per-id sound lookup — missing ids return undefined instead of throwing,
	// so id-based accessors can no-op on columns that have state but no sound
	_sound(id: string): Sound | undefined {
		if (!id) return undefined;
		const item = this.soundMap[id];
		return item ? item.sound : undefined;
	}
	get(): SoundItem[];
	get(id: string): SoundItem;
	/**
	 * Return the sound item for `id`, or the whole list when omitted.
	 * @throws when `id` is not registered.
	 */
	get(id?: string): SoundItem | SoundItem[] {
		if (!id) return this.sounds;
		if (!this.soundMap[id]) throw new Error("ID '" + id + "' doesn't exist!");

		return this.soundMap[id];
	}
	/**
	 * Destroy all sounds and analysers. With `force`, also tears down the
	 * recorders, MIDI, the devicechange listener and all event listeners — used
	 * when the engine is being discarded entirely.
	 */
	destroy(force?: boolean): void {
		this.sounds.forEach((s) => s.sound.destroy());
		this.get().forEach((s) => {
			this.unload(s.id);
		});
		this.sounds = [];
		this.soundMap = {};
		this.destroyAnalysers();

		if (force) {
			if (this.masterRecorder) this.masterRecorder.destroy();
			if (this.sampleRecorder) this.sampleRecorder.destroy();

			try {
				WebMidi.disable();
			} catch (err) {}

			if (
				this._onDeviceChange &&
				navigator.mediaDevices &&
				navigator.mediaDevices.removeEventListener
			)
				navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);
			this._bootstrap = null;
			this._inputStatus = null;
			this._midiStatus = null;
			this.removeAllListeners();
			this.closeInputStream();
		}
	}

	// ---- models & presets: thin facade over ModelManager -----------------
	/** Model list from /models/index.json (drives the dropdown). */
	get models() {
		return this.modelManager.models;
	}
	/** Saved preset slots for the current model. */
	get presets() {
		return this.modelManager.presets;
	}
	/**
	 * Index of the preset slot currently being edited, or -1 when none.
	 *
	 * Set by `restorePreset` and `savePreset`; while it is set, every sound change
	 * re-snapshots that slot, so a restored preset tracks live edits and is
	 * written back to the model on save.
	 */
	get currentPreset() {
		return this.modelManager.currentPreset;
	}
	/** The currently loaded model, or null before the first load. */
	get model() {
		return this.modelManager.model;
	}
	/** Fetch the model index (see ModelManager.loadModels). */
	loadModels() {
		return this.modelManager.loadModels();
	}
	/**
	 * Load and populate a model by name (or a supplied zip buffer). Clears the
	 * automation take first, since a new model replaces every sound.
	 */
	loadModel(name: string, zipContent?: ArrayBuffer) {
		// a new model replaces every sound (and its ids/effects) — a take from
		// the previous model would be meaningless
		this.automation.clear();
		return this.modelManager.loadModel(name, zipContent);
	}
	/** Load a model from a user-selected .zip File (clears automation first). */
	loadModelFromFile(file: File, onProgress?: (e: ProgressEvent<FileReader>) => void) {
		this.automation.clear();
		return this.modelManager.loadModelFromFile(file, onProgress);
	}
	/** Create an empty in-memory model of `cols` x `rows` cells (clears automation). */
	createModel(name: string, cols: number, rows: number) {
		this.automation.clear();
		return this.modelManager.createModel(name, cols, rows);
	}
	/** Serialize the current state to a .zip Blob (does not download). */
	saveModel(name?: string) {
		return this.modelManager.saveModel(name);
	}
	/** Serialize and download the current model as a .zip. */
	downloadModel(name?: string) {
		return this.modelManager.downloadModel(name);
	}
	/** Download one sound's original audio file. */
	downloadSound(id: string) {
		return this.modelManager.downloadSound(id);
	}
	/** Trigger a browser download of `blob` under `filename`. */
	download(blob: Blob, filename: string) {
		return this.modelManager.download(blob, filename);
	}
	/** Snapshot every sound into a preset (first free slot). */
	savePreset(name?: string) {
		return this.modelManager.savePreset(name);
	}
	/** Restore every sound to the preset stored in `index`. */
	restorePreset(index: number) {
		return this.modelManager.restorePreset(index);
	}
	/**
	 * Stop tracking edits to the current preset slot. The slot keeps its saved
	 * contents; it just stops following further changes (see `currentPreset`).
	 */
	clearCurrentPreset() {
		return this.modelManager.clearCurrentPreset();
	}
	/** Randomize every sound and store the result as a preset (see ModelManager). */
	randomizePreset(index?: number) {
		return this.modelManager.randomizePreset(index);
	}
	/** True when `index` holds a preset. */
	hasPreset(index: number) {
		return this.modelManager.hasPreset(index);
	}
	/** Empty every preset slot. */
	clearPresets() {
		return this.modelManager.clearPresets();
	}

	/** Build one effect instance (used by Sound._materialize for lazy effects). */
	createEffectInstance(type: string, opt?: Record<string, unknown>): Promise<Effect> {
		return createEffect(type, this.context, opt);
	}
	/**
	 * Add an effect to a sound's chain. A bypassed effect (`bypass !== false`)
	 * is registered lazily (no worklet node until enabled); otherwise the node is
	 * built now.
	 *
	 * @throws when the effect type is unknown.
	 */
	async addEffect(
		id: string,
		type: string,
		bypass?: boolean,
		opt?: Record<string, unknown>,
	): Promise<unknown> {
		const sound = this.get(id).sound;
		// A bypassed effect isn't in the graph, so don't build its worklet node
		// yet — Sound builds it on first un-bypass. Only `false` (audible) needs
		// the node up front.
		if (bypass !== false && typeof sound.addPendingEffect === 'function') {
			const def = EFFECTS.filter((eff) => eff.id === type)[0];
			if (!def) throw new Error('Effect doesnt exist: ' + type);
			return sound.addPendingEffect(type, def.defaults, opt || {}, bypass);
		}
		const effect = await createEffect(type, this.context, opt);
		return sound.addEffect(type, effect, bypass);
	}
	/** Remove the effect at `idx` from a sound's chain. */
	removeEffect(id: string, idx: number): unknown {
		return this.get(id).sound.removeEffect(idx);
	}
	/** Move an effect within a sound's chain from `idx` to `toIdx`. */
	moveEffect(id: string, idx: number, toIdx: number): unknown {
		return this.get(id).sound.moveEffect(id, idx, toIdx);
	}
	/** Bypass or un-bypass the effect at `idx` on a sound's chain. */
	effectBypass(id: string, idx: number, on: boolean): unknown {
		return this.get(id).sound.effectBypass(idx, on);
	}
	/** Read or write one effect's params (whole chain when `idx` is omitted). */
	effectParams(id: string, idx?: number, params?: Record<string, unknown>): unknown {
		const s = this._sound(id);
		return s ? s.effectParams(idx, params) : undefined;
	}
	/** Bypass the whole effect chain of a sound. */
	disableEffects(id: string): void {
		this.get(id).sound.disableEffects();
	}
	/** Re-enable the whole effect chain of a sound. */
	enableEffects(id: string): void {
		this.get(id).sound.enableEffects();
	}
	/** Aggregate snapshot of the grid (count / playing / looping / muted / volume). */
	info(): Record<string, unknown> {
		const info: Record<string, unknown> = {};
		info.count = this.get().length;
		info.playing = this.sounds.filter((s) => s.sound._playing).length > 0;
		info.looping = this.sounds.filter((s) => s.sound._loop).length > 0;
		info.muted = this.sounds.filter((s) => s.sound._muted).length > 0;
		info.locked = this.sounds.filter((s) => s.sound._locked).length > 0;
		info.volume = this.masterGain.gain.value;
		info.pan = 0;
		info.rate = 1.0;
		return info;
	}

	/**
	 * Build a transient, unregistered Sound from a URL (used for one-shot
	 * previews). Not added to `sounds`; the caller owns it.
	 */
	playSound(url: string, opt: Record<string, any> = {}): Sound {
		const sound = new Sound(String(Date.now()), url, this, {
			filename: 'Temp.wav',
			pitchBlockMs: this.pitchBlockMs,
			...opt,
		});
		/*
		this.masterGain = typeof this.context.createGain === 'undefined' ? this.context.createGainNode() : this.context.createGain();
		this.masterGain.gain.value = this._volume;
		this.masterGain.connect(this.context.destination);
		*/
		return sound;
	}

	/** Start (`true`) or stop (`false`) a master-mix recording via masterRecorder. */
	record(start: boolean): Promise<unknown> | void {
		if (start) {
			return this.masterRecorder
				.record(this.masterGain)
				.then((recording) => {
					return recording;
				})
				.catch((err) => {
					this.emit('error', err);
				});
		} else {
			this.masterRecorder.stop();
		}
		return;
	}
	/** Discard the in-progress master recording and emit the reset state. */
	cancelRecord() {
		this.masterRecorder.cancel();
		this.recording = false;
		this.emit('recording', false);
		this.emitMasterState({
			recording: false,
		});
	}
	/**
	 * Start/stop sampling the selected input into sound `id`. On success the
	 * cell's audio is replaced with the recording.
	 */
	sample(id: string, start: boolean): Promise<unknown> | void {
		if (!this.inputStreamSource) return Promise.reject('No audio input source selected');

		if (!start) return this.sampleRecorder.stop();

		this.stop(id);
		// a cell can exist with no Sound yet (a new/empty model) — create one so
		// the take has somewhere to land (replace() rebuilds it with the audio)
		if (!this._sound(id)) this.add(id, null, 'sample-' + id + '.wav');
		return this.sampleRecorder
			.record(this.inputStreamSource, id)
			.then((recording: { url: string; filename: string }) => {
				const sound = this._sound(id);
				if (!sound) return console.error('NO SOUND there anymore', id);

				this.replace(id, recording.url, recording.filename);
				return recording;
			})
			.catch((err) => {
				console.log(err);
				throw err;
			});
	}
	/** Cancel the in-progress sample take and clear the sampling state. */
	cancelSample(id: string): void {
		this.sampleRecorder.cancel();
		this.sampling = false;
		this.emit('sampling', id, false);
		const sound = this._sound(id);
		if (sound) sound.sampling(false);
		this.emitMasterState({
			sampling: false,
		});
	}

	/**
	 * Encode PCM (per-channel arrays or an AudioBuffer) to a wav/mp3 Blob in a
	 * worker. Emits `encodingprogress`; the returned promise is also abortable
	 * via {@link cancelEncodeAudio}.
	 */
	encodeAudio(
		buffer: Float32Array[] | AudioBuffer,
		format: string,
		opt: Record<string, unknown>,
	): Promise<Blob> {
		this.encoderPromise = new Promise((resolve, reject) => {
			this.worker = createEncoderWorker();
			this.worker.reject = reject;
			this.worker.addEventListener('message', (event) => {
				if (event.data.progress) return this.emit('encodingprogress', event.data.progress);

				if (this.worker) this.worker.terminate();
				this.worker = null;
				resolve(event.data);
			});
			this.worker.addEventListener('error', (err) => {
				if (this.worker && this.worker.terminate) {
					this.worker.terminate();
					this.worker = null;
					console.error('terminated encoding worker wit error', err);
				}
				reject(err);
			});

			this.worker.postMessage({
				buffer,
				format,
				options: opt,
			});
		});
		return this.encoderPromise;
	}
	/** Abort the in-flight encodeAudio worker (rejects with 'CANCELLED'). */
	cancelEncodeAudio() {
		if (!this.worker) return;
		this.worker.reject('CANCELLED');
		this.worker.terminate();
		this.worker = null;
	}
	/** Alias for {@link initMidiDevices}: enable WebMidi and list inputs. */
	initMidi(): Promise<MidiDeviceInfoLike[]> {
		return this.initMidiDevices();
	}
	/**
	 * Enable WebMidi, list the current inputs and subscribe to
	 * connected/disconnected so `mididevices` stays current.
	 * @throws 'MIDI not supported' when WebMidi cannot start.
	 */
	async initMidiDevices(): Promise<MidiDeviceInfoLike[]> {
		try {
			// WebMidi v3: enable() is a promise; the old callback form no longer
			// receives an error (failures reject instead)
			await WebMidi.enable();
		} catch (err) {
			throw 'MIDI not supported';
		}

		this.midiDevices = WebMidi.inputs.map((i) => {
			return {
				deviceId: i.id,
				name: i.name,
				connection: i.connection,
				state: i.state,
				manufacturer: i.manufacturer,
			};
		});

		WebMidi.addListener('connected', (event) => {
			const i = event.port;
			if (i.type === 'output') return;
			const device = {
				deviceId: i.id,
				name: i.name,
				connection: i.connection,
				state: i.state,
				manufacturer: i.manufacturer,
			};
			if (this.midiDevices.filter((d) => d.deviceId === device.deviceId).length) return;
			this.midiDevices.push(device);
			this.emit('mididevices', this.midiDevices);
		});
		WebMidi.addListener('disconnected', (event) => {
			const i = event.port;
			if (i.type === 'output') return;
			const device = {
				deviceId: i.id,
				name: i.name,
				connection: i.connection,
				state: i.state,
				manufacturer: i.manufacturer,
			};
			this.midiDevices = this.midiDevices.filter((d) => d.deviceId !== device.deviceId);
			this.emit('mididevices', this.midiDevices);
		});

		this.emit('mididevices', this.midiDevices);
		return this.midiDevices;
	}
	/**
	 * Listen to one MIDI input device for note on/off (replacing the previous)
	 * and remember it as `lastMidiDevice` for the next init().
	 */
	initMidiSource(midiDeviceId: string): Promise<void> {
		try {
			if (this.midiDevice) {
				this.midiDevice.removeListener('noteon');
				this.midiDevice.removeListener('noteoff');
			}
			this.midiDevice = WebMidi.inputs.filter((d) => d.id === midiDeviceId)[0];
			if (!this.midiDevice) return Promise.reject('MIDI device not found');
			// WebMidi v3: addListener(event, listener, { channels? }) — the old
			// v2 ('noteon', 'all', cb) form would pass 'all' as the listener
			this.midiDevice.addListener('noteon', this.onMidiNoteOn.bind(this));
			this.midiDevice.addListener('noteoff', this.onMidiNoteOff.bind(this));
			this._writeStored('lastMidiDevice', midiDeviceId);
		} catch (err) {
			return Promise.reject(err);
		}

		return Promise.resolve();
	}
	/**
	 * Handle a MIDI note-on: in MIDI-learn mode, bind the note to the sound
	 * waiting for it; otherwise play the mapped sound(s) at that velocity.
	 */
	onMidiNoteOn(e: NoteMessageEvent): void {
		console.log('midi', e.port.name, e.note.number);
		if (this.master.state.midiMapMode) {
			const sound = this.get().filter((s) => s.sound._midiMapMode)[0];
			if (sound) this.mapMidiNote(sound.id, e.note.number);
			this.emitMasterState({
				midiMapMode: false,
			});
			return;
		}
		// webmidi v3: rawVelocity was renamed rawAttack (on the Note object)
		this.playNote(e.note.number, e.note.rawAttack);
		this.emit('noteon', e);
	}
	/** Handle a MIDI note-off (emits `noteoff` with the note number). */
	onMidiNoteOff(e: NoteMessageEvent): void {
		this.emit('noteoff', e.note.number);
	}
	/** Bind a MIDI note to a sound (idempotent; exits MIDI-learn mode). */
	mapMidiNote(id: string, note: number): void {
		if (!this.midiMap[note]) this.midiMap[note] = [];
		if (this.midiMap[note].filter((i) => i === id).length) return; //already mapped

		this.midiMap[note].push(id);

		const sound = this.get(id).sound;
		this.get().forEach((s) => s.sound.midiMapMode(false));
		sound.midiNote(note);
		sound.midiMapMode(false);
	}
	/** Remove the mapping between a sound and a MIDI note. */
	unmapMidiNote(id: string, note: number): void {
		if (this.midiMap[note]) {
			this.midiMap[note] = this.midiMap[note].filter((i) => {
				if (i === id) {
					this.get(id).sound.midiNote(0);
					this.get(id).sound.midiMapMode(false);
					return false;
				}
				return true;
			});
		}
	}
	/** Enter (or leave) MIDI-learn mode for one sound and broadcast the state. */
	midiMapMode(id: string, on: boolean): void {
		this.get().forEach((s) => {
			s.sound.midiMapMode(s.id === id ? on : false);
		});
		this.emitMasterState({
			midiMapMode: on,
		});
	}
	/** Play every sound mapped to `note`, scaling volume by `velocity` (0–127). */
	playNote(note: number, velocity: number): void {
		if (this.midiMap[note]) {
			this.midiMap[note].forEach((id) => {
				const sound = this.get(id).sound;
				const vol = (velocity / 127) * sound._volume;
				sound.play({
					volume: vol,
				});
			});
		}
	}
	/**
	 * Get (creating on first use) the analyser for a sound and type, or the
	 * shared 'input'/'master' analysers. Returns undefined for a cell with no
	 * sound. Subscribe to the result with
	 * `analyser.addEventListener(type, opt, cb)`.
	 *
	 * @param id - sound id, or 'input' / 'master'.
	 * @param type - 'volume' | 'timedomain' | 'frequency'.
	 * @param opt - analyser options (fftSize, cuts, …).
	 */
	analyse(id: string, type: string, opt?: Record<string, unknown>): Analyser | undefined {
		if (id === 'input') return this.inputAnalyser;
		if (id === 'master') return this.outputAnalyser;

		// a grid column can exist with no sound (a model whose cell count is
		// larger than its file list) — nothing to analyse then, and a visual
		// must not crash the app over it
		const sound = this._sound(id);
		if (!sound) return undefined;

		// one analyser per sound+type, reused across mounts (a sound can have a
		// frequency gradient and a volume meter without building two chains)
		const key = id + ':' + type;
		const node = this.analyserNodeFor(id);
		let analyser = this.analyserMap[key];
		if (analyser) {
			analyser.setNode(node);
		} else {
			analyser = new Analyser(id, this.context, node, opt);
			this.analyserMap[key] = analyser;
			this.analysers.push(analyser);
		}
		// meters/gradients of a stopped sound only need to settle, not run
		analyser.setActive(!!sound._playing);
		return analyser;
	}
	/** Idle/resume the analysers of one sound (called on play/stop). */
	setAnalysersActive(id: string, on: boolean): void {
		if (!id) return;
		Object.keys(this.analyserMap).forEach((key) => {
			if (key.slice(0, key.lastIndexOf(':')) === id) this.analyserMap[key].setActive(on);
		});
	}
	/**
	 * The node a per-sound analyser taps: the channel processor when it exists
	 * (post-EQ, post-gain-trim — the last per-sound stage), otherwise the
	 * main-thread volume node. Meters therefore read what the strip is audible
	 * at once the channel strip is in use.
	 */
	analyserNodeFor(id: string): AudioNode | undefined {
		const sound = this._sound(id);
		return sound ? (sound._channelNode || sound.node) : undefined;
	}
	/** Re-point a sound's analysers after its audio node was replaced. */
	setAnalysersNode(id: string, node: AudioNode): void {
		if (!id || !node) return;
		Object.keys(this.analyserMap).forEach((key) => {
			if (key.slice(0, key.lastIndexOf(':')) === id) this.analyserMap[key].setNode(node);
		});
	}
	/**
	 * Release a per-sound analyser created by analyse(). Called from the
	 * Visualizer's unmount so meters/gradients don't accumulate in
	 * `this.analysers` every time a view mounts (the mixer, hovered locked
	 * columns, …). Shared input/output analysers are never touched here, and an
	 * analyser still used by another subscriber is left connected.
	 */
	removeAnalyser(analyser: Analyser): void {
		if (!analyser) return;
		if (analyser === this.outputAnalyser || analyser === this.inputAnalyser) return;
		if (analyser.hasListeners && analyser.hasListeners()) return;
		analyser.destroy();
		this.analysers = this.analysers.filter((a) => a !== analyser);
		Object.keys(this.analyserMap).forEach((key) => {
			if (this.analyserMap[key] === analyser) delete this.analyserMap[key];
		});
	}
	/** Destroy and forget every analyser (per-sound, input and output). */
	destroyAnalysers() {
		this.analysers.forEach((analyser) => {
			analyser.destroy();
		});
		// drop the destroyed references so the arrays can't grow across reloads
		this.analysers = [];
		this.analyserMap = {};
		if (this.inputAnalyser) this.inputAnalyser.destroy();
		if (this.outputAnalyser) this.outputAnalyser.destroy();
	}
	/**
	 * Extract (and cache) interleaved waveform peaks for one sound.
	 * @param spp - samples per peak.
	 * @param opt - `{ start, end, mono, bits }` draw options.
	 */
	extractPeaks(
		id: string,
		spp = 1000,
		opt: { start?: number; end?: number; mono?: boolean; bits?: number } = {},
	): unknown {
		const s: SoundItem = this.get(id);
		const buffer = s.sound.buffer;
		if (!buffer) return null;

		const start =
			opt.start !== undefined ? Math.floor((opt.start / buffer.duration) * buffer.length) : 0;
		const end =
			opt.end !== undefined
				? Math.floor((opt.end / buffer.duration) * buffer.length)
				: buffer.length - 1;
		const mono = opt.mono !== undefined ? opt.mono : true;
		const bits = opt.bits !== undefined ? opt.bits : 8;

		// extractPeaks scans the whole range on the main thread, and the waveform
		// redraws on resize/re-zoom/re-mount with the same params. Cache per
		// sound, keyed by the buffer revision (bumped on load/reverse/crop) and
		// the draw params. Bounded so zooming doesn't grow it without limit.
		const version = s.sound._bufferVersion || 0;
		const key = version + ':' + spp + ':' + mono + ':' + bits + ':' + start + ':' + end;
		if (!s._peaksCache) s._peaksCache = new Map();
		const cached = s._peaksCache.get(key);
		if (cached) return cached;

		s.peaks = extractPeaks(buffer, spp, mono, start, end, bits);
		s._peaksCache.set(key, s.peaks);
		if (s._peaksCache.size > 8) s._peaksCache.delete(s._peaksCache.keys().next().value);
		return s.peaks;
	}
}
export default AudioEngine;
