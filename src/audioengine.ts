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
import { EventEmitter } from 'events';
import ModelManager from './model';
import Automation from './automation';
import type { Effect } from './effects/core';
import type { EffectDefinition } from './effects';
import type {
	AudioEngineOptions,
	MediaDeviceInfoLike,
	MidiDeviceInfoLike,
	ProcessSampleOptions,
} from './types';

/** Result of initInputDevices()/init(). */
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
	processSample: false,
	modelsPath: '/models',
	audioPath: '/audio',
};

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
	_onDeviceChange: (() => void) | null;

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

		// Model/preset I/O (load/save/download .purple.zip + settings snapshots).
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

		// keep the handler so destroy() can detach it (was leaking per engine)
		this._onDeviceChange = () => {
			this.listDevices().then((devices) => {
				this.emit('inputdevices', devices);
			});
		};
		navigator.mediaDevices.addEventListener('devicechange', this._onDeviceChange);
	}
	emitMasterState(opt = {}) {
		if (!Object.keys(opt).length) return;
		this.master.state = { ...this.master.state, ...opt };
		this.emit('masterstate', this.master.state, opt);
	}
	init(lastInput?: string | null, lastMidiInput?: string | null): Promise<InputInitResult> {
		return new Promise((resolve, reject) => {
			return this.initInputDevices(lastInput)
				.then((devices) => {
					resolve(devices);
					this.emit('masterstate', this.master.state);
				})
				.catch((err) => reject(err));
		});
	}
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
	createInputSource(stream: MediaStream, deviceId: string): void {
		this.closeInputStream();

		const device = this.inputDevices.filter((i) => i.deviceId === deviceId)[0];
		this.inputStream = stream;
		this.inputStreamSource = this.context.createMediaStreamSource(this.inputStream);
		if (!this.inputAnalyser)
			this.inputAnalyser = new Analyser('input', this.context, this.inputStreamSource);
		else this.inputAnalyser.setNode(this.inputStreamSource);
		this.inputDeviceId = deviceId;
		localStorage.setItem('lastInputDevice', deviceId);
	}
	closeInputStream() {
		if (this.inputStream) this.inputStream.getAudioTracks().forEach((t) => t.stop());
	}
	initInput(label: string): void {
		const device = this.inputDevices.filter(
			(d) => d.label.toLowerCase().indexOf(label.toLowerCase()) > -1,
		)[0];
		if (device) this.initInputSource(device.deviceId);
	}
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
			...opt,
		});
		// Sound.emitState only ever emits 'state' (never 'state<id>'), so this is
		// the single forwarder that turns it into the per-column engine event
		sound.on('state', (state, updated) => {
			this.emit('state' + id, state, updated);
		});
		sound.on('effectparams', (id, type, opt) => {
			this.emit('effectparams', id, type, opt);
		});
		sound.on('load', () => {
			this.onLoad(id);
			this.master._updateDuration();
		});
		sound.on('change', () => {
			this.emit('change' + id, sound.duration());
			this.emit('change', id, sound.duration());
			this.master._updateDuration();
		});

		sound.on('ready', (id) => {
			const status = {
				total: this.sounds.length,
				ready: this.ready(),
			};
			this.emit('ready', id, status);
		});
		sound.on('rate', () => {
			if (this.enableElapsed) this.master._updateDuration();
		});
		sound.on('playing', (sid, on) => {
			const isPlaying = this.master.isPlaying();
			this.emitMasterState({
				playing: isPlaying,
			});
			// let the master meter settle rather than hard-pausing it, so a
			// delay/reverb tail still shows after the last sound stops
			this.outputAnalyser.setActive(isPlaying);
			this.setAnalysersActive(sid, on === true);
		});
		sound.on('stop', () => {
			const isPlaying = this.master.isPlaying();
			this.emitMasterState({
				playing: this.master.isPlaying(),
			});
			this.outputAnalyser.setActive(isPlaying);
			this.setAnalysersActive(id, false);
		});
		sound.on('elapsed', (elapsed) => {
			this.emit('elapsed' + id, elapsed);
		});
		sound.on('muted', (on) => {});
		sound.on('loopend', (on) => {
			this.emit('loopend' + id, on);
		});
		sound.on('loaderror', (err) => {
			this.emit('loaderror', err, id);
			this.onLoad(id);
		});
		sound.on('loop', (on) => {
			this.emit('loop', id, on);
			this.emit('loop' + id, {
				loop: on,
				loopStart: sound._loopStart,
				loopEnd: sound._loopEnd,
			});
			this.master._updateDuration();
		});
		sound.on('ended', () => {
			this.emit('ended', sound.id);
			this.emit('ended' + sound.id);
			const isPlaying = this.master.isPlaying();
			this.emitMasterState({
				playing: isPlaying,
			});
			this.outputAnalyser.setActive(isPlaying);
		});
		sound.on('solo', (on) => {
			this.emit('solo', sound.id, on);
			this.emitMasterState({
				solo: this.master.solo(),
			});
		});
		this.emit('create', id, sound);
		return sound;
	}
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
		this.emit('add', item.sound.id, item.sound);
		sound.emitState('add', id);

		return item;
	}
	remove(id: string): void {
		const item = this.soundMap[id];
		if (!item) return;
		item.sound.destroy();
		delete this.soundMap[id];
		this.sounds = this.sounds.filter((s) => s.id !== id);
		this.emit('remove', id);
	}
	removeAll() {
		this.sounds.forEach((s) => this.remove(s.id));
	}
	replace(id: string, url: string, filename: string): void {
		this.unload(id);
		const has = this.sounds.some((i) => i.id === id);
		if (!has) {
			// uploading into a column that has no sound yet → create it
			this.add(id, url, filename);
			return;
		}
		const sounds = this.sounds.map((i, idx) => {
			if (i.id === id) {
				const effectParams = i.sound._currentEffectParams();
				i.sound = this.createSound(id, url, filename, i.sound.getSaveState());
				i.sound.load();
				// the sound now owns a brand-new audio node — re-point its
				// analysers, otherwise the meters keep reading the discarded one
				// (e.g. after sampling or uploading into a channel)
				this.setAnalysersNode(id, i.sound.node);
				if (effectParams && effectParams.length)
					effectParams.forEach((e) => this.addEffect(id, e.type, !e.bypassed, e.params));
			}
			return i;
		});
		this.sounds = sounds;
	}
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
	exist(id: string): boolean {
		return this.soundMap[id] !== undefined;
	}
	reset(id: string): void {
		this.get(id).sound.reset();
	}
	ready(): number {
		return this.sounds.filter((s) => s.sound._ready).length;
	}
	load(id?: string): void {
		if (id) this.get(id).sound.load();
		else this.get().forEach((s) => s.sound.load());
	}
	soundForEach(id: string | undefined, fn: (sound: Sound, id: string) => void): void {
		if (id) {
			const item = this.soundMap[id];
			if (item) fn(item.sound, id);
		} else {
			this.get().forEach((item) => fn(item.sound, item.id));
		}
	}
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
	play(id: string, opt?: Record<string, unknown>): void {
		this.soundForEach(id, (sound) => sound.play(opt));
	}
	stop(id?: string): void {
		this.soundForEach(id, (sound) => sound.stop());
	}
	pause(id?: string, on?: boolean): boolean | void {
		if (id) {
			return this.get(id).sound.pause(on);
		}
		this.get().forEach((s) => s.sound.pause(on));
		return on;
	}
	unpause(id: string): void {
		// Sound has no `unpause`; resuming is `pause(false)` (this engine method
		// previously called a non-existent Sound.unpause and would have thrown)
		this.soundForEach(id, (sound) => sound.pause(false));
	}
	loop(
		id?: string,
		on?: boolean,
		offset?: { start?: number; end?: number },
	): boolean | void {
		if (id) {
			return this.get(id).sound.loop(on, offset);
		} else {
			this.sounds.forEach((s) => {
				s.sound.loop(on, offset);
				if (!on) this.stop(s.id);
			});
		}
	}
	loopStart(id: string, offset?: number): number {
		return this.get(id).sound._loopStart;
	}
	loopEnd(id: string, offset?: number): number {
		return this.get(id).sound._loopEnd;
	}
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
	gain(id: string, gain?: number): number | void {
		if (id) {
			const s = this._sound(id);
			return s && s.gain(gain);
		}
		this.get().forEach((s) => s.sound.gain(gain));
	}
	rate(id?: string, rate?: number): void {
		this.soundForEach(id, (sound) => sound.rate(rate));
	}
	/** Tempo-preserving pitch shift, in semitones (0 = original). */
	pitch(id: string, pitch: number): void {
		this.soundForEach(id, (sound) => sound.pitch(pitch));
	}
	mute(id: string, on = true): void {
		this.soundForEach(id, (sound) => sound.mute(on));
	}
	unmute(id: string): void {
		// Sound has no `unmute`; unmuting is mute(false)
		this.soundForEach(id, (sound) => sound.mute(false));
	}
	pan(id: string, deg: number): unknown {
		const s = this._sound(id);
		return s ? s.pan(deg) : undefined;
	}
	duration(id: string): number {
		return this.get(id).sound._duration;
	}
	jump(id: string, sec: number): unknown {
		return this.get(id).sound.jump(sec);
	}
	solo(id: string, on: boolean, multi = true): void {
		this.sounds.forEach((s) => {
			if (s.id === id) s.sound.solo(on, false);
			else s.sound.solo(multi ? s.sound._solo : false, multi ? !s.sound._solo : on);
		});
	}
	lock(id?: string, on?: boolean): boolean | void {
		if (id) {
			const s = this._sound(id);
			return s ? s.lock(on) : undefined;
		}
		this.get().forEach((s) => s.sound.lock(on));
	}
	reverse(id: string, on: boolean): void {
		this.get(id).sound.reverse(on);
	}
	crop(id: string, start: number, end: number): void {
		this.get(id).sound.crop(start, end);
	}
	playing(id: string): boolean {
		return this.get(id).sound._playing;
	}
	toggleplay(id?: string): void {
		if (id) this.get(id).sound._playing ? this.pause(id) : this.play(id);
		else
			this.get().forEach((s) => {
				if (s.sound._playing) this.pause(id);
				else this.play(s.id);
			});
	}
	togglemute(id?: string): void {
		if (id) this.get(id).sound.mute() ? this.mute(id) : this.unmute(id);
		else
			this.get().forEach((s) => {
				if (s.sound.mute()) this.unmute(id);
				else this.mute(s.id);
			});
	}
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
	get(id?: string): SoundItem | SoundItem[] {
		if (!id) return this.sounds;
		if (!this.soundMap[id]) throw new Error("ID '" + id + "' doesn't exist!");

		return this.soundMap[id];
	}
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

			if (this._onDeviceChange)
				navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);
			this.removeAllListeners();
			this.closeInputStream();
		}
	}

	// ---- models & presets: thin facade over ModelManager -----------------
	get models() {
		return this.modelManager.models;
	}
	get presets() {
		return this.modelManager.presets;
	}
	get model() {
		return this.modelManager.model;
	}
	loadModels() {
		return this.modelManager.loadModels();
	}
	loadModel(name: string, zipContent?: ArrayBuffer) {
		// a new model replaces every sound (and its ids/effects) — a take from
		// the previous model would be meaningless
		this.automation.clear();
		return this.modelManager.loadModel(name, zipContent);
	}
	loadModelFromFile(file: File, onProgress?: (e: ProgressEvent<FileReader>) => void) {
		this.automation.clear();
		return this.modelManager.loadModelFromFile(file, onProgress);
	}
	createModel(name: string, cols: number, rows: number) {
		this.automation.clear();
		return this.modelManager.createModel(name, cols, rows);
	}
	saveModel(name?: string) {
		return this.modelManager.saveModel(name);
	}
	downloadModel(name?: string) {
		return this.modelManager.downloadModel(name);
	}
	downloadSound(id: string) {
		return this.modelManager.downloadSound(id);
	}
	download(blob: Blob, filename: string) {
		return this.modelManager.download(blob, filename);
	}
	savePreset(name?: string) {
		return this.modelManager.savePreset(name);
	}
	restorePreset(index: number) {
		return this.modelManager.restorePreset(index);
	}
	randomizePreset(index?: number) {
		return this.modelManager.randomizePreset(index);
	}
	hasPreset(index: number) {
		return this.modelManager.hasPreset(index);
	}
	clearPresets() {
		return this.modelManager.clearPresets();
	}

	/** Build one effect instance (used by Sound._materialize for lazy effects). */
	createEffectInstance(type: string, opt?: Record<string, unknown>): Promise<Effect> {
		return createEffect(type, this.context, opt);
	}
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
	removeEffect(id: string, idx: number): unknown {
		return this.get(id).sound.removeEffect(idx);
	}
	moveEffect(id: string, idx: number, toIdx: number): unknown {
		return this.get(id).sound.moveEffect(id, idx, toIdx);
	}
	effectBypass(id: string, idx: number, on: boolean): unknown {
		return this.get(id).sound.effectBypass(idx, on);
	}
	effectParams(id: string, idx?: number, params?: Record<string, unknown>): unknown {
		const s = this._sound(id);
		return s ? s.effectParams(idx, params) : undefined;
	}
	disableEffects(id: string): void {
		this.get(id).sound.disableEffects();
	}
	enableEffects(id: string): void {
		this.get(id).sound.enableEffects();
	}
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

	playSound(url: string, opt: Record<string, any> = {}): Sound {
		const sound = new Sound(String(Date.now()), url, this, {
			filename: 'Temp.wav',
			...opt,
		});
		/*
		this.masterGain = typeof this.context.createGain === 'undefined' ? this.context.createGainNode() : this.context.createGain();
		this.masterGain.gain.value = this._volume;
		this.masterGain.connect(this.context.destination);
		*/
		return sound;
	}

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
	cancelRecord() {
		this.masterRecorder.cancel();
		this.recording = false;
		this.emit('recording', false);
		this.emitMasterState({
			recording: false,
		});
	}
	sample(id: string, start: boolean): Promise<unknown> | void {
		if (!this.inputStreamSource) return Promise.reject('No audio input source selected');

		if (start) {
			this.stop(id);
			return this.sampleRecorder
				.record(this.inputStreamSource, id)
				.then((recording: { url: string; filename: string }) => {
					const sound = this.get(id) ? this.get(id).sound : null;
					if (!sound) return console.error('NO SOUND there anymore', id);

					this.replace(id, recording.url, recording.filename);
					return recording;
				})
				.catch((err) => {
					console.error(err);
					throw err;
				});
		} else {
			this.sampleRecorder.stop();
		}
		return;
	}
	cancelSample(id: string): void {
		this.sampleRecorder.cancel();
		this.sampling = false;
		this.emit('sampling', id, false);
		if (this.get(id).sound) this.get(id).sound.sampling(false);
		this.emitMasterState({
			sampling: false,
		});
	}

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
	cancelEncodeAudio() {
		if (!this.worker) return;
		this.worker.reject('CANCELLED');
		this.worker.terminate();
		this.worker = null;
	}
	initMidi(): Promise<MidiDeviceInfoLike[]> {
		return this.initMidiDevices();
	}
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
	initMidiSource(midiDeviceId: string): Promise<void> {
		try {
			if (this.midiDevice) {
				this.midiDevice.removeListener('noteon');
				this.midiDevice.removeListener('noteoff');
			}
			this.midiDevice = WebMidi.inputs.filter((d) => d.id === midiDeviceId)[0];
			// WebMidi v3: addListener(event, listener, { channels? }) — the old
			// v2 ('noteon', 'all', cb) form would pass 'all' as the listener
			this.midiDevice.addListener('noteon', this.onMidiNoteOn.bind(this));
			this.midiDevice.addListener('noteoff', this.onMidiNoteOff.bind(this));
		} catch (err) {
			return Promise.reject(err);
		}

		return Promise.resolve();
	}
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
	onMidiNoteOff(e: NoteMessageEvent): void {
		this.emit('noteoff', e.note.number);
	}
	mapMidiNote(id: string, note: number): void {
		if (!this.midiMap[note]) this.midiMap[note] = [];
		if (this.midiMap[note].filter((i) => i === id).length) return; //already mapped

		this.midiMap[note].push(id);

		const sound = this.get(id).sound;
		this.get().forEach((s) => s.sound.midiMapMode(false));
		sound.midiNote(note);
		sound.midiMapMode(false);
	}
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
	midiMapMode(id: string, on: boolean): void {
		this.get().forEach((s) => {
			s.sound.midiMapMode(s.id === id ? on : false);
		});
		this.emitMasterState({
			midiMapMode: on,
		});
	}
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
	analyse(
		id: string,
		type: string,
		opt?: Record<string, unknown>,
		cb?: (data: unknown, options: unknown) => void,
	): Analyser | undefined {
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
		let analyser = this.analyserMap[key];
		if (analyser) {
			analyser.setNode(sound.node);
		} else {
			analyser = new Analyser(id, this.context, sound.node, opt);
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
