/**
 * Master transport controller. Extracted from AudioEngine so the engine
 * class no longer carries a ~160-line inline object. Every method keeps the
 * exact same behavior (including events and masterstate emission), with
 * engine access via `this.engine`.
 */
import type AudioEngine from './audioengine';

/** Broadcast transport state (engine.master.state / masterstate events). */
export interface MasterState {
	volume: number;
	startedAt: number;
	elapsed: number;
	duration: number;
	rate: number;
	locked: boolean;
	muted: boolean;
	playing: boolean;
	looping: boolean;
	reversed: boolean;
	paused: boolean;
	stopped: boolean;
	recording: boolean;
	sampling: boolean;
	solo: boolean;
	midiMapMode: boolean;
	pan: number;
}

/**
 * Transport controller for the whole engine: play/stop/pause every sound,
 * master mute/volume/rate/loop and the aggregate state broadcast as
 * `masterstate`. Owned by the engine (`engine.master`).
 */
class Master {
	engine: AudioEngine;
	state: MasterState;
	/** interval driving `masterelapsed` while playing (or null) */
	elapsedInterval: ReturnType<typeof setInterval> | null = null;

	/** Create the effect instance (stores engine + initial options). */
	constructor(engine: AudioEngine, initialVolume: number) {
		this.engine = engine;
		this.state = {
			volume: initialVolume,
			startedAt: 0,
			elapsed: 0,
			duration: 0,
			rate: 1.0,
			locked: false,
			muted: false,
			playing: false,
			looping: false,
			reversed: false,
			paused: false,
			stopped: true,
			recording: false,
			sampling: false,
			solo: false,
			midiMapMode: false,
			pan: 0,
		};
	}

	/** Stop every sound, emit `stopall` and refresh the aggregate duration. */
	stop() {
		this._clearElapsed();
		this.engine.sounds.forEach((s) => this.engine.stop(s.id));
		this.engine.emit('stopall');
		this.engine.emitMasterState({ stopped: true, playing: true });
		this._updateDuration();
	}

	/**
	 * Play every sound, emit `playall` and start the elapsed timer when
	 * requested (per-call or engine-wide with `enableElapsed`).
	 */
	play(opt = { enableElapsed: false }) {
		this.engine.sounds.forEach((s) => this.engine.play(s.id));
		this.engine.emit('playall');
		this.engine.emitMasterState({
			stopped: false,
			playing: true,
			startedAt: this.engine.context.currentTime,
			duration: this.duration(),
		});
		if (opt.enableElapsed || this.engine.enableElapsed) {
			// don't leak elapsed intervals: clear any previous one first
			if (this.elapsedInterval) clearInterval(this.elapsedInterval);
			this.elapsedInterval = setInterval(() => this._checkElapsed(), 50);
		}
	}

	/** True while at least one sound is playing. */
	isPlaying() {
		return this.engine.sounds.filter((s) => s.sound._playing).length > 0;
	}

	/** Mute/unmute every sound; returns the master muted flag. */
	mute(on: boolean) {
		this.engine.sounds.forEach((s) => {
			this.engine.mute(s.id, on);
		});
		this.engine.emit('muteall', on);
		this.engine.emitMasterState({ muted: on });
		return this.state.muted;
	}

	/** True only when every sound is muted (empty grid counts as muted). */
	muted() {
		// `sound.muted` is the method reference (always truthy) — the state flag
		// is `_muted`. True only when every sound is muted.
		return !this.engine.sounds.some((s) => !s.sound._muted);
	}

	/** Pause/resume every sound; emits `pauseall`. */
	pause(on: boolean) {
		this.engine.sounds.forEach((s) => this.engine.pause(s.id, on));
		this.engine.emit('pauseall', on);
		this.engine.emitMasterState({ paused: on, playing: this.isPlaying() });
	}

	/** Get (no arg) or set the master loop flag; emits `loopall`. */
	loop(on?: boolean) {
		if (on === undefined) return this.state.looping;

		this.engine.sounds.forEach((s) => {
			s.sound.loop(on);
		});
		this.engine.emit('loopall', on);
		this.engine.emitMasterState({ looping: on });
		return this.state.looping;
	}

	/**
	 * Get (no arg) or set the master reverse flag: every sound's buffer is
	 * flipped in one call (per-sound granular control stays on
	 * `engine.reverse(id, on)`).
	 */
	reverse(on?: boolean) {
		if (on === undefined) return this.state.reversed;

		this.engine.sounds.forEach((s) => {
			this.engine.reverse(s.id, on);
		});
		this.engine.emit('reverseall', on);
		this.engine.emitMasterState({ reversed: on });
		return this.state.reversed;
	}

	/** Get (no arg) or ramp the master output volume (0–1). */
	volume(vol?: number) {
		if (vol === undefined) return this.state.volume;
		const next = Number(vol);
		if (!Number.isFinite(next)) return this.state.volume;
		// smooth like every other level (Sound.volume) instead of a hard
		// `.value` write, and accept 0 (the old `if (vol)` dropped it)
		this.engine.masterGain.gain.setTargetAtTime(next, this.engine.context.currentTime, 0.02);
		this.engine._volume = next;
		this.engine.emit('mastervolume', next);
		this.engine.emitMasterState({ volume: next });
		return next;
	}

	/** Record a master pan value in the state (no audible effect yet). */
	pan(deg: number) {
		this.engine.emitMasterState({ pan: deg });
		return this.state.pan;
	}

	/** Apply a playback rate to every sound and refresh the duration. */
	rate(rate: number) {
		this.engine.sounds.forEach((s) => s.sound.rate(rate));
		this.engine.emitMasterState({ rate: rate });
		this._updateDuration();
		return 0;
	}

	/** Jump every sound to `sec` seconds. */
	jump(sec: number) {
		this.engine.sounds.forEach((s) => s.sound.jump(sec));
		this.engine.emitMasterState();
		return sec;
	}

	/** Get (no arg) or set the locked flag on every sound. */
	locked(on?: boolean) {
		if (on !== undefined) {
			this.engine.sounds.forEach((s) => s.sound.lock(on));
			this.engine.emitMasterState({ locked: on });
		}
		return this.engine.sounds.filter((s) => s.sound._locked).length > 0;
	}

	/** Longest real (rate/loop-adjusted) duration across all sounds. */
	duration() {
		let duration = 0;
		this.engine.sounds.forEach((s) => {
			if (s.sound.realDuration() > duration) duration = s.sound.realDuration();
		});
		return duration;
	}

	/** True while at least one sound is soloed. */
	solo() {
		return this.engine.sounds.filter((s) => s.sound._solo).length > 0;
	}

	/** Reset every sound to its defaults and refresh the duration. */
	reset() {
		this.engine.sounds.forEach((s) => s.sound.reset());
		this._updateDuration();
	}

	/** Emit `masterelapsed` (clamped to the master duration) on each tick. */
	_checkElapsed() {
		if (!this.state.playing) return this._clearElapsed();

		const elapsed = this.engine.context.currentTime - this.state.startedAt;
		const masterDur = this.duration();
		const el = masterDur > elapsed ? elapsed : masterDur;
		this.engine.emit('masterelapsed', el);
	}

	/** Stop the elapsed timer and reset elapsed/startedAt in the state. */
	_clearElapsed() {
		if (this.elapsedInterval) clearInterval(this.elapsedInterval);
		this.elapsedInterval = null;
		this.engine.emitMasterState({ elapsed: 0, startedAt: 0 });
	}

	/** Recompute and broadcast the aggregate duration. */
	_updateDuration() {
		const dur = this.duration();
		this.engine.emitMasterState({ duration: dur });
	}
}

export default Master;
