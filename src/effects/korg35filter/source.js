// -------------------------------------------------------- Korg 35 filter --
//
// Virtual-analog Korg 35 24 dB low-pass / high-pass filter (MS-10 and early
// MS-20), ported from the Faust sources of the faustfilters project:
// <https://github.com/SpotlightKid/faustfilters> — faust/korg35lpf.dsp and
// faust/korg35hpf.dsp (Faust by Eric Tarr / Christopher Arndt, MIT-style
// STK-4.3 license). The per-sample recursion is a 1:1 transcription of the
// generated C++ (plugins/korg35{lpf,hpf}/Korg35*.cpp), so this matches the
// reference plugins sample for sample. Two things are deliberately identical
// to the original and must not be "prettified":
//   * the cutoff control is one-pole smoothed *inside* the DSP (44.1/sr
//     pole, Faust si.smoo) while Q feeds the resonance gain K directly
//   * Q = 0.707 gives K = 0 (no resonance); the range is 0.5 .. 10
//
// One processor covers both models: `isHpf` (from the `highpass` param) picks
// the branch per sample, so a single instance switches low pass <-> high pass
// at runtime. isHpf: 0 = low pass, 1 = high pass.
function korg35State() {
	var srClamped = Math.min(192000, Math.max(1, sampleRate));
	var kCut = 44.1 / srClamped;      // cutoff smoother pole (Faust fConst1)
	var kTan = Math.PI / srClamped;   // tan() step (Faust fConst3)
	var maxCutoff = sampleRate * 0.49;
	var cs = 0;   // smoothed cutoff (Hz)
	var s1 = 0;   // ladder integrator states
	var s2 = 0;
	var s3 = 0;
	// one output sample; advances the state
	return function (x, cutoff, q, isHpf) {
		if (!(cutoff < maxCutoff)) cutoff = maxCutoff;
		cs = kCut * cutoff + (1 - kCut) * cs;
		var g = Math.tan(kTan * cs);
		var t1 = g + 1;
		var t2 = 1 - g / t1;
		var K = 0.21521576 * (q - 0.707);
		var y, t3, t4, t5, t6;
		if (isHpf) {
			t3 = (x - s3) * g;
			t4 = (x - (s3 + (t3 - s1 + g * s2 / t1) / t1)) / (1 - K * (g * t2 / t1));
			y = t4;
			t5 = K * t4;
			t6 = g * (t5 - s2) / t1;
			s1 = s1 + 2 * (g * (t5 - (t6 + s1 + s2)) / t1);
			s2 = s2 + 2 * t6;
			s3 = s3 + 2 * (t3 / t1);
		} else {
			t3 = (x - s3) * g;
			t4 = g * ((s3 + (t3 + K * s1 * t2 - s2) / t1) / (1 - K * (g * t2 / t1)) - s1) / t1;
			y = s1 + t4;
			s1 = s1 + 2 * t4;
			s2 = s2 + 2 * (g * (K * y - s2) / t1);
			s3 = s3 + 2 * (t3 / t1);
		}
		return y;
	};
}

// The (mono) Faust recursion runs once per channel; `highpass` selects the mode.
class Korg35FilterProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.fL = korg35State();
		this.fR = korg35State();
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var q = paramAt(parameters.q, 0);
		var isHpf = paramAt(parameters.highpass, 0) >= 0.5 ? 1 : 0;
		var i;
		for (i = 0; i < s.n; i++) {
			var co = paramAt(parameters.cutoff, i);
			s.outL[i] = this.fL(s.inL[i], co, q, isHpf);
			if (s.outR) s.outR[i] = this.fR(s.inR[i], co, q, isHpf);
		}
		return true;
	}
}
Korg35FilterProcessor.parameterDescriptors = desc([['cutoff', 20000, 20, 20000], ['q', 1, 0.5, 10], ['highpass', 0, 0, 1]]);
registerProcessor('korg35filter', Korg35FilterProcessor);
