function ppv(p, i) {
	return p && p.length > 1 ? p[i] : p && p.length ? p[0] : 0;
}
// dry/wet mix levels matching Utils.getDryLevel/getWetLevel
function ppMixLevels(mix) {
	var dry = 1;
	var wet = 1;
	if (mix <= 0.5) {
		dry = 1;
		wet = 1 - (0.5 - mix) * 2;
	} else {
		wet = 1;
		dry = 1 - (mix - 0.5) * 2;
	}
	return { dry: dry, wet: wet };
}
// one-pole/T60-ish smoothing coefficient
function ppSlew(time, sr) {
	if (!(time > 0)) return 1;
	return 1 - Math.exp(-1 / (sr * time));
}
// RBJ biquad (lowpass / highpass / bandpass, constant-skirt)
function ppBiquad() {
	var a0 = 1, a1 = 0, a2 = 0, b0 = 1, b1 = 0, b2 = 0;
	var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	function set(type, f, q, sr) {
		// clamp Q up: RBJ biquads become (marginally) unstable for Q -> 0 and
		// the Filters effect defaults peak to 0.0001
		if (!(q > 0.5)) q = 0.5;
		var w0 = 2 * Math.PI * Math.max(1, f) / sr;
		var cosw = Math.cos(w0);
		var alpha = Math.sin(w0) / (2 * Math.max(0.0001, q));
		if (type === 'lowpass') {
			var half = (1 - cosw) / 2;
			b0 = half; b1 = 2 * half; b2 = half;
		} else if (type === 'highpass') {
			var hhalf = (1 + cosw) / 2;
			b0 = hhalf; b1 = -(2 * hhalf); b2 = hhalf;
		} else {
			b0 = alpha; b1 = 0; b2 = -alpha;
		}
		a0 = 1 + alpha;
		a1 = -2 * cosw;
		a2 = 1 - alpha;
		// note: do NOT reset x/y history here — set() is called every block
		// while coefficients barely change, and resetting would restart the
		// filter's transient every 128 samples (breaking DC + low-freq response)
	}
	function process(x) {
		var y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
		x2 = x1; x1 = x;
		y2 = y1; y1 = y;
		return y;
	}
	return { set: set, process: process };
}
// fractional-delay line
function ppDelayLine(maxSamples) {
	var size = maxSamples + 1;
	var buf = new Float32Array(size);
	var pos = 0;
	function write(x) {
		buf[pos] = x;
		pos += 1;
		if (pos >= size) pos = 0;
	}
	function read(d) {
		if (d < 0) d = 0;
		var r = pos - d;
		var i0 = Math.floor(r);
		var f = r - i0;
		var ia = i0 % size;
		if (ia < 0) ia += size;
		var ib = ia + 1;
		if (ib >= size) ib = 0;
		var a = buf[ia];
		var b = buf[ib];
		return a + f * (b - a);
	}
	return { write: write, read: read, size: size };
}
// iterative radix-2 complex FFT (in place, interleaved real+imag arrays)
function ppFft(n) {
	var levels = 0;
	var m = n;
	while (m > 1) { m = m >> 1; levels++; }
	var rev = new Uint32Array(n);
	for (var i = 0; i < n; i++) {
		var r = 0;
		var x = i;
		for (var k = 0; k < levels; k++) {
			r = (r << 1) | (x & 1);
			x = x >> 1;
		}
		rev[i] = r;
	}
	function transform(re, im, inv) {
		var i, j, len, len2, ang, wr, wi, cr, ci, uRe, uIm, vRe, vIm, ncr;
		for (i = 0; i < n; i++) {
			j = rev[i];
			if (j > i) {
				var tr = re[i]; re[i] = re[j]; re[j] = tr;
				var ti = im[i]; im[i] = im[j]; im[j] = ti;
			}
		}
		for (len = 2; len <= n; len = len << 1) {
			len2 = len >> 1;
			ang = (inv ? -2 : 2) * Math.PI / len;
			wr = Math.cos(ang);
			wi = Math.sin(ang);
			for (i = 0; i < n; i += len) {
				cr = 1; ci = 0;
				for (j = 0; j < len2; j++) {
					uRe = re[i + j];
					uIm = im[i + j];
					vRe = re[i + j + len2] * cr - im[i + j + len2] * ci;
					vIm = re[i + j + len2] * ci + im[i + j + len2] * cr;
					re[i + j] = uRe + vRe;
					im[i + j] = uIm + vIm;
					re[i + j + len2] = uRe - vRe;
					im[i + j + len2] = uIm - vIm;
					ncr = cr * wr - ci * wi;
					ci = cr * wi + ci * wr;
					cr = ncr;
				}
			}
		}
		if (inv) {
			for (i = 0; i < n; i++) {
				re[i] /= n;
				im[i] /= n;
			}
		}
	}
	return { transform: transform };
}
// uniform partitioned overlap-save convolution (Gardner's UPOLS), block=128,
// FFT=256, partition=128. Exact linear convolution of the stream with ir.
function ppConvolver() {
	var block = 128;
	var N = 256;
	var fft = ppFft(N);
	var H = [];
	var Xfd = [];
	var ring = new Float32Array(N);
	var timeRe = new Float32Array(N);
	var timeIm = new Float32Array(N);
	var freqRe = new Float32Array(N);
	var freqIm = new Float32Array(N);
	function setIr(ir) {
		var nBlocks = Math.max(1, Math.ceil(ir.length / block));
		H = [];
		for (var i = 0; i < nBlocks; i++) {
			timeRe.fill(0);
			timeIm.fill(0);
			var off = i * block;
			var ln = Math.min(block, ir.length - off);
			for (var s = 0; s < ln; s++) timeRe[s] = ir[off + s];
			fft.transform(timeRe, timeIm, false);
			var st = new Float32Array(N * 2);
			for (var q = 0; q < N; q++) {
				st[q * 2] = timeRe[q];
				st[q * 2 + 1] = timeIm[q];
			}
			H.push(st);
		}
		Xfd = [];
		for (i = 0; i < nBlocks; i++) Xfd.push(new Float32Array(N * 2));
		ring.fill(0);
	}
	function processBlock(inBlock, outBlock) {
		if (!H.length) {
			// no impulse loaded yet: emit silence (dry still passes through
			// the processor-level mix)
			outBlock.fill(0);
			return;
		}
		ring.copyWithin(0, block);
		ring.set(inBlock, block);
		var i, j;
		for (i = Xfd.length - 1; i >= 1; i--) Xfd[i].set(Xfd[i - 1]);
		timeRe.set(ring);
		timeIm.fill(0);
		fft.transform(timeRe, timeIm, false);
		for (i = 0; i < N; i++) {
			Xfd[0][i * 2] = timeRe[i];
			Xfd[0][i * 2 + 1] = timeIm[i];
		}
		freqRe.fill(0);
		freqIm.fill(0);
		for (i = 0; i < H.length; i++) {
			var xd = Xfd[i];
			var hc = H[i];
			for (j = 0; j < N; j++) {
				var a = xd[j * 2], b = xd[j * 2 + 1];
				var c = hc[j * 2], d = hc[j * 2 + 1];
				freqRe[j] += a * c - b * d;
				freqIm[j] += a * d + b * c;
			}
		}
		fft.transform(freqRe, freqIm, true);
		for (i = 0; i < block; i++) outBlock[i] = freqRe[block + i];
	}
	return { setIr: setIr, processBlock: processBlock };
}
// feed-forward compressor (threshold dB, ratio, knee dB, attack/release s)
function ppCompressorState() {
	var env = -120;
	return function process(x, sr, threshold, knee, ratio, attack, release) {
		var absx = Math.abs(x);
		var xdb = 20 * Math.log(Math.max(absx, 1e-9)) / Math.LN10;
		var atk = ppSlew(attack, sr);
		var rel = ppSlew(release, sr);
		if (xdb > env) env += (xdb - env) * atk;
		else env += (xdb - env) * rel;
		var over = env - threshold;
		var khalf = knee / 2;
		var g = 0;
		if (over > khalf) g = (1 / ratio - 1) * over;
		else if (over > -khalf) g = (1 / ratio - 1) * over * over / (2 * knee);
		var gain = Math.pow(10, g / 20);
		return x * gain;
	};
}
// diode saturator used by ringmodulator (even function, like the shared
// WaveShaper curve: d(-v) == d(v))
function ppDiode(h, v) {
	var a = Math.abs(v);
	var vb = 0.2;
	var vl = 0.4;
	if (a <= vb) return 0;
	if (a <= vl) return h * ((a - vb) * (a - vb)) / (2 * (vl - vb));
	return h * a - h * vl + h * ((vl - vb) * (vl - vb)) / (2 * (vl - vb));
}
// distortion curve shared by distortion and quadrafuzz
function ppDistort(x, gain) {
	var g = gain | 0;
	if (g <= 0) return (3 * x * 20 * Math.PI / 180) / Math.PI;
	return (3 + g) * x * 20 * Math.PI / 180 / (Math.PI + g * Math.abs(x));
}
// Scratch silence for processors whose input has gone away: a stopped source
// leaves an EMPTY input array in some browsers (Safari), which used to mute the
// effect and cut delay/reverb tails the moment the source stopped. Feeding
// zeros keeps the processor running so feedback effects can ring out. Safe to
// share — no processor writes to its input buffers.
var ppSilence = null;
function ppSetupStereo(inputs, outputs) {
	var ip = inputs[0] || [];
	var op = outputs[0] || [];
	var outL = op[0];
	if (!outL) return null;
	var outR = op[1];
	var n = outL.length;
	var inL = (ip[0] && ip[0].length) ? ip[0] : null;
	var inR = (ip[1] && ip[1].length) ? ip[1] : inL;
	if (!inL) {
		if (!ppSilence || ppSilence.length !== n) ppSilence = new Float32Array(n);
		inL = ppSilence;
		inR = ppSilence;
	}
	return { inL: inL, inR: inR, outL: outL, outR: outR, n: n };
}
// parameter descriptor builder (name, default, min, max)
function ppDesc(list) {
	return list.map(function (d) {
		return { name: d[0], defaultValue: d[1], minValue: d[2], maxValue: d[3] };
	});
}
function ppFilterProcess(instance, s, parameters) {
	var freq = ppv(parameters.frequency, 0);
	var peak = ppv(parameters.peak, 0);
	var i;
	instance.bqL.set(instance.type, freq, peak, sampleRate);
	instance.bqR.set(instance.type, freq, peak, sampleRate);
	for (i = 0; i < s.n; i++) {
		s.outL[i] = instance.bqL.process(s.inL[i]);
		if (s.outR) s.outR[i] = instance.bqR.process(s.inR[i]);
	}
}
