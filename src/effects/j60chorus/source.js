// ------------------------------------------ J60 chorus (BBD delay) --
//
// Mono-in / stereo-out Juno-60 chorus. Ported from jpcima/rc-effect-playground
// ("Hera Chorus", ISC license - see LICENSE.txt):
//   * sources/chorus.dsp (+ generated chorus.dsp.cxx) gives the LFO, the
//     100 ms smoothing of every mode parameter and the 0.83*dry + wet blend
//   * sources/bbd_line.cpp / bbd_filter.cpp model the switched-capacitor
//     Bucket-Brigade delay: 256 stages, clock Fclk = 2*stages/delay, alternating
//     between a 5th-order input charge filter and a 5th-order output charge
//     filter (the measured Juno-60 analog specs bbd_fin_j60 / bbd_fout_j60,
//     discretized by pole interpolation over 128 steps)
// The mode table (rates / delays / stereo) is measured in pendragon-andyh/Juno60
// (Chorus/README.md). The BBD colour (its own charge filters) replaces the
// simple 10 kHz anti-alias lowpass of the reference's digital delay branch.
//
// The dry/wet blend is layered on top of the hardware sound:
//   out = x + mix * ((1-enabled)*x + enabled*(0.83*x + wet) - x)
// so mix = 1 is the hardware behaviour and mix = 0 is clean dry.
//
// Complex numbers are split into re/im Float64Arrays to keep the audio callback
// allocation-free.

// Measured Juno-60 BBD input / output charge-filter specs (bbd_filter.cpp).
var J60_IN = {
	M: 5,
	Rre: [251589, -130428, -130428, 4634, 4634],
	Rim: [0, -4165, 4165, -22873, 22873],
	Pre: [-46580, -55482, -55482, -26292, -26292],
	Pim: [0, 25082, -25082, -59437, 59437],
	isInput: 1,
};
var J60_OUT = {
	M: 5,
	Rre: [5092, 11256, 11256, -13802, -13802],
	Rim: [0, -99566, 99566, -24606, 24606],
	Pre: [-176261, -51468, -51468, -26276, -26276],
	Pim: [0, 21437, -21437, -59699, 59699],
	isInput: 0,
};

// Discretize one analog spec (BBD::compute_filter) into an N-row table of
// complex gains G, plus the discretized poles and the real feedback term H.
function bbdComplexFilter(spec, fs, N) {
	var M = spec.M;
	var ts = 1 / fs;
	var Pre = new Float64Array(M), Pim = new Float64Array(M);
	var pr = new Float64Array(M), pth = new Float64Array(M);
	var m;
	for (m = 0; m < M; m++) {
		var er = Math.exp(ts * spec.Pre[m]);
		var th = ts * spec.Pim[m];
		Pre[m] = er * Math.cos(th);
		Pim[m] = er * Math.sin(th);
		pr[m] = Math.hypot(Pre[m], Pim[m]);
		pth[m] = Math.atan2(Pim[m], Pre[m]);
	}
	var GRe = new Float64Array(N * M), GIm = new Float64Array(N * M);
	for (var step = 0; step < N; step++) {
		var d = step / (N - 1);
		for (m = 0; m < M; m++) {
			var ex = spec.isInput ? d : 1 - d;
			var rr = Math.pow(pr[m], ex);
			var ang = pth[m] * ex;
			var zRe = rr * Math.cos(ang), zIm = rr * Math.sin(ang);
			var gRe, gIm;
			if (spec.isInput) {
				gRe = ts * (spec.Rre[m] * zRe - spec.Rim[m] * zIm);
				gIm = ts * (spec.Rre[m] * zIm + spec.Rim[m] * zRe);
			} else {
				var den = spec.Pre[m] * spec.Pre[m] + spec.Pim[m] * spec.Pim[m];
				var qRe = (spec.Rre[m] * spec.Pre[m] + spec.Rim[m] * spec.Pim[m]) / den;
				var qIm = (spec.Rim[m] * spec.Pre[m] - spec.Rre[m] * spec.Pim[m]) / den;
				gRe = qRe * zRe - qIm * zIm;
				gIm = qRe * zIm + qIm * zRe;
			}
			GRe[step * M + m] = gRe;
			GIm[step * M + m] = gIm;
		}
	}
	var H = 0;
	for (m = 0; m < M; m++) {
		var dn = spec.Pre[m] * spec.Pre[m] + spec.Pim[m] * spec.Pim[m];
		H -= (spec.Rre[m] * spec.Pre[m] + spec.Rim[m] * spec.Pim[m]) / dn;
	}
	return { M: M, N: N, GRe: GRe, GIm: GIm, Pre: Pre, Pim: Pim, H: H };
}

// Interpolate the G table row for a fractional clock phase (interpolate_G).
function bbdInterpG(f, d, outRe, outIm) {
	var M = f.M, N = f.N;
	var row = d * (N - 1);
	var r1 = row | 0;
	if (r1 > N - 1) r1 = N - 1;
	var r2 = r1 + 1 < N ? r1 + 1 : N - 1;
	var mu = row - (row | 0);
	var o1 = r1 * M, o2 = r2 * M;
	for (var m = 0; m < M; m++) {
		outRe[m] = (1 - mu) * f.GRe[o1 + m] + mu * f.GRe[o2 + m];
		outIm[m] = (1 - mu) * f.GIm[o1 + m] + mu * f.GIm[o2 + m];
	}
}

// One BBD line (bbd_line.cpp process_single): 256 stages, alternating between
// storing a charge through the input filter and reading the charge delta
// through the output filter. process(x, fclk) with fclk = Fclk/Fs.
function bbdLine(fs, ns) {
	var fin = bbdComplexFilter(J60_IN, fs, 128);
	var fout = bbdComplexFilter(J60_OUT, fs, 128);
	var Min = fin.M, Mout = fout.M;
	var mem = new Float64Array(ns);
	var imem = 0, pclk = 0, ptick = 0, ybbdOld = 0;
	var XinRe = new Float64Array(Min), XinIm = new Float64Array(Min);
	var XoutRe = new Float64Array(Mout), XoutIm = new Float64Array(Mout);
	var XoutMemRe = new Float64Array(Mout), XoutMemIm = new Float64Array(Mout);
	var GinRe = new Float64Array(Min), GinIm = new Float64Array(Min);
	var GoutRe = new Float64Array(Mout), GoutIm = new Float64Array(Mout);
	return function (input, fclk) {
		var m, tick;
		for (m = 0; m < Mout; m++) {
			XoutRe[m] = 0;
			XoutIm[m] = 0;
		}
		if (fclk > 0) {
			var pclkOld = pclk;
			pclk += fclk;
			var tickCount = pclk | 0;
			pclk -= tickCount;
			for (tick = 0; tick < tickCount; tick++) {
				var d = (1 - pclkOld + tick) * (1 / fclk);
				d -= d | 0;
				if ((ptick & 1) === 0) {
					bbdInterpG(fin, d, GinRe, GinIm);
					var sRe = 0, sIm = 0;
					for (m = 0; m < Min; m++) {
						sRe += GinRe[m] * XinRe[m] - GinIm[m] * XinIm[m];
						sIm += GinRe[m] * XinIm[m] + GinIm[m] * XinRe[m];
					}
					mem[imem] = sRe;
					imem = imem + 1 < ns ? imem + 1 : 0;
				} else {
					bbdInterpG(fout, d, GoutRe, GoutIm);
					var ybbd = mem[imem];
					var delta = ybbd - ybbdOld;
					ybbdOld = ybbd;
					for (m = 0; m < Mout; m++) {
						XoutRe[m] += GoutRe[m] * delta;
						XoutIm[m] += GoutIm[m] * delta;
					}
				}
				ptick++;
			}
		}
		for (m = 0; m < Min; m++) {
			var xr = XinRe[m], xi = XinIm[m];
			XinRe[m] = fin.Pre[m] * xr - fin.Pim[m] * xi + input;
			XinIm[m] = fin.Pre[m] * xi + fin.Pim[m] * xr;
		}
		var y = fout.H * ybbdOld;
		for (m = 0; m < Mout; m++) {
			var oRe = fout.Pre[m] * XoutMemRe[m] - fout.Pim[m] * XoutMemIm[m] + XoutRe[m];
			var oIm = fout.Pre[m] * XoutMemIm[m] + fout.Pim[m] * XoutMemRe[m] + XoutIm[m];
			XoutMemRe[m] = oRe;
			XoutMemIm[m] = oIm;
			y += oRe;
		}
		return y;
	};
}

// LFO + smoothed mode parameters + the two BBD lines (chorus.dsp.cxx compute()).
// The smoothed states are seeded from the current mode on the first block
// instead of ramping up from zero (the reference resets them to 0, which makes
// the first 100 ms sweep the delay up from 0 and is audible as a whoosh when an
// effect is dropped into a running mix); the enabled flag still fades in.
function j60ChorusState(fs) {
	var p = Math.exp(-10 / fs); // fConst1: 100 ms one-pole pole
	var om = 1 - p; // fConst2
	var invSr = 1 / fs; // fConst3
	var NS = 256;
	var lineL = bbdLine(fs, NS);
	var lineR = bbdLine(fs, NS);
	var seeded = false;
	var enabled = 0;
	var dMinL = 0, dMaxL = 0, shape = 0, rate = 0, phL = 0, phR = 0;
	var dMinR = 0, dMaxR = 0, stereo = 1;
	var out = new Float64Array(2);
	return function (x, mode, mix) {
		var isIII = mode === 3;
		var minLT = isIII ? 0.00322 : 0.00154;
		var maxLT = isIII ? 0.00356 : 0.00515;
		var minRT = isIII ? 0.00328 : 0.00151;
		var maxRT = isIII ? 0.00365 : 0.0054;
		var shapeT = isIII ? 1 : 0;
		var rateT = isIII ? 9.75 : mode === 2 ? 0.863 : 0.513;
		var stereoT = isIII ? 0 : 1;
		if (!seeded) {
			seeded = true;
			dMinL = minLT;
			dMaxL = maxLT;
			dMinR = minRT;
			dMaxR = maxRT;
			shape = shapeT;
			rate = rateT;
			stereo = stereoT;
		}
		enabled = p * enabled + om * (mode !== 0 ? 1 : 0);
		dMinL = p * dMinL + om * minLT;
		dMaxL = p * dMaxL + om * maxLT;
		shape = p * shape + om * shapeT;
		var ratePrev = rate;
		rate = p * rate + om * rateT;
		var tL = phL + invSr * ratePrev;
		phL = tL - Math.floor(tL);
		var tR = phR + invSr * rate;
		phR = tR - Math.floor(tR);
		var tri = 1 - Math.abs(2 * phL - 1);
		var sine = 0.5 * (Math.sin(2 * Math.PI * phR) + 1);
		var lfo = (1 - shape) * tri + shape * sine;
		dMinR = p * dMinR + om * minRT;
		dMaxR = p * dMaxR + om * maxRT;
		stereo = p * stereo + om * stereoT;
		var delayL = dMinL + (dMaxL - dMinL) * lfo;
		var delayR = dMinR + (dMaxR - dMinR) * ((1 - stereo) * lfo + stereo * (1 - lfo));
		var wetL = lineL(x, ((2 * NS) / delayL) * invSr);
		var wetR = lineR(x, ((2 * NS) / delayR) * invSr);
		var eL = (1 - enabled) * x + enabled * (0.83 * x + wetL);
		var eR = (1 - enabled) * x + enabled * (0.83 * x + wetR);
		out[0] = x + mix * (eL - x);
		out[1] = x + mix * (eR - x);
		return out;
	};
}

class J60ChorusProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.st = j60ChorusState(sampleRate);
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var ci = paramAt(parameters.chorusI, 0) >= 0.5 ? 1 : 0;
		var cii = paramAt(parameters.chorusII, 0) >= 0.5 ? 1 : 0;
		var mode = ci | (cii << 1);
		var mix = paramAt(parameters.mix, 0);
		var i;
		for (i = 0; i < s.n; i++) {
			// Juno 60 signal path: mono into the chorus, stereo out
			var o = this.st((s.inL[i] + s.inR[i]) * 0.5, mode, mix);
			s.outL[i] = o[0];
			if (s.outR) s.outR[i] = o[1];
		}
		return true;
	}
}
J60ChorusProcessor.parameterDescriptors = desc([
	['chorusI', 0, 0, 1],
	['chorusII', 1, 0, 1],
	['mix', 1, 0, 1],
]);
registerProcessor('j60chorus', J60ChorusProcessor);
