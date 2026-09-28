// Per-sound channel processor: audio-thread loop clock, anti-click fade and
// elapsed-time reporting (registers `channel`).
//
// It sits in a Sound's chain where the anti-click fade node used to be (after
// the volume node, before the panner). All three jobs used to be main-thread
// mechanisms in sound.ts — the loop boundary was a `setInterval` with look-ahead
// AudioParam scheduling, the elapsed playhead a 30ms `setTimeout`. Timers are
// never sample accurate and get throttled in background tabs, so they run on
// the audio thread here instead.
//
// The native AudioBufferSourceNode still does the playback/looping; this
// processor only shadows its playhead from a `(startTime, startPos, rate, loop)`
// anchor the Sound re-sends on play / resume / rate / loop change. Position is
// recomputed from `currentTime` every block (no accumulated drift). When neither
// looping nor reporting elapsed it is a plain passthrough.
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
		this.emitElapsed = false;
		this.elapsedPeriod = 0.03; // seconds between `elapsed` messages
		this.elapsedAccum = 0;
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
		}
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
		var i, g, l;

		for (i = 0; i < n; i++) {
			if (looping) {
				g = 1;
				// intro ramp covers the click at (re)start
				if (this.sinceStart + i < fadeFrames) g = (this.sinceStart + i) / fadeFrames;
				if (fadeActive && u >= 0) {
					var pos = u - len * Math.floor(u / len); // [0, len)
					var rem = (len - pos) / this.rate; // seconds until the wrap
					var since = pos / this.rate; // seconds since the wrap
					if (rem < this.fadeDur) g = Math.min(g, rem / this.fadeDur);
					else if (since < this.fadeDur) g = Math.min(g, since / this.fadeDur);
				}
				this.gain = g;
				u += step;
			} else {
				// release the anti-click gain back to unity after a stop, and
				// keep a non-looping channel at unity
				this.gain += (1 - this.gain) * PP_CHANNEL_RELEASE;
			}
			l = inL ? inL[i] : 0;
			outL[i] = l * this.gain;
			if (outR) outR[i] = (inR ? inR[i] : l) * this.gain;
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
var PP_CHANNEL_RELEASE = 1 - Math.exp(-1 / (0.01 * sampleRate));
registerProcessor('channel', ChannelProcessor);
