// ------------------------------------------------- Tape Saturation --
//
// Port of the tape-saturation stage of "Aureate" (basilica-audio/Aureate),
// src/dsp/{TapeSaturator.h,AdaaShapers.h} plus the tape-path section of
// AureateEngine. Licensed under the AGPL-3.0 — see LICENSE.txt.
//
// Aureate is an orchestral saturation "glue" processor. This effect ports the
// nonlinearity and the three things its single "Warmth" knob drives, and
// leaves out the rest of the plugin (glue compressor, iron transformer,
// wow/flutter, hiss, HF/LF trim, auto gain) — those are separate instruments.
//
//   input -> Drive (gain) -> [4x oversampled:
//            Warmth HF-rolloff (tape self-erasure)
//            -> LF head bump (tape transport resonance, 80 Hz)
//            -> asymmetric saturator (Character curve, Warmth+Bias bias,
//                 ADAA1 in HQ quality)
//         ] -> downsample -> dry/wet mix -> Output trim
//
// The nonlinearity is shift-then-recentre, y = f(x + bias) - f(bias), which is
// what makes the saturation genuinely asymmetric: the two half-cycles approach
// different ceilings, and a zero-mean input comes out even-harmonic-rich and
// DC-shifted. Subtracting f(bias) is what guarantees silence in, silence out
// for every bias — the "glue" is the harmonic asymmetry, not a level offset.
//
// The three Character curves are all the same shape over different bases:
//   0 Tape    tanh — smooth, odd-harmonic-dominant, least asymmetric
//   1 Console 2*tanh(v/2) — unity slope, smaller cubic term, so it stays
//              transparent until pushed (a summing-bus knee, not a fuzzer)
//   2 Valve   sign(v)*(1 - e^-|v|) — most asymmetric, even-harmonic-forward
//
// Deviations from the C++ original, all deliberate:
//
//   * oversampling. Aureate gets 4x polyphase half-band IIR from JUCE. Here it
//     is two cascaded 2x stages built from a linear-phase half-band FIR
//     (Blackman-Harris windowed sinc, 65 taps, cutoff exactly a quarter of the
//     upsampled rate). That is an exact half-band, so the zero taps are
//     exactly zero and only 33 of the 65 are non-zero; two cascaded stages give
//     a measured -130 dB stopband and 0.005 dB of passband error. JUCE's IIR
//     resampler is not portable to an AudioWorklet, and a fixed FIR needs no
//     coefficient updates.
//   * parameter smoothing. Aureate steps 50 ms linear ramps once per block;
//     this uses a one-pole smoother at the host rate, which cannot overshoot
//     and costs nothing extra.
//   * dry-path delay. Aureate reports its latency to the host and expects the
//     host to compensate. An AudioWorklet effect inside a per-sound chain
//     cannot, so the dry side of the mix is delayed by the oversampler's group
//     delay instead (see DRY_DELAY) — that keeps `mix=0` an exact,
//     phase-aligned passthrough.

var TS_LN2 = 0.6931471805599453;

// ------------------------------------------------ TapeSaturator.h --
//
// The three transfer-function bases, evaluated in double. Kept separate from
// the bias recentring so the ADAA path can reuse them.
function tsCurve(v, model) {
	if (model === 1) return 2 * Math.tanh(v / 2); // console soft knee
	if (model === 2) {
		// exponential saturation; copysign(1 - e^-|v|, v)
		var e = 1 - Math.exp(-Math.abs(v));
		return v < 0 ? -e : e;
	}
	return Math.tanh(v); // tape
}

// Aureate's per-model ceiling on Warmth's bias contribution. The order is the
// voicing: tape is the most forgiving, valve the most asymmetric.
function tsMaxWarmthBias(model) {
	return model === 1 ? 0.1 : model === 2 ? 0.3 : 0.12;
}

// ln cosh(v), never forming cosh(v) itself — it overflows in single precision
// for |v| > ~89, which is exactly where a 24 dB Drive pushes the saturator.
function tsLogCosh(v) {
	var a = Math.abs(v);
	return a + Math.log1p(Math.exp(-2 * a)) - TS_LN2;
}

// Antiderivatives of the three un-biased bases. Any additive constant cancels
// in the ADAA difference, so none is carried.
function tsAntiderivative(v, model) {
	if (model === 1) {
		// d/dv [ 4 * ln cosh(v/2) ] = 2 tanh(v/2), the console knee at scale 2
		return 4 * tsLogCosh(v / 2);
	}
	if (model === 2) {
		// d/dv [ |v| + e^-|v| - 1 ] = sign(v) * (1 - e^-|v|) on both branches,
		// so the form is valid across zero with no special case
		var a = Math.abs(v);
		return a + Math.exp(-a) - 1;
	}
	return tsLogCosh(v);
}

// ------------------------------------------- AdaaShapers.h --
//
// First-order antiderivative anti-aliasing (ADAA1). Instead of point-sampling
// the nonlinearity, integrate it across the segment between input samples:
//
//     y[n] = (F(x[n]) - F(x[n-1])) / (x[n] - x[n-1])
//
// so a sharp corner in f is smeared over the sampling interval instead of
// generating unbounded harmonic energy, and the components that would fold
// back are attenuated at the source. This composes with the oversampler rather
// than replacing it — it runs inside the same 4x region.
//
// Caveats, both inherited from upstream and both documented there:
//  1. ADAA1 carries an inherent half-sample delay at the rate it runs at (in the
//     linear limit it collapses to (x[n]+x[n-1])/2). At 4x that is 0.125 host
//     samples — folded into the integer dry delay and inaudible.
//  2. The same averager has a cos(w/2) magnitude droop, so very high harmonics
//     come out fractionally quieter than the Classic path. HQ is an alias-floor
//     option, not a re-voicing.
//
// Only the input sample is stored, not the previous antiderivative: the bias
// moves every block, and a cached F(x[n-1]) taken under the previous block's
// bias would put a step in the output at every block boundary. Recomputing both
// evaluations costs one extra transcendental and removes the artefact.

var TS_MIN_DELTA = 1e-5;

function tsAntiderivativeBiased(x, bias, model) {
	// the bias is handled so the recentring survives into the ADAA path:
	// f(x+b) - f(b) integrates to F(x+b) - f(b)*x
	return tsAntiderivative(x + bias, model) - tsCurve(bias, model) * x;
}

// f(x) = f(x + bias) - f(bias), the Classic-path output
function tsShape(x, bias, model) {
	return tsCurve(x + bias, model) - tsCurve(bias, model);
}

// ------------------------------------------------ 2x half-band --
//
// One 2x rate conversion. `TAPS` is the prototype length; the windowed sinc is
// designed at a quarter of the upsampled rate, so every tap at an even offset
// from the centre is exactly zero and the result is a true half-band (centre
// tap 0.5, tap sum 1, alternating sum 0). Only the 32 odd-offset taps are ever
// multiplied, so the cost is 32 MACs per output rather than 64.
var TS_TAPS = 65;
var TS_HALF_CENTRE = 32; // (TAPS - 1) / 2
var TS_ODD_LEN = 32; // taps at odd offsets: (TAPS - 1) / 2
var TS_ODD = null;

function tsOddTaps() {
	if (TS_ODD) return TS_ODD;
	// Blackman-Harris window coefficients. This form peaks at the centre, which
	// is what a filter (as opposed to a spectrum estimator) needs.
	var a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
	var h = new Float64Array(TS_TAPS);
	for (var n = 0; n < TS_TAPS; n++) {
		var x = n - TS_HALF_CENTRE;
		// ideal half-band lowpass, 2*fc = 0.5; the DC tap is 0.5
		var ideal = x === 0 ? 0.5 : Math.sin(Math.PI * 0.5 * x) / (Math.PI * x);
		var ph = (2 * Math.PI * n) / (TS_TAPS - 1);
		var w = a0 - a1 * Math.cos(ph) + a2 * Math.cos(2 * ph) - a3 * Math.cos(3 * ph);
		h[n] = ideal * w;
	}
	// The window peaks at exactly 1 and the ideal centre tap at exactly 0.5, so
	// h[centre] is already 0.5 and the half-band conditions hold as designed.
	// Normalise it anyway: the up-converter below hard-codes the even branch as
	// a literal 1.0 (= 2 * 0.5), so pinning h[centre] to 0.5 is what keeps that
	// literal honest if the window is ever retuned. The odd taps inherit the
	// same scale, which leaves their sum at 0.5.
	var g = 0.5 / h[TS_HALF_CENTRE];
	var odd = new Float64Array(TS_ODD_LEN);
	for (var j = 0; j < TS_ODD_LEN; j++) odd[j] = h[2 * j + 1] * g;
	TS_ODD = odd;
	return odd;
}

// Upsample by 2. Zero-stuffing a constant c into (c, 0) halves its average, so
// the interpolator has to put that factor of 2 back: with the prototype summing
// to 1, the whole up-stage gain is 2. In the split-by-phase form that lands as
// 2*0.5 = 1 on the even branch and 2 on the odd-branch dot product.
function tsUp2() {
	var odd = tsOddTaps();
	var buf = new Float64Array(64);
	var w = 0;
	function process(x, out) {
		// x[n] lands at w, so x[n-j] is at w-j
		buf[w] = x;
		// even phase: the only non-zero even-offset tap is the centre, so the
		// whole even branch is one sample TS_HALF_CENTRE/2 back at unity
		out[0] = buf[(w - TS_HALF_CENTRE / 2 + 64) % 64];
		// odd phase: the 32 non-zero odd-offset taps
		var acc = 0;
		for (var j = 0; j < TS_ODD_LEN; j++) acc += odd[j] * buf[(w - j + 64) % 64];
		out[1] = 2 * acc;
		w = (w + 1) % 64;
	}
	function reset() { buf.fill(0); w = 0; }
	return { process: process, reset: reset };
}

// Downsample by 2, fed one input pair at a time. No compensating gain: a
// decimator is plain sampling behind a lowpass, so the prototype's unity tap
// sum is already the right gain. In split-by-phase form that is 0.5 on the
// retained even-phase centre tap plus the odd-branch dot product summing to
// the other 0.5.
function tsDown2() {
	var odd = tsOddTaps();
	var buf = new Float64Array(128);
	var w = 0;
	function process(even, oddSample) {
		buf[w] = even;
		buf[(w + 1) % 128] = oddSample;
		// centre tap: y[2n-32], the even phase TS_HALF_CENTRE samples back
		var acc = 0.5 * buf[(w - TS_HALF_CENTRE + 128) % 128];
		// odd taps at y[2n-1-2j]; buf[w+1] holds y[2n+1], so y[2n-1-2j] is
		// (w+1) - (2j+2) = w-1-2j slots back
		for (var j = 0; j < TS_ODD_LEN; j++) {
			acc += odd[j] * buf[(w - 1 - 2 * j + 128) % 128];
		}
		w = (w + 2) % 128;
		return acc;
	}
	function reset() { buf.fill(0); w = 0; }
	return { process: process, reset: reset };
}

// ----------------------------------------------------- biquads --
//
// RBJ cookbook, direct form I, one instance per channel. Aureate uses a
// Butterworth lowpass for the Warmth rolloff and a resonant peak for the head
// bump, so both shapes live here.
function tsBiquad() {
	var a0 = 1, a1 = 0, a2 = 0, b0 = 1, b1 = 0, b2 = 0;
	var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	function setLowPass(f, q, sr) {
		var w0 = (2 * Math.PI * Math.max(1, f)) / sr;
		var cosw = Math.cos(w0);
		var alpha = Math.sin(w0) / (2 * Math.max(0.5, q));
		b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = b0;
		a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
	}
	function setPeak(f, gainDb, q, sr) {
		var A = Math.pow(10, gainDb / 40);
		var w0 = (2 * Math.PI * Math.max(1, f)) / sr;
		var cosw = Math.cos(w0);
		var alpha = Math.sin(w0) / (2 * Math.max(0.5, q));
		b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A;
		a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A;
	}
	function process(x) {
		var y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
		x2 = x1; x1 = x;
		y2 = y1; y1 = y;
		return y;
	}
	function reset() { x1 = 0; x2 = 0; y1 = 0; y2 = 0; }
	return { setLowPass: setLowPass, setPeak: setPeak, process: process, reset: reset };
}

// ------------------------------------------------- the stage --

function tsState(sr) {
	var OVER = 4;
	// Group delay of the two 2x up stages and the two 2x down stages, in host
	// samples: 16 (up@2x) + 8 (up@4x) + 8 (down@4x) + 16 (down@2x). The dry
	// path is delayed by exactly this so a blend with the wet path does not
	// comb. The Warmth/head-bump biquads sit in the wet path and add a delay of
	// their own (about half a host sample at Warmth=0, a few at Warmth=1); that
	// is not compensated, matching upstream, so heavy Warmth with a partial mix
	// tilts the blend slightly.
	var DRY_DELAY = TS_HALF_CENTRE / 2 + TS_HALF_CENTRE / 4 +
		TS_HALF_CENTRE / 4 + TS_HALF_CENTRE / 2;
	// 50 ms glide, as upstream, expressed in samples so the block-length
	// correction below is exact rather than a fudge
	var SMOOTH_SAMPLES = 0.05 * sr;

	// oversampling, one instance per channel
	var up = [null, null];
	var dn = [null, null];
	var bq = [null, null];
	var hp = [null, null];
	var prevIn = [0, 0]; // ADAA1 previous input, per channel
	var ch;
	for (ch = 0; ch < 2; ch++) {
		up[ch] = [tsUp2(), tsUp2()];
		dn[ch] = [tsDown2(), tsDown2()];
		bq[ch] = tsBiquad(); // Warmth lowpass
		hp[ch] = tsBiquad(); // head bump peak
	}
	// dry path delay line, one per channel
	var dryBuf = [new Float64Array(DRY_DELAY + 1), new Float64Array(DRY_DELAY + 1)];
	var dryW = [0, 0];
	// per-channel scratch for one input sample's worth of 4x output
	var upOut = new Float64Array(2);
	var dnIn = new Float64Array(4);

	// smoothed parameter state (host rate)
	var cur = { drive: 0.25, warmth: 0.35, bias: 0, mix: 1, output: 0 };
	var tgt = { drive: 0.25, warmth: 0.35, bias: 0, mix: 1, output: 0 };
	var model = 0;
	var hq = 1;

	function configure(p) {
		tgt.drive = p.drive;
		tgt.warmth = p.warmth;
		tgt.bias = p.bias;
		tgt.mix = p.mix;
		tgt.output = p.output;
		// Character and Quality are discrete switches — smoothing them would
		// only mean running the wrong curve (or the wrong algebra) for a few
		// milliseconds.
		model = p.character;
		hq = p.quality;
	}

	// One-pole glide toward each target, stepped once per block. The
	// coefficient has to account for the block length: slew() returns the
	// per-*sample* step, and using it per block would stretch a 50 ms glide to
	// (44100/128)*50 ms = 17 s, which no parameter would ever visibly move in.
	// Holding the target for n samples and stepping once is
	// 1 - (1-k)^n = 1 - exp(-n/SMOOTH_SAMPLES).
	function smooth(n) {
		var sm = 1 - Math.exp(-n / SMOOTH_SAMPLES);
		cur.drive += (tgt.drive - cur.drive) * sm;
		cur.warmth += (tgt.warmth - cur.warmth) * sm;
		cur.bias += (tgt.bias - cur.bias) * sm;
		cur.mix += (tgt.mix - cur.mix) * sm;
		cur.output += (tgt.output - cur.output) * sm;
	}

	function processSample(x, c) {
		// --- derived, exactly as AureateEngine maps its parameters ---
		var driveGain = Math.pow(10, (cur.drive * 24) / 20);
		// Warmth -> rolloff cutoff, log-interpolated 20 kHz -> 3 kHz. At 4x the
		// rate is 4*sr, so 20 kHz sits far below Nyquist and warmth=0 really is
		// transparent in band.
		var warmth = cur.warmth < 0 ? 0 : cur.warmth > 1 ? 1 : cur.warmth;
		var lpHz = 20000 * Math.pow(3000 / 20000, warmth);
		var bumpDb = warmth * 1.5;
		// Warmth's bias contribution is Character-dependent; Bias adds to it;
		// the sum is clamped so driving both to their extremes together cannot
		// push the saturator into a fully one-sided operating point.
		var bias = warmth * tsMaxWarmthBias(model) + cur.bias * 0.3;
		if (bias > 0.9) bias = 0.9; else if (bias < -0.9) bias = -0.9;
		var wet = x * driveGain;

		// --- up 2x, twice ---
		// Each up stage is fed *both* samples of its input stream. Feeding only
		// one would interpolate half the spectrum away: it still passes a
		// low-frequency tone but at roughly a quarter of its amplitude and with
		// a badly warped phase, so the dry/wet blend would no longer line up.
		up[c][0].process(wet, upOut);
		var e0 = upOut[0], e1 = upOut[1];
		up[c][1].process(e0, upOut);
		dnIn[0] = upOut[0]; dnIn[1] = upOut[1];
		up[c][1].process(e1, upOut);
		dnIn[2] = upOut[0]; dnIn[3] = upOut[1];

		// --- 4x processing ---
		bq[c].setLowPass(lpHz, Math.SQRT1_2, sr * OVER);
		hp[c].setPeak(80, bumpDb, 0.9, sr * OVER);
		var i;
		for (i = 0; i < OVER; i++) {
			var v = bq[c].process(dnIn[i]);
			v = hp[c].process(v);
			if (hq) {
				var prev = prevIn[c];
				prevIn[c] = v;
				var delta = v - prev;
				// as delta -> 0 the difference quotient is 0/0 and loses
				// precision well before it is exactly 0; the correct limit is
				// the midpoint evaluation, which is continuous with the quotient
				// on either side, so the branch switch is inaudible
				v = Math.abs(delta) < TS_MIN_DELTA
					? tsShape(0.5 * (v + prev), bias, model)
					: (tsAntiderivativeBiased(v, bias, model) -
						tsAntiderivativeBiased(prev, bias, model)) / delta;
			} else {
				v = tsShape(v, bias, model);
			}
			dnIn[i] = v;
		}

		// --- down 2x, twice ---
		// The first stage consumes the 4x stream, so it runs twice per host
		// sample and yields two 2x samples; only then does the second stage
		// blend them. Calling the first stage once and feeding the second stage
		// raw 4x samples would throw the first stage's work away.
		dnIn[1] = dn[c][0].process(dnIn[0], dnIn[1]);
		dnIn[3] = dn[c][0].process(dnIn[2], dnIn[3]);
		return dn[c][1].process(dnIn[1], dnIn[3]);
	}

	// write the input into the dry delay line and read the aligned dry sample
	function processDry(x, c) {
		var size = DRY_DELAY + 1;
		dryBuf[c][dryW[c]] = x;
		var r = (dryW[c] - DRY_DELAY + size) % size;
		var out = dryBuf[c][r];
		dryW[c] = (dryW[c] + 1) % size;
		return out;
	}

	function reset() {
		var i;
		for (i = 0; i < 2; i++) {
			up[i][0].reset(); up[i][1].reset();
			dn[i][0].reset(); dn[i][1].reset();
			bq[i].reset(); hp[i].reset();
			prevIn[i] = 0;
			dryBuf[i].fill(0);
			dryW[i] = 0;
		}
		cur = { drive: 0.25, warmth: 0.35, bias: 0, mix: 1, output: 0 };
		tgt = { drive: 0.25, warmth: 0.35, bias: 0, mix: 1, output: 0 };
	}

	return {
		configure: configure,
		smooth: smooth,
		processSample: processSample,
		processDry: processDry,
		reset: reset,
		// the smoothed mix and output trim, applied after the dry/wet blend.
		// Output is a trim on the *combined* signal, unlike Drive which only
		// affects the wet path.
		mixValue: function () { return cur.mix; },
		outputGain: function () { return Math.pow(10, (cur.output * 24) / 20); },
		DRY_DELAY: DRY_DELAY,
	};
}

class TapeSaturationProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.st = tsState(sampleRate);
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		this.st.configure({
			drive: paramAt(parameters.drive, 0),
			warmth: paramAt(parameters.warmth, 0),
			bias: paramAt(parameters.bias, 0),
			character: Math.round(paramAt(parameters.character, 0)),
			quality: paramAt(parameters.quality, 0),
			mix: paramAt(parameters.mix, 0),
			output: paramAt(parameters.output, 0),
		});
		this.st.smooth(s.n);
		var m = this.st;
		var mix = m.mixValue();
		var dryAmt = 1 - mix;
		var outGain = m.outputGain();
		var hasR = !!s.outR;
		var i;
		for (i = 0; i < s.n; i++) {
			// the right channel is only computed when the output wants it, so a
			// mono-configured node does not pay for a second channel
			var wl = m.processSample(s.inL[i], 0);
			var dl = m.processDry(s.inL[i], 0);
			s.outL[i] = (dryAmt * dl + mix * wl) * outGain;
			if (hasR) {
				var wr = m.processSample(s.inR[i], 1);
				var dr = m.processDry(s.inR[i], 1);
				s.outR[i] = (dryAmt * dr + mix * wr) * outGain;
			}
		}
		return true;
	}
}
TapeSaturationProcessor.parameterDescriptors = desc([
	['drive', 0.25, 0, 1],
	['warmth', 0.35, 0, 1],
	['bias', 0, -1, 1],
	['character', 0, 0, 2],
	['quality', 1, 0, 1],
	['mix', 1, 0, 1],
	['output', 0, -1, 1],
]);
registerProcessor('tapesaturation', TapeSaturationProcessor);
