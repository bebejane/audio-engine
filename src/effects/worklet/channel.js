// Per-sound channel processor: audio-thread loop clock, anti-click fade,
// elapsed-time reporting and a 4-band EQ (registers `channel`).
//
// It sits in a Sound's chain where the anti-click fade node used to be (after
// the volume node, before the panner), i.e. a channel strip: the EQ is applied
// here (post-effects, pre-panner), then the anti-click fade gain.
//
// The loop clock, fade and elapsed reporting used to be main-thread mechanisms
// in sound.ts (a `setInterval` with look-ahead AudioParam scheduling, and a
// 30ms `setTimeout`); timers are not sample accurate and get throttled in
// background tabs, so they run on the audio thread here.
//
// The native AudioBufferSourceNode still does the playback/looping; this
// processor only shadows its playhead from a `(startTime, startPos, rate, loop)`
// anchor re-sent on play / resume / rate / loop change. Position is recomputed
// from `currentTime` every block (no accumulated drift).
class ChannelProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.active = false; // playing (anchored)
		this.loop = false;
		this.loopStart = 0;
		this.loopEnd = 0;
		this.rate = 1;
		this.fadeDur = 0.006;
		this.startTime = 0; // context time of the anchor
		this.startPos = 0; // buffer-seconds playhead at the anchor
		this.floorCount = 0; // wraps completed up to the previous block
		this.sinceStart = 0; // output frames since the anchor (intro fade)
		this.gain = 1; // current anti-click gain (released on stop)
		this.rebaseline = false;
		// Signal delay of anything between the source and this node (the pitch
		// shifter). The clock below is a zero-latency model of the source, so
		// audio arriving here is `delay` seconds behind that model; the fade
		// window is shifted by the same amount to sit on the real wrap.
		this.delay = 0;
		this.emitElapsed = false;
		this.elapsedPeriod = 0.03; // seconds between `elapsed` messages
		this.elapsedAccum = 0;
		// 4-band EQ: targets + smoothed values (`cf/cg/cq`) per band, one biquad
		// per channel. `eqState` is null until the Sound sends its first config.
		this.eqState = null;
		this.eqOn = [false, false, false, false];
		this.eqL = [rbj(), rbj(), rbj(), rbj()];
		this.eqR = [rbj(), rbj(), rbj(), rbj()];
		this.port.onmessage = (e) => this.handle(e.data);
	}

	handle(d) {
		if (!d) return;
		if (d.type === 'start' || d.type === 'update') {
			this.active = true;
			this.loop = !!d.loop;
			this.loopStart = d.loopStart || 0;
			this.loopEnd = d.loopEnd || 0;
			this.rate = d.rate > 0 ? d.rate : 1;
			this.fadeDur = d.fadeDur > 0 ? d.fadeDur : 0.006;
			this.delay = d.delay > 0 ? d.delay : 0;
			this.startTime = d.startTime;
			this.startPos = d.startPos;
			this.sinceStart = 0;
			this.emitElapsed = !!d.elapsed;
			this.elapsedPeriod = d.elapsedPeriod > 0 ? d.elapsedPeriod : 0.03;
			this.elapsedAccum = 0;
			// rebaseline against this block's clock on the next process() so a
			// first pass starting before loopStart can't be counted as a wrap
			this.rebaseline = true;
		} else if (d.type === 'stop') {
			this.active = false;
		} else if (d.type === 'eqAll') {
			this.setEqAll(d.bands);
		} else if (d.type === 'eq') {
			this.mergeEq(d.band | 0, d);
		}
	}

	/** Seed the EQ state from a full 4-band config (or defaults for gaps). */
	setEqAll(bands) {
		const next = channelDefaultEq();
		for (let i = 0; i < 4; i++) {
			const src = bands && bands[i] ? bands[i] : {};
			const b = next[i];
			if (src.on !== undefined) b.on = !!src.on;
			if (src.type !== undefined) b.type = src.type;
			if (typeof src.frequency === 'number') b.frequency = src.frequency;
			if (typeof src.gain === 'number') b.gain = src.gain;
			if (typeof src.q === 'number') b.q = src.q;
			// start smoothing from the target so the first block is already right
			b.cf = b.frequency;
			b.cg = b.gain;
			b.cq = b.q;
		}
		this.eqState = next;
	}

	/** Apply a partial update to one band. */
	mergeEq(band, d) {
		if (!this.eqState) this.setEqAll(null);
		if (band < 0 || band > 3) return;
		const b = this.eqState[band];
		if (d.on !== undefined) b.on = !!d.on;
		if (d.eqType !== undefined) b.type = d.eqType;
		if (typeof d.frequency === 'number') b.frequency = d.frequency;
		if (typeof d.gain === 'number') b.gain = d.gain;
		if (typeof d.q === 'number') b.q = d.q;
	}

	process(inputs, outputs) {
		var out = outputs[0] || [];
		var outL = out[0];
		if (!outL) return true;
		var outR = out[1];
		var inp = inputs[0] || [];
		var inL = inp[0] && inp[0].length ? inp[0] : null;
		var inR = inp[1] && inp[1].length ? inp[1] : inL;
		var n = outL.length;
		var len = this.loopEnd - this.loopStart;
		var looping = this.active && this.loop && len > 0 && this.rate > 0;

		// --- EQ: smooth parameters + refresh coefficients once per block ------
		var eqActive = false;
		if (this.eqState) {
			var sm = 1 - Math.exp(-n / (sampleRate * EQ_SMOOTH_SEC));
			for (var bi = 0; bi < 4; bi++) {
				var s = this.eqState[bi];
				s.cf += (s.frequency - s.cf) * sm;
				s.cg += (s.gain - s.cg) * sm;
				s.cq += (s.q - s.cq) * sm;
				// a shelf/peak with ~0 dB is a no-op; LP/HP filter regardless
				var on =
					s.on && (s.type === 'lowpass' || s.type === 'highpass' || Math.abs(s.cg) > 0.005);
				this.eqOn[bi] = on;
				if (on) eqActive = true;
				this.eqL[bi].set(s.type, sampleRate, s.cf, s.cq, s.cg);
				this.eqR[bi].set(s.type, sampleRate, s.cf, s.cq, s.cg);
			}
		}

		// playhead at the start of this block, in buffer seconds (raw). `u` is
		// its distance from loopStart, used for the fade/wrap math.
		var elapsedSec = this.startPos + (currentTime - this.startTime) * this.rate;
		var u = elapsedSec - this.loopStart;
		if (looping && this.rebaseline) {
			this.floorCount = Math.max(0, Math.floor(u / len));
			this.rebaseline = false;
		}

		var fadeFrames = this.fadeDur * sampleRate;
		var step = this.rate / sampleRate;
		var fadeActive = looping && len / this.rate >= this.fadeDur * 3;
		var i, g, l, r;

		for (i = 0; i < n; i++) {
			l = inL ? inL[i] : 0;
			r = inR ? inR[i] : l;
			if (eqActive) {
				for (var bj = 0; bj < 4; bj++) {
					if (!this.eqOn[bj]) continue;
					l = this.eqL[bj].process(l);
					r = this.eqR[bj].process(r);
				}
			}
			if (looping) {
				g = 1;
				// intro ramp covers the click at (re)start
				if (this.sinceStart + i < fadeFrames) g = (this.sinceStart + i) / fadeFrames;
				if (fadeActive) {
					// The wrap this fade belongs to is heard `delay` seconds after
					// the clock above reports it, so look ahead by that much and
					// fade around the *audible* wrap instead. Without this (e.g.
					// the pitch shifter in the path) the fade lands late and the
					// wrap clicks.
					var ahead = this.delay * this.rate;
					if (u + ahead >= 0) {
						var pos = (u + ahead) - len * Math.floor((u + ahead) / len); // [0, len)
						var rem = (len - pos) / this.rate; // seconds until the wrap
						var since = pos / this.rate; // seconds since the wrap
						if (rem < this.fadeDur) g = Math.min(g, rem / this.fadeDur);
						else if (since < this.fadeDur) g = Math.min(g, since / this.fadeDur);
					}
				}
				this.gain = g;
				u += step;
			} else {
				// release the anti-click gain back to unity after a stop, and
				// keep a non-looping channel at unity
				this.gain += (1 - this.gain) * CHANNEL_RELEASE;
			}
			outL[i] = l * this.gain;
			if (outR) outR[i] = r * this.gain;
		}

		if (this.active) {
			if (looping) {
				this.sinceStart += n;
				var floorEnd = Math.floor(u / len);
				if (floorEnd > this.floorCount) {
					this.port.postMessage({ type: 'loopend', wraps: floorEnd - this.floorCount });
					this.floorCount = floorEnd;
				}
			}
			if (this.emitElapsed) {
				this.elapsedAccum += n;
				if (this.elapsedAccum >= this.elapsedPeriod * sampleRate) {
					this.elapsedAccum -= this.elapsedPeriod * sampleRate;
					var value = elapsedSec; // position at block start
					if (looping) value = this.loopStart + (((value - this.loopStart) % len) + len) % len;
					if (value < 0) value = 0;
					this.port.postMessage({ type: 'elapsed', value: value });
				}
			}
		}
		return true;
	}
}
// ~10ms one-pole release for the anti-click gain (the old `setTargetAtTime(1)`)
var CHANNEL_RELEASE = 1 - Math.exp(-1 / (0.01 * sampleRate));
// ~20ms one-pole smoothing for EQ parameter changes (per block)
var EQ_SMOOTH_SEC = 0.02;
// flat 4-band defaults: low shelf / two bells / high shelf, all off
function channelDefaultEq() {
	return [
		{ on: false, type: 'lowshelf', frequency: 100, gain: 0, q: 0.7, cf: 100, cg: 0, cq: 0.7 },
		{ on: false, type: 'peaking', frequency: 300, gain: 0, q: 0.7, cf: 300, cg: 0, cq: 0.7 },
		{ on: false, type: 'peaking', frequency: 2000, gain: 0, q: 0.7, cf: 2000, cg: 0, cq: 0.7 },
		{ on: false, type: 'highshelf', frequency: 6000, gain: 0, q: 0.7, cf: 6000, cg: 0, cq: 0.7 },
	];
}
registerProcessor('channel', ChannelProcessor);
