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
	paused: boolean;
	stopped: boolean;
	recording: boolean;
	sampling: boolean;
	solo: boolean;
	midiMapMode: boolean;
	pan: number;
}

class Master {
	engine: AudioEngine;
	state: MasterState;
	elapsedInterval: ReturnType<typeof setInterval> | null = null;

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
			paused: false,
			stopped: true,
			recording: false,
			sampling: false,
			solo: false,
			midiMapMode: false,
			pan: 0,
		};
	}

	stop() {
		this._clearElapsed();
		this.engine.sounds.forEach((s) => this.engine.stop(s.id));
		this.engine.emit('stopall');
		this.engine.emitMasterState({ stopped: true, playing: true });
		this._updateDuration();
	}

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

	isPlaying() {
		return this.engine.sounds.filter((s) => s.sound._playing).length > 0;
	}

	mute(on: boolean) {
		this.engine.sounds.forEach((s) => {
			this.engine.mute(s.id, on);
		});
		this.engine.emit('muteall', on);
		this.engine.emitMasterState({ muted: on });
		return this.state.muted;
	}

	muted() {
		// `sound.muted` is the method reference (always truthy) — the state flag
		// is `_muted`. True only when every sound is muted.
		return !this.engine.sounds.some((s) => !s.sound._muted);
	}

	pause(on: boolean) {
		this.engine.sounds.forEach((s) => this.engine.pause(s.id, on));
		this.engine.emit('pauseall', on);
		this.engine.emitMasterState({ paused: on, playing: this.isPlaying() });
	}

	loop(on?: boolean) {
		if (on === undefined) return this.state.looping;

		this.engine.sounds.forEach((s) => {
			s.sound.loop(on);
		});
		this.engine.emit('loopall', on);
		this.engine.emitMasterState({ looping: on });
		return this.state.looping;
	}

	volume(vol?: number) {
		if (vol === undefined) return this.state.volume;
		const next = Number(vol);
		if (!Number.isFinite(next)) return this.state.volume;
		// smooth like every other level (Sound.volume) instead of a hard
		// `.value` write, and accept 0 (the old `if (vol)` dropped it)
		this.engine.masterGain.gain.setTargetAtTime(
			next,
			this.engine.context.currentTime,
			0.02,
		);
		this.engine._volume = next;
		this.engine.emit('mastervolume', next);
		this.engine.emitMasterState({ volume: next });
		return next;
	}

	pan(deg: number) {
		this.engine.emitMasterState({ pan: deg });
		return this.state.pan;
	}

	rate(rate: number) {
		this.engine.sounds.forEach((s) => s.sound.rate(rate));
		this.engine.emitMasterState({ rate: rate });
		this._updateDuration();
		return 0;
	}

	jump(sec: number) {
		this.engine.sounds.forEach((s) => s.sound.jump(sec));
		this.engine.emitMasterState();
		return sec;
	}

	locked(on?: boolean) {
		if (on !== undefined) {
			this.engine.sounds.forEach((s) => s.sound.lock(on));
			this.engine.emitMasterState({ locked: on });
		}
		return this.engine.sounds.filter((s) => s.sound._locked).length > 0;
	}

	duration() {
		let duration = 0;
		this.engine.sounds.forEach((s) => {
			if (s.sound.realDuration() > duration) duration = s.sound.realDuration();
		});
		return duration;
	}

	solo() {
		return this.engine.sounds.filter((s) => s.sound._solo).length > 0;
	}

	reset() {
		this.engine.sounds.forEach((s) => s.sound.reset());
		this._updateDuration();
	}

	_checkElapsed() {
		if (!this.state.playing) return this._clearElapsed();

		const elapsed = this.engine.context.currentTime - this.state.startedAt;
		const masterDur = this.duration();
		const el = masterDur > elapsed ? elapsed : masterDur;
		this.engine.emit('masterelapsed', el);
	}

	_clearElapsed() {
		if (this.elapsedInterval) clearInterval(this.elapsedInterval);
		this.elapsedInterval = null;
		this.engine.emitMasterState({ elapsed: 0, startedAt: 0 });
	}

	_updateDuration() {
		const dur = this.duration();
		this.engine.emitMasterState({ duration: dur });
	}
}

export default Master;