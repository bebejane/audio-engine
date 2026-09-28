// ------------------------------------------ Magnetic Tape Emulation --
//
// Port of "The Kiss of Shame" tape desecration processor
// (https://github.com/hollance/TheKissOfShame), Source/AudioProcessing/*.
// Licensed under the GPL-3.0 — see LICENSE.txt.
//
// AudioGraph::processGraph is a per-sample chain:
//
//   input drive (linear gain)
//     -> InputSaturation   odd/even harmonic mixing, 4 kHz one-pole LP
//     -> Flange            modulated delay line, 0.5 * (x + xDelayed)
//     -> HurricaneSandy    the `age` macro: LP sweep, granular noise,
//                          random level dips, periodic noise bursts
//     -> Hiss              tape hiss, up to -46 dB
//     -> Shame             delay line modulated by a randomly-perturbed cosine
//     -> Blend             linear dry/wet
//     -> output level (linear gain)
//
// The input saturation stage is unconditional — this is a tape machine, not a
// damage unit, so the effect is audible at its default settings even with
// shame/age/hiss at zero.
//
// Deliberate deviations from the C++ original:
//
//   * sample rate. Upstream hardcodes 44100 (buffer sizes, `domainMS * 44.1`,
//     and modulation depths counted in raw samples). Everything is derived
//     from the real `sampleRate` here so the character holds at 48 kHz and up.
//   * the three bundled audio assets (Hiss.wav 12.7 MB, PinkNoise.wav 3.8 MB,
//     LowLevelGrainNoise.wav 7.0 MB) are generated procedurally — a worklet
//     has no bundle to load them from.
//   * `juce::Random` becomes a seeded xorshift so the degradation is
//     deterministic; the DSP harness depends on that.
//   * per-block buffer copies (`audioGraphProcessingBuffer = audioBuffer`)
//     become pre-allocated scratch. The upstream "extremely loud glitch" they
//     bolted a +20 dB limiter onto is not reproduced, because nothing here
//     reads uninitialised memory.
//   * Shame keeps ONE wavetable instead of four. Upstream's own TODO notes all
//     four hold identical data and `waveformIndx` is pinned to 0, so the
//     interpolation between them is a no-op — the output is bit-identical.

var MTE_PI = 3.14159265359;

// ------------------------------------------------------- helpers --

// juce::Random (setSeedRandomly / nextFloat / nextBool) replacement. A fixed
// seed is more useful than a random one: the same effect instance degrades the
// same way every time, and the offline harness can assert on it.
function mteRng(seed) {
	var s = (seed >>> 0) || 0x1a2b3c4d;
	function nextUint() {
		s ^= s << 13; s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5; s >>>= 0;
		return s;
	}
	return {
		nextFloat: function () { return (nextUint() >>> 8) / 16777216; },
		nextBool: function () { return (nextUint() & 1) === 1; }
	};
}

function mteClamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Stand-in for the three bundled audio assets. `lpHz`/`hpHz` shape the
// spectrum with one-pole filters; `pink` selects a -3 dB/oct slope (Paul
// Kellett's approximation) instead of white. The hiss gets a highpass because
// real tape hiss has no rumble in it.
function mteNoise(sr, seconds, seed, lpHz, hpHz, pink) {
	var n = Math.max(64, Math.round(seconds * sr));
	var buf = new Float32Array(n);
	var rng = mteRng(seed);
	var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
	var lpCoef = lpHz > 0 ? 1 - Math.exp(-2 * MTE_PI * lpHz / sr) : 0;
	var hpCoef = hpHz > 0 ? Math.exp(-2 * MTE_PI * hpHz / sr) : 0;
	var lp = 0, hpY = 0, hpX = 0;
	for (var i = 0; i < n; i++) {
		var w = rng.nextFloat() * 2 - 1;
		var v = w;
		if (pink) {
			b0 = 0.99886 * b0 + w * 0.0555179;
			b1 = 0.99332 * b1 + w * 0.0750759;
			b2 = 0.96900 * b2 + w * 0.1538520;
			b3 = 0.86650 * b3 + w * 0.3104856;
			b4 = 0.55000 * b4 + w * 0.5329522;
			b5 = -0.7616 * b5 - w * 0.0168980;
			v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
			b6 = w * 0.115926;
		}
		if (lpCoef > 0) { lp += lpCoef * (v - lp); v = lp; }
		if (hpCoef > 0) { v = hpCoef * (hpY + v - hpX); hpY = v; hpX = v; }
		buf[i] = v;
	}
	return buf;
}

// ------------------------------------------------- InputSaturation.h --
//
// `AudioGraph` constructs this as `InputSaturation{0.0f, 2.0f, 0.272f}` and
// the constructor then sets drive 1.0, output 1.0, oddGain 1.0, evenGain 0.3
// and a 4 kHz one-pole rolloff. All of those are constants, so they are folded
// in here; the only state is the lowpass memory per channel.
//
// Odd harmonics come from the odd transfer function sign(x)*tanh(2|x|), even
// harmonics from the even one tanh(0.272|x|), and the two are summed 1 : 0.3.
// The mix can never exceed unity in magnitude (tanh is bounded and the weights
// sum to one), so no output clamp is needed.
function mteInputSaturation(sr) {
	var satThreshold = 0;
	var satRateOdd = 2.0;
	var satRateEven = 0.272;
	var oddGain = 1.0;
	var evenGain = 0.3;
	// weightEvenAndOddWaveshaping: g = 1 / (oddGain + evenGain)
	var g = 1 / (oddGain + evenGain);
	var og = oddGain * g;
	var eg = evenGain * g;
	var coef = 0;
	var priorSample = [0, 0];

	// setFrequencyRolloff(4000)
	coef = 4000 * 2 * MTE_PI / sr;
	if (coef > 1) coef = 1; else if (coef < 0) coef = 0;

	function process(x, channel) {
		// odd harmonic waveshaping
		var odd = x;
		if (odd > satThreshold) {
			odd = satThreshold + Math.tanh(satRateOdd * (Math.abs(odd) - satThreshold)) * (1 - satThreshold);
		} else if (odd < -satThreshold) {
			odd = -satThreshold - Math.tanh(satRateOdd * (Math.abs(odd) - satThreshold)) * (1 - satThreshold);
		}
		// even harmonic waveshaping (starts from the untouched input)
		var even = Math.tanh(satRateEven * Math.abs(x));
		// mix the two, then the single-pole lowpass
		var y = og * odd + eg * even;
		var last = priorSample[channel];
		last = coef * y + (1 - coef) * last;
		priorSample[channel] = last;
		return last;
	}

	function reset() { priorSample[0] = 0; priorSample[1] = 0; }
	return { process: process, reset: reset };
}

// -------------------------------------------------------- Biquads.h --
//
// Second-order Butterworth, direct form I, one instance per channel. The
// upstream class also carries a "modified biquad" path (c0/d0) that no setter
// in this plug-in ever enables, so it is not ported.
function mteButterworth(sr) {
	var a0 = 0, a1 = 0, a2 = 0, b1 = 0, b2 = 0;
	var priorIn2 = [0, 0], priorIn1 = [0, 0], curIn = [0, 0];
	var priorOut2 = [0, 0], priorOut1 = [0, 0], curOut = [0, 0];
	var sqrt2 = 1.41421356237309504880168872420969808;

	function setLowHighPass(fc, isLowPass) {
		var theta = fc * MTE_PI / sr;
		if (theta >= 0.49 * MTE_PI) theta = 0.49 * MTE_PI;
		var C, CC;
		if (isLowPass) {
			C = 1 / Math.tan(theta);
			CC = C * C;
			a0 = 1 / (1 + sqrt2 * C + CC);
			a1 = 2 * a0;
			a2 = a0;
			b1 = 2 * a0 * (1 - CC);
			b2 = a0 * (1 - sqrt2 * C + CC);
		} else {
			C = Math.tan(theta);
			CC = C * C;
			a0 = 1 / (1 + sqrt2 * C + CC);
			a1 = -2 * a0;
			a2 = a0;
			b1 = 2 * a0 * (CC - 1);
			b2 = a0 * (1 - sqrt2 * C + CC);
		}
	}

	function process(x, channel) {
		priorIn2[channel] = priorIn1[channel];
		priorIn1[channel] = curIn[channel];
		curIn[channel] = x;
		curOut[channel] =
			a0 * curIn[channel] + a1 * priorIn1[channel] + a2 * priorIn2[channel] -
			b1 * priorOut1[channel] - b2 * priorOut2[channel];
		priorOut2[channel] = priorOut1[channel];
		priorOut1[channel] = curOut[channel];
		return curOut[channel];
	}

	function reset() {
		for (var i = 0; i < 2; i++) {
			priorIn2[i] = 0; priorIn1[i] = 0; curIn[i] = 0;
			priorOut2[i] = 0; priorOut1[i] = 0; curOut[i] = 0;
		}
	}

	return { setLowHighPass: setLowHighPass, process: process, reset: reset };
}

// --------------------------------------------------------- Flange.h --
//
// A 2000-sample circular delay line, `0.5 * (x + xDelayed)`. Normally a
// flanger is driven by an LFO; here the depth is the `flange` parameter, so
// the "reel drag" is performed by hand (upstream exposes it on the GUI reels).
//
// The buffer is sized from the sample rate, and the depth smoother is derived
// from its time constant: upstream nudges `curDepth` toward the target by a
// fixed 0.001 per sample, which is a ~22.7 ms time constant at 44.1 kHz and
// gets twice as slow in ms at 88.2 kHz if you take the constant literally.
function mteFlange(sr) {
	var scale = sr / 44100;
	var SIZE = Math.max(16, Math.round(2000 * scale));
	var bufL = new Float32Array(SIZE);
	var bufR = new Float32Array(SIZE);
	var curPos = 0;
	var playPosition = 0;
	var curDepth = 0;
	var targetDepth = 0;
	var SMOOTH_TAU = 1 / (0.001 * 44100);
	var k = 1 - Math.exp(-1 / (sr * SMOOTH_TAU));
	var out = new Float64Array(2);

	function setDepth(depth) {
		// 0..1 in, 0..1000 samples of delay out
		targetDepth = depth * 1000 * scale;
	}

	function process(xL, xR) {
		bufL[curPos] = xL;
		bufR[curPos] = xR;
		var prevX = Math.floor(playPosition);
		var fraction = playPosition - prevX;
		var nextX = (prevX + 1) % SIZE;
		out[0] = 0.5 * (xL + (bufL[prevX] * (1 - fraction) + bufL[nextX] * fraction));
		out[1] = 0.5 * (xR + (bufR[prevX] * (1 - fraction) + bufR[nextX] * fraction));
		if (Math.abs(targetDepth - curDepth) < 0.01) curDepth = targetDepth;
		else curDepth += (targetDepth - curDepth) * k;
		playPosition = curPos - curDepth;
		if (playPosition >= SIZE) playPosition -= SIZE;
		if (playPosition < 0) playPosition += SIZE;
		curPos = (curPos + 1) % SIZE;
	}

	function reset() {
		curPos = 0; playPosition = 0; curDepth = 0; targetDepth = 0;
		bufL.fill(0); bufR.fill(0);
	}

	return { setDepth: setDepth, process: process, reset: reset, out: out };
}

// ------------------------------------------------------ Envelope.h --
//
// Envelope generator with linear segments, looping. Upstream stores the domain
// and loop length in samples as `ms * 44.1`; here they come from the real
// sample rate, which is the same number at 44.1 kHz and correct everywhere else.
function mteEnvelope(points, domainMs, loopMs, sr) {
	var incr = 0;
	var domain = Math.max(1, Math.round(domainMs * sr / 1000));
	var loopDuration = Math.max(1, Math.round(loopMs * sr / 1000));
	if (loopDuration < domain) domain = loopDuration;

	function process() {
		var value = 0;
		if (incr < domain) {
			var curPos = incr / domain;
			// find the two points curPos falls between (points are x-ascending,
			// so search from the top and the first hit is the right segment)
			var prevX = 0, prevY = 0, nextX = 1, nextY = 0;
			for (var i = points.length - 1; i >= 0; i--) {
				if (curPos >= points[i][0]) {
					prevX = points[i][0]; prevY = points[i][1];
					nextX = points[i + 1][0]; nextY = points[i + 1][1];
					break;
				}
			}
			var span = nextX - prevX;
			var distance = span > 0 ? (curPos - prevX) / span : 0;
			value = (1 - distance) * prevY + distance * nextY;
		}
		incr++;
		if (incr >= loopDuration) incr = 0;
		return value;
	}

	function reset() { incr = 0; }
	return { process: process, reset: reset };
}

// --------------------------------------------------- EnvelopeDips.h --
//
// Random envelope that only ever dips, from 1.0 down by up to
// `dynamicExtremity`. The dip points are regenerated every time the domain
// wraps, so the level keeps wandering instead of looping audibly.
function mteEnvelopeDips(domainMs, dynamicExtremity, numPoints, numPointRandomness, sr) {
	var rng = mteRng(0x5f3759df);
	var incr = 0;
	var domain = Math.max(1, Math.round(domainMs * sr / 1000));
	var points = [];

	function calculateDipPoints() {
		points = [];
		var numRandPoints = Math.floor(numPoints * (1 - numPointRandomness * rng.nextFloat())) + 1;
		var partitionSize = 1 / (numRandPoints + 1);
		// the first and last points are always 1.0
		points.push([0, 1]);
		for (var i = 0; i < numRandPoints; i++) {
			var xInit = (i + 1) / (numRandPoints + 1);
			var xDeviation = rng.nextFloat() * partitionSize * 0.4;
			if (rng.nextBool()) xDeviation = -xDeviation;
			points.push([xInit + xDeviation, 1 - dynamicExtremity * rng.nextFloat()]);
		}
		points.push([1, 1]);
	}

	calculateDipPoints();

	function process() {
		var curPos = incr / domain;
		var prevX = 0, prevY = 1, nextX = 1, nextY = 1;
		for (var i = points.length - 1; i >= 0; i--) {
			if (curPos >= points[i][0]) {
				prevX = points[i][0]; prevY = points[i][1];
				nextX = points[i + 1][0]; nextY = points[i + 1][1];
				break;
			}
		}
		var span = nextX - prevX;
		var distance = span > 0 ? (curPos - prevX) / span : 0;
		var value = (1 - distance) * prevY + distance * nextY;
		incr++;
		if (incr >= domain) {
			calculateDipPoints();
			incr = 0;
		}
		return value;
	}

	function reset() {
		incr = 0;
		calculateDipPoints();
	}

	return { process: process, reset: reset };
}

// ---------------------------------------------------------- Hiss.h --
//
// Plays a seamless noise loop under the signal. The recorded hiss fades in at
// the start of the wav and out at the end; to hide that, the buffer is read at
// two positions half a loop apart and crossfaded with a triangle ramp, which
// makes the loop period inaudible. Same trick, same arithmetic, but the
// buffer is synthesised (see mteNoise) rather than loaded.
function mteHiss(sr) {
	var buf = mteNoise(sr, 2.0, 0x2545f491, 0, 60, false);
	var len = buf.length;
	var half = len >> 1;
	var indx1 = 0;
	var indx2 = half;
	var hissLevel = 0;
	var signalLevel = 1;

	function setHissLevel(level) {
		// up to -46 dB of hiss, dry trimmed by the same amount
		hissLevel = level * 0.005;
		signalLevel = 1 - hissLevel;
	}

	function process(x, channel) {
		var rampValue = indx1 < half ? indx1 / half : (len - indx1) / half;
		var hissSample = rampValue * buf[indx1] + (1 - rampValue) * buf[indx2];
		indx1 = (indx1 + 1) % len;
		indx2 = (indx2 + 1) % len;
		return signalLevel * x + hissLevel * hissSample;
	}

	function reset() { indx1 = 0; indx2 = half; }
	return { setHissLevel: setHissLevel, process: process, reset: reset };
}

// -------------------------------------------------- LoopCrossfade.h --
//
// The same seamless-loop reader, but as a single-channel source: this is the
// pre-recorded low-frequency grain noise mixed in by the age macro.
function mteLoopCrossfade(sr) {
	var buf = mteNoise(sr, 2.0, 0x9e3779b1, 120, 0, false);
	var len = buf.length;
	var half = len >> 1;
	var indx1 = 0;
	var indx2 = half;
	var loopLevel = 0;

	function setLoopCrossfadeLevel(level) { loopLevel = level; }

	// upstream's processLoopCrossSample(channel) is only ever called with
	// channel 0 and advances the indices once per call, so it is mono here
	function process() {
		var rampValue = indx1 < half ? indx1 / half : (len - indx1) / half;
		var sample = rampValue * buf[indx1] + (1 - rampValue) * buf[indx2];
		indx1 = (indx1 + 1) % len;
		indx2 = (indx2 + 1) % len;
		return loopLevel * sample;
	}

	function reset() { indx1 = 0; indx2 = half; }
	return { setLoopCrossfadeLevel: setLoopCrossfadeLevel, process: process, reset: reset };
}

// --------------------------------------------- Granulate.h / .cpp -- //
//
// STK's granular synthesiser (Gary Scavone, Perry Cook), vendored by upstream
// under its own MIT licence. Reads the pink-noise buffer at truncating (not
// interpolating) positions, so the grains are deliberately gritty.
//
// The upstream copy hardcodes SAMPLE_RATE 44100; the real rate is used here.
// `gain_` is computed but never applied in STK's tick() either, and is
// likewise unused.
function mteGranulate(audioData, nVoices, sampleRate) {
	var rng = mteRng(0xc2b2ae35);
	var GRAIN_STOPPED = 0, GRAIN_FADEIN = 1, GRAIN_SUSTAIN = 2, GRAIN_FADEOUT = 3;
	var gDuration = 30, gRampPercent = 50, gDelay = 0, gOffset = 0;
	var gStretch = 0, stretchCounter = 0, gRandomFactor = 0.097;
	var gPointer = 0;
	var grains = [];
	var dataLen = audioData.length;

	function newGrain(i, n) {
		return {
			eScaler: 0, eRate: 0,
			attackCount: 0, sustainCount: 0, decayCount: 0, delayCount: 0,
			counter: Math.floor(i * gDuration * 0.001 * sampleRate / n),
			pointer: 0, startPointer: 0, repeats: 0, state: GRAIN_STOPPED
		};
	}

	function setGrainParameters(duration, rampPercent, offset, delay) {
		gDuration = duration > 0 ? duration : 1;
		gRampPercent = rampPercent > 100 ? 100 : rampPercent;
		gOffset = offset;
		gDelay = delay;
	}

	function setRandomFactor(randomness) {
		gRandomFactor = randomness < 0 ? 0 : randomness > 1 ? 0.97 : 0.97 * randomness;
	}

	function setVoices(n) {
		while (grains.length < n) {
			var i = grains.length;
			var g = newGrain(i, n);
			g.pointer = gPointer;
			grains.push(g);
		}
		while (grains.length > n) grains.pop();
		for (var k = 0; k < grains.length; k++) {
			grains[k].counter = Math.floor(k * gDuration * 0.001 * sampleRate / n);
		}
	}

	function reset() {
		gPointer = 0;
		for (var i = 0; i < grains.length; i++) {
			grains[i].repeats = 0;
			grains[i].counter = Math.floor(i * gDuration * 0.001 * sampleRate / grains.length);
			grains[i].state = GRAIN_STOPPED;
		}
	}

	function calculateGrain(g) {
		if (g.repeats > 0) {
			g.repeats--;
			g.pointer = g.startPointer;
			if (g.attackCount > 0) {
				g.eScaler = 0;
				g.eRate = -g.eRate;
				g.counter = g.attackCount;
				g.state = GRAIN_FADEIN;
			} else {
				g.counter = g.sustainCount;
				g.state = GRAIN_SUSTAIN;
			}
			return;
		}

		// duration, randomized by +/- the random factor
		var seconds = gDuration * 0.001;
		seconds += seconds * gRandomFactor * (rng.nextFloat() * 2 - 1);
		var count = Math.floor(seconds * sampleRate);
		g.attackCount = Math.floor(gRampPercent * 0.005 * count);
		g.decayCount = g.attackCount;
		g.sustainCount = count - 2 * g.attackCount;
		g.eScaler = 0;
		if (g.attackCount > 0) {
			g.eRate = 1 / g.attackCount;
			g.counter = g.attackCount;
			g.state = GRAIN_FADEIN;
		} else {
			g.counter = g.sustainCount;
			g.state = GRAIN_SUSTAIN;
		}

		// delay before the next grain
		seconds = gDelay * 0.001;
		seconds += seconds * gRandomFactor * (rng.nextFloat() * 2 - 1);
		g.delayCount = Math.max(0, Math.floor(seconds * sampleRate));

		g.repeats = gStretch;

		// pointer jump, plus a little extra scatter
		seconds = gOffset * 0.001;
		seconds += seconds * gRandomFactor * rng.nextFloat();
		var offset = Math.floor(seconds * sampleRate);
		seconds = gDuration * 0.001 * gRandomFactor * (rng.nextFloat() * 2 - 1);
		offset += Math.floor(seconds * sampleRate);
		g.pointer += offset;
		while (g.pointer >= dataLen) g.pointer -= dataLen;
		if (g.pointer < 0) g.pointer = 0;
		g.startPointer = Math.floor(g.pointer);
	}

	// upstream's switch uses [[fallthrough]] to run the SUSTAIN and FADEOUT
	// cases when a stage has zero length; modelled here as an explicit chain
	function advanceState(g) {
		if (g.state === GRAIN_STOPPED) { calculateGrain(g); return; }
		if (g.state === GRAIN_FADEIN) {
			if (g.sustainCount > 0) { g.counter = g.sustainCount; g.state = GRAIN_SUSTAIN; return; }
			g.state = GRAIN_SUSTAIN;
		}
		if (g.state === GRAIN_SUSTAIN) {
			if (g.decayCount > 0) { g.counter = g.decayCount; g.eRate = -g.eRate; g.state = GRAIN_FADEOUT; return; }
			g.state = GRAIN_FADEOUT;
		}
		if (g.delayCount > 0) { g.counter = g.delayCount; g.state = GRAIN_STOPPED; return; }
		calculateGrain(g);
	}

	function tick() {
		var outSample = 0;
		if (dataLen === 0) return 0;
		for (var i = 0; i < grains.length; i++) {
			var g = grains[i];
			if (g.counter <= 0) advanceState(g);
			if (g.state > 0) {
				var s = audioData[Math.floor(g.pointer)];
				if (g.state === GRAIN_FADEIN || g.state === GRAIN_FADEOUT) {
					s *= g.eScaler;
					g.eScaler += g.eRate;
				}
				outSample += s;
				g.pointer++;
				if (g.pointer >= dataLen) g.pointer = 0;
			}
			// upstream decrements unconditionally, which can drive `counter`
			// negative and wedge the grain forever when a stage is empty
			g.counter--;
			if (g.counter < 0) g.counter = 0;
		}
		if (stretchCounter++ === gStretch) {
			gPointer++;
			if (gPointer >= dataLen) gPointer = 0;
			stretchCounter = 0;
		}
		return outSample;
	}

	setGrainParameters(30, 50, 0, 0);
	setRandomFactor(0.1);
	gStretch = 0;
	stretchCounter = 0;
	setVoices(nVoices);
	reset();

	return {
		tick: tick,
		setVoices: setVoices,
		setStretch: function (stretchFactor) {
			gStretch = stretchFactor <= 1 ? 0 : stretchFactor >= 1000 ? 1000 : stretchFactor - 1;
		},
		setGrainParameters: setGrainParameters,
		setRandomFactor: setRandomFactor,
		reset: reset
	};
}

// ------------------------------------------------- HurricaneSandy.h --
//
// The `age` macro: everything that happens to tape that spent years in a bad
// cupboard, and then a hurricane. Five concurrent degradations, all scaled by
// a single 0..1 knob:
//
//   * the signal low-passes from 20 kHz down to 2 kHz
//   * pink noise is granulated into an amplitude wobble
//   * a random envelope only ever dips, ducking the signal
//   * above age 0.5, periodic bursts of white noise
//   * a bed of low-frequency granular noise mixed under everything
function mteHurricaneSandy(sr) {
	var rng = mteRng(0x27d4eb2d);
	var grainImpact = 0, lowFreqGrainNoiseLevel = 0, ampFluctuationImpact = 0, noiseBurstImpact = 0;

	var dips = mteEnvelopeDips(1000, 0.5, 15, 0.5, sr);
	// used to mix the noise burst in
	var noiseEnv = mteEnvelope([
		[0, 0], [0.143, 0.073], [0.305, 0.367], [0.383, 0.567], [0.428, 0], [1, 0]
	], 350, 350, sr);
	// used to duck the original signal during a noise burst
	var sigEnv = mteEnvelope([
		[0, 0], [0.143, 0.2], [0.305, 0.8], [0.383, 0.5], [0.428, 0], [1, 0]
	], 350, 350, sr);

	// STK granulator over pink noise: randomFactor 1.0, stretch 0, 10 voices
	var granulator = mteGranulate(mteNoise(sr, 1.5, 0x165667b1, 0, 0, true), 10, sr);
	granulator.setRandomFactor(1.0);
	granulator.setStretch(0);

	var lowFreqGranular = mteLoopCrossfade(sr);
	lowFreqGranular.setLoopCrossfadeLevel(0.25);

	var lpGrains = mteButterworth(sr);
	lpGrains.setLowHighPass(2000, true);
	var hpGrains = mteButterworth(sr);
	hpGrains.setLowHighPass(50, false);
	var lpSignal = mteButterworth(sr);
	var out = new Float64Array(2);

	function setInterpolatedParameters(input) {
		input = mteClamp01(input);
		// grain interpolation
		grainImpact = input;
		granulator.setGrainParameters(
			Math.floor(10 * input + 5), 75, 50, Math.floor(1000 * (1.01 - input))
		);
		lowFreqGrainNoiseLevel = 0.15 * input;
		ampFluctuationImpact = input;
		// periodic bursts of white noise only past the halfway point
		noiseBurstImpact = input > 0.5 ? 2 * (input - 0.5) : 0;
		// signal lowpass sweeps linearly from 20 kHz down to 2 kHz
		lpSignal.setLowHighPass(20050 * (1 - input) + 2000, true);
	}

	setInterpolatedParameters(0);

	function process(xL, xR) {
		var lfGrainSample = lowFreqGranular.process();
		var grainSample = granulator.tick();
		grainSample = lpGrains.process(grainSample, 0);
		grainSample = hpGrains.process(grainSample, 0);
		var dipsLevel = dips.process();
		var noiseBurstEnvValue = noiseEnv.process();
		var signalEnvValue = 1 - sigEnv.process();
		var white = rng.nextFloat() * 2 - 1;
		var ch = [xL, xR];
		var i;
		for (i = 0; i < 2; i++) {
			var x = lpSignal.process(ch[i], i);
			var noiseBurst = signalEnvValue * x + 0.05 * noiseBurstEnvValue * white;
			x = (1 - noiseBurstImpact) * x + noiseBurstImpact * noiseBurst;
			x *= 1 - grainImpact * grainSample;
			x = ampFluctuationImpact * dipsLevel * x + (1 - ampFluctuationImpact) * x;
			x = x + lowFreqGrainNoiseLevel * lfGrainSample;
			out[i] = x;
		}
	}

	return { setInterpolatedParameters: setInterpolatedParameters, process: process, out: out };
}

// --------------------------------------------------------- Shame.h --
//
// A 44100-sample delay line whose read position is modulated by a
// single-cycle cosine wavetable. The table is unipolar (it runs 0 down to -1)
// so the read position never reaches into the future, and after every lap a
// new random rate fluctuation is chosen — that randomness is what makes this
// "Shame" rather than a plain chorus.
//
// `setInterpolatedParameters` is three piecewise segments, and the discontinuities
// in rate/depth at 50% and 85% are audible in the original too:
//
//   0.00 - 0.50  depth  0 -> 5    periodicity 0.50    rate  7
//   0.50 - 0.85  depth  5 -> 30   periodicity 0.50->0.25  rate  7 -> 77
//   0.85 - 1.00  depth 30 -> 60   periodicity 0.25->0.75  rate 77 -> 57
function mteShame(sr) {
	var rng = mteRng(0x85ebca6b);
	var scale = sr / 44100;
	// upstream's BUFFER_SIZE is 44100, i.e. exactly one second at its hardcoded
	// rate; keeping it at one second means `rate` below stays in Hz
	var SIZE = Math.max(1024, Math.round(sr));
	var bufL = new Float32Array(SIZE);
	var bufR = new Float32Array(SIZE);
	// one cycle of 0.5 * (cos(x) - 1): a cosine that only ever goes negative
	var wave = new Float32Array(SIZE);
	for (var j = 0; j < SIZE; j++) wave[j] = 0.5 * (Math.cos(2 * MTE_PI * j / (SIZE - 1)) - 1);
	var curPos = 0;
	var playPosition = 0;
	var curPosWTable = 0;
	var rateFluctuation = 0;
	var depth = 0.5;
	var rate = 2.0;
	var randPeriodicity = 0;
	var out = new Float64Array(2);

	function setInterpolatedParameters(input) {
		input = mteClamp01(input);
		if (input <= 0.5) {
			depth = 5 * input / 0.5;
			randPeriodicity = 0.5;
			rate = 7.0;
		} else if (input <= 0.85) {
			depth = 5 + 25 * (input - 0.5) / (0.85 - 0.5);
			randPeriodicity = 0.5 - 0.25 * (input - 0.5) / (0.85 - 0.5);
			rate = 7.0 + 70.0 * (input - 0.5) / (0.85 - 0.5);
		} else {
			depth = 30 + 30 * (input - 0.85) / 0.15;
			randPeriodicity = 0.25 + 0.5 * (input - 0.85) / 0.15;
			rate = 77.0 - 20 * (input - 0.85) / 0.15;
		}
		// depth is a delay-line length in samples, so it has to track the rate
		depth *= scale;
	}

	function processWavetable() {
		var prevPos = Math.floor(curPosWTable);
		var fracPos = curPosWTable - prevPos;
		var nextPos = (prevPos + 1) % SIZE;
		var value = wave[prevPos] * (1 - fracPos) + wave[nextPos] * fracPos;
		curPosWTable += rate + rateFluctuation;
		if (curPosWTable >= SIZE) {
			// reached the end of the table: pick a new random rate
			rateFluctuation = (rng.nextFloat() * 2 - 1) * rate * randPeriodicity;
			curPosWTable -= SIZE;
		}
		if (curPosWTable < 0) curPosWTable += SIZE;
		return value;
	}

	function process(xL, xR) {
		bufL[curPos] = xL;
		bufR[curPos] = xR;
		var prevX = Math.floor(playPosition);
		var fraction = playPosition - prevX;
		var nextX = (prevX + 1) % SIZE;
		out[0] = bufL[prevX] * (1 - fraction) + bufL[nextX] * fraction;
		out[1] = bufR[prevX] * (1 - fraction) + bufR[nextX] * fraction;
		playPosition = curPos + depth * processWavetable();
		if (playPosition >= SIZE) playPosition -= SIZE;
		if (playPosition < 0) playPosition += SIZE;
		curPos = (curPos + 1) % SIZE;
	}

	function reset() {
		curPos = 0; playPosition = 0; curPosWTable = 0; rateFluctuation = 0;
		bufL.fill(0); bufR.fill(0);
	}

	return {
		setInterpolatedParameters: setInterpolatedParameters,
		process: process,
		reset: reset,
		out: out
	};
}

// ------------------------------------------------- AudioGraph.h --

function magneticTapeState(sr) {
	var inSaturation = mteInputSaturation(sr);
	var flange = mteFlange(sr);
	var sandy = mteHurricaneSandy(sr);
	var shame = mteShame(sr);
	var hiss = mteHiss(sr);
	var inputGain = 1;
	var outputGain = 1;
	var blendValue = 1;
	var dryL = 0, dryR = 0;
	var wetL = 0, wetR = 0;
	var out = new Float64Array(2);

	function configure(params) {
		// Parameters::update maps these onto -18 .. +18 dB
		inputGain = Math.pow(10, (params.inputDrive * 36 - 18) / 20);
		outputGain = Math.pow(10, (params.outputLevel * 36 - 18) / 20);
		// Blend.h: a straight linear crossfade, not an equal-power one
		blendValue = params.mix;
		hiss.setHissLevel(params.hiss);
		shame.setInterpolatedParameters(params.shame);
		sandy.setInterpolatedParameters(params.age);
		flange.setDepth(params.flange);
	}

	function processSample(xL, xR) {
		// 1. input drive
		xL *= inputGain;
		xR *= inputGain;
		// Blend compares against the driven-but-unprocessed signal
		dryL = xL;
		dryR = xR;

		// 2. input saturation (always applied; the settings are fixed upstream)
		wetL = inSaturation.process(xL, 0);
		wetR = inSaturation.process(xR, 1);

		// 3. flange
		flange.process(wetL, wetR);
		wetL = flange.out[0];
		wetR = flange.out[1];

		// 4. the age macro
		sandy.process(wetL, wetR);
		wetL = sandy.out[0];
		wetR = sandy.out[1];

		// 5. hiss
		wetL = hiss.process(wetL, 0);
		wetR = hiss.process(wetR, 1);

		// 6. shame
		shame.process(wetL, wetR);
		wetL = shame.out[0];
		wetR = shame.out[1];

		// 7. blend with the dry, then the output level
		out[0] = ((1 - blendValue) * dryL + blendValue * wetL) * outputGain;
		out[1] = ((1 - blendValue) * dryR + blendValue * wetR) * outputGain;
		if (!Number.isFinite(out[0])) out[0] = 0;
		if (!Number.isFinite(out[1])) out[1] = 0;
	}

	return { configure: configure, processSample: processSample, out: out };
}

class MagneticTapeProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.st = magneticTapeState(sampleRate);
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		this.st.configure({
			inputDrive: paramAt(parameters.inputDrive, 0),
			outputLevel: paramAt(parameters.outputLevel, 0),
			shame: paramAt(parameters.shame, 0),
			age: paramAt(parameters.age, 0),
			hiss: paramAt(parameters.hiss, 0),
			mix: paramAt(parameters.mix, 0),
			flange: paramAt(parameters.flange, 0),
		});
		var i;
		for (i = 0; i < s.n; i++) {
			this.st.processSample(s.inL[i], s.inR[i]);
			s.outL[i] = this.st.out[0];
			if (s.outR) s.outR[i] = this.st.out[1];
		}
		return true;
	}
}
MagneticTapeProcessor.parameterDescriptors = desc([
	['inputDrive', 0.5, 0, 1],
	['outputLevel', 0.5, 0, 1],
	['shame', 0, 0, 1],
	['age', 0, 0, 1],
	['hiss', 0, 0, 1],
	['mix', 1, 0, 1],
	['flange', 0, 0, 1],
]);
registerProcessor('magnetictape', MagneticTapeProcessor);
