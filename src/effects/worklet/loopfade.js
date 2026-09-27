// Sound loop clock + anti-click fade (registers `pp-loopfade`).
//
// This used to be a main-thread `setInterval` in sound.ts that scheduled a ~6ms
// gain dip on a `fadeNode` gain and fired `loopend`. Timers are never sample
// accurate and get throttled in background tabs, so both jobs now run on the
// audio thread here.
//
// The native AudioBufferSourceNode still does the looping; this processor only
// shadows its playhead from a `(startTime, startPos, rate, loop)` anchor that
// the Sound re-sends on play / rate change / loop change. Position is
// recomputed from `currentTime` every block (no accumulated drift), and a wrap
// is any whole loop length the position has advanced past.
//
// It sits where the fade node used to (after the volume node, before the
// panner), so the fade is still applied after the effects. When not looping it
// is a plain passthrough.
class PPLoopFadeProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.active = false; // looping + playing
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
		this.port.onmessage = (e) => this.handle(e.data);
	}

	handle(d) {
		if (!d) return;
		if (d.type === 'start' || d.type === 'update') {
			this.active = true;
			this.loopStart = d.loopStart;
			this.loopEnd = d.loopEnd;
			this.rate = d.rate > 0 ? d.rate : 1;
			this.fadeDur = d.fadeDur > 0 ? d.fadeDur : 0.006;
			this.startTime = d.startTime;
			this.startPos = d.startPos;
			this.sinceStart = 0;
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
		var active = this.active && len > 0 && this.rate > 0;

		// playhead distance from loopStart, in buffer seconds
		var u = this.startPos - this.loopStart + (currentTime - this.startTime) * this.rate;
		if (active && this.rebaseline) {
			this.floorCount = Math.max(0, Math.floor(u / len));
			this.rebaseline = false;
		}

		var fadeFrames = this.fadeDur * sampleRate;
		var step = this.rate / sampleRate;
		var fadeActive = active && len / this.rate >= this.fadeDur * 3;

		var i, g, l;
		for (i = 0; i < n; i++) {
			if (active) {
				g = 1;
				// intro ramp covers the click at (re)start — matches the old
				// `startNow` envelope, including on a rate/loop re-anchor
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
				// release the anti-click gain back to unity after a stop/pause
				this.gain += (1 - this.gain) * PP_LOOP_RELEASE;
			}
			l = inL ? inL[i] : 0;
			outL[i] = l * this.gain;
			if (outR) outR[i] = (inR ? inR[i] : l) * this.gain;
		}

		if (active) {
			this.sinceStart += n;
			var floorEnd = Math.floor(u / len);
			if (floorEnd > this.floorCount) {
				this.port.postMessage({ type: 'loopend', wraps: floorEnd - this.floorCount });
				this.floorCount = floorEnd;
			}
		}
		return true;
	}
}
// ~10ms one-pole release for the anti-click gain (the old `setTargetAtTime(1)`)
var PP_LOOP_RELEASE = 1 - Math.exp(-1 / (0.01 * sampleRate));
registerProcessor('pp-loopfade', PPLoopFadeProcessor);
