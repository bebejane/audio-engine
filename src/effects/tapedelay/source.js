// ------------------------------------------------------- Tape Delay --
//
// Multi-head tape echo in the spirit of the Roland RE-201 Space Echo. The base
// delay / feedback / mix come from cyrusasfa/TapeDelay; the tape character is
// modelled after the ISC-licensed re-deemer DSP (naturarum/re-deemer,
// crates/te2-dsp/src/tape/*):
//   * wow + flutter + scrape-flutter capstan speed model (one shared capstan)
//   * Jiles-Atherton tape hysteresis solved with RK4, after Chowdhury DAFx-19
//   * record pre-emphasis, level-dependent HF self-erasure, repro de-emphasis
//     + head bump + speed-dependent gap loss + spacing loss
//   * tape types I/II/IV and an "age" macro (wear, dropouts, bias sag)
// See LICENSE.txt. Three playback heads at t, 2t, 3t (density scales
// the spacing); feedback returns through the record path so every repeat is
// re-recorded and re-saturated.

var PP_TAPE_TYPES = [
	// Type I (ferric): strong emphasis, pronounced bump, dullest top.
	{ a: 2.2e4 / 3.5e5, alpha: 1.6e-3, k: 2.7e4 / 3.5e5, c: 0.17, drive: 4 * (2.2e4 / 3.5e5), bias: 0.82,
		emphasisDb: 6.0, emphasisFc: 5200, bumpFc: 85, bumpDb: 2.6, gapFc: 13000, spacingDb: -2.5, spacingFc: 9000 },
	// Type II (chrome): 70 us EQ, brighter, leaner bump.
	{ a: 2.2e4 / 3.5e5, alpha: 1.6e-3, k: (2.7e4 / 3.5e5) * 1.25, c: 0.17, drive: 4 * (2.2e4 / 3.5e5) * 0.78, bias: 0.88,
		emphasisDb: 4.5, emphasisFc: 6300, bumpFc: 80, bumpDb: 2.2, gapFc: 15000, spacingDb: -1.8, spacingFc: 10000 },
	// Type IV (metal): most headroom, most extended.
	{ a: 2.2e4 / 3.5e5, alpha: 1.6e-3, k: (2.7e4 / 3.5e5) * 1.5, c: 0.17, drive: 4 * (2.2e4 / 3.5e5) * 0.6, bias: 0.92,
		emphasisDb: 3.5, emphasisFc: 7000, bumpFc: 76, bumpDb: 1.8, gapFc: 16500, spacingDb: -1.2, spacingFc: 11000 },
];
var PP_TAPE_DRIVE_LO = 0.35;  // effDrive = base*(LO + SPAN*drive)
var PP_TAPE_DRIVE_SPAN = 2.2;

function ppClamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

// RBJ biquad with shelves / peaking / LP / HP (normalized coefficients baked).
function ppRBJ() {
	var b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
	var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	function norm(nb0, nb1, nb2, na0, na1, na2) {
		var inv = 1 / na0;
		b0 = nb0 * inv; b1 = nb1 * inv; b2 = nb2 * inv; a1 = na1 * inv; a2 = na2 * inv;
	}
	function setup(kind, sr, f, q, db) {
		f = ppClamp(f, 1, 0.49 * sr);
		var A = Math.pow(10, db / 40);
		var w0 = 2 * Math.PI * f / sr;
		var cosw = Math.cos(w0);
		var sinw = Math.sin(w0);
		if (kind === 'peaking') {
			var al = sinw / (2 * q);
			norm(1 + al * A, -2 * cosw, 1 - al * A, 1 + al / A, -2 * cosw, 1 - al / A);
		} else if (kind === 'lowshelf') {
			var als = sinw / 2 * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
			var bs = 2 * Math.sqrt(A) * als;
			norm(A * ((A + 1) - (A - 1) * cosw + bs), 2 * A * ((A - 1) - (A + 1) * cosw), A * ((A + 1) - (A - 1) * cosw - bs),
				(A + 1) + (A - 1) * cosw + bs, -2 * ((A - 1) + (A + 1) * cosw), (A + 1) + (A - 1) * cosw - bs);
		} else if (kind === 'highshelf') {
			var alh = sinw / 2 * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
			var bh = 2 * Math.sqrt(A) * alh;
			norm(A * ((A + 1) + (A - 1) * cosw + bh), -2 * A * ((A - 1) + (A + 1) * cosw), A * ((A + 1) + (A - 1) * cosw - bh),
				(A + 1) - (A - 1) * cosw + bh, 2 * ((A - 1) - (A + 1) * cosw), (A + 1) - (A - 1) * cosw - bh);
		} else if (kind === 'lowpass') {
			var al2 = sinw / (2 * q);
			norm((1 - cosw) / 2, 1 - cosw, (1 - cosw) / 2, 1 + al2, -2 * cosw, 1 - al2);
		} else { // highpass
			var al3 = sinw / (2 * q);
			norm((1 + cosw) / 2, -(1 + cosw), (1 + cosw) / 2, 1 + al3, -2 * cosw, 1 - al3);
		}
	}
	function process(x) {
		var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
		x2 = x1; x1 = x; y2 = y1; y1 = y;
		return Number.isFinite(y) ? y : 0;
	}
	function reset() { x1 = x2 = y1 = y2 = 0; }
	return { set: setup, process: process, reset: reset };
}

// Jiles-Atherton hysteresis (after Chowdhury, DAFx-19 / re-deemer, ISC).
function ppLangevin(x) {
	if (Math.abs(x) < 1e-4) return x / 3 - x * x * x / 45;
	return 1 / Math.tanh(x) - 1 / x;
}
function ppLangevinD(x) {
	if (Math.abs(x) < 1e-4) return 1 / 3 - x * x / 15;
	var coth = 1 / Math.tanh(x);
	return 1 - coth * coth + 1 / (x * x);
}
function ppTapeParams(typeIdx, driveParam) {
	var t = PP_TAPE_TYPES[ppClamp(typeIdx | 0, 0, PP_TAPE_TYPES.length - 1)];
	return {
		a: t.a, alpha: t.alpha, k: t.k, c: t.c, bias: t.bias,
		baseDrive: t.drive,
		drive: t.drive * (PP_TAPE_DRIVE_LO + PP_TAPE_DRIVE_SPAN * driveParam),
		emphasisDb: t.emphasisDb, emphasisFc: t.emphasisFc,
		bumpFc: t.bumpFc, bumpDb: t.bumpDb, gapFc: t.gapFc,
		spacingDb: t.spacingDb, spacingFc: t.spacingFc,
	};
}
function ppTapeMagState() {
	var m = 0, hPrev = 0, mAnPrev = 0, xPrev = 0;
	function dmdt(p, mm, h, dh) {
		var q = (h + p.alpha * mm) / p.a;
		var mAn = ppLangevin(q);
		var l = ppLangevinD(q);
		var delta = dh >= 0 ? 1 : -1;
		var diff = mAn - mm;
		var deltaM = diff * delta >= 0 ? 1 : 0;
		var denomIrr = (1 - p.c) * delta * p.k - p.alpha * diff;
		var irr = Math.abs(denomIrr) < 1e-12 ? 0 : (1 - p.c) * deltaM * diff / denomIrr;
		var rev = p.c * l / p.a;
		var denom = 1 - p.c * p.alpha * l / p.a;
		return (irr + rev) / Math.max(1e-9, denom) * dh;
	}
	function step(x, p, dt) {
		var h = x * p.drive;
		var dh = (h - hPrev) / dt;
		var hHalf = 0.5 * (h + hPrev);
		var k1 = dt * dmdt(p, m, hPrev, dh);
		var k2 = dt * dmdt(p, m + 0.5 * k1, hHalf, dh);
		var k3 = dt * dmdt(p, m + 0.5 * k2, hHalf, dh);
		var k4 = dt * dmdt(p, m + k3, h, dh);
		var mn = m + (k1 + 2 * k2 + 2 * k3 + k4) / 6;
		if (!Number.isFinite(mn)) mn = 0;
		m = ppClamp(mn, -1, 1);
		hPrev = h;
		var mAn = ppLangevin((h + p.alpha * mAnPrev) / p.a);
		mAn = ppLangevin((h + p.alpha * mAn) / p.a);
		mAnPrev = mAn;
		return p.bias * mAn + (1 - p.bias) * m;
	}
	// 2x oversampled (linear upsample, box decimate)
	function process(x, p, dt2, outNorm) {
		var ya = step(0.5 * (xPrev + x), p, dt2);
		var yb = step(x, p, dt2);
		xPrev = x;
		return 0.5 * (ya + yb) * outNorm;
	}
	function reset() { m = 0; hPrev = 0; mAnPrev = 0; xPrev = 0; }
	return { process: process, reset: reset };
}
// Normalize the hysteresis small-signal gain so a knob change of drive does
// not change the level (measured once per tape type at construction).
function ppTapeMagNorm(typeIdx, sr) {
	var p = ppTapeParams(typeIdx, 1);
	var st = ppTapeMagState();
	var dt2 = 1 / (2 * sr);
	var n = Math.max(2048, Math.floor(sr * 0.06));
	var inSq = 0, outSq = 0;
	for (var i = 0; i < n; i++) {
		var x = 0.05 * Math.sin(2 * Math.PI * 1000 * i / sr);
		var y = st.process(x, p, dt2, 1);
		if (i > n / 2) { inSq += x * x; outSq += y * y; }
	}
	var gain = Math.sqrt(outSq / Math.max(1e-12, inSq));
	return 1 / Math.max(1e-6, gain);
}

// Shared capstan: wow + flutter + scrape flutter speed multiplier and, per
// channel, oxide dropout dips (re-deemer wow_flutter.rs, ISC).
function ppTapeWowFlutter(sr) {
	var FL = [6.3, 10.7, 17.9, 29.4];
	var FA = [1.0, 0.7, 0.45, 0.25];
	var wowPhase = 0;
	var driftState = 0;
	var driftCoeff = 1 - Math.exp(-2 * Math.PI * 0.4 / sr);
	var flPhase = [0, 1.3, 2.9, 4.1];
	var scrape = [0, 0];
	var rng = 0x9e3779b9 >>> 0;
	var amount = 0.3, age = 0.2;
	var dropPos = [0, 0], dropLen = [0, 0], dropDepth = [0, 0];
	var gains = [1, 1];
	function noise() {
		rng = (rng * 1664525 + 1013904223) >>> 0;
		return (rng >>> 8) / 8388608 - 1;
	}
	function next() {
		var c = amount;
		wowPhase += 2 * Math.PI * 0.83 / sr;
		if (wowPhase >= 2 * Math.PI) wowPhase -= 2 * Math.PI;
		var wow = 1.0e-3 * c * Math.sin(wowPhase);
		var driftTarget = noise() * 0.8e-3 * c;
		driftState += driftCoeff * (driftTarget - driftState);
		var flDepth = 0.30e-3 * c;
		var flutter = 0;
		for (var i = 0; i < 4; i++) {
			flPhase[i] += 2 * Math.PI * FL[i] / sr;
			if (flPhase[i] >= 2 * Math.PI) flPhase[i] -= 2 * Math.PI;
			flutter += FA[i] * flDepth * Math.sin(flPhase[i]);
		}
		var nz = noise();
		var w = 2 * Math.PI * (2000 / sr);
		var r = 0.995;
		var bpin = nz - 2 * r * Math.cos(w) * scrape[0] - r * r * scrape[1];
		var scrapeOut = (bpin - scrape[1]) * 0.02e-3 * c;
		scrape[1] = scrape[0]; scrape[0] = bpin;
		var mult = 1 + wow + driftState + flutter + scrapeOut;
		var rate = age * age * 0.4 / sr;
		for (var ch = 0; ch < 2; ch++) {
			if (dropLen[ch] > 0) {
				dropPos[ch] += 1;
				var t = dropPos[ch] / dropLen[ch];
				if (t >= 1) { dropLen[ch] = 0; gains[ch] = 1; }
				else gains[ch] = 1 - dropDepth[ch] * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
			} else if (Math.abs(noise()) < rate) {
				dropLen[ch] = (8 + Math.abs(noise()) * 42) * 1e-3 * sr;
				dropPos[ch] = 0;
				dropDepth[ch] = 0.3 + 0.6 * Math.abs(noise()) * age;
			}
		}
		return mult;
	}
	return {
		next: next,
		noise: noise,
		gains: gains,
		setAmount: function (a, g) { amount = a; age = g; },
	};
}

function ppTapeDelayState(sr) {
	var bufLen = Math.ceil(sr * 3.5) + 8;
	var mags = [ppTapeMagState(), ppTapeMagState()];
	var lines = [ppDelayLine(bufLen), ppDelayLine(bufLen)];
	var preEmph = [ppRBJ(), ppRBJ()];
	var deEmph = [ppRBJ(), ppRBJ()];
	var bump = [ppRBJ(), ppRBJ()];
	var gap = [ppRBJ(), ppRBJ()];
	var spacingEq = [ppRBJ(), ppRBJ()];
	var bassEq = [ppRBJ(), ppRBJ()];
	var trebleEq = [ppRBJ(), ppRBJ()];
	var eraseEnv = [0, 0], eraseLp = [0, 0];
	var envCoeff = 1 - Math.exp(-2 * Math.PI * 25 / sr);
	var osDt = 1 / (2 * sr);
	var capstan = ppTapeWowFlutter(sr);
	var norms = [ppTapeMagNorm(0, sr), ppTapeMagNorm(1, sr), ppTapeMagNorm(2, sr)];
	var timeCoeff = 1 - Math.exp(-1 / (0.12 * sr));
	var curTimeMs = 220;
	var timeMs = 220;
	var seeded = false;
	var cfg = { density: 1, h1: 1, h2: 0, h3: 0, feedback: 0.5, mix: 0.5, hiss: 0.1, wear: 0.2, p: null, outNorm: 1 };
	var out = new Float64Array(2);

	function configure(params) {
		timeMs = params.time;
		// seed the motor on the first block so adding the effect doesn't glide
		// into place; later time changes still ramp (the RE-201 repitch)
		if (!seeded) { seeded = true; curTimeMs = timeMs; }
		capstan.setAmount(params.wowFlutter, params.age);
		cfg.density = params.density;
		cfg.h1 = params.head1 >= 0.5;
		cfg.h2 = params.head2 >= 0.5;
		cfg.h3 = params.head3 >= 0.5;
		cfg.feedback = params.feedback;
		cfg.mix = params.mix;
		cfg.hiss = params.hiss;
		cfg.wear = params.age;
		var typeIdx = ppClamp(params.tapeType | 0, 0, 2);
		cfg.p = ppTapeParams(typeIdx, params.drive);
		cfg.outNorm = norms[typeIdx] * (2.55 / (PP_TAPE_DRIVE_LO + PP_TAPE_DRIVE_SPAN * params.drive));
		for (var i = 0; i < 2; i++) {
			var p = cfg.p;
			preEmph[i].set('highshelf', sr, p.emphasisFc, 0.9, p.emphasisDb);
			deEmph[i].set('highshelf', sr, p.emphasisFc, 0.9, -p.emphasisDb);
			spacingEq[i].set('highshelf', sr, p.spacingFc, 0.8, p.spacingDb);
			bump[i].set('peaking', sr, ppClamp(p.bumpFc, 25, 400), 1.1, p.bumpDb);
			gap[i].set('lowpass', sr, ppClamp(p.gapFc * (1 - 0.62 * params.age), 1200, 0.45 * sr), 0.6, 0);
			bassEq[i].set('lowshelf', sr, 200, 0.9, params.bass);
			trebleEq[i].set('highshelf', sr, 3000, 0.9, params.treble);
		}
	}

	function processSample(x0, x1) {
		curTimeMs += (timeMs - curTimeMs) * timeCoeff;
		var invSpeed = 1 / capstan.next();
		var base = (curTimeMs / 1000) * sr;
		var sp = base * cfg.density;
		var maxd = bufLen - 4;
		var d1 = ppClamp(base * invSpeed, 1, maxd);
		var d2 = ppClamp((base + sp) * invSpeed, 1, maxd);
		var d3 = ppClamp((base + 2 * sp) * invSpeed, 1, maxd);
		for (var ch = 0; ch < 2; ch++) {
			var x = ch === 0 ? x0 : x1;
			var line = lines[ch];
			var y1 = cfg.h1 ? line.read(d1) : 0;
			var y2 = cfg.h2 ? line.read(d2) : 0;
			var y3 = cfg.h3 ? line.read(d3) : 0;
			var sum = y1 + y2 + y3;
			sum = deEmph[ch].process(sum);
			sum = bump[ch].process(sum);
			sum = gap[ch].process(sum);
			sum = spacingEq[ch].process(sum);
			var wet = trebleEq[ch].process(bassEq[ch].process(sum));
			wet *= capstan.gains[ch];
			var rec = x + sum * cfg.feedback;
			rec = preEmph[ch].process(rec);
			rec = mags[ch].process(rec, cfg.p, osDt, cfg.outNorm);
			eraseEnv[ch] += envCoeff * (Math.abs(rec) - eraseEnv[ch]);
			var excess = Math.max(0, eraseEnv[ch] - (0.55 - 0.2 * cfg.wear));
			var fc = 20000 * (1 - 0.55 * cfg.wear) / (1 + 6 * excess);
			var c = 1 - Math.exp(-2 * Math.PI * Math.min(fc, 0.45 * sr) / sr);
			eraseLp[ch] += c * (rec - eraseLp[ch]);
			line.write(eraseLp[ch]);
			out[ch] = (1 - cfg.mix) * x + cfg.mix * wet + (capstan.noise() * 2 - 1) * cfg.hiss * 0.015;
		}
	}

	return { configure: configure, processSample: processSample, out: out };
}

class TapeDelayProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.st = ppTapeDelayState(sampleRate);
	}
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		this.st.configure({
			time: ppv(parameters.time, 0),
			feedback: ppv(parameters.feedback, 0),
			mix: ppv(parameters.mix, 0),
			head1: ppv(parameters.head1, 0),
			head2: ppv(parameters.head2, 0),
			head3: ppv(parameters.head3, 0),
			density: ppv(parameters.density, 0),
			wowFlutter: ppv(parameters.wowFlutter, 0),
			drive: ppv(parameters.drive, 0),
			bass: ppv(parameters.bass, 0),
			treble: ppv(parameters.treble, 0),
			hiss: ppv(parameters.hiss, 0),
			tapeType: ppv(parameters.tapeType, 0),
			age: ppv(parameters.age, 0),
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
TapeDelayProcessor.parameterDescriptors = ppDesc([
	['time', 220, 30, 600],
	['feedback', 0.5, 0, 1.05],
	['mix', 0.5, 0, 1],
	['head1', 1, 0, 1],
	['head2', 0, 0, 1],
	['head3', 0, 0, 1],
	['density', 1, 0.5, 2],
	['wowFlutter', 0.3, 0, 1],
	['drive', 0.3, 0, 1],
	['bass', 0, -15, 15],
	['treble', 0, -15, 15],
	['hiss', 0.1, 0, 1],
	['tapeType', 0, 0, 2],
	['age', 0.2, 0, 1],
]);
registerProcessor('tapedelay', TapeDelayProcessor);
