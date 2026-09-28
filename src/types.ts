/**
 * Lightweight typed facade over the JS audio engine (lib/audio/audioengine.ts).
 * Only the surface the React app calls is declared; the engine itself stays
 * untyped JavaScript. Signature details are intentionally loose (the engine's
 * own types are whatever the Web Audio API yields) — the point is that
 * components no longer cross an `any` boundary, so typos in engine method
 * names/args are caught by tsc.
 */

/** One editable parameter of an effect, as declared in the engine catalog. */
export interface EffectParamDef {
	value: number | boolean;
	max: number | boolean;
	min: number | boolean;
	type: 'integer' | 'float' | 'boolean' | string;
	/** User-facing display name for this parameter. */
	name: string;
}

/** A catalog entry (engine.effects → EFFECTS): what can be added to a chain. */
export interface EffectDef {
	id: string;
	name: string;
	defaults: Record<string, EffectParamDef>;
}

/** One effect in a sound's chain (engine `state<id>` → `effects[]`). */
export interface EffectEntry {
	idx: number;
	id: string;
	type: string;
	bypassed: boolean;
	params: Record<string, number | boolean>;
	defaults: Record<string, EffectParamDef>;
}

/** Per-sample processing applied to recordings (trim/normalize/fade). */
export interface ProcessSampleOptions {
	trim?: boolean;
	normalize?: boolean;
	fade?: boolean;
}

/** Options accepted by the AudioEngine constructor (see Studio). */
export interface AudioEngineOptions {
	/** AudioContext sample rate; omit to use the device default. */
	sampleRate?: number;
	/** Number of output channels (stored, used by ads/analysers). */
	channels?: number;
	/** Initial master volume (0–1). */
	volume?: number;
	/** Legacy Electron flag (unused in the web build). */
	electron?: boolean;
	/** Create output/input analysers at startup. */
	enableAnalysers?: boolean;
	/** Enable loop support on every sound. */
	enableLoops?: boolean;
	/** Track playback elapsed time per sound. */
	enableElapsed?: boolean;
	/**
	 * Warm the Signalsmith Stretch pitch shifter at startup: load its module and
	 * pre-create the per-sound node, so the first pitch change doesn't pay the
	 * dynamic module load. The node is still only connected while pitch ≠ 0, so
	 * there is no latency/CPU cost until a sound is actually pitched. Defaults to
	 * true; set false for many-voice / headless workloads that never pitch.
	 */
	preloadPitch?: boolean;
	/** Trim/normalize recorded samples; `false` disables processing. */
	processSample?: boolean | ProcessSampleOptions;
	/** Base path model zips/index.json are fetched from (default '/models'). */
	modelsPath?: string;
	/** Base path a model's audio files are served from (default '/audio'). */
	audioPath?: string;
}

/** A microphone as enumerated by `navigator.mediaDevices` (structural copy). */
export interface MediaDeviceInfoLike {
	deviceId: string;
	label: string;
	groupId: string;
	kind: string;
}

/** A MIDI input as reported by WebMidi (structural copy). */
export interface MidiDeviceInfoLike {
	deviceId: string;
	name: string;
	connection: string;
	state: string;
	manufacturer: string;
}

/**
 * Per-capability outcome of {@link AudioEngine.init}. `'ok'` and `'skipped'`
 * are successful; `'denied'`/`'unsupported'`/`'error'` describe why a requested
 * capability did not come up.
 */
export type InitStatus = 'ok' | 'skipped' | 'denied' | 'unsupported' | 'error';

/** Result of initializing the microphone input (one feature of `init`). */
export interface InputInitStatus {
	status: InitStatus;
	/** Inputs enumerated so far (labels may be blank before permission). */
	devices: MediaDeviceInfoLike[];
	/** Device id that was opened, when one was. */
	selected?: string;
	/** The underlying failure (permission error, …) for denied/error. */
	error?: unknown;
}

/** Result of initializing MIDI (one feature of `init`). */
export interface MidiInitStatus {
	status: InitStatus;
	/** MIDI inputs found. */
	devices: MidiDeviceInfoLike[];
	/** Device id that was attached for note input, when one was. */
	selected?: string;
	/** The underlying failure for unsupported/error. */
	error?: unknown;
}

/** Combined result of {@link AudioEngine.init}. */
export interface InitResult {
	/** AudioContext state after the bootstrap (`resumed` is true when running). */
	context: { state: AudioContextState; resumed: boolean };
	/** Present only when `input` was requested. */
	input?: InputInitStatus;
	/** Present only when `midi` was requested. */
	midi?: MidiInitStatus;
}

/** Options for {@link AudioEngine.init}. Everything is opt-in. */
export interface InitOptions {
	/** Initialize the microphone: `true`, `{ deviceId }`, or `false` (default). */
	input?: boolean | { deviceId?: string };
	/** Initialize MIDI: `true`, `{ deviceId }`, or `false` (default). */
	midi?: boolean | { deviceId?: string };
	/** Restore the last-used device ids from localStorage (default true). */
	restore?: boolean;
	/** Also resume the AudioContext (default false; must be a user gesture). */
	resume?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The subset of the engine's EventEmitter surface used by components. */
export interface AudioEngineEvents {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	on(event: string, listener: (...args: any[]) => void): AudioEngine;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	off(event: string, listener: (...args: any[]) => void): AudioEngine;
	emit(event: string, ...args: unknown[]): boolean;
}

/** Transport controller (engine.master) as used by the app. */
export interface MasterLike {
	state: Record<string, Any>;
	play(opt?: { enableElapsed?: boolean }): void;
	stop(): void;
	pause(on: boolean): void;
	mute(on: boolean): void;
	muted(): boolean;
	loop(on?: boolean): Any;
	volume(vol?: number): Any;
	locked(on?: boolean): Any;
	reset(): void;
}

/** Engine automation recorder (record every state change, loop it back). */
export interface AutomationLike {
	/** Currently recording? */
	readonly recording: boolean;
	/** Currently looping playback? */
	readonly playing: boolean;
	/** Number of captured changes. */
	readonly count: number;
	/** Toggle/arm recording (R). */
	record(on?: boolean): boolean;
	/** Toggle/arm looped playback (L). */
	play(on?: boolean): boolean;
	/** Stop everything and drop the take. */
	clear(): void;
}

/** A Sound wrapper as seen by the app (engine.sounds / playSound results). */
export interface SoundLike {
	id: string;
	url: string;
	filename?: string;
	mimeType?: string;
	_loaded?: boolean;
	_buffer?: ArrayBuffer | null;
	sound: {
		[key: string]: Any;
		load(url?: string): void;
		play(opt?: Record<string, unknown>): void;
		stop(): void;
		volume(v?: number): Any;
		on(event: string, listener: Any): Any;
		off(event: string, listener: Any): Any;
		destroy(): void;
	};
}

/**
 * The engine's app-facing surface. Implemented by the concrete `AudioEngine`
 * class and asserted against it at compile time in `contract.ts`, so the two
 * cannot drift.
 */
export interface AudioEngine extends AudioEngineEvents {
	master: MasterLike;
	/** Records engine state changes and loops them back (R / L shortcuts). */
	automation: AutomationLike;
	context: AudioContext;
	sounds: SoundLike[];
	soundMap: Record<string, SoundLike>;
	sampleRate: number;
	effects: EffectDef[];
	/** Encode raw PCM (or an AudioBuffer) to a wav/mp3 Blob in a worker. */
	encodeAudio(
		buffer: Float32Array[] | AudioBuffer,
		format: 'wav' | 'mp3',
		opt?: Record<string, unknown>,
	): Promise<Blob>;
	/** Abort the in-flight encodeAudio (rejects with 'CANCELLED'). */
	cancelEncodeAudio(): void;
	/**
	 * Initialize the engine in one call. Features are opt-in (`input`/`midi`
	 * default to `false`, so nothing prompts unless asked) and isolated: a
	 * denied/unsupported capability resolves with a per-feature status rather
	 * than rejecting. Optionally resumes the AudioContext and restores the
	 * last-used devices.
	 */
	init(options?: InitOptions): Promise<InitResult>;
	/** Resume a suspended AudioContext; must be called from a user gesture. */
	resume(): Promise<AudioContextState>;
	initInputDevices(
		lastDeviceId?: string | null,
	): Promise<{ devices?: MediaDeviceInfoLike[]; selected?: string }>;
	initInputSource(deviceId: string): Promise<unknown>;
	initMidi(): Promise<MidiDeviceInfoLike[]>;
	initMidiSource(deviceId: string): Promise<unknown>;
	listDevices(): Promise<MediaDeviceInfoLike[]>;
	listMidiDevices(): Promise<MidiDeviceInfoLike[]>;
	createInputSource(stream: MediaStream, deviceId: string): void;
	add(
		id: string,
		url: string | null,
		filename?: string | null,
		opt?: Record<string, unknown>,
	): SoundLike;
	addEffect(
		id: string,
		type: string,
		bypass?: boolean,
		opt?: Record<string, unknown>,
	): Promise<Any>;
	removeEffect(id: string, idx: number): Any;
	moveEffect(id: string, idx: number, toIdx: number): Any;
	remove(id: string): void;
	replace(id: string, url: string, filename: string): void;
	load(id?: string): void;
	unload(id?: string): void;
	get(): SoundLike[];
	get(id: string): SoundLike;
	play(id: string, opt?: Record<string, unknown>): void;
	pause(id?: string, on?: boolean): Any;
	stop(id?: string): void;
	exist(id: string): boolean;
	mute(id: string, on?: boolean): void;
	unmute(id: string): void;
	solo(id: string, on: boolean, multi?: boolean): void;
	lock(id: string, on?: boolean): Any;
	reverse(id: string, on: boolean): void;
	volume(id: string, vol?: number): Any;
	pan(id: string, deg: number): Any;
	rate(id: string, rate: number): void;
	/** Tempo-preserving pitch shift, in semitones (0 = original, ±24 = ±2 octaves). */
	pitch(id: string, pitch: number): void;
	loop(id: string, on: boolean, offset?: Record<string, number>): Any;
	effectBypass(id: string, idx: number | string, on: boolean): Any;
	/** With no `idx` returns the whole chain (Sound._currentEffectParams()). */
	effectParams(id: string, idx?: number | string, params?: Record<string, Any>): Any;
	enableEffects(id: string): void;
	disableEffects(id: string): void;
	midiMapMode(id: string, on: boolean): void;
	unmapMidiNote(id: string, note?: number): void;
	record(start: boolean): Promise<Any> | Any;
	sample(id: string, start: boolean): Promise<Any> | Any;
	cancelSample(id: string): void;
	playSound(url: string, opt?: Record<string, unknown>): RawSound;
	analyse(id: string, type: string, opt?: Record<string, Any>): Any;
	removeAnalyser(analyser: Any): void;
	extractPeaks(id: string, spp?: number, opt?: Record<string, Any>): Any;
	reset(id: string): void;
	destroy(force?: boolean): void;

	// ---- models & presets (ModelManager) ----
	models: ModelMeta[];
	presets: PresetSlot[];
	model: Model | null;
	loadModels(): Promise<ModelMeta[]>;
	loadModel(name: string, zipContent?: ArrayBuffer): Promise<Model | undefined>;
	loadModelFromFile(
		file: File,
		onProgress?: (e: ProgressEvent<FileReader>) => void,
	): Promise<Model>;
	createModel(name: string, cols: number, rows: number): Model;
	saveModel(name?: string): Promise<{ blob: Blob; model: Model } | null>;
	downloadModel(name?: string): Promise<Model | undefined>;
	downloadSound(id: string): void;
	download(blob: Blob, filename: string): void;
	savePreset(name?: string): Preset;
	restorePreset(index: number): void;
	randomizePreset(index?: number): Preset;
	hasPreset(index: number): boolean;
	clearPresets(): void;
}

/**
 * A `Sound` as returned by `playSound()` before it is registered as a grid
 * item — the same object, but the app only relies on this fire-and-forget
 * subset (play/stop/volume + events).
 */
export interface RawSound {
	id?: string;
	load(url?: string): void;
	play(opt?: Record<string, unknown>): void;
	stop(): void;
	volume(v?: number): Any;
	on(event: string, listener: Any): Any;
	off(event: string, listener: Any): Any;
	once?(event: string, listener: Any): Any;
	destroy(): void;
	[key: string]: Any;
}
/**
 * Model/preset data shapes shared by the engine (lib/audio) and the React app.
 *
 * A "model" is a saved grid of sampler cells (.zip): an index.json plus
 * the audio files. `presets` snapshots the live settings of every sound so a
 * whole grid state can be restored with one call. Presets are slot-addressed:
 * one slot per number key (1-9, then 0), `null` for an empty slot. Old files
 * (no `version` / `presets`) load transparently as v1 with no presets.
 */

/** One effect's serialized state (defaults intentionally omitted to stay small). */
export interface EffectSnapshot {
	idx: number;
	type: string;
	bypassed: boolean;
	params: Record<string, number | boolean>;
}

/** The live settings of a single sound (superset of Sound.getSaveState()). */
export interface SoundSettings {
	volume?: number;
	rate?: number;
	/** Tempo-preserving pitch shift in semitones (0 = original). */
	pitch?: number;
	pan?: number;
	panX?: number;
	panZ?: number;
	panWidth?: number;
	loop?: boolean;
	loopStart?: number;
	loopEnd?: number;
	solo?: boolean;
	locked?: boolean;
	muted?: boolean;
	paused?: boolean;
	pausedAt?: number;
	/** @deprecated legacy key from before the `paused` rename; read for compat only. */
	pause?: boolean;
	reversed?: boolean;
	effectsEnabled?: boolean;
	effects?: EffectSnapshot[];
}

/** A sound's settings plus the grid id they belong to (one preset entry). */
export interface PresetSound extends SoundSettings {
	id: string;
}

/** A saved snapshot of every sound in the current model. */
export interface Preset {
	/** Creation timestamp (ms). */
	at: number;
	/** Optional user-facing name. */
	name?: string;
	/** One entry per sound at the time the preset was taken. */
	sounds: PresetSound[];
}

/** One preset slot: a snapshot, or `null` when the slot is still empty. */
export type PresetSlot = Preset | null;

/** One audio file entry inside a model's index.json. */
export interface ModelFile {
	filename: string;
	mimeType?: string;
	params?: SoundSettings;
	/** Runtime only — never serialized to index.json (the bytes live in the zip). */
	buffer?: ArrayBuffer;
}

/** A loaded model (grid of sounds): the shape of index.json plus buffers. */
export interface Model {
	name: string;
	/** Model format version; absent in legacy files (treated as 1). */
	version?: number;
	cols: number;
	rows: number;
	files: ModelFile[];
	presets?: PresetSlot[];
	contentLength?: number;
	/** True for an in-memory model that has not been saved as a zip yet. */
	new?: boolean;
}

/** The lightweight entry from /models/index.json (drives the model dropdown). */
export interface ModelMeta {
	name: string;
	cols?: number;
	rows?: number;
}
