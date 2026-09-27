import { arrayMoveImmutable, reverse, slice } from './utils';
import { EventEmitter } from 'events';
import type { Effect, EffectDefaults } from './effects/core';
import type AudioEngine from './audioengine';

/** Options accepted by Sound.play() (callers may pass extras via the index sig). */
interface PlayOptions {
	start?: number;
	duration?: number;
	enableElapsed?: boolean;
	noStop?: boolean;
	fadeIn?: number;
	fadeOut?: number;
	fadeType?: string;
	volume?: number;
	[key: string]: unknown;
}

/** Minimal shape of the Signalsmith Stretch node used by the pitch shifter. */
interface StretchLike {
	start?: () => void;
	schedule?: (opt: { semitones: number; active: boolean }) => unknown;
	disconnect?: () => void;
}

/** Sound settings defaults, mirrored as `_<key>` fields on the instance. */
interface SoundDefaults {
	url: string | null;
	rate: number;
	pitch: number;
	volume: number;
	gain: number;
	duration: number;
	pan: number;
	panWidth: number;
	panX: number;
	panZ: number;
	loop: boolean;
	loopStart: number;
	loopEnd: number;
	sampling: boolean;
	solo: boolean;
	locked: boolean;
	paused: boolean;
	pausedAt: number;
	loaded: boolean;
	loading: boolean;
	ready: boolean;
	playing: boolean;
	muted: boolean;
	midiNote: number;
	midiMapMode: boolean;
	reversed: boolean;
	effectsEnabled: boolean;
	elapsed: number;
	error: unknown;
}

/** One slot in a sound's effect chain (`Sound.effects`). */
interface EffectSlot {
	id: string;
	type: string;
	effect: Effect | null;
	bypassed: boolean;
	idx: number;
	defaults: EffectDefaults;
	/** Pending (not-yet-materialized) params for lazily-created effects. */
	values?: Record<string, any>;
	creating?: boolean;
	connected?: boolean;
}

/** Serialized shape of one effect (effectParams()/state.effects entries). */
interface EffectParamEntry {
	idx: number;
	id: string;
	type: string;
	bypassed: boolean;
	params: Record<string, number | boolean>;
	defaults: EffectDefaults;
}

const defaults: SoundDefaults = {
	url: null,
	rate: 1.0,
	pitch: 0,
	volume: 0.5,
	gain: 0.0,
	duration: 0,
	pan: 0,
	panWidth: 50,
	panX: 0,
	panZ: 0,
	loop: false,
	loopStart: 0,
	loopEnd: 0,
	sampling: false,
	solo: false,
	locked: false,
	paused: false,
	pausedAt: 0,
	loaded: false,
	loading: false,
	ready: false,
	playing: false,
	muted: false,
	midiNote: 0,
	midiMapMode: false,
	reversed: false,
	effectsEnabled: true,
	elapsed: 0,
	error: null,
};

// State events that can change the effect chain. `effects` is only included in
// the state payload for these, so the many scalar writes (volume/pan/mute/
// elapsed/…) don't rebuild/carry the chain snapshot or force chain-UI re-renders.
const EFFECT_STATE_EVENTS = new Set([
	'addeffect',
	'removeeffect',
	'moveeffect',
	'effectbypass',
	'effectparams',
	'effectsenabled',
	'reset',
	'add',
	'load',
]);

/**
 * Constructor options for a Sound. `Record<string, any>` intentionally allows
 * the saved settings blob (SoundSettings) to be spread in on load.
 */
export interface SoundOptions extends Record<string, any> {
	filename?: string | null;
	local?: boolean;
	enableLoops?: boolean;
	enableMeter?: boolean;
	enableElapsed?: boolean;
}

class Sound extends EventEmitter {
	DEBUG: boolean;
	id: string;
	engine: AudioEngine;
	context: AudioContext;
	sampleRate: number;
	node: GainNode;
	buffer: AudioBuffer | null;
	enableLoops: boolean;
	enableMeter: boolean;
	enableElapsed: boolean;
	effects: EffectSlot[];
	spillOver: boolean;
	panner: PannerNode;
	fadeNode: GainNode;
	source: AudioBufferSourceNode | null;
	effectsInputNode: GainNode;
	effectsOutputNode: GainNode;
	chain: AudioNode[];
	elapseTimeout: NodeJS.Timeout | null;
	fadeInTimeout: NodeJS.Timeout | null;
	fadeOutTimeout: NodeJS.Timeout | null;
	_buffer: ArrayBuffer | null;
	_org_buffer: ArrayBuffer | null;
	_filename: string;
	_mimeType: string | null;
	_url: string | null;
	_connected: boolean;
	_effectsCache: EffectParamEntry[] | null;
	_effectsEnabled: boolean;
	_pitchNode: AudioWorkletNode | null;
	_pitchNodeFailed: boolean;
	_pitchActive: boolean;
	_stretch: StretchLike | null;
	_pitchPending: boolean;
	_loopFadeDur: number;
	_loopTimer: ReturnType<typeof setInterval> | null;
	_cycle: number;
	_nextWrap: number;
	_fadeScheduledUntil: number;
	_fadeActive: boolean;
	_bufferVersion: number;
	_destroyed: boolean;
	_offset: number;
	_startedAt: number;
	_elapsed: number;
	_duration: number;
	_loaded: boolean;
	_loading: boolean;
	_ready: boolean;
	_error: unknown;
	_playing: boolean;
	_paused: boolean;
	_pausedAt: number;
	_muted: boolean;
	_mutedVol: number;
	_solo: boolean;
	_soloOn: boolean;
	_locked: boolean;
	_loop: boolean;
	_loopStart: number;
	_loopEnd: number;
	_rate: number;
	_pitch: number;
	_volume: number;
	_gain: number;
	_pan: number;
	_panWidth: number;
	_panX: number;
	_panZ: number;
	_sampling: boolean;
	_midiNote: number;
	_midiMapMode: boolean;
	_reversed: boolean;
	_reverse: boolean | undefined;
	_id: string;
	_clearElapsedEnded: () => void | null;

	constructor(
		id: string,
		url: string | null,
		engine: AudioEngine,
		opt: SoundOptions = {
			filename: null,
			local: false,
			enableLoops: false,
			enableMeter: false,
			enableElapsed: false,
		},
	) {
		super();
		this.DEBUG = true;
		Object.keys(defaults).forEach(
			(k) =>
				((this as any)['_' + k] =
					opt[k] !== undefined
						? opt[k]
						: (defaults as unknown as Record<string, unknown>)[k]),
		);
		this.id = id;
		this.engine = engine;
		this.context = engine.context;
		this.sampleRate = this.context.sampleRate;
		this.node = this.context.createGain();
		this.buffer = null;
		this._buffer = null;
		this._org_buffer = null;
		// bumped whenever the PCM changes (load/reverse/crop) so cached peaks
		// (AudioEngine.extractPeaks) are invalidated
		this._bufferVersion = 0;
		this._filename = opt.filename
			? opt.filename
			: this._url
				? this._url.substring(this._url.lastIndexOf('/') + 1)
				: opt.filename;
		this._mimeType = this.urlToMimeType(this._filename);
		this._url = url;
		this.enableLoops = opt.enableLoops;
		this.enableMeter = opt.enableMeter;
		this.enableElapsed = opt.enableElapsed;
		this.node.gain.setValueAtTime(this._volume, this.context.currentTime);
		(this.node as any).paused = true; // legacy marker, not part of GainNode
		this.effects = [];
		// cached result of _currentEffectParams() — invalidated by every effect
		// mutation so high-frequency param writes (mouse moves) don't re-map the
		// whole chain and re-read every effect's params on each state emit
		this._effectsCache = null;
		this.spillOver = true;
		// createPanner takes no options; 'equalpower' is already the default
		this.panner = this.context.createPanner();
		// dedicated gain for the loop-boundary fade envelope — kept separate
		// from node.gain (volume/mute) so they never fight each other
		this.fadeNode = this.context.createGain();
		this.fadeNode.gain.value = 1;
		this._loopFadeDur = 0.006;
		// one interval drives both the look-ahead fade envelope and the loopend
		// events (previously a setInterval + a separate setTimeout that had to be
		// torn down and recreated on every rate change)
		this._loopTimer = null;
		this._cycle = 0;
		this._nextWrap = 0;
		this._fadeScheduledUntil = 0;
		this._fadeActive = false;
		this.source = null;
		this.effectsInputNode = this.context.createGain();
		this.effectsOutputNode = this.context.createGain();
		this.chain = [];
		// tempo-preserving pitch shifter (Signalsmith Stretch) inserted between
		// the source and the effects; created lazily and bypassed at 0
		// semitones so it costs nothing when unused
		this._pitchNode = null;
		this._pitchNodeFailed = false;
		this._pitchActive = Math.abs(this._pitch || 0) > 0.01;
		this._stretch = null;
		this._pitchPending = false;
		this.onEnded = this.onEnded.bind(this);
	}
	play(options: Partial<PlayOptions> = {}) {
		const opt: PlayOptions = {
			start: 0,
			duration: 0,
			enableElapsed: false,
			noStop: false,
			fadeIn: 0,
			fadeOut: 0,
			fadeType: 'linear',
			...options,
		};

		if (!this._ready || !this.buffer || this._sampling) return;

		if (this._paused) return this.pause(false);

		if (this.source) {
			this.source.removeEventListener('ended', this.onEnded);
			this._clearLoopScheduler();
		}

		if (this._playing && this.source) this.source.stop();

		const soloOn = this.engine.master.solo();

		this.source = this.context.createBufferSource();
		this.source.buffer = this.buffer;

		if (!this._muted && (soloOn ? this._solo : true)) this._connectChain();

		const ct = this.context.currentTime;
		this._offset = Math.max(0, opt.start || this._pausedAt || this._loopStart || 0);
		this.source.loop = this._loop;
		this.source.loopStart = Math.max(0, this._loopStart || this.source.loopStart || 0);
		this.source.loopEnd = Math.max(0, this._loopEnd || this.source.loopEnd || 0);
		this.source.playbackRate.value = this._rate;
		this.source.addEventListener('ended', this.onEnded);

		if (opt.volume !== undefined)
			this.node.gain.setValueAtTime(opt.volume, this.context.currentTime + 0.005); // this.volume(opt.volume)

		this.source.start(0, this._offset); //, opt.duration && !this._loop ? opt.duration : this._duration - this._offset);

		if (opt.fadeIn !== undefined && opt.fadeIn !== 0.0)
			this.fadeIn(opt.fadeIn, opt.fadeType, 0.00001, opt.volume || this._volume);
		if (opt.fadeOut !== undefined && opt.fadeOut !== 0.0 && !this._loop)
			this.fadeOut(opt.fadeOut, opt.fadeType, 0.00001, opt.duration || this._duration);

		this._startedAt = this.context.currentTime;
		this._playing = true;
		this._emit('playing', true);
		this._startLoopScheduler();

		if (this.enableElapsed || opt.enableElapsed) {
			this._clearElapsed();
			// a looping buffer never fires 'ended', so a fresh once() per play
			// would pile up listeners (MaxListenersExceededWarning) — swap the
			// previous one instead of adding yet another
			if (this._clearElapsedEnded) this.removeListener('ended', this._clearElapsedEnded);
			this._clearElapsedEnded = () => this._clearElapsed();
			this.once('ended', this._clearElapsedEnded);
			this.emit('elapsed', this._offset);
			this._checkElapsed();
		}
		//console.log('play', this._offset, 'muted', this._muted, 'loop', this._loopStart + ' > ' + this._loopEnd, 'dur=', opt.duration, opt.fadeIn, opt.fadeOut)
	}
	_connectChain() {
		if (!this.source) return;

		this._disconnectChain();
		const effects = this.effects;
		// source or effect — both expose `.connect()`
		type ChainNode = { connect(node: AudioNode): unknown };
		let lastOutput: ChainNode = this.source as unknown as ChainNode;
		// pitch shifter first so the effects process the transposed signal
		if (this._pitchActive && !this._pitchNode) this._ensurePitchNode();
		if (this._pitchActive && this._pitchNode) {
			lastOutput.connect(this._pitchNode);
			lastOutput = this._pitchNode;
		}
		effects
			// `e.effect` is null while a lazily-added effect is still bypassed
			.filter((e) => !e.bypassed && e.effect)
			.forEach((e) => {
				const effect = e.effect as Effect;
				lastOutput.connect(effect.inputNode);
				lastOutput = effect;
			});
		lastOutput.connect(this.node);
		this.node.connect(this.fadeNode);
		this.fadeNode.connect(this.panner);
		this.panner.connect(this.engine.masterGain);
		this._connected = true;
	}
	_disconnectChain() {
		if (this._connected) {
			const effects = this.effects;
			this.source.disconnect();
			if (this._pitchNode) {
				try {
					this._pitchNode.disconnect();
				} catch (e) {}
			}
			effects.forEach((e) => {
				if (e.effect) e.effect.disconnect();
			});
			this.node.disconnect(this.fadeNode);
			this.fadeNode.disconnect(this.panner);
			this.panner.disconnect(this.engine.masterGain);
		}
		this._connected = false;
	}
	addEffect(type: string, eff: Effect, bypass?: boolean): EffectParamEntry {
		const idx = this.effects.length;
		const effect: EffectSlot = {
			id: type,
			type: type,
			effect: eff,
			bypassed: true,
			idx: idx,
			defaults: eff.defaults,
		};
		this.effects.push(effect);
		this._invalidateEffects();

		this._emit('addeffect', type, idx);
		this.effectBypass(idx, bypass);
		return this._currentEffectParams(idx) as EffectParamEntry;
	}
	/**
	 * Add a bypassed effect without building its AudioWorkletNode yet. The node
	 * is created on first un-bypass (see _materialize), so models whose effects
	 * are saved bypassed don't pay for idle processors. `values` holds the
	 * params until then so getSaveState/presets stay correct.
	 */
	addPendingEffect(
		type: string,
		defaults: EffectDefaults,
		params?: Record<string, any>,
		bypass?: boolean,
	): EffectParamEntry {
		const idx = this.effects.length;
		const values: Record<string, any> = {};
		Object.keys(defaults).forEach((k) => {
			values[k] =
				params && params[k] !== undefined && params[k] !== null ? params[k] : defaults[k].value;
		});
		this.effects.push({
			id: type,
			type,
			effect: null,
			bypassed: true,
			idx,
			defaults,
			values,
		});
		this._invalidateEffects();

		this._emit('addeffect', type, idx);
		this.effectBypass(idx, bypass);
		return this._currentEffectParams(idx) as EffectParamEntry;
	}
	/** Build the real effect node for a pending entry, then re-apply its params. */
	_materialize(idx: number): void {
		const e = this.effects[idx];
		if (!e || e.effect || e.creating) return;
		e.creating = true;
		this.engine
			.createEffectInstance(e.type, { ...e.values })
			.then((inst: Effect) => {
				e.creating = false;
				// the entry may have been removed/reordered (or the whole sound
				// destroyed) while the node was building — match by identity,
				// not the captured index
				if (this._destroyed || !this.effects.includes(e)) {
					if (inst && inst.disconnect) inst.disconnect();
					return;
				}
				e.effect = inst;
				// apply any param writes that landed while the node was building
				if (e.values)
					Object.keys(e.defaults).forEach((k) => {
						if (e.values[k] !== undefined) inst[k] = e.values[k];
					});
				if (!e.bypassed) this._connectChain();
				this._emit('effectparams', this._currentEffectParams(idx));
			})
			.catch((err: unknown) => {
				e.creating = false;
				console.error('failed to create effect', e.type, err);
			});
	}
	effectBypass(idx: number, bypass?: boolean): EffectSlot {
		if (idx < 0 || idx > this.effects.length - 1 || !this.effects[idx])
			throw new Error('effect not found at idx=' + idx);
		else if (bypass === undefined) return this.effects[idx];
		const e = this.effects[idx];
		e.bypassed = bypass;
		this._invalidateEffects();
		// lazily build the node the first time a pending effect is enabled
		if (!bypass && !e.effect) this._materialize(idx);
		this._connectChain();
		this._emit('effectbypass', idx, bypass);
		return e;
	}
	removeEffect(idx: number): EffectParamEntry | EffectParamEntry[] {
		const effects = this.effects.filter((e, i) => i !== idx);
		effects.forEach((eff, idx) => (eff.idx = idx));
		this.effects = effects || [];
		this._invalidateEffects();
		this._connectChain();
		this._emit('removeeffect', idx);
		return this._currentEffectParams();
	}
	moveEffect(id: string, idx: number, toIdx: number): EffectParamEntry | EffectParamEntry[] {
		this.effects = arrayMoveImmutable(this.effects, idx, toIdx);
		this.effects.forEach((e, idx) => (e.idx = idx));
		this._invalidateEffects();
		this._connectChain();
		// notify the app like add/remove/bypass do — without this the chain
		// order change is invisible to the UI until some other state event fires
		this._emit('moveeffect', idx, toIdx);
		return this._currentEffectParams();
	}

	effectParams(
		idx?: number,
		params?: Record<string, any>,
	): EffectParamEntry | EffectParamEntry[] {
		if (params === undefined && idx === undefined) return this._currentEffectParams();
		if (idx !== undefined && !this.effects[idx]) return {} as EffectParamEntry;
		if (params === undefined && idx !== undefined) return this._currentEffectParams(idx);

		const e = this.effects[idx];
		if (e.effect) {
			Object.keys(e.effect.defaults).forEach((k) => {
				if (params[k] !== undefined) e.effect[k] = params[k];
			});
		} else if (e.values) {
			// pending (not yet materialized): store the values on the entry
			Object.keys(e.defaults).forEach((k) => {
				if (params[k] !== undefined) e.values[k] = params[k];
			});
		}
		this._invalidateEffects();
		const newParams = this._currentEffectParams(idx);
		this._emit('effectparams', newParams);
		return newParams;
	}
	disableEffects() {
		this.effects.forEach((e, idx) => (e.bypassed = true));
		this._invalidateEffects();
		this._connectChain();
		this._effectsEnabled = false;
		this._emit('effectsenabled', false);
	}
	enableEffects() {
		this.effects.forEach((e, idx) => {
			e.bypassed = false;
			// pending entries have no node yet — build them now that they're on
			if (!e.effect) this._materialize(idx);
		});
		this._invalidateEffects();
		this._effectsEnabled = true;
		this._connectChain();
		this._emit('effectsenabled', true);
	}
	fadeIn(time: number, type: string, fromVolume: number, toVolume: number): void {
		this.node.gain.setValueAtTime(fromVolume, this.context.currentTime);
		const endTime = this.context.currentTime + time - 0.001;

		if (type === 'linear') this.node.gain.linearRampToValueAtTime(toVolume, endTime);
		else if (type === 'exponential') this.node.gain.exponentialRampToValueAtTime(toVolume, endTime);
		else if (type === 'logarithmic') this.node.gain.linearRampToValueAtTime(toVolume, endTime);
		else if (type === 'scurve') this.node.gain.linearRampToValueAtTime(toVolume, endTime);

		//console.log('fadein', time, type, fromVolume, toVolume,this.context.currentTime,time)
	}
	fadeOut(time: number, type: string, toVolume: number, offset = 0): void {
		const delay = time > offset ? 0 : offset - time;
		clearTimeout(this.fadeOutTimeout);
		//console.log('fadeout', time, type, toVolume, offset, delay*1000)
		this.fadeOutTimeout = setTimeout(() => {
			const endTime = this.context.currentTime + time;
			if (type === 'linear') this.node.gain.linearRampToValueAtTime(toVolume, endTime);
			else if (type === 'exponential')
				this.node.gain.exponentialRampToValueAtTime(toVolume, endTime);
			else if (type === 'logarithmic') this.node.gain.linearRampToValueAtTime(toVolume, endTime);
			else if (type === 'scurve') this.node.gain.linearRampToValueAtTime(toVolume, endTime);
			//console.log('fade out', time, type, toVolume, offset, delay)
		}, delay * 1000);
	}
	/** Drop the memoized chain snapshot (call from every effect mutation). */
	_invalidateEffects() {
		this._effectsCache = null;
	}
	_effectEntry(e: EffectSlot, idx: number): EffectParamEntry {
		return {
			idx,
			id: e.type,
			type: e.type,
			bypassed: e.bypassed,
			// pending entries have no node yet — report their stored values
			params: e.effect ? e.effect.params() : { ...(e.values || {}) },
			defaults: e.defaults,
		};
	}
	_currentEffectParams(): EffectParamEntry[];
	_currentEffectParams(idx: number): EffectParamEntry;
	_currentEffectParams(idx?: number): EffectParamEntry | EffectParamEntry[] {
		if (idx !== undefined) {
			const e = this.effects[idx];
			return e ? this._effectEntry(e, idx) : ({} as EffectParamEntry);
		}
		// whole-chain reads are the high-frequency path (every state emit) — the
		// memoized array is reused until an effect mutation invalidates it, so
		// scalar writes (volume/pan/…) don't re-map the chain each time
		if (!this._effectsCache)
			this._effectsCache = this.effects.map((e, i) => this._effectEntry(e, i));
		return this._effectsCache;
	}
	_checkElapsed() {
		if (!this._playing || this._paused) return;
		let el = this.context.currentTime - this._startedAt + this._offset;
		// keep the playhead inside the loop region: the native loop wraps at the
		// exact boundary while our ticker can lag, so wrap the marker in-modulo
		// rather than trusting _startedAt to have been reset exactly on time
		if (this._loop && this._loopEnd > this._loopStart) {
			const len = this._loopEnd - this._loopStart;
			const v = (((el - this._loopStart) % len) + len) % len;
			el = this._loopStart + v;
		}
		this._elapsed = el;
		this.emit('elapsed', this._elapsed);
		this.elapseTimeout = setTimeout(() => this._checkElapsed(), 30);
	}
	_clearElapsed() {
		clearTimeout(this.elapseTimeout);
		this._elapsed = 0;
		this.emit('elapsed', 0);
	}
	/**
	 * Loop-boundary anti-click fades + loopend events, driven by one interval.
	 * Native looping jumps from loopEnd to loopStart at a non-zero sample, which
	 * clicks every cycle. We schedule a short gain envelope on `fadeNode` in
	 * *audio time* (look-ahead scheduling) so the gain is ~0 exactly at each
	 * wrap, with a ~6ms fade back in:
	 *
	 *   ...—silence—fadeBackIn→loopStart→...→loopEnd→silence—✓wrap—...
	 *
	 * The same tick advances `_nextWrap` and fires `loopend` at the exact wrap
	 * time (not the tick time), so no separate setTimeout is needed. rate()
	 * re-anchors an already-running scheduler instead of recreating it.
	 */
	_startLoopScheduler() {
		this._clearLoopScheduler();
		this._armLoopScheduler(true);
	}

	/** Re-align a running scheduler after a rate/loop change (keeps the timer). */
	_reanchorLoopScheduler() {
		this._armLoopScheduler(true);
	}

	/** (Re)compute the wrap anchor + schedule the fade envelope. */
	_armLoopScheduler(scheduleFades: boolean): void {
		if (!this._loop || this._paused || this._rate <= 0 || !this.source) return;
		const len = this._loopEnd - this._loopStart;
		if (len <= 0) return;
		const cycle = len / this._rate;
		this._cycle = cycle;
		this._nextWrap = this._computeNextWrap(len);
		this._fadeActive = cycle >= this._loopFadeDur * 3; // too tiny to fade
		this._fadeScheduledUntil = this._nextWrap;
		if (scheduleFades && this._fadeActive) this._scheduleLoopFades(this._nextWrap, true);
		if (!this._loopTimer) this._loopTimer = setInterval(() => this._loopTick(), 100);
	}

	/** Next loop boundary in audio time, from the current playback position. */
	_computeNextWrap(len: number): number {
		const now = this.context.currentTime;
		const pos = ((now - this._startedAt) * this._rate + this._offset - this._loopStart) % len || 0;
		const into = pos < 0 ? pos + len : pos;
		return now + (len - into) / this._rate;
	}

	_loopTick() {
		if (!this._playing || this._paused || this._cycle <= 0) return this._clearLoopScheduler();
		const now = this.context.currentTime;

		// fire loopend at the wrap time for every wrap the tick may have skipped
		// (background tabs throttle timers), then resync if still far behind
		let wraps = 0;
		while (now >= this._nextWrap && wraps < 8) {
			const wrap = this._nextWrap;
			this._nextWrap += this._cycle;
			this._elapsed = 0;
			this._startedAt = wrap;
			this.emit('loopend', true);
			wraps++;
		}
		if (now >= this._nextWrap) {
			const skipped = Math.floor((now - this._nextWrap) / this._cycle) + 1;
			this._nextWrap += skipped * this._cycle;
			// keep pausedAt/bounded position sane after a long background gap
			this._startedAt = now;
		}

		if (this._fadeActive && this._fadeScheduledUntil - now < 0.7)
			this._scheduleLoopFades(this._fadeScheduledUntil, false);
	}

	_scheduleLoopFades(from: number, startNow: boolean): void {
		if (!this.fadeNode) return;
		const g = this.fadeNode.gain;
		const dur = this._loopFadeDur;
		const cycle = this._cycle;
		let t = from;

		if (startNow) {
			// cover the click at the moment playback begins (offset = loopStart)
			try {
				g.cancelScheduledValues(this.context.currentTime);
			} catch (e) {}
			g.setValueAtTime(0.0001, this.context.currentTime);
			g.linearRampToValueAtTime(1, this.context.currentTime + dur);
		} else {
			try {
				g.cancelScheduledValues(t - 0.02);
			} catch (e) {}
		}

		// schedule the next several wraps: hold 1 → fade out to ~0 at the wrap
		// → fade back in
		for (let i = 0; i < 4; i++) {
			g.setValueAtTime(1, t - dur);
			g.linearRampToValueAtTime(0.0001, t);
			g.setValueAtTime(0.0001, t);
			g.linearRampToValueAtTime(1, t + dur);
			t += cycle;
		}
		this._fadeScheduledUntil = t;
		g.setValueAtTime(1, t);
	}

	_clearLoopScheduler() {
		clearInterval(this._loopTimer);
		this._loopTimer = null;
		this._fadeActive = false;
		if (!this.fadeNode) return;
		try {
			const g = this.fadeNode.gain;
			g.cancelScheduledValues(this.context.currentTime);
			g.setTargetAtTime(1, this.context.currentTime, 0.01);
		} catch (e) {}
	}
	stop() {
		if (!this.source) return;

		this._clearElapsed();
		this._clearLoopScheduler();
		clearTimeout(this.fadeOutTimeout);
		clearTimeout(this.fadeInTimeout);

		if (this.source && this._playing) this.source.stop();

		//if (!this.spillOver) this.effects.filter((e) => !e.bypassed).forEach((e) => e.effect.disconnect())

		this._pausedAt = 0;
		this._startedAt = 0;
		this._playing = false;
		this._emit('ended');
		this._emit('stop');
		this._emit('playing', false);
	}
	_emit(event: string, val?: unknown, val2?: unknown): void {
		this.emitState(event, val);
		this.emit(event, this.id, val, val2);
	}
	emitState(event: string, val?: unknown): void {
		const updated: Record<string, unknown> = {};
		if (typeof val === 'object') {
			const obj = val as Record<string, unknown>;
			Object.keys(obj).forEach((k) => {
				(this as any)['_' + k] = obj[k];
				updated[k] = obj[k];
			});
		} else updated[event] = val;

		this.emit(
			'state',
			{
				id: this.id,
				ready: this._ready,
				loaded: this._loaded,
				loading: this._loading,
				playing: this._playing,
				volume: this._volume,
				gain: this._gain,
				pan: this._pan,
				panWidth: this._panWidth,
				rate: this._rate,
				pitch: this._pitch,
				loop: this._loop,
				loopStart: this._loopStart,
				loopEnd: this._loopEnd,
				muted: this._muted,
				mutedVol: this._mutedVol,
				paused: this._paused,
				pausedAt: this._pausedAt,
				solo: this._solo,
				soloOn: this._soloOn,
				locked: this._locked,
				duration: this._duration,
				sampling: this._sampling,
				filename: this._filename,
				elapsed: this._elapsed,
				midiNote: this._midiNote,
				midiMapMode: this._midiMapMode,
				reversed: this._reversed,
				effectsEnabled: this._effectsEnabled,
				// event-gated: listeners keep their previous `effects` reference
				// on scalar updates (they merge the payload), and refresh it on
				// any real chain change
				...(EFFECT_STATE_EVENTS.has(event) ? { effects: this._currentEffectParams() } : {}),
				error: this._error,
				_event: event,
			},
			updated,
		);
	}
	getSaveState() {
		return {
			volume: this._volume,
			rate: this._rate,
			pitch: this._pitch,
			pan: this._pan,
			panZ: this._panZ,
			panX: this._panX,
			panWidth: this._panWidth,
			loop: this._loop,
			loopStart: this._loopStart,
			loopEnd: this._loopEnd,
			solo: this._solo,
			locked: this._locked,
			muted: this._muted,
			paused: this._paused,
			pausedAt: this._pausedAt,
			reversed: this._reversed,
			effectsEnabled: this._effectsEnabled,
			effects: this._currentEffectParams(),
		};
	}
	reset() {
		const { _duration, _loaded, _ready } = this;

		this.stop();
		this.effects.forEach((e) => {
			if (e.effect) {
				e.effect.disconnect();
				e.effect.reset();
			} else if (e.values) {
				// pending entry: reset the stored values
				Object.keys(e.defaults).forEach((k) => (e.values[k] = e.defaults[k].value));
			}
			e.connected = false;
		});
		this._invalidateEffects();
		Object.keys(defaults).forEach(
			(k) => ((this as any)['_' + k] = (defaults as unknown as Record<string, unknown>)[k]),
		);
		this._loaded = _loaded;
		this._duration = _duration;
		this._loopEnd = _duration;
		this._ready = _ready;
		this.loop(false);
		this.mute(defaults.muted);
		this.solo(defaults.solo);
		this.volume(defaults.volume);
		this.rate(defaults.rate);
		this.pitch(defaults.pitch);
		this.pan(defaults.pan);
		this.reverse(defaults.reversed);
		this.lock(defaults.locked);
		this._emit('reset', this.id);
	}

	onEnded() {
		this._startedAt = 0;
		if (!this._loop) {
			this._playing = false;
			this._emit('playing', false);
		}
		this.emit('ended');
	}
	pause(on?: boolean): boolean {
		if (on) {
			// stop fades/loopend while paused; resume (play) re-arms them
			this._clearLoopScheduler();
			if (this.source) {
				this._pausedAt = this._startedAt ? this.context.currentTime - this._startedAt : 0;
				this.source.stop();
			}
			this._paused = true;
		} else {
			this._paused = false;
			if (this._pausedAt) {
				this.play({
					start: this._pausedAt,
				});
			}
			this._pausedAt = 0;
		}

		this._emit('pause', this._paused);
		return this._paused;
	}

	jump(sec: number): void {
		const nextTime = this.context.currentTime - this._startedAt + sec * 1;
		this.pause();
		this.play({
			start: nextTime >= 0 ? nextTime : 0,
		});
	}
	mute(on?: boolean): boolean | void {
		if (on === undefined) return this._muted;
		if (this._muted === on) return;
		this._muted = on;
		// ramped mute gain instead of disconnecting the chain — hard graph
		// rewiring on every toggle caused audible cuts/clicks when the grid
		// muted/unmuted columns during mouse moves
		if (this.source) this._applyGain();
		this._emit('muted', on);
	}

	// effective output gain = volume * (1 + gain), 0 while muted.
	_targetGain() {
		return this._muted ? 0 : this._volume * (1 + (this._gain || 0));
	}
	// state-based smoothing: repeated calls just move the target, so fast
	// parameter updates (mouse moves) converge without zipper noise
	_applyGain() {
		if (!this.node) return;
		this.node.gain.setTargetAtTime(this._targetGain(), this.context.currentTime, 0.02);
	}

	volume(vol?: number): number {
		if (vol !== undefined) this._volume = vol;
		this._applyGain();
		this._emit('volume', this._volume);
		return this._volume;
	}
	gain(gain?: number): number {
		if (gain !== undefined) this._gain = gain;
		this._applyGain();
		this._emit('gain', this._gain);
		return this._gain;
	}
	rate(rate?: number): number {
		if (rate !== undefined && this.source && this._rate !== rate) {
			this.source.playbackRate.cancelScheduledValues(this.context.currentTime);
			this.source.playbackRate.setValueAtTime(this._rate, this.context.currentTime + 0.01);
			this.source.playbackRate.linearRampToValueAtTime(rate, this.context.currentTime + 0.05);
		}

		this._rate = rate !== undefined ? Number(rate) : this._rate;
		this._emit('rate', this._rate);
		// re-anchor an already-running scheduler in place (no interval churn
		// while dragging the rate); (re)start it when it isn't running
		if (this._loop && this._playing && !this._paused && this._rate > 0 && this._loopTimer)
			this._reanchorLoopScheduler();
		else this._startLoopScheduler();
		return this._rate;
	}

	/**
	 * Tempo-preserving pitch shift, in semitones (0 = original, ±24 = ±2
	 * octaves). Runs the source through the Signalsmith Stretch worklet
	 * inserted between the source and the effects, so duration, loop points
	 * and rate are untouched. The node is only connected while pitch ≠ 0 and
	 * is created lazily.
	 */
	pitch(semitones?: number): number {
		if (semitones !== undefined) {
			const next = Math.max(-24, Math.min(24, Number(semitones)));
			const wasActive = this._pitchActive;
			this._pitch = isNaN(next) ? 0 : next;
			this._pitchActive = Math.abs(this._pitch) > 0.01;

			if (this._pitchActive) this._ensurePitchNode();
			this._applyPitch();
			// (re)plug the chain only when the shifter enters/leaves the path
			if (this.source && wasActive !== this._pitchActive) this._connectChain();
		}
		this._emit('pitch', this._pitch);
		return this._pitch;
	}

	/** Push the current pitch to the Signalsmith Stretch node. */
	_applyPitch() {
		if (this._stretch) this._scheduleStretch();
	}

	/** Schedule the current pitch (semitones) on the Signalsmith Stretch node. */
	_scheduleStretch() {
		if (!this._stretch || !this._stretch.schedule) return;
		// NB: remote methods (including latency()) return Promises, so they
		// can't be used in time arithmetic. Live input ignores rate/loop*, and
		// omitting `output`/`outputTime` schedules the change immediately.
		this._stretch.schedule({
			semitones: this._pitch,
			active: true,
		});
	}

	/**
	 * Create the Signalsmith Stretch pitch node on demand (loaded at runtime
	 * from /public — see lib/audio/pitch/stretch.ts). Async; the chain is
	 * rebuilt once the node exists.
	 */
	_ensurePitchNode() {
		if (this._pitchNode || this._pitchNodeFailed || this._pitchPending) return this._pitchNode;
		this._pitchPending = true;
		import('./pitch/stretch')
			.then(({ default: loadSignalsmithStretch }) => loadSignalsmithStretch())
			.then((SignalsmithStretch) =>
				SignalsmithStretch(this.context, {
					// these REPLACE the library defaults, so outputChannelCount
					// (used for `this.channels`) must be included or the
					// processor throws in its worklet constructor
					numberOfInputs: 1,
					numberOfOutputs: 1,
					outputChannelCount: [2],
				}),
			)
			.then((stretch) => {
				this._stretch = stretch;
				this._pitchNode = stretch;
				this._pitchPending = false;
				if (stretch.start) stretch.start();
				this._scheduleStretch();
				if (this.source && this._pitchActive) this._connectChain();
			})
			.catch((err) => {
				console.error('signalsmith-stretch unavailable', err);
				this._pitchPending = false;
				this._pitchNodeFailed = true;
			});
		return this._pitchNode;
	}

	pan(deg: number): { x: number; z: number } {
		var xDeg = parseInt(String(deg));
		var zDeg = xDeg + 90;
		if (zDeg > 90) zDeg = 180 - zDeg;

		var x = Math.sin(xDeg * (Math.PI / 180));
		var z = Math.sin(zDeg * (Math.PI / 180));

		// both position axes must move together: writing only positionX leaves the
		// source on the z=0 side plane, which the equal-power panner collapses to
		// hard-left / hard-right (the sound only centres exactly at deg 0)
		if (this.panner) {
			const now = this.context.currentTime;
			if (this.panner.positionX) {
				if (this._panX !== x) this.panner.positionX.setTargetAtTime(x, now, 0.05);
				if (this._panZ !== z) this.panner.positionZ.setTargetAtTime(z, now, 0.05);
			} else {
				this.panner.setPosition(x, 0, z);
			}
		}

		const panWidth =
			deg <= 0 ? (((-90 + Math.abs(-deg)) / -90) * 100) / 2 : 50 + ((deg / 90) * 100) / 2;
		this._pan = deg;
		this._panWidth = Math.floor(panWidth);
		this._panX = x;
		this._panZ = z;
		this._emit('pan', this._pan);
		return {
			x: x,
			z: z,
		};
	}
	loop(on?: boolean, offset: { start?: number; end?: number } = {}): boolean {
		if (on === undefined) return this._loop;
		this._loopStart =
			offset.start !== undefined ? Math.max(0, offset.start) : Math.max(0, this._loopStart || 0);
		this._loopEnd =
			offset.end !== undefined
				? Math.max(this._loopStart, offset.end)
				: on
					? this._duration
					: Math.max(this._loopStart, this._loopEnd || 0);
		this._loop = on;

		if (this.source) {
			this.source.loopStart = Math.max(0, this._loopStart);
			this.source.loopEnd = this._loopEnd;
			this.source.loop = on;
		}
		if (!this._loop) {
			this._clearLoopScheduler();
		} else if (this._playing && !this._paused) {
			this._startLoopScheduler();
		}
		this._emit('loop', on);
		return this._loop;
	}

	reverse(on?: boolean): unknown {
		if (on === undefined) return this._reverse;
		if (!this.buffer) return;
		if (on && !this._reversed) reverse(this.buffer);
		if (!on && this._reversed) reverse(this.buffer);
		this._bufferVersion++;
		this._reversed = on;
		this._emit('reversed', on);
		this.emit('change');
	}
	crop(start: number, end: number): void {
		const s = Math.floor(start * this.sampleRate);
		const e = Math.floor(end * this.sampleRate);
		const data = this.buffer.getChannelData(0);
		const cropped = slice([data], s, e > data.length - 1 ? data.length - 1 : e);
		const newBuff = new AudioBuffer({
			length: cropped[0].length,
			numberOfChannels: 1,
			sampleRate: this.sampleRate,
		});
		newBuff.copyToChannel(cropped[0] as never, 0);
		this.buffer = newBuff;
		this._bufferVersion++;
		this._duration = this.buffer.duration; ///this.buffer.numberOfChannels;
		this._emit('duration', this._duration);
		this.emit('change');
	}

	solo(on?: boolean, mute?: boolean): boolean | void {
		if (on === undefined) return this._solo;
		this.mute(mute);
		this._solo = on;
		this._emit('solo', on);
		return this._solo;
	}
	lock(on?: boolean): boolean | void {
		if (on === undefined) return this._locked;
		this._locked = on;
		this._emit('locked', on);
	}
	duration() {
		return this._duration;
	}
	realDuration() {
		if (this._duration === 0 || this._rate === 0) return 0;
		// only count the loop range when actually looping — a disabled loop
		// still leaves stale _loopStart/_loopEnd around
		const len =
			this._loop && this._loopEnd > this._loopStart
				? this._loopEnd - this._loopStart
				: this._duration;
		return len / this._rate;
	}
	sampling(on: boolean): void {
		this._sampling = on;
		this._emit('sampling', on);
	}

	load(url?: string): void {
		this._clearElapsed();
		this._clearLoopScheduler();
		this._loaded = false;
		this._error = null;
		this._url = url !== undefined ? url : this._url;

		if (!this._url || !this._filename) {
			this._ready = true;
			return this._emit('ready', true);
		}

		this._loading = true;
		this._emit('loading', true);
		this._url = this._url.includes('blob:') ? this._url : encodeURIComponent(this._url);

		if (/^data:[^;]+;base64,/.test(url)) {
			let data = atob(url.split(',')[1]);
			let dataView = new Uint8Array(data.length);
			for (let i = 0; i < data.length; ++i) dataView[i] = data.charCodeAt(i);
			this.decodeAudioData(dataView.buffer);
		} else {
			let xhr = new XMLHttpRequest();
			xhr.open('GET', this._url, true);
			xhr.withCredentials = false;
			xhr.responseType = 'arraybuffer';
			xhr.addEventListener('load', () => {
				let code = parseInt((xhr.status + '')[0]);
				if (code !== 0 && code !== 2 && code !== 3)
					return (xhr.onerror as unknown as (msg: string) => void)(
						'Failed loading audio file with status: ' + xhr.status + '.',
					);
				this.decodeAudioData(xhr.response);
			});
			xhr.addEventListener('error', (err) => {
				this._loading = false;
				this._ready = true;
				this._url = null;
				this._error = err;
				this._emit('ready', true);
				this._emit('loaderror', err);
			});

			try {
				xhr.send();
			} catch (e) {
				(xhr.onerror as unknown as (e: unknown) => void)(e);
			}
		}
	}
	decodeAudioData(arrayBuffer: ArrayBuffer): void {
		const error = (err?: unknown) => {
			console.error('ERRROR decoding audio data', this._id, err);
			this._url = null;
			this._loading = false;
			this._loaded = false;
			this._ready = true;
			this._error = err;
			this._emit('ready', true);
			this._emit('loaderror', this._error);
			this.sampling(false);
		};
		// Copy buffer
		let _buffer = new ArrayBuffer(arrayBuffer.byteLength);
		new Uint8Array(_buffer).set(new Uint8Array(arrayBuffer));

		const success = (buffer: AudioBuffer) => {
			if (buffer) {
				//console.log('decoded data', this.id, buffer.duration)

				this.buffer = this._reversed ? reverse(buffer) : buffer;
				this._buffer = _buffer;
				this._bufferVersion++;
				this._duration = buffer.duration; ///buffer.numberOfChannels;
				//this._loopEnd = this._duration;
				this._loaded = true;
				this._loading = false;
				this._ready = true;
				this._error = null;
				this._emit('ready', true);
				this._emit('loaded', true);
				this.emit('load');
				this.emit('change');
				this.sampling(false);
			} else error();
		};

		/*
		this.context.decodeAudioData(arrayBuffer).then((buffer)=>{
			success(buffer)
		}).catch((err)=>error(err))
		return
		*/
		const p = this.context.decodeAudioData(
			arrayBuffer,
			(buffer) => {
				success(buffer);
			},
			(err) => {
				if (!p) error(err);
			},
		);
		if (p && p.catch) p.catch((err) => error(err));
	}
	urlToMimeType(url?: string | null): string | null {
		if (!url) return 'audio/mpeg';
		const src = url.toLowerCase();
		if (src.endsWith('.mp3')) return 'audio/mpeg';
		else if (src.endsWith('.wav')) return 'audio/wav';
		else if (src.endsWith('.m4a')) return 'audio/mp4';
		else return null;
	}
	midiNote(number: number): void {
		this._midiNote = number;
		this._emit('midinote', number);
	}
	midiMapMode(on: boolean): void {
		this._midiMapMode = on;
		this._emit('midimapmode', on);
	}
	destroy() {
		(this as any).emit = () => {};
		// stop a late _materialize promise from wiring a node into a dead sound
		this._destroyed = true;

		if (this.source && this._playing) {
			this.source.removeEventListener('ended', this.onEnded);
			this.source.stop();
		}
		this.effects.forEach((e) => {
			if (e.effect) e.effect.disconnect();
		});
		if (this._pitchNode) {
			try {
				this._pitchNode.disconnect();
			} catch (e) {}
			this._pitchNode = null;
		}
		this._stretch = null;
		this.source = null;
		this.buffer = null;
		this._buffer = null;
		this._clearElapsed();
		this._clearLoopScheduler();
		try {
			if (this.fadeNode && this.fadeNode.disconnect) this.fadeNode.disconnect();
		} catch (e) {}
		clearTimeout(this.fadeOutTimeout);
	}
	log() {
		if (!this.DEBUG) return;
		//let caller_line = (new Error).stack.split("\n")[4]
		console.log('Sound.js', this.id, Array.prototype.slice.call(arguments).join(' '));
	}
	error(err: unknown): void {
		void err;
	}
}

export default Sound;
