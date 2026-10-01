import { arrayMoveImmutable, reverse, slice } from './utils';
import { EventEmitter } from 'events';
import { ensureEffectsWorklet } from './effects/worklet';
import type { Effect, EffectDefaults } from './effects/core';
import type { EqBand, EqBandOptions } from './types';
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
	/**
	 * Signal delay through the shifter, in seconds (asynchronous — the value
	 * only arrives after the worklet replies, so it can't be used in time
	 * arithmetic; it is read once to keep the loop fade aligned).
	 */
	latency?: () => Promise<number>;
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

/** Valid band types (RBJ shapes). */
const EQ_TYPES = ['lowshelf', 'peaking', 'highshelf', 'lowpass', 'highpass'];
/** Channel gain trim range, in dB (−24 … +24). */
const MIN_GAIN_DB = -24;
const MAX_GAIN_DB = 24;
/** Clamp a possibly-NaN number into [lo, hi]. */
const clampNumber = (v: unknown, lo: number, hi: number): number => {
	const n = Number(v);
	return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
};
/** Fresh flat 4-band EQ (matches the channel processor's defaults). */
const defaultEq = (): EqBand[] => [
	{ on: false, type: 'lowshelf', frequency: 100, gain: 0, q: 0.7 },
	{ on: false, type: 'peaking', frequency: 300, gain: 0, q: 0.7 },
	{ on: false, type: 'peaking', frequency: 2000, gain: 0, q: 0.7 },
	{ on: false, type: 'highshelf', frequency: 6000, gain: 0, q: 0.7 },
];

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
	/** Signalsmith Stretch block size in ms (see AudioEngineOptions.pitchBlockMs). */
	pitchBlockMs?: number;
}

/**
 * One sampler cell: owns an AudioBufferSourceNode + a volume/channel-processor/
 * panner chain and an ordered effect chain, and emits `state`/`*<id>` events the
 * engine forwards.
 *
 * A Sound is created by `AudioEngine.add()`/`createSound()` and usually lives
 * for one grid cell. Its many `_<name>` fields mirror the `SoundDefaults`
 * settings and are what `getSaveState()` / presets serialize.
 * Nodes are rebuilt on every `play()` (Web Audio sources are one-shot).
 */
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
	source: AudioBufferSourceNode | null;
	effectsInputNode: GainNode;
	effectsOutputNode: GainNode;
	chain: AudioNode[];
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
	/** True while the Stretch node should stay in the graph for this playback. */
	_pitchEngaged: boolean;
	/**
	 * Dry/wet gain pair around the shifter. While engaged the source feeds both
	 * the dry gain and the shifter, so the pair can be crossfaded instead of the
	 * shifter being spliced in — a cold insert drops its latency worth of audio
	 * and the signal returning from that gap clicks.
	 */
	_dryGain: GainNode | null;
	_wetGain: GainNode | null;
	/** Target dry/wet mix: 0 = dry only, 1 = shifter only. */
	_pitchMix: number;
	_stretch: StretchLike | null;
	_pitchPending: boolean;
	/**
	 * Round-trip latency (seconds) of whatever sits between the source and the
	 * channel processor — the pitch shifter, 0 when it is out of the path. Sent
	 * to the processor so it can place the loop fade on the audible wrap.
	 */
	_chainDelay: number;
	/**
	 * The shifter's measured latency, remembered across the times it is out of
	 * the path (it is only measured once, when the node is built). `_chainDelay`
	 * is this value while the shifter is engaged and 0 while it is not.
	 */
	_pitchLatency: number;
	/**
	 * Signalsmith Stretch block size (ms) for this sound's shifter. Equal to the
	 * shifter's round-trip latency. Applied via `configure({ blockMs })` once the
	 * node exists; see AudioEngineOptions.pitchBlockMs.
	 */
	_pitchBlockMs: number;
	_loopFadeDur: number;
	/**
	 * Context time at which an in-flight splice fade ends (0 = none). While it is
	 * still in the future `_applyGain` leaves the gain alone — see `_spliceFade`.
	 */
	_spliceEnds: number;
	_channelNode: AudioWorkletNode | null;
	_channelNodePending: boolean;
	_channelNodeFailed: boolean;
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
	/** Channel gain trim, in dB (−24 … +12; 0 = unity), applied in the channel processor. */
	_gain: number;
	_pan: number;
	_panWidth: number;
	_panX: number;
	_panZ: number;
	_sampling: boolean;
	_midiNote: number;
	_midiMapMode: boolean;
	_reversed: boolean;
	_id: string;
	/** Whether the current playback reports `elapsed` (enableElapsed or play opt). */
	_emitElapsed: boolean;
	/** 4-band channel EQ (band 0..3); flat (all off) by default. */
	_eq: EqBand[];

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
					opt[k] !== undefined ? opt[k] : (defaults as unknown as Record<string, unknown>)[k]),
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
		// Stretch block size for this sound's shifter (see _ensurePitchNode); the
		// library's own default is 120ms and we default to 40 (same quality on
		// tonal material, 80ms less latency — measured).
		this._pitchBlockMs =
			Number.isFinite(opt.pitchBlockMs) && opt.pitchBlockMs > 0 ? opt.pitchBlockMs : 40;
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
		this._loopFadeDur = 0.006;
		// context time at which the in-flight splice fade ends (0 = none); see
		// _spliceFade. While it is still in the future the volume envelope owns
		// the gain, so _applyGain must not stomp it.
		this._spliceEnds = 0;
		// no pitch shifter in the path yet, so nothing delays the signal
		this._chainDelay = 0;
		// measured once the shifter node exists (see _ensurePitchNode)
		this._pitchLatency = 0;
		// Per-sound channel processor (loop clock + anti-click fade + elapsed)
		// lives on the audio thread (see src/effects/worklet/channel.js). The
		// node is created lazily on the first loop/elapsed play and kept for the
		// sound's lifetime; until it exists the sound plays straight to the
		// panner and elapsed falls back to no reporting.
		this._channelNode = null;
		this._channelNodePending = false;
		this._channelNodeFailed = false;
		this._emitElapsed = false;
		// 4-band channel EQ (flat by default; may come from a loaded model)
		this._eq = defaultEq();
		if (Array.isArray(opt.eq)) this._applyEqConfig(opt.eq);
		this.source = null;
		this.effectsInputNode = this.context.createGain();
		this.effectsOutputNode = this.context.createGain();
		this.chain = [];
		// tempo-preserving pitch shifter (Signalsmith Stretch) inserted between
		// the source and the effects; created lazily, and kept out of the path
		// until the pitch first leaves 0 (see `pitch()`)
		this._pitchNode = null;
		this._pitchNodeFailed = false;
		this._pitchActive = Math.abs(this._pitch || 0) > 0.01;
		// dry/wet pair around the shifter; created with the pitch node. Starts
		// fully wet so a chain built before playback (play() connects first)
		// behaves exactly like the old direct insert.
		this._dryGain = null;
		this._wetGain = null;
		this._pitchMix = 1;
		// whether the shifter is currently wired into the path. It is decoupled
		// from `_pitchActive`: once engaged it stays in the graph (glided to 0
		// semitones) until the next play(), because removing the latency-carrying
		// Stretch node mid-playback jumps the signal and clicks.
		this._pitchEngaged = this._pitchActive;
		this._stretch = null;
		this._pitchPending = false;
		// NB: the Signalsmith node is NOT created here even when the engine
		// preloads pitch — creating a Stretch node per Sound up front garbles
		// audio on some setups. `preloadPitch` only warms the module (once, in
		// AudioEngine); the per-sound node stays lazy, created on first use.
		this.onEnded = this.onEnded.bind(this);
	}
	/**
	 * Start playback: build a fresh source, connect the chain (unless filtered
	 * out by solo), apply rate/loop/fades and start the elapsed ticker. A muted
	 * sound is still wired up and runs silently, so unmuting mid-play makes it
	 * audible from the current position.
	 *
	 * No-op until the buffer has loaded. If paused, resumes instead of
	 * restarting (see {@link pause}).
	 *
	 * @param options - start offset/duration, fades, optional volume override.
	 */
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
			this._stopChannel();
		}

		// Replacing a live source is a hard cut (stop → rewire → start). Dip the
		// gain across the whole seam so the old source's abrupt stop can't click;
		// the new source additionally gets the channel processor's intro ramp.
		// Skipped when the caller asked for an explicit fadeIn/fadeOut — those
		// own the gain envelope themselves and would fight the dip.
		const replacing = !!(this._playing && this.source);
		const explicitFade = (opt.fadeIn || 0) !== 0 || ((opt.fadeOut || 0) !== 0 && !this._loop);
		if (replacing && !explicitFade) this._spliceFade(0.002, 0.008);

		if (this._playing && this.source) this.source.stop();

		const soloOn = this.engine.master.solo();

		this.source = this.context.createBufferSource();
		this.source.buffer = this.buffer;

		// each fresh playback decides the shifter topology from the current
		// pitch: flat starts dry/zero-latency even if a Stretch node exists
		this._pitchEngaged = this._pitchActive;
		// ...and the chain delay follows the topology, not just the node. The
		// shifter can be out of the path while its latency is still remembered,
		// and a stale value here would place every loop fade one latency early.
		this._chainDelay = this._pitchEngaged ? this._pitchLatency : 0;

		// Always wire the chain (unless solo-excluded) — muted included. The
		// source runs silently behind a zeroed volume gain, so unmuting mid-play
		// makes it audible from the current position instead of leaving it
		// disconnected. The gain is seeded to its target below, before the
		// source starts, so a muted start is silent from the first quantum.
		if (soloOn ? this._solo : true) this._connectChain();
		// a fresh chain starts fully wet when the shifter is part of it: it is
		// built before the source starts, so there is no live signal to crossfade
		if (this._pitchEngaged) this._setPitchMix(1, 0);

		const ct = this.context.currentTime;
		// Seed the volume node with the current target before the source starts.
		// While muted it can still hold a stale gain from an earlier unmuted
		// playback; snapping it to 0 here keeps the connected chain silent and
		// leaves unmute (which ramps via _applyGain) to fade in mid-play.
		this.node.gain.cancelScheduledValues(ct);
		this.node.gain.setValueAtTime(this._targetGain(), ct);
		// any in-flight splice envelope was just cancelled, so stop blocking
		// _applyGain on it
		this._spliceEnds = 0;
		this._offset = Math.max(0, opt.start || this._pausedAt || this._loopStart || 0);
		this.source.loop = this._loop;
		this.source.loopStart = Math.max(0, this._loopStart || this.source.loopStart || 0);
		this.source.loopEnd = Math.max(0, this._loopEnd || this.source.loopEnd || 0);
		this.source.playbackRate.value = this._rate;
		this.source.addEventListener('ended', this.onEnded);

		if (opt.volume !== undefined)
			// mute wins over a per-play volume override
			this.node.gain.setValueAtTime(
				this._muted ? 0 : opt.volume,
				this.context.currentTime + 0.005,
			); // this.volume(opt.volume)

		this.source.start(0, this._offset); //, opt.duration && !this._loop ? opt.duration : this._duration - this._offset);

		if (opt.fadeIn !== undefined && opt.fadeIn !== 0.0)
			this.fadeIn(opt.fadeIn, opt.fadeType, 0.00001, this._muted ? 0 : opt.volume || this._volume);
		if (opt.fadeOut !== undefined && opt.fadeOut !== 0.0 && !this._loop)
			this.fadeOut(opt.fadeOut, opt.fadeType, 0.00001, opt.duration || this._duration);

		this._startedAt = this.context.currentTime;
		this._playing = true;
		this._emit('playing', true);
		// gate elapsed before anchoring so the processor knows to report it
		this._emitElapsed = !!(this.enableElapsed || opt.enableElapsed);
		this._anchorChannel(true);

		if (this._emitElapsed) {
			this._clearElapsed();
			this.emit('elapsed', this._offset);
		}
		//console.log('play', this._offset, 'muted', this._muted, 'loop', this._loopStart + ' > ' + this._loopEnd, 'dur=', opt.duration, opt.fadeIn, opt.fadeOut)
	}
	/**
	 * Schedule a short anti-click dip on the volume node to mask a hard seam in
	 * the graph — a chain rebuild or a source replace while audio is flowing.
	 *
	 * The down-ramp is short enough to hit zero at the render quantum where the
	 * graph change actually lands, so the seam happens at (near) zero gain; the
	 * up-ramp then eases back to the current target. All of it is scheduled ahead
	 * of time — deliberately no `setTimeout`, which is throttled to seconds in a
	 * background tab and would trade a click for a dropout.
	 *
	 * @param down - seconds to ramp down (must be short so the seam lands at 0)
	 * @param up - seconds to ramp back up to the target
	 */
	_spliceFade(down = 0.002, up = 0.008): void {
		if (!this.node) return;
		const target = this._targetGain();
		// silent (muted): nothing audible to mask, and dipping would only block
		// _applyGain for the length of the envelope
		if (target === 0) return;
		const g = this.node.gain;
		const t = this.context.currentTime;
		g.cancelScheduledValues(t);
		g.setValueAtTime(g.value, t);
		g.linearRampToValueAtTime(0, t + down);
		g.setValueAtTime(0, t + down);
		g.linearRampToValueAtTime(target, t + down + up);
		this._spliceEnds = t + down + up;
	}
	/**
	 * Rebuild a live chain with a short gain dip around it. Use this instead of a
	 * bare {@link _connectChain} for any mid-playback mutation (effect
	 * add/remove/bypass, the channel node landing, first pitch engage): the
	 * blanket disconnect/reconnect would otherwise cut the signal and click.
	 */
	_rebuildChain(): void {
		if (this._playing && this.source && this._connected) this._spliceFade();
		this._connectChain();
	}
	/** Lazily create the dry/wet pair the engaged shifter is crossfaded across. */
	_ensurePitchGains(): boolean {
		if (!this._pitchNode) return false;
		if (!this._dryGain) {
			this._dryGain = this.context.createGain();
			this._dryGain.gain.value = 1 - this._pitchMix;
		}
		if (!this._wetGain) {
			this._wetGain = this.context.createGain();
			this._wetGain.gain.value = this._pitchMix;
		}
		return true;
	}
	/**
	 * Crossfade the pitch dry/wet pair (0 = dry only, 1 = shifter only).
	 *
	 * `delay` postpones the ramp so the shifter can prime for its latency before
	 * its output is trusted: a freshly connected Stretch node emits silence and
	 * then signal, and that onset would click if it arrived at full wet.
	 */
	_setPitchMix(mix: number, ramp = 0.02, delay = 0): void {
		const from = this._pitchMix;
		this._pitchMix = mix;
		if (!this._dryGain || !this._wetGain) return;
		const t = this.context.currentTime;
		const start = t + Math.max(0, delay);
		const dry = this._dryGain.gain;
		const wet = this._wetGain.gain;
		dry.cancelScheduledValues(t);
		wet.cancelScheduledValues(t);
		dry.setValueAtTime(1 - from, t);
		dry.setValueAtTime(1 - from, start);
		dry.linearRampToValueAtTime(1 - mix, start + ramp);
		wet.setValueAtTime(from, t);
		wet.setValueAtTime(from, start);
		wet.linearRampToValueAtTime(mix, start + ramp);
	}
	/**
	 * Bring the (already built) shifter into the path without a seam. The splice
	 * is gain-neutral because the dry branch stays at full level, and the
	 * crossfade to wet only starts once the shifter has primed for its latency.
	 */
	_engagePitchLive(): void {
		const live = !!(this._playing && this.source && this._connected);
		if (live) this._setPitchMix(0, 0);
		this._rebuildChain();
		if (live) this._setPitchMix(1, 0.02, this._pitchLatency > 0 ? this._pitchLatency : 0.05);
	}
	/**
	 * (Re)build the audio graph from the source through the optional pitch node,
	 * the non-bypassed effects, the volume node, the channel processor and
	 * panner into the
	 * master gain.
	 */
	_connectChain() {
		if (!this.source) return;

		this._disconnectChain();
		const effects = this.effects
			// `e.effect` is null while a lazily-added effect is still bypassed
			.filter((e) => !e.bypassed && e.effect)
			.map((e) => e.effect as Effect);
		// the first node after the source stage: the first effect, or the volume
		// node when the chain is empty
		const nextInput: AudioNode = effects.length ? effects[0].inputNode : this.node;
		// pitch shifter first so the effects process the transposed signal. While
		// engaged it runs as a parallel dry/wet pair rather than a hard insert, so
		// it can be crossfaded in mid-playback (see _setPitchMix) instead of
		// dropping its latency worth of audio and clicking.
		if (this._pitchEngaged && !this._pitchNode) this._ensurePitchNode();
		if (this._pitchEngaged && this._ensurePitchGains()) {
			this.source.connect(this._dryGain!);
			this.source.connect(this._pitchNode!);
			this._pitchNode!.connect(this._wetGain!);
			this._dryGain!.connect(nextInput);
			this._wetGain!.connect(nextInput);
		} else {
			this.source.connect(nextInput);
		}
		effects.forEach((effect, i) => {
			effect.connect(i < effects.length - 1 ? effects[i + 1].inputNode : this.node);
		});
		// channel processor (when it exists) owns the anti-click fade; otherwise
		// go straight to the panner
		if (this._channelNode) {
			this.node.connect(this._channelNode);
			this._channelNode.connect(this.panner);
		} else {
			this.node.connect(this.panner);
		}
		this.panner.connect(this.engine.masterGain);
		this._connected = true;
	}
	/** Tear down every connection made by {@link _connectChain}. */
	_disconnectChain() {
		if (this._connected) {
			const effects = this.effects;
			this.source.disconnect();
			if (this._pitchNode) {
				try {
					this._pitchNode.disconnect();
				} catch (e) {}
			}
			// the dry/wet pair around the shifter (see _connectChain)
			if (this._dryGain) {
				try {
					this._dryGain.disconnect();
				} catch (e) {}
			}
			if (this._wetGain) {
				try {
					this._wetGain.disconnect();
				} catch (e) {}
			}
			effects.forEach((e) => {
				if (e.effect) e.effect.disconnect();
			});
			// Detach only the audible destination (panner / channel processor).
			// A blanket `node.disconnect()` also severed the per-sound analyser
			// taps created by AudioEngine.analyse(), so track meters went dead
			// after any chain rebuild (play/stop, mute, effect change) and never
			// recovered — Analyser.setNode() no-ops when the node is unchanged.
			// Analyser edges are re-pointed explicitly via setAnalysersNode()
			// when the node itself is actually replaced.
			try {
				this.node.disconnect(this.panner);
			} catch (e) {}
			if (this._channelNode) {
				try {
					this.node.disconnect(this._channelNode);
				} catch (e) {}
			}
			// Detach only the channel processor's audible destination. A blanket
			// `_channelNode.disconnect()` also severed the per-sound analyser taps
			// (meters now ride the channel processor), so a stop→play or any chain
			// rebuild killed the meter for good — the tap is only remade when the
			// node is replaced. A targeted disconnect throws when the node was
			// never wired to the panner, hence the try/catch.
			if (this._channelNode) {
				try {
					this._channelNode.disconnect(this.panner);
				} catch (e) {}
			}
			this.panner.disconnect(this.engine.masterGain);
		}
		this._connected = false;
	}
	/**
	 * Append an already-built effect (see AudioEngine.addEffect) to the chain.
	 * Effects are added bypassed by default; `bypass: false` enables it at once.
	 */
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
				if (!e.bypassed) this._rebuildChain();
				this._emit('effectparams', this._currentEffectParams(idx));
			})
			.catch((err: unknown) => {
				e.creating = false;
				console.error('failed to create effect', e.type, err);
			});
	}
	/** Get the effect slot at `idx`; with `bypass` set it enables/disables it. */
	effectBypass(idx: number, bypass?: boolean): EffectSlot {
		if (idx < 0 || idx > this.effects.length - 1 || !this.effects[idx])
			throw new Error('effect not found at idx=' + idx);
		else if (bypass === undefined) return this.effects[idx];
		const e = this.effects[idx];
		e.bypassed = bypass;
		this._invalidateEffects();
		// lazily build the node the first time a pending effect is enabled
		if (!bypass && !e.effect) this._materialize(idx);
		this._rebuildChain();
		this._emit('effectbypass', idx, bypass);
		return e;
	}
	/** Remove the effect at `idx`, re-index the rest and return the new chain. */
	removeEffect(idx: number): EffectParamEntry | EffectParamEntry[] {
		const effects = this.effects.filter((e, i) => i !== idx);
		effects.forEach((eff, idx) => (eff.idx = idx));
		this.effects = effects || [];
		this._invalidateEffects();
		this._rebuildChain();
		this._emit('removeeffect', idx);
		return this._currentEffectParams();
	}
	/** Move the effect at `idx` to `toIdx`, re-index and return the new chain. */
	moveEffect(id: string, idx: number, toIdx: number): EffectParamEntry | EffectParamEntry[] {
		this.effects = arrayMoveImmutable(this.effects, idx, toIdx);
		this.effects.forEach((e, idx) => (e.idx = idx));
		this._invalidateEffects();
		this._rebuildChain();
		// notify the app like add/remove/bypass do — without this the chain
		// order change is invisible to the UI until some other state event fires
		this._emit('moveeffect', idx, toIdx);
		return this._currentEffectParams();
	}

	/**
	 * Read (no `params`) or write one effect's parameters. Writing pushes only
	 * the supplied keys through the effect's setters (or the pending values
	 * before materialization) and emits `effectparams`.
	 */
	effectParams(idx?: number, params?: Record<string, any>): EffectParamEntry | EffectParamEntry[] {
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
	/** Bypass the whole chain without losing per-effect bypass states. */
	disableEffects() {
		this.effects.forEach((e, idx) => (e.bypassed = true));
		this._invalidateEffects();
		this._rebuildChain();
		this._effectsEnabled = false;
		this._emit('effectsenabled', false);
	}
	/** Un-bypass every effect (materializing any pending nodes) and reconnect. */
	enableEffects() {
		this.effects.forEach((e, idx) => {
			e.bypassed = false;
			// pending entries have no node yet — build them now that they're on
			if (!e.effect) this._materialize(idx);
		});
		this._invalidateEffects();
		this._effectsEnabled = true;
		this._rebuildChain();
		this._emit('effectsenabled', true);
	}
	/**
	 * Ramp the volume node from `fromVolume` to `toVolume` over `time` seconds.
	 * `type` selects the ramp shape (linear/exponential/logarithmic/scurve; the
	 * non-linear names currently map to a linear ramp).
	 */
	fadeIn(time: number, type: string, fromVolume: number, toVolume: number): void {
		this.node.gain.setValueAtTime(fromVolume, this.context.currentTime);
		const endTime = this.context.currentTime + time - 0.001;

		if (type === 'linear') this.node.gain.linearRampToValueAtTime(toVolume, endTime);
		else if (type === 'exponential') this.node.gain.exponentialRampToValueAtTime(toVolume, endTime);
		else if (type === 'logarithmic') this.node.gain.linearRampToValueAtTime(toVolume, endTime);
		else if (type === 'scurve') this.node.gain.linearRampToValueAtTime(toVolume, endTime);

		//console.log('fadein', time, type, fromVolume, toVolume,this.context.currentTime,time)
	}
	/**
	 * Schedule a fade to `toVolume` that begins `offset - time` seconds from now
	 * (i.e. it completes at `offset`). Replaces any pending fade-out.
	 */
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
	/** Serialize one chain slot (live params, or pending values before materialization). */
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
	/**
	 * Serialized effect chain snapshot: one entry with an index, or the whole
	 * array (memoized until the next mutation — see `_effectsCache`).
	 */
	_currentEffectParams(): EffectParamEntry[];
	_currentEffectParams(idx: number): EffectParamEntry;
	/**
	 * Implementation of the two overloads above; see `_currentEffectParams()`
	 * and `_currentEffectParams(idx)`.
	 */
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
	/**
	 * Reset the playhead to 0 and emit it. The live updates now come from the
	 * channel processor (`elapsed` messages) rather than a main-thread timer.
	 */
	_clearElapsed() {
		this._elapsed = 0;
		this.emit('elapsed', 0);
	}
	/**
	 * Post the playhead anchor to the channel processor (loop clock + fade +
	 * elapsed). The native source does the playback; the processor shadows its
	 * position, so the anchor is re-sent on play, resume and every rate/loop
	 * change. Creates the node on first use.
	 *
	 * @param restart - re-arm the intro fade. Only a genuine (re)start of playback
	 * should pass `true`; the live re-anchors sent while dragging rate/loop must
	 * not, or the fade (a ramp up from 0) would be re-armed at drag frequency and
	 * chop the gain instead of covering a single start.
	 */
	_anchorChannel(restart = false): void {
		if (!this._playing || this._paused || this._rate <= 0) return;
		const looping = this._loop && this._loopEnd > this._loopStart;
		if (!looping && !this._emitElapsed) return;
		const node = this._channelNode;
		if (!node) return void this._ensureChannelNode();
		const now = this.context.currentTime;
		// playhead at `now`, from the same base the old scheduler used
		const startPos = (now - this._startedAt) * this._rate + this._offset;
		node.port.postMessage({
			type: 'start',
			restart,
			startTime: now,
			startPos,
			loop: looping,
			loopStart: this._loopStart,
			loopEnd: this._loopEnd,
			rate: this._rate,
			fadeDur: this._loopFadeDur,
			delay: this._chainDelay,
			elapsed: this._emitElapsed,
			elapsedPeriod: 0.03,
		});
	}

	/** Tell the channel processor to stop counting/fading/reporting. */
	_stopChannel(): void {
		if (this._channelNode) this._channelNode.port.postMessage({ type: 'stop' });
	}

	/**
	 * Get or set the 4-band channel EQ (applied in the channel processor, after
	 * the effects and before the panner).
	 *
	 * - `eq()` → all four bands (a copy).
	 * - `eq(band)` → one band.
	 * - `eq(band, options)` → merge the given fields into one band and return it.
	 *
	 * Bands are 0–3; frequencies are Hz (20–20000), gain in dB (±18), Q 0.1–10,
	 * and `type` is one of lowshelf/peaking/highshelf/lowpass/highpass. Enabling
	 * a band lazily creates the channel node if needed.
	 */
	eq(band?: number, options?: EqBandOptions): EqBand | EqBand[] | undefined {
		if (band === undefined) return this._eq.map((b) => ({ ...b }));
		if (!(band >= 0 && band < 4)) return undefined;
		const b = this._eq[band];
		if (options === undefined) return { ...b };

		if (options.on !== undefined) b.on = !!options.on;
		if (options.type !== undefined && EQ_TYPES.indexOf(options.type) > -1) b.type = options.type;
		if (options.frequency !== undefined) b.frequency = clampNumber(options.frequency, 20, 20000);
		if (options.gain !== undefined) b.gain = clampNumber(options.gain, -18, 18);
		if (options.q !== undefined) b.q = clampNumber(options.q, 0.1, 10);

		this._sendEqBand(band);
		// enabling a band (or moving it) needs the channel node in the chain even
		// when the sound neither loops nor reports elapsed
		if (!this._channelNode) this._ensureChannelNode();
		this.emit('eq', this.id, band, { ...b });
		this.emitState('eq');
		return { ...b };
	}

	/** Merge a saved EQ config (from a model/preset) into the current bands. */
	_applyEqConfig(bands: EqBandOptions[]): void {
		for (let i = 0; i < 4 && i < bands.length; i++) {
			const src = bands[i];
			if (!src || typeof src !== 'object') continue;
			const b = this._eq[i];
			if (src.on !== undefined) b.on = !!src.on;
			if (src.type !== undefined && EQ_TYPES.indexOf(src.type) > -1) b.type = src.type;
			if (src.frequency !== undefined) b.frequency = clampNumber(src.frequency, 20, 20000);
			if (src.gain !== undefined) b.gain = clampNumber(src.gain, -18, 18);
			if (src.q !== undefined) b.q = clampNumber(src.q, 0.1, 10);
		}
	}

	/** Push the whole 4-band EQ to the channel processor (on creation). */
	_sendEq(): void {
		if (!this._channelNode) return;
		this._channelNode.port.postMessage({
			type: 'eqAll',
			bands: this._eq.map((b) => ({
				on: b.on,
				type: b.type,
				frequency: b.frequency,
				gain: b.gain,
				q: b.q,
			})),
		});
	}

	/** Push one band to the channel processor. */
	_sendEqBand(band: number): void {
		if (!this._channelNode) return;
		const b = this._eq[band];
		this._channelNode.port.postMessage({
			type: 'eq',
			band,
			on: b.on,
			eqType: b.type,
			frequency: b.frequency,
			gain: b.gain,
			q: b.q,
		});
	}

	/** Create the channel processor node on demand; re-anchors once it exists. */
	_ensureChannelNode(): void {
		if (this._channelNode || this._channelNodeFailed || this._channelNodePending) return;
		this._channelNodePending = true;
		ensureEffectsWorklet(this.context)
			.then(() => {
				if (this._destroyed) return;
				const base: AudioWorkletNodeOptions = {
					numberOfInputs: 1,
					numberOfOutputs: 1,
				};
				let node: AudioWorkletNode;
				try {
					node = new AudioWorkletNode(this.context, 'channel', {
						...base,
						outputChannelCount: [2],
					});
				} catch (err) {
					node = new AudioWorkletNode(this.context, 'channel', base);
				}
				node.port.onmessage = (e) => this._onChannelMessage(e.data);
				this._channelNode = node;
				this._channelNodePending = false;
				try {
					// only rewire if a chain is already up (e.g. a solo-excluded
					// sound never connected)
					if (this._connected) this._rebuildChain();
					// the node starts `started: false`, so it fades in regardless
					this._anchorChannel();
					this._sendEq();
					this._sendGain();
					// the meters tap the strip's real level: re-point the per-sound
					// analysers at the processor (post-EQ, post-gain-trim), the
					// same re-point a node swap already performs
					this.engine.setAnalysersNode(this.id, node);
				} catch (err) {
					console.error('channel processor wiring failed', err);
				}
			})
			.catch((err) => {
				console.error('channel processor unavailable', err);
				this._channelNodePending = false;
				this._channelNodeFailed = true;
			});
	}

	/** Handle a channel-processor message: the wrap pulse and the playhead. */
	_onChannelMessage(data: { type?: string; value?: number }): void {
		if (!data) return;
		if (data.type === 'loopend') {
			// re-anchor the main-thread playhead to the wrap, as the old
			// scheduler did (`_startedAt = wrap`), so pause()/jump() keep a
			// bounded, loop-local position instead of counting from the start
			if (this._playing && !this._paused) {
				this._startedAt = this.context.currentTime;
				this._offset = this._loopStart;
			}
			this.emit('loopend', true);
		} else if (data.type === 'elapsed') {
			this._elapsed = data.value as number;
			this.emit('elapsed', this._elapsed);
		}
	}
	/** Stop playback: halt the source, stop the channel processor and emit. */
	stop() {
		if (!this.source) return;

		this._clearElapsed();
		this._stopChannel();
		clearTimeout(this.fadeOutTimeout);
		clearTimeout(this.fadeInTimeout);

		if (this.source && this._playing) this.source.stop();

		//if (!this.spillOver) this.effects.filter((e) => !e.bypassed).forEach((e) => e.effect.disconnect())

		this._pausedAt = 0;
		this._paused = false;
		this._startedAt = 0;
		this._playing = false;
		this._emit('ended');
		this._emit('stop');
		this._emit('playing', false);
	}
	/** Emit both the `state` snapshot and the `<event>` event (with this id). */
	_emit(event: string, val?: unknown, val2?: unknown): void {
		this.emitState(event, val);
		this.emit(event, this.id, val, val2);
	}
	/**
	 * Emit the full `state` snapshot. An object `val` is merged into the `_`
	 * fields (the object form of `_emit`), otherwise `val` is recorded under the
	 * event key. The `effects` chain is only included for chain-changing events.
	 */
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
				// the EQ array is only carried on `eq` events (kept off the
				// high-frequency scalar updates)
				...(event === 'eq' ? { eq: this._eq.map((b) => ({ ...b })) } : {}),
				error: this._error,
				_event: event,
			},
			updated,
		);
	}
	/** Serialize the settings that survive a save/load or preset round-trip. */
	getSaveState() {
		return {
			volume: this._volume,
			gain: this._gain || 0,
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
			eq: this._eq.map((b) => ({ ...b })),
			effects: this._currentEffectParams(),
		};
	}
	/** Stop, reset every setting to its default and re-apply them to the graph. */
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
		this._eq = defaultEq();
		this._sendEq();
		this._sendGain();
		this._emit('reset', this.id);
	}

	/** Source `ended` handler: clear playing (non-loop) and re-emit `ended`. */
	onEnded() {
		this._startedAt = 0;
		if (!this._loop) {
			this._playing = false;
			this._emit('playing', false);
			// the processor would otherwise keep reporting elapsed past the end
			this._stopChannel();
			if (this._emitElapsed) this._clearElapsed();
		}
		this.emit('ended');
	}
	/**
	 * Pause (`on = true`) or resume playback. Pausing stops the source and
	 * remembers the position; resuming calls `play({ start: pausedAt })`.
	 * @returns the resulting paused flag.
	 */
	pause(on?: boolean): boolean {
		if (on) {
			// stop the loop clock while paused; resume (play) re-anchors it
			this._stopChannel();
			if (this.source) {
				// absolute buffer position at `now`, from the same clock the
				// loop scheduler uses (`_anchorChannel`), wrapped into the loop
				// window — so a resume lands exactly where it paused, at any
				// rate and with a loop selection
				const elapsed = this._startedAt
					? (this.context.currentTime - this._startedAt) * this._rate
					: 0;
				let pos = this._offset + elapsed;
				if (this._loop && this._loopEnd > this._loopStart) {
					const span = this._loopEnd - this._loopStart;
					pos = this._loopStart + ((((pos - this._loopStart) % span) + span) % span);
				}
				this._pausedAt = Math.max(0, pos);
				// detach the source's onended before stopping it: `source.stop()`
				// fires `ended`, which would leak a synthetic engine 'ended' here
				// (stopping the channel processor + emitting ended while merely
				// paused). play() re-attaches it on resume.
				this.source.removeEventListener('ended', this.onEnded);
				if (!this._loop && this._playing) {
					this._playing = false;
					this._emit('playing', false);
				}
				this.source.stop();
			}
			this._paused = true;
		} else {
			// resume only if we were actually paused; `play()` delegates here
			// when it sees `_paused`, so this must always start playback — even
			// with `_pausedAt === 0` (paused at the very start, or a stop() that
			// cleared the position), which used to be swallowed silently
			const wasPaused = this._paused;
			this._paused = false;
			if (wasPaused) {
				const start = this._pausedAt;
				this._pausedAt = 0;
				this.play({ start });
			}
		}

		this._emit('pause', this._paused);
		return this._paused;
	}

	/** Restart playback at `sec` seconds (pause then play from that offset). */
	jump(sec: number): void {
		const nextTime = this.context.currentTime - this._startedAt + sec * 1;
		this.pause();
		this.play({
			start: nextTime >= 0 ? nextTime : 0,
		});
	}
	/**
	 * Get the mute flag (no arg) or set it. Muting ramps the output gain to 0
	 * rather than rewiring the graph (avoids clicks during fast toggles).
	 */
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

	// effective output gain = the volume fader (0 while muted). The channel
	// gain trim lives in the channel processor, applied post-fade (after the
	// EQ), so the two levels don't fight.
	_targetGain() {
		return this._muted ? 0 : this._volume;
	}
	// state-based smoothing: repeated calls just move the target, so fast
	// parameter updates (mouse moves) converge without zipper noise
	_applyGain() {
		if (!this.node) return;
		const now = this.context.currentTime;
		// a splice envelope owns the gain until it finishes; a volume change that
		// lands mid-dip is dropped (callers re-issue it as they continue to set
		// the value, and the envelope ends within ~10ms)
		if (this._spliceEnds && now < this._spliceEnds) return;
		this._spliceEnds = 0;
		this.node.gain.setTargetAtTime(this._targetGain(), now, 0.02);
	}

	/** Get (no arg) or set the channel volume (0–1); always re-applies the gain. */
	volume(vol?: number): number {
		if (vol !== undefined) this._volume = vol;
		this._applyGain();
		this._emit('volume', this._volume);
		return this._volume;
	}
	/**
	 * Get (no arg) or set the channel gain trim, in dB (−24 … +12; 0 = unity).
	 *
	 * Applied in the channel processor (after the EQ, before the panner), so
	 * it is a post-fade trim that does not fight the volume fader, the mute
	 * ramp or the loop anti-click gain — all of which live on the volume node.
	 * The first non-default set lazily creates the channel node (like `eq()`).
	 */
	gain(gainIn?: number): number {
		if (gainIn !== undefined) {
			this._gain = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Number(gainIn) || 0));
			if (this._channelNode) this._sendGain();
			else this._ensureChannelNode();
		}
		this._emit('gain', this._gain);
		return this._gain;
	}

	/** Push the channel gain trim (dB) to the channel processor. */
	_sendGain(): void {
		if (!this._channelNode) return;
		this._channelNode.port.postMessage({
			type: 'gain',
			db: Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Number(this._gain) || 0)),
		});
	}
	/**
	 * Get (no arg) or set the playback rate. While playing, a set rate is
	 * ramped on the source and the loop scheduler is re-anchored.
	 */
	rate(rate?: number): number {
		if (rate !== undefined && this.source && this._rate !== rate) {
			// ramp from the *live* value: cancelling to `this._rate` (the previous
			// target) snapped the playhead back whenever a prior ramp was still in
			// flight, stepping the pitch/tempo
			const now = this.context.currentTime;
			const from = this.source.playbackRate.value;
			this.source.playbackRate.cancelScheduledValues(now);
			this.source.playbackRate.setValueAtTime(from, now);
			this.source.playbackRate.linearRampToValueAtTime(rate, now + 0.05);
		}

		this._rate = rate !== undefined ? Number(rate) : this._rate;
		this._emit('rate', this._rate);
		// re-anchor the channel processor in place (no timer churn while dragging)
		this._anchorChannel();
		return this._rate;
	}

	/**
	 * Tempo-preserving pitch shift, in semitones (0 = original, ±24 = ±2
	 * octaves). Runs the source through the Signalsmith Stretch worklet
	 * inserted between the source and the effects, so duration, loop points
	 * and rate are untouched. The node is created on demand, or eagerly at
	 * construction when the engine's `preloadPitch` option is set.
	 *
	 * The node is wired in when the pitch first leaves 0 and then stays in the
	 * path for the rest of the playback — returning to 0 glides the shifter to
	 * unity rather than removing it. Removing a latency-carrying Stretch node
	 * mid-playback jumps the signal by its latency and clicks; keeping it in
	 * makes flattening silent (at the cost of the shifter's latency until the
	 * next play, which starts dry again).
	 *
	 * Wiring it in mid-playback is also done without a seam: the chain is rebuilt
	 * as a parallel dry/wet pair and crossfaded once the shifter has primed
	 * (see {@link _engagePitchLive}), instead of a hard insert that drops the
	 * shifter's latency of audio and clicks when the signal returns.
	 *
	 * The shifter's latency equals its block size, set from `pitchBlockMs` (see
	 * AudioEngineOptions) and defaulting to 40 ms rather than the library's 120.
	 */
	pitch(semitones?: number): number {
		if (semitones !== undefined) {
			const next = Math.max(-24, Math.min(24, Number(semitones)));
			const wasEngaged = this._pitchEngaged;
			this._pitch = isNaN(next) ? 0 : next;
			this._pitchActive = Math.abs(this._pitch) > 0.01;

			if (this._pitchActive) {
				this._pitchEngaged = true;
				if (!this._pitchNode) this._ensurePitchNode();
				else if (this.source && !wasEngaged) {
					// bring a warm shifter into a live path via the dry/wet
					// crossfade rather than a hard insert (see _engagePitchLive);
					// adopt its delay so the loop fade stays aligned
					this._chainDelay = this._pitchLatency;
					this._engagePitchLive();
				}
			}
			// flattening does NOT disconnect the node — see the method doc
			this._applyPitch();
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
			.then(async (stretch) => {
				this._stretch = stretch;
				this._pitchNode = stretch;
				this._pitchPending = false;
				if (stretch.start) stretch.start();
				this._scheduleStretch();
				// Apply this sound's block size BEFORE reading the latency: the
				// shifter's round-trip latency *is* its block size, so the value
				// read below (and everything downstream — the loop-fade placement
				// and the crossfade priming) depends on configuring it first.
				if (stretch.configure && this._pitchBlockMs) {
					try {
						await stretch.configure({ blockMs: this._pitchBlockMs });
					} catch (e) {
						// keep the library default if the config is rejected
					}
				}
				// Read the shifter's delay *before* wiring it in: the channel
				// processor needs it to place the loop fade on the audible wrap,
				// and the crossfade below needs it to wait out the primer. This
				// is a remote call (async), so the wiring is deferred to it.
				let seconds = 0;
				if (stretch.latency) {
					try {
						seconds = await stretch.latency();
					} catch (e) {
						seconds = 0;
					}
				}
				const next = typeof seconds === 'number' && seconds > 0 ? seconds : 0;
				this._pitchLatency = next;
				// only in force while the shifter is actually engaged
				const applied = this._pitchEngaged ? next : 0;
				const changed = applied !== this._chainDelay;
				if (changed) this._chainDelay = applied;
				if (this.source && this._pitchEngaged) {
					this._engagePitchLive();
					if (changed) this._anchorChannel();
				} else if (changed) {
					this._anchorChannel();
				}
			})
			.catch((err) => {
				console.error('signalsmith-stretch unavailable', err);
				this._pitchPending = false;
				this._pitchNodeFailed = true;
			});
		return this._pitchNode;
	}

	/**
	 * Set the stereo pan in degrees (-90 = hard left, 90 = hard right) on the
	 * panner, moving both position axes together.
	 * @returns the computed `{ x, z }` panner position.
	 */
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
	/**
	 * Get the loop flag (no arg) or enable/disable looping with optional
	 * `{ start, end }` bounds (seconds). Re-anchors the channel processor.
	 */
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
			// keep elapsed reporting if it is still wanted, otherwise stop the
			// processor (so it stops looping/fading the now non-looping source)
			if (this._playing && !this._paused && this._emitElapsed) this._anchorChannel();
			else this._stopChannel();
		} else if (this._playing && !this._paused) {
			this._anchorChannel();
		}
		this._emit('loop', on);
		return this._loop;
	}

	/**
	 * Get the reversed flag (no arg) or reverse/un-reverse the decoded buffer in
	 * place. Bumps the buffer version so cached peaks are invalidated.
	 *
	 * A running AudioBufferSourceNode keeps rendering the buffer it was started
	 * with, so an in-place flip would not be heard until the next play();
	 * playback is re-triggered from the current playhead so the change is
	 * audible immediately.
	 */
	reverse(on?: boolean): unknown {
		if (on === undefined) return this._reversed;
		if (!this.buffer) return;
		const changed = (on && !this._reversed) || (!on && this._reversed);
		if (on && !this._reversed) reverse(this.buffer);
		if (!on && this._reversed) reverse(this.buffer);
		this._bufferVersion++;
		this._reversed = on;
		this._emit('reversed', on);
		this.emit('change');
		// swap the live source so the flip is heard without waiting for the next
		// natural play (see the method doc)
		if (changed && this.source && this._playing && !this._paused) this._replayFromPosition();
	}

	/**
	 * Re-trigger playback from the current playhead. Used when the decoded buffer
	 * is mutated in place mid-playback (reverse): the running source keeps
	 * rendering the buffer it started with, so the mutation is otherwise
	 * inaudible until the next natural play. `play()` rebuilds the source and
	 * splice-fades the seam so the restart is click-free.
	 */
	_replayFromPosition(): void {
		const now = this.context.currentTime;
		let pos = (now - this._startedAt) * this._rate + this._offset;
		if (this._loop && this._loopEnd > this._loopStart) {
			// keep the playhead inside the loop window (works for negative
			// values too, unlike a plain % remainder)
			const span = this._loopEnd - this._loopStart;
			pos = this._loopStart + ((((pos - this._loopStart) % span) + span) % span);
		} else if (this._duration > 0) {
			pos = Math.min(Math.max(0, pos), this._duration);
		}
		this.play({ start: Math.max(0, pos), enableElapsed: this._emitElapsed });
	}
	/**
	 * Replace the buffer with the `[start, end)` seconds range (mono, channel 0),
	 * bump the version and emit the new duration.
	 */
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

	/**
	 * Get the solo flag (no arg) or set it. `mute` (optional) also applies the
	 * mute state that accompanies the solo change.
	 */
	solo(on?: boolean, mute?: boolean): boolean | void {
		if (on === undefined) return this._solo;
		this.mute(mute);
		this._solo = on;
		this._emit('solo', on);
		return this._solo;
	}
	/** Get the locked flag (no arg) or set it (locked columns ignore global edits). */
	lock(on?: boolean): boolean | void {
		if (on === undefined) return this._locked;
		this._locked = on;
		this._emit('locked', on);
	}
	/** Raw buffer duration in seconds (not adjusted for rate/loop). */
	duration() {
		return this._duration;
	}
	/** Audible duration: the loop length (when looping) divided by the rate. */
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
	/** Mark the sound as actively sampling (drives the UI state/events). */
	sampling(on: boolean): void {
		this._sampling = on;
		this._emit('sampling', on);
	}

	/**
	 * Fetch and decode the audio file at `url` (or the current url). Handles
	 * data: URLs, XHR loading and the reverse-on-decode case; emits
	 * `loading`/`ready`/`loaded`/`loaderror` as it progresses.
	 */
	load(url?: string): void {
		this._clearElapsed();
		this._stopChannel();
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
	/**
	 * Decode a copied ArrayBuffer into an AudioBuffer, apply the reversed flag,
	 * store the raw bytes (`_buffer`, used by save/export) and emit ready/loaded.
	 * On failure emits `loaderror` and clears the loaded state.
	 */
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
	/** Guess a MIME type from the file extension (mp3/wav/m4a; mp3 fallback). */
	urlToMimeType(url?: string | null): string | null {
		if (!url) return 'audio/mpeg';
		const src = url.toLowerCase();
		if (src.endsWith('.mp3')) return 'audio/mpeg';
		else if (src.endsWith('.wav')) return 'audio/wav';
		else if (src.endsWith('.m4a')) return 'audio/mp4';
		else return null;
	}
	/** Record the MIDI note mapped to this sound and emit `midinote`. */
	midiNote(number: number): void {
		this._midiNote = number;
		this._emit('midinote', number);
	}
	/** Toggle MIDI-learn mode for this sound and emit `midimapmode`. */
	midiMapMode(on: boolean): void {
		this._midiMapMode = on;
		this._emit('midimapmode', on);
	}
	/** Tear down nodes/listeners so a destroyed sound cannot be played or emit. */
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
		this._stopChannel();
		if (this._channelNode) {
			try {
				this._channelNode.disconnect();
			} catch (e) {}
			this._channelNode = null;
		}
		clearTimeout(this.fadeOutTimeout);
	}
	/** Debug logger (no-op unless `DEBUG` is on). */
	log() {
		if (!this.DEBUG) return;
		//let caller_line = (new Error).stack.split("\n")[4]
		console.log('Sound.js', this.id, Array.prototype.slice.call(arguments).join(' '));
	}
	/** Reserved error hook (kept for API compatibility; currently a no-op). */
	error(err: unknown): void {
		void err;
	}
}

export default Sound;
