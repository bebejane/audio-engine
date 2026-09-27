// @ts-nocheck
/**
 * Automation — records every engine state change and plays it back on a loop.
 *
 * Capture works by wrapping the engine's public mutating methods (sound
 * params, effects, transport) and the master's methods, so any change made
 * through the engine — mouse gestures, knobs, MIDI, preset restores — is
 * recorded as `{ t, target, method, args }` and replayed by calling the exact
 * same method with the same arguments. Replay calls are flagged (`replaying`)
 * so they are not captured again.
 *
 * Timing is relative to the record start; playback loops over the recorded
 * duration with a single `setInterval` scheduler.
 */

// engine methods whose calls are recorded (getters are intentionally excluded)
const ENGINE_METHODS = [
	'volume',
	'gain',
	'pan',
	'rate',
	'pitch',
	'mute',
	'unmute',
	'solo',
	'loop',
	'reverse',
	'lock',
	'play',
	'stop',
	'pause',
	'unpause',
	'reset',
	'enableEffects',
	'disableEffects',
	'addEffect',
	'removeEffect',
	'moveEffect',
	'effectBypass',
	'effectParams',
];

// master (transport) methods worth automating
const MASTER_METHODS = ['volume', 'mute', 'loop', 'locked', 'play', 'stop', 'pause'];

const TICK_MS = 16;
/** minimum loop length, so a single quick change doesn't spin */
const MIN_DURATION = 300;

/** shallow-copy object/array args so later mutation can't corrupt the take */
function copyArg(value) {
	if (Array.isArray(value)) return value.slice();
	if (value && typeof value === 'object') return { ...value };
	return value;
}

let uid = 0;

export default class Automation {
	engine;
	/** recorded calls: { t, target, method, args } */
	events = [];
	recording = false;
	playing = false;
	/** true while replaying, so wrapped calls don't re-record */
	replaying = false;
	_t0 = 0;
	_duration = 0;
	_timer = null;
	_installed = false;
	_id = ++uid;

	constructor(engine) {
		this.engine = engine;
	}

	/** wrap the engine/master mutators once */
	install() {
		if (this._installed) return;
		this._installed = true;
		this._wrap(this.engine, 'engine', ENGINE_METHODS);
		if (this.engine.master) this._wrap(this.engine.master, 'master', MASTER_METHODS);
	}

	_wrap(obj, target, names) {
		const self = this;
		names.forEach((name) => {
			const orig = obj[name];
			if (typeof orig !== 'function') return;
			obj[name] = function (...args) {
				if (self.recording && !self.replaying) {
					self.events.push({
						t: performance.now() - self._t0,
						target,
						method: name,
						args: args.map(copyArg),
					});
				}
				return orig.apply(this, args);
			};
		});
	}

	get count() {
		return this.events.length;
	}

	/** toggle/arm recording; returns the new recording flag */
	record(on) {
		const next = on === undefined ? !this.recording : !!on;
		if (next === this.recording) return this.recording;
		if (next) {
			this.stopPlayback();
			this.events = [];
			this._t0 = performance.now();
			this.recording = true;
		} else {
			this.recording = false;
			const last = this.events.length ? this.events[this.events.length - 1].t : 0;
			this._duration = Math.max(performance.now() - this._t0, last + MIN_DURATION);
		}
		this._changed();
		return this.recording;
	}

	/** toggle/arm looped playback; returns the new playing flag */
	play(on) {
		const next = on === undefined ? !this.playing : !!on;
		if (next) {
			if (!this.events.length) return false;
			if (this.recording) this.record(false);
			// start from a clean transport: the take (and whatever play/stop it
			// recorded) owns playback, so sounds left running don't fight it
			if (this.engine.master) this.engine.master.stop();
			this.playing = true;
			this._start();
		} else {
			this.stopPlayback();
		}
		this._changed();
		return this.playing;
	}

	stopPlayback() {
		if (this._timer !== null) {
			clearInterval(this._timer);
			this._timer = null;
		}
		this.replaying = false;
		this.playing = false;
	}

	/** drop the take and stop everything (e.g. when a new model is loaded) */
	clear() {
		this.stopPlayback();
		this.recording = false;
		this.events = [];
		this._duration = 0;
		this._changed();
	}

	_start() {
		const self = this;
		const duration = this._duration || MIN_DURATION;
		let index = 0;
		let prev = 0;
		this.replaying = true;
		const start = performance.now();
		this._timer = setInterval(() => {
			const elapsed = (performance.now() - start) % duration;
			// the loop wrapped — start firing from the top again
			if (elapsed < prev) index = 0;
			prev = elapsed;
			while (index < self.events.length && self.events[index].t <= elapsed) {
				self._apply(self.events[index]);
				index++;
			}
		}, TICK_MS);
	}

	_apply(event) {
		const obj = event.target === 'master' ? this.engine.master : this.engine;
		const fn = obj && obj[event.method];
		if (typeof fn === 'function') fn.apply(obj, event.args);
	}

	_changed() {
		this.engine.emit('automation', {
			id: this._id,
			recording: this.recording,
			playing: this.playing,
			count: this.events.length,
		});
	}
}
