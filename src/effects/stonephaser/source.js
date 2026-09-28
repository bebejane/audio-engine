// ------------------------------------------------------- stone phaser --
//
// 4-stage analog phaser, ported from the Faust DSP in
// github.com/jpcima/stone-phaser (BSL-1.0 / CC0-1.0), itself a gray-box model
// of a real pedal following Kiiski, Esqueda & Valimaki, "Time-variant gray-box
// modeling of a phaser pedal" (DAFx-16).
//
// Mono chain, run twice for stereo:
//   x -> HPF(33 Hz) -> (+) -> allpass x4 -> out
//   feedback: out -> HPF(feedbackBassCut) * colorGain -> (+)
//
// Every control is one-pole smoothed with a 100 ms time constant (Faust
// "tsmooth"). Two things are deliberate and must not be "fixed": all four
// allpass stages share a single coefficient, and that coefficient is Faust's
// approximation a = -1 + 2*PI*f/SR rather than the textbook tan() form.
//
// The recurrences below are a direct transcription of the Faust-generated C++
// (plugins/stone-phaser/gen/StonePhaserDsp.cpp) -- note that the right channel
// of the stereo build is the same mono phaser with the LFO phase offset by the
// (smoothed) "phase" control.
function hzToMidi(f) {
	return 69 + 12 * Math.log2(f / 440);
}
// Faust "sineTri"(0.95, pos) wavetable: a rounded triangle, 1 at pos 0
// dipping to ~0 at pos 0.5. Faust uses a 128-entry rdtable + linear
// interpolation; kept here so the sweep matches sample for sample.
function phaserTriTable() {
	var n = 128;
	var a = 0.975;
	var asin = Math.asin(a);
	var t = new Float32Array(n);
	for (var i = 0; i < n; i++) {
		var x = i / n;
		t[i] = 1 - Math.sin(2 * (x < 0.5 ? x : 1 - x) * asin) / a;
	}
	return t;
}
function phaserState() {
	return { hp: 0, fbp: 0, r5: 0, r4: 0, r3: 0, r2: 0, r1: 0 };
}
// one sample of the mono phaser; st is per-channel, the rest are shared
// per-sample coefficients
function phaserSample(st, x, p33, hpGain, pfb, fbGain, colorGain, a) {
	var hp1 = st.hp;
	st.hp = x + p33 * hp1;
	var inHpf = hpGain * (st.hp - hp1);
	var fbp1 = st.fbp;
	st.fbp = st.r1 + pfb * fbp1;
	var inFb = colorGain * fbGain * (st.fbp - fbp1);
	var p5 = st.r5, p4 = st.r4, p3 = st.r3, p2 = st.r2;
	st.r5 = inHpf + inFb - a * p5;
	st.r4 = p5 + a * (st.r5 - p4);
	st.r3 = p4 + a * (st.r4 - p3);
	st.r2 = p3 + a * (st.r3 - p2);
	// fourth allpass output; note there is deliberately NO recursive term here
	// (Faust: "fRec1[i] = fRec2[i-1] + fRec2[i] * a") -- adding one turns the
	// wet path into a resonant one-pole cascade instead of an allpass
	st.r1 = p2 + a * st.r2;
	return st.r1;
}
function phaserCoef(tbl, loKey, hiKey, pos, sr, c8, kl) {
	var fidx = 128 * pos;
	var i0 = fidx | 0;
	var fr = fidx - i0;
	var t0 = tbl[i0];
	var t1 = tbl[(i0 + 1) & 127];
	var key = loKey + (hiKey - loKey) * (t0 + (t1 - t0) * fr);
	// a = -1 + 2*PI*f/SR, f = midikey2hz(key)
	var a = c8 * Math.exp(kl * (key - 69)) - 1;
	// keep every pole (-a) inside the unit circle; only reachable below
	// ~11.5 kHz sample rate, where the pedal itself would blow up
	if (a > 0.999) a = 0.999;
	else if (a < -0.999) a = -0.999;
	return a;
}
// one-pole smoother in Faust's "si.smooth(tau2pole(0.1))" form: the state is
// seeded with its target so the effect does not fade in on start
function smoother(init, pole) {
	var s = init;
	return function (target) {
		s = (1 - pole) * target + pole * s;
		return s;
	};
}

class StonePhaserProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.tbl = phaserTriTable();
		this.stL = phaserState();
		this.stR = phaserState();
		this.p33 = Math.exp(-6.283185307179586 * 33 / sampleRate);
		this.hpGain = 0.5 * (1 + this.p33);
		this.c8 = 2764.6015655503763 / sampleRate; // 2*PI*440 / SR
		this.kl = 0.05776226504666211; // ln(2)/12
		this.MIDI_LO_COLOR = hzToMidi(80);
		this.MIDI_HI_COLOR = hzToMidi(2200);
		this.MIDI_LO_PLAIN = hzToMidi(300);
		this.MIDI_HI_PLAIN = hzToMidi(6000);
		var pole = 1 - slew(0.1, sampleRate);
		// seeded with the parameter defaults (see desc below)
		this.smLf = smoother(0.2, pole);
		this.smFb = smoother(0.01 * 0.75, pole);
		this.smColorFb = smoother(0.01 * 0.75, pole);
		this.smFbCut = smoother(500, pole);
		this.smW = smoother(Math.sin(0.5 * Math.PI / 2), pole);
		this.smD = smoother(Math.cos(0.5 * Math.PI / 2), pole);
		this.smPhase = smoother(1, pole);
		this.smLo = smoother(this.MIDI_LO_COLOR, pole);
		this.smHi = smoother(this.MIDI_HI_COLOR, pole);
		this.phaseL = 0;
		this.phaseR = 0;
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var fb = paramAt(parameters.feedback, 0);
		var mix = paramAt(parameters.mix, 0);
		var fbCut = paramAt(parameters.feedbackBassCut, 0);
		var color = paramAt(parameters.color, 0) >= 0.5;
		var phase = paramAt(parameters.phase, 0);
		// block-constant targets, smoothed per sample below
		var tgtLf = paramAt(parameters.speed, 0);
		var tgtFb = 0.01 * fb;
		var tgtMixF = mix * Math.PI / 2;
		var tgtW = Math.sin(tgtMixF);
		var tgtD = Math.cos(tgtMixF);
		var tgtPhase = 1 + phase / 360;
		var tgtLo = color ? this.MIDI_LO_COLOR : this.MIDI_LO_PLAIN;
		var tgtHi = color ? this.MIDI_HI_COLOR : this.MIDI_HI_PLAIN;
		var tbl = this.tbl;
		var c8 = this.c8;
		var kl = this.kl;
		var p33 = this.p33;
		var hpGain = this.hpGain;
		var i;
		for (i = 0; i < s.n; i++) {
			var lf = this.smLf(tgtLf);
			var fbBase = this.smFb(tgtFb);
			var colorGain = this.smColorFb(color ? fbBase : 0.1 * fbBase);
			var fbCutS = this.smFbCut(fbCut);
			var w = this.smW(tgtW);
			var d = this.smD(tgtD);
			var loKey = this.smLo(tgtLo);
			var hiKey = this.smHi(tgtHi);
			var pfb = Math.exp(-6.283185307179586 * fbCutS / sampleRate);
			var fbGain = 0.5 * (1 + pfb);
			this.phaseL += lf / sampleRate;
			if (this.phaseL >= 1) this.phaseL -= Math.floor(this.phaseL);
			var phR = this.phaseL + this.smPhase(tgtPhase);
			phR -= Math.floor(phR);
			var aL = phaserCoef(tbl, loKey, hiKey, this.phaseL, sampleRate, c8, kl);
			var aR = phaserCoef(tbl, loKey, hiKey, phR, sampleRate, c8, kl);
			var xL = s.inL[i];
			var yL = phaserSample(this.stL, xL, p33, hpGain, pfb, fbGain, colorGain, aL);
			s.outL[i] = xL * d + yL * w;
			if (s.outR) {
				var xR = s.inR[i];
				var yR = phaserSample(this.stR, xR, p33, hpGain, pfb, fbGain, colorGain, aR);
				s.outR[i] = xR * d + yR * w;
			}
		}
		return true;
	}
}
StonePhaserProcessor.parameterDescriptors = desc([
	['speed', 0.2, 0.01, 5],
	['feedback', 0.75, 0, 0.99],
	['feedbackBassCut', 500, 10, 5000],
	['mix', 0.5, 0, 1],
	['color', 1, 0, 1],
	['phase', 0, -180, 180],
]);
registerProcessor('stonephaser', StonePhaserProcessor);
