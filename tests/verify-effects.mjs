// Offline DSP harness for the effects AudioWorklet source. Runs each processor
// in a simulated audio-thread environment and asserts behavior.
import { EFFECTS_WORKLET_SOURCE } from '../src/effects/workletsource.generated.ts';

const SR = 44100;
const BLOCK = 128;

globalThis.AudioWorkletProcessor = class {
	constructor() {
		this.port = {
			postMessage: () => {},
		};
	}
};
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.currentFrame = 0;
globalThis.registerProcessor = (name, cls) => {
	registered[name] = cls;
};

const registered = {};
new Function(EFFECTS_WORKLET_SOURCE)();
const names = Object.keys(registered);
console.log('registered processors:', names.length);

let failures = 0;
const check = (label, cond, extra = '') => {
	if (cond) console.log('  ok  -', label);
	else {
		failures++;
		console.log('  FAIL-', label, extra);
	}
};

// -- driver ----------------------------------------------------------------
function makeProc(name, params = {}) {
	const proc = new registered[name]();
	const p = { ...params };
	const chunks = [];
	const run = (inL, inR) => {
		const L = new Float32Array(BLOCK);
		const R = new Float32Array(BLOCK);
		if (inL) L.set(inL);
		if (inR) R.set(inR);
		const outL = new Float32Array(BLOCK);
		const outR = new Float32Array(BLOCK);
		const paramsObj = {};
		for (const k of Object.keys(p)) {
			paramsObj[k] = p[k] instanceof Float32Array ? p[k] : Float32Array.from([p[k]]);
		}
		proc.process([[L, R], []], [[outL, outR], []], paramsObj);
		chunks.push([Float32Array.from(outL), Float32Array.from(outR)]);
		return [outL, outR];
	};
	const drain = () => {
		const n = chunks.length * BLOCK;
		const L = new Float32Array(n);
		const R = new Float32Array(n);
		chunks.forEach((c, i) => {
			L.set(c[0], i * BLOCK);
			R.set(c[1], i * BLOCK);
		});
		return { L, R };
	};
	return { proc, run, drain, set: (k, v) => (p[k] = v) };
}
function sine(freq, amp = 1, n = SR) {
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
	return a;
}
function impulse(n = SR) {
	const a = new Float32Array(n);
	a[0] = 1;
	return a;
}
// Naive DFT magnitude at a single frequency
function dftBin(x, freq, start = 0, len = 8192) {
	let re = 0;
	let im = 0;
	for (let i = 0; i < len; i++) {
		const v = x[start + i] || 0;
		const ph = (2 * Math.PI * freq * i) / SR;
		re += v * Math.cos(ph);
		im -= v * Math.sin(ph);
	}
	return Math.sqrt(re * re + im * im);
}
function maxIdx(x) {
	let m = -1;
	let idx = 0;
	for (let i = 0; i < x.length; i++) {
		if (Math.abs(x[i]) > m) {
			m = Math.abs(x[i]);
			idx = i;
		}
	}
	return { m, idx };
}

// -- pp-delay --------------------------------------------------------------
console.log('\npp-delay');
{
	const d = makeProc('pp-delay', { feedback: 0, time: 0.1, mix: 0.5 });
	const blocks = 100; // 12800 samples > 4410 delay
	for (let b = 0; b < blocks; b++) {
		const buf = new Float32Array(BLOCK);
		if (b === 0) buf[0] = 1;
		d.run(buf);
	}
	const { L } = d.drain();
	const { m, idx } = maxIdx(L.subarray(100, 12800));
	check('delayed impulse ~4410 samples', Math.abs(idx + 100 - 4410) <= 1, `idx=${idx + 100} m=${m.toFixed(3)}`);
	check('dry impulse preserved', Math.abs(L[0] - 1) < 1e-6, `L[0]=${L[0]}`);
	check('finite', Number.isFinite(L.reduce((a, v) => a + Math.abs(v), 0)));
}

// -- pp-stereopanner -------------------------------------------------------
console.log('\npp-stereopanner');
{
	const d = makeProc('pp-stereopanner', { pan: -1 });
	const s = sine(220, 0.8, BLOCK * 8);
	for (let b = 0; b < 8; b++) d.run(s.subarray(b * BLOCK, (b + 1) * BLOCK), s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const { L, R } = d.drain();
	check('pan=-1 => left full', maxIdx(L).m > 0.75, `L=${maxIdx(L).m.toFixed(3)}`);
	check('pan=-1 => right silent', maxIdx(R).m < 1e-6, `R=${maxIdx(R).m.toFixed(3)}`);
	const d2 = makeProc('pp-stereopanner', { pan: 1 });
	for (let b = 0; b < 8; b++) d2.run(s.subarray(b * BLOCK, (b + 1) * BLOCK), s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const r2 = d2.drain();
	check('pan=1 => right full', maxIdx(r2.R).m > 0.75, `R=${maxIdx(r2.R).m.toFixed(3)}`);
	check('pan=1 => left silent', maxIdx(r2.L).m < 1e-6);
}

// -- pp-tremolo ------------------------------------------------------------
console.log('\npp-tremolo');
{
	const d = makeProc('pp-tremolo', { speed: 20, depth: 1, mix: 0.5 });
	const one = new Float32Array(BLOCK).fill(1);
	const outs = [];
	for (let b = 0; b < 40; b++) {
		const [oL] = d.run(one);
		outs.push(...oL);
	}
	const mn = Math.min(...outs);
	const mx = Math.max(...outs);
	// depth=1, mix=0.5 -> output = x*(1+g) with g in [0,1] (native shaper range)
	check('amplitude modulated 1..2', Math.abs(mn - 1) < 0.05 && Math.abs(mx - 2) < 0.05, `min=${mn.toFixed(2)} max=${mx.toFixed(2)}`);
}

// -- pp-lowpassfilter ------------------------------------------------------
console.log('\npp-lowpassfilter');
{
	const d = makeProc('pp-lowpassfilter', { frequency: 100, peak: 0.0001 });
	const dc = new Float32Array(BLOCK).fill(1);
	const outDC = [];
	for (let b = 0; b < 10; b++) {
		const [o] = d.run(dc);
		outDC.push(...o);
	}
	const dcg = outDC.slice(500, 1000).reduce((a, v) => a + v, 0) / 500;
	check('DC passes' , Math.abs(dcg - 1) < 0.05, `dcg=${dcg.toFixed(3)}`);
	const hi = sine(4400, 1, BLOCK * 10);
	const outHi = [];
	for (let b = 0; b < 10; b++) {
		const [o] = d.run(hi.subarray(b * BLOCK, (b + 1) * BLOCK));
		outHi.push(...o);
	}
	const hiPeak = maxIdx(Float32Array.from(outHi.slice(BLOCK * 5, BLOCK * 10))).m; // steady region
	check('4.4k attenuated at 100Hz cutoff', hiPeak < 0.15, `peak=${hiPeak.toFixed(4)}`);
}

// -- pp-korg35lpf / pp-korg35hpf -------------------------------------------
// Ported from faustfilters (SpotlightKid) — see korg35filters.ts. Checks the
// two defining traits of the Korg 35 models: low-pass/high-pass shaping plus
// the resonance peak that makes these filters musical.
console.log('\npp-korg35 filters');
{
	const runTone = (name, params, freq, blocks = 16) => {
		const d = makeProc(name, params);
		const n = blocks * BLOCK;
		const s = sine(freq, 0.5, n);
		const L = new Float32Array(n);
		for (let b = 0; b < blocks; b++) {
			const [oL] = d.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
			L.set(oL, b * BLOCK);
		}
		return L;
	};
	// settled-region peak (skip the first 8 blocks of transients/smoothing)
	const peak = (sig) => maxIdx(sig.subarray(BLOCK * 8)).m;

	// low pass
	{
		const d = makeProc('pp-korg35lpf', { cutoff: 1000, q: 1 });
		const dc = new Float32Array(BLOCK).fill(1);
		const out = [];
		for (let b = 0; b < 20; b++) {
			const [o] = d.run(dc);
			out.push(...o);
		}
		const g = out.slice(BLOCK * 12).reduce((a, v) => a + v, 0) / (8 * BLOCK);
		check('LPF DC passes (unity)', Math.abs(g - 1) < 0.05, `dcg=${g.toFixed(3)}`);

		const pass = peak(runTone('pp-korg35lpf', { cutoff: 1500, q: 0.707 }, 220));
		check('LPF passband preserved', pass > 0.25, `peak=${pass.toFixed(3)}`);
		const stop = peak(runTone('pp-korg35lpf', { cutoff: 150, q: 0.707 }, 4400));
		check('LPF stopband attenuated', stop < 0.05, `peak=${stop.toFixed(4)}`);

		const flat = peak(runTone('pp-korg35lpf', { cutoff: 1000, q: 0.707 }, 1000));
		const res = peak(runTone('pp-korg35lpf', { cutoff: 1000, q: 5 }, 1000));
		check('LPF Q raises the cutoff peak', res > flat * 1.6, `flat=${flat.toFixed(3)} res=${res.toFixed(3)}`);
		check('LPF finite', Number.isFinite(res));
	}

	// high pass
	{
		const d = makeProc('pp-korg35hpf', { cutoff: 500, q: 1 });
		const dc = new Float32Array(BLOCK).fill(1);
		const out = [];
		for (let b = 0; b < 24; b++) {
			const [o] = d.run(dc);
			out.push(...o);
		}
		const tail = maxIdx(Float32Array.from(out.slice(BLOCK * 16))).m;
		check('HPF blocks DC', tail < 0.02, `tail=${tail.toFixed(4)}`);

		const pass = peak(runTone('pp-korg35hpf', { cutoff: 150, q: 0.707 }, 4400));
		check('HPF passband preserved', pass > 0.25, `peak=${pass.toFixed(3)}`);
		const stop = peak(runTone('pp-korg35hpf', { cutoff: 3000, q: 0.707 }, 100));
		check('HPF stopband attenuated', stop < 0.05, `peak=${stop.toFixed(4)}`);

		const flat = peak(runTone('pp-korg35hpf', { cutoff: 1000, q: 0.707 }, 1000));
		const res = peak(runTone('pp-korg35hpf', { cutoff: 1000, q: 5 }, 1000));
		check('HPF Q raises the cutoff peak', res > flat * 1.6, `flat=${flat.toFixed(3)} res=${res.toFixed(3)}`);
		check('HPF finite', Number.isFinite(res));
	}
}

// -- pp-j60chorus ----------------------------------------------------------
// Juno-60 chorus. I and II are stereo (the right LFO is inverted); I+II runs
// the same phase on both sides and is near-mono. Ported from
// jpcima/rc-effect-playground (Hera Chorus) — see j60chorus.ts.
console.log('\npp-j60chorus');
{
	const SEC = Math.ceil(SR / BLOCK);
	const blocks = SEC * 2;
	const tone = sine(220, 0.5, blocks * BLOCK);
	const capture = (params) => {
		const d = makeProc('pp-j60chorus', params);
		const L = new Float32Array(blocks * BLOCK);
		const R = new Float32Array(blocks * BLOCK);
		for (let b = 0; b < blocks; b++) {
			const inb = tone.subarray(b * BLOCK, (b + 1) * BLOCK);
			const [oL, oR] = d.run(inb, inb);
			L.set(oL, b * BLOCK);
			R.set(oR, b * BLOCK);
		}
		return { L, R };
	};

	// both buttons off => exact dry passthrough (enabled settles to 0)
	const off = capture({ chorusI: 0, chorusII: 0, mix: 1 });
	let offErr = 0;
	for (let i = SEC * BLOCK; i < blocks * BLOCK; i += 17)
		offErr = Math.max(offErr, Math.abs(off.L[i] - tone[i]));
	check('both off => dry passthrough', offErr < 1e-4, `maxErr=${offErr.toExponential(2)}`);

	// mode II => anti-phase stereo modulation
	const ii = capture({ chorusI: 0, chorusII: 1, mix: 1 });
	check('II finite', ii.L.every((v) => Number.isFinite(v)));
	const diff = new Float32Array(blocks * BLOCK);
	for (let i = 0; i < diff.length; i++) diff[i] = ii.L[i] - ii.R[i];
	const width = maxIdx(diff.subarray(SEC * BLOCK)).m;
	check('II => L/R stereo (anti-phase LFO)', width > 0.02, `maxDiff=${width.toFixed(4)}`);

	// the comb sweeps with the LFO => a steady tone swells over time
	const mags = [];
	for (let w = SEC; w + Math.ceil(2048 / BLOCK) < blocks; w += 20)
		mags.push(dftBin(ii.L, 220, w * BLOCK, 2048));
	check('II => moving comb', Math.max(...mags) > Math.min(...mags) * 1.5,
		`max=${Math.max(...mags).toFixed(2)} min=${Math.min(...mags).toFixed(2)}`);

	// I+II => near-mono (same LFO phase both sides), far less stereo than II
	const both = capture({ chorusI: 1, chorusII: 1, mix: 1 });
	const bd = new Float32Array(blocks * BLOCK);
	for (let i = 0; i < bd.length; i++) bd[i] = both.L[i] - both.R[i];
	const bothWidth = maxIdx(bd.subarray(SEC * BLOCK)).m;
	check('I+II => near-mono', bothWidth < width * 0.5, `diff=${bothWidth.toFixed(4)} vs ${width.toFixed(4)}`);

	// mix=0 => dry even with a button engaged
	const dry = capture({ chorusI: 0, chorusII: 1, mix: 0 });
	let mErr = 0;
	for (let i = SEC * BLOCK; i < blocks * BLOCK; i += 17)
		mErr = Math.max(mErr, Math.abs(dry.L[i] - tone[i]));
	check('mix=0 => dry', mErr < 1e-4, `maxErr=${mErr.toExponential(2)}`);
}

// -- pp-tapedelay ----------------------------------------------------------
// Multi-head tape echo. Head echoes land at t, 2t, 3t; feedback decays; drive
// saturates; wow/flutter shifts the tape. Ported from re-deemer (ISC) — see
// tapedelay.ts.
console.log('\npp-tapedelay');
{
	const base = {
		time: 200, feedback: 0, mix: 1, head1: 1, head2: 0, head3: 0,
		density: 1, wowFlutter: 0, drive: 0, bass: 0, treble: 0, hiss: 0,
		tapeType: 0, age: 0,
	};
	const capture = (params, blocks, gen) => {
		const d = makeProc('pp-tapedelay', params);
		const out = new Float32Array(blocks * BLOCK);
		for (let b = 0; b < blocks; b++) {
			const inb = gen ? gen(b) : new Float32Array(BLOCK);
			if (!gen && b === 0) inb[0] = 1;
			const [oL] = d.run(inb, inb);
			out.set(oL, b * BLOCK);
		}
		return out;
	};
	const peakNear = (sig, center, half) => {
		let m = 0, idx = 0;
		const lo = Math.max(0, center - half);
		const hi = Math.min(sig.length, center + half);
		for (let i = lo; i < hi; i++) if (Math.abs(sig[i]) > m) { m = Math.abs(sig[i]); idx = i; }
		return { m, idx };
	};
	const t = Math.round(200 * SR / 1000); // 8820

	// head 1 echo at t
	const h1 = capture(base, 320);
	const e1 = peakNear(h1, t, 200);
	check('head1 echo lands at ~t', Math.abs(e1.idx - t) < 30, `idx=${e1.idx} m=${e1.m.toFixed(3)}`);
	check('tapedelay finite', h1.every(Number.isFinite));

	// heads 2 + 3 echo at 2t and 3t
	const h23 = capture({ ...base, head1: 0, head2: 1, head3: 1 }, 500);
	const e2 = peakNear(h23, 2 * t, 200);
	const e3 = peakNear(h23, 3 * t, 300);
	check('head2 echo at ~2t', Math.abs(e2.idx - 2 * t) < 60 && e2.m > 0.02, `idx=${e2.idx} m=${e2.m.toFixed(3)}`);
	check('head3 echo at ~3t', Math.abs(e3.idx - 3 * t) < 120 && e3.m > 0.02, `idx=${e3.idx} m=${e3.m.toFixed(3)}`);

	// feedback regenerates and decays
	const fd = capture({ ...base, feedback: 0.6 }, 700);
	const f1 = peakNear(fd, t, 200).m;
	const f2 = peakNear(fd, 2 * t, 200).m;
	check('feedback repeats decay', f1 > 0.02 && f2 > 0 && f2 < f1, `f1=${f1.toFixed(3)} f2=${f2.toFixed(3)}`);

	// mix=0 => dry passthrough
	const dryD = capture({ ...base, mix: 0 }, 8);
	let dryErr = 0;
	for (let i = 0; i < dryD.length; i += 7) dryErr = Math.max(dryErr, Math.abs(dryD[i] - (i === 0 ? 1 : 0)));
	check('mix=0 => dry', dryErr < 1e-5, `maxErr=${dryErr.toExponential(2)}`);

	// wow/flutter shifts the echo in time
	const w = capture({ ...base, wowFlutter: 1 }, 320);
	const ew = peakNear(w, t, 200);
	check('wow/flutter shifts the tape', Math.abs(ew.idx - e1.idx) >= 3, `shift=${ew.idx - e1.idx}`);

	// drive saturates a tone (more harmonics), stays bounded
	const SEC2 = Math.ceil(SR / BLOCK);
	const tone = sine(200, 0.8, SEC2 * BLOCK);
	const gen = (b) => tone.subarray(b * BLOCK, (b + 1) * BLOCK);
	const harmonics = (params) => {
		const out = capture({ ...base, time: 50, ...params }, SEC2, gen);
		const start = BLOCK * 30;
		const f0 = dftBin(out, 200, start, 2048);
		const h3 = dftBin(out, 600, start, 2048);
		const h2 = dftBin(out, 400, start, 2048);
		return { thd: Math.max(h2, h3) / Math.max(1e-9, f0), peak: maxIdx(out.subarray(start)).m };
	};
	const clean = harmonics({ drive: 0 });
	const hot = harmonics({ drive: 1 });
	check('drive adds tape harmonics', hot.thd > clean.thd * 1.5, `clean=${clean.thd.toFixed(4)} hot=${hot.thd.toFixed(4)}`);
	check('drive stays bounded', hot.peak < 3 && Number.isFinite(hot.peak), `peak=${hot.peak.toFixed(2)}`);

	// all tape types run clean
	for (const tt of [0, 1, 2]) {
		const o = capture({ ...base, tapeType: tt }, 8);
		check('tapeType ' + tt + ' finite', o.every(Number.isFinite));
	}
}

// -- pp-distortion ---------------------------------------------------------
console.log('\npp-distortion');
{
	const d = makeProc('pp-distortion', { gain: 0 });
	const s = sine(200, 0.9, BLOCK * 8);
	for (let b = 0; b < 8; b++) d.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const { L } = d.drain();
	const p0 = maxIdx(L).m;
	check('gain=0 => x/3 curve', Math.abs(p0 - 0.3) < 0.02, `peak=${p0.toFixed(3)}`);
	const d2 = makeProc('pp-distortion', { gain: 1 });
	for (let b = 0; b < 8; b++) d2.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const q = d2.drain();
	const p1 = maxIdx(q.L).m;
	check('gain=1 => hotter/nonzero', p1 > p0 && p1 > 0.3, `peak=${p1.toFixed(3)}`);
}

// -- pp-compressor ---------------------------------------------------------
console.log('\npp-compressor');
{
	const d = makeProc('pp-compressor', { threshold: -24, knee: 30, attack: 0, release: 0.25, ratio: 20 });
	const s = sine(220, 1, BLOCK * 16);
	for (let b = 0; b < 16; b++) d.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const { L } = d.drain();
	const steady = maxIdx(L.subarray(BLOCK * 8, BLOCK * 16)).m;
	check('loud input compressed hard', steady < 0.15, `steady peak=${steady.toFixed(4)}`);
	const d2 = makeProc('pp-compressor', { threshold: -24, knee: 30, attack: 0, release: 0.25, ratio: 1 });
	for (let b = 0; b < 16; b++) d2.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const q = d2.drain();
	const flat = maxIdx(q.L.subarray(BLOCK * 8, BLOCK * 16)).m;
	check('ratio=1 => unity', Math.abs(flat - 1) < 0.02, `peak=${flat.toFixed(3)}`);
}

// -- pp-flanger ------------------------------------------------------------
console.log('\npp-flanger');
{
	const d = makeProc('pp-flanger', { time: 0.5, speed: 0.2, depth: 0.5, feedback: 0.5, mix: 0.5 });
	const s = sine(400, 0.8, BLOCK * 40);
	for (let b = 0; b < 40; b++) d.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const { L } = d.drain();
	const m = maxIdx(L);
	check('no NaN', Number.isFinite(m.m));
	check('produces output', m.m > 0.1, `peak=${m.m.toFixed(3)}`);
	const env = [];
	for (let i = 0; i < L.length; i += 64) {
		let s2 = 0;
		for (let j = 0; j < 64; j++) s2 += L[i + j] * L[i + j];
		env.push(Math.sqrt(s2 / 64));
	}
	const envMin = Math.min(...env);
	const envMax = Math.max(...env);
	check('swirling envelope (varies)', envMax > envMin * 1.5, `envMax=${envMax.toFixed(2)} envMin=${envMin.toFixed(2)}`);
}

// -- pp-stonephaser --------------------------------------------------------
console.log('\npp-stonephaser');
{
	// all six params must be supplied: the harness has no descriptor defaults
	const base = { speed: 2, feedback: 0.9, feedbackBassCut: 500, mix: 0.5, color: 1, phase: 0 };
	const SEC = Math.ceil(SR / BLOCK); // blocks per second
	const blocks = SEC * 2;
	const s = sine(1000, 0.8, blocks * BLOCK);

	const run = (params, stereo = false) => {
		const d = makeProc('pp-stonephaser', params);
		const L = new Float32Array(blocks * BLOCK);
		const R = new Float32Array(blocks * BLOCK);
		for (let b = 0; b < blocks; b++) {
			const inb = s.subarray(b * BLOCK, (b + 1) * BLOCK);
			const [oL, oR] = d.run(inb, inb);
			L.set(oL, b * BLOCK);
			if (stereo) R.set(oR, b * BLOCK);
		}
		return { L, R };
	};

	// default settings (not "dry" in the no-wet sense): the reference run the
	// color comparison below is measured against
	const ref = run(base);
	check('no NaN', ref.L.every((v) => Number.isFinite(v)));
	check('produces output', maxIdx(ref.L).m > 0.1, `peak=${maxIdx(ref.L).m.toFixed(3)}`);

	// the moving notch makes a steady tone swing in magnitude between windows
	// (windows are measured after the 100 ms parameter smoothers have settled)
	const mags = [];
	for (let w = SEC; w + Math.ceil(2048 / BLOCK) < blocks; w += 20) {
		mags.push(dftBin(ref.L, 1000, w * BLOCK, 2048));
	}
	const lo = Math.min(...mags);
	const hi = Math.max(...mags);
	check('notch sweeps a steady tone', hi > lo * 2, `max=${hi.toFixed(2)} min=${lo.toFixed(2)}`);

	// Faust mixes with an equal-power sin/cos crossfade, so mix=0 is pure dry
	const dm = run({ ...base, mix: 0 }).L;
	let worst = 0;
	for (let i = SEC * BLOCK; i < dm.length; i += 13) worst = Math.max(worst, Math.abs(dm[i] - s[i]));
	check('mix=0 => dry passthrough', worst < 0.01, `maxErr=${worst.toFixed(4)}`);

	// stereo phase offsets the right channel's LFO
	const dp = run({ ...base, phase: 180 }, true);
	const diff = new Float32Array(blocks * BLOCK);
	for (let i = 0; i < diff.length; i++) diff[i] = dp.L[i] - dp.R[i];
	const stereoDiff = maxIdx(diff.subarray(SEC * BLOCK)).m;
	check('phase=180 => L/R differ', stereoDiff > 0.05, `maxDiff=${stereoDiff.toFixed(3)}`);

	// color off = lighter feedback + a higher sweep range
	const dc = run({ ...base, color: 0 }).L;
	let dsum = 0;
	let nsum = 0;
	for (let i = SEC * BLOCK; i < dc.length; i++) {
		dsum += (dc[i] - ref.L[i]) ** 2;
		nsum += ref.L[i] ** 2;
	}
	const rel = Math.sqrt(dsum) / Math.sqrt(nsum);
	check('color off changes voicing', rel > 0.1, `rel=${rel.toFixed(3)}`);

	// topology, part 1: the wet path must be a true allpass cascade. With
	// mix=1 and no feedback its magnitude response is flat -- this is what the
	// dry/wet nulls are made of, and it is the check that catches a broken
	// allpass recursion (a resonant one-pole cascade gives a big hump instead).
	const capture = (params) => {
		const d = makeProc('pp-stonephaser', params);
		for (let b = 0; b < SEC * 2; b++) d.run(new Float32Array(BLOCK)); // frozen LFO
		const out = new Float32Array(N);
		for (let b = 0; b < N / BLOCK; b++) {
			const buf = new Float32Array(BLOCK);
			if (b === 0) buf[0] = 1;
			const [oL] = d.run(buf);
			out.set(oL, b * BLOCK);
		}
		return out;
	};
	const N = 4096;
	const wet = capture({ ...base, speed: 0, feedback: 0, mix: 1 });
	let flatLo = Infinity;
	let flatHi = 0;
	for (let f = 500; f <= 16000; f += 250) {
		const m = dftBin(wet, f, 0, N);
		flatLo = Math.min(flatLo, m);
		flatHi = Math.max(flatHi, m);
	}
	check('wet path is allpass (flat)', flatHi / flatLo < 1.03, `flatness=${(flatHi / flatLo).toFixed(4)}`);

	// topology, part 2: summing 4 identical first-order allpasses with the dry
	// signal gives exactly 2 nulls (6 stages would give 3, 2 stages 1).
	const ir = capture({ ...base, speed: 0, feedback: 0 });
	const NF = 2048;
	const mag = new Float64Array(NF);
	for (let k = 1; k < NF; k++) mag[k] = dftBin(ir, (k * SR) / (2 * NF), 0, N);
	// count contiguous deep groups, so the several bins inside one null count once
	let notches = 0;
	let inNull = false;
	let gap = 0;
	for (let k = 3; k < NF - 3; k++) {
		if (mag[k] < 0.2) {
			if (!inNull) notches++;
			inNull = true;
			gap = 0;
		} else if (inNull && ++gap > 6) {
			inNull = false;
		}
	}
	check('4-stage allpass => 2 nulls', notches === 2, `notches=${notches}`);
}

// -- pp-pingpongdelay ------------------------------------------------------
console.log('\npp-pingpongdelay');
{
	const d = makeProc('pp-pingpongdelay', { feedback: 0.5, time: 0.3, mix: 0.5 });
	const blocks = 300; // 38400 samples; delay=13230
	for (let b = 0; b < blocks; b++) {
		const buf = new Float32Array(BLOCK);
		if (b === 0) buf[0] = 1;
		d.run(buf);
	}
	const { L, R } = d.drain();
	const l1 = maxIdx(L.subarray(BLOCK * 100, BLOCK * 130)); // around 12800-16640
	const r1 = maxIdx(R.subarray(BLOCK * 200, BLOCK * 260)); // around 25600-33280
	check('first tap on L', Math.abs(l1.idx + BLOCK * 100 - 13230) < 40, `L idx≈${l1.idx + BLOCK * 100}`);
	check('first R tap after ~2x delay', Math.abs(r1.idx + BLOCK * 200 - 26460) < 80, `R idx≈${r1.idx + BLOCK * 200}`);
	check('R tap nonzero', r1.m > 0.3, `m=${r1.m.toFixed(3)}`);
}

// -- pp-quadrafuzz ---------------------------------------------------------
console.log('\npp-quadrafuzz');
{
	const d = makeProc('pp-quadrafuzz', {
		lowGain: 0, midLowGain: 0, midHighGain: 0, highGain: 0,
	});
	const s = sine(100, 0.8, BLOCK * 8);
	for (let b = 0; b < 8; b++) d.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
	const { L } = d.drain();
	const peak = maxIdx(L.subarray(BLOCK * 2, BLOCK * 8)).m;
	// dry + low band (147Hz lowpass passes 100Hz): ~ x*(1+1/3)
	check('dry + lowband', peak > 0.8 && peak < 1.3, `peak=${peak.toFixed(3)}`);
}

// -- pp-ringmodulator ------------------------------------------------------
console.log('\npp-ringmodulator');
{
	const d = makeProc('pp-ringmodulator', { speed: 30, distortion: 0.2, mix: 0.5 });
	const n = SR; // 1 second
	const s = sine(100, 0.8, n);
	const sig = new Float32Array(Math.ceil(n / BLOCK) * BLOCK + BLOCK);
	for (let b = 0; b < Math.ceil(n / BLOCK); b++) {
		const [o] = d.run(s.subarray(b * BLOCK, (b + 1) * BLOCK));
		sig.set(o, b * BLOCK);
	}
	const skip = BLOCK * 8;
	const at = (f) => dftBin(sig, f, skip, 16384);
	const a100 = at(100);
	const side = Math.max(at(70), at(130));
	check('sidebands present (ring modulation)', side > a100 * 0.25, `|100|=${a100.toFixed(1)} side=${side.toFixed(1)}`);
}

// -- pp-reverb (convolution) -----------------------------------------------
console.log('\npp-reverb / pp-convolver');
{
	// deterministic "IR": two taps; mix=1 => wet only (all-pass dry removed)
	const ir = new Float32Array(512);
	ir[0] = 1;
	ir[200] = 0.5;
	const d = makeProc('pp-reverb', { mix: 1 });
	d.proc.port.onmessage({ data: { type: 'ir', channels: [ir, ir] } });
	const imp = impulse();
	const out = new Float32Array(512 * 4);
	for (let b = 0; b < 16; b++) {
		const [oL] = d.run(imp.subarray(b * BLOCK, (b + 1) * BLOCK));
		out.set(oL, b * BLOCK);
	}
	check('convolution reproduces IR taps', Math.abs(out[200] - 0.5) < 0.05 && Math.abs(out[0] - 1) < 0.05,
		`out[0]=${out[0].toFixed(3)} out[200]=${out[200].toFixed(3)}`);
	check('no NaN', out.every((v) => Number.isFinite(v)));

	// delay-by-128 with delta IR
	const d2 = makeProc('pp-convolver', { mix: 1 });
	d2.proc.port.onmessage({ data: { type: 'ir', channels: [new Float32Array([1])] } });
	const ramp = new Float32Array(BLOCK * 8);
	for (let i = 0; i < ramp.length; i++) ramp[i] = (i % 37) - 18;
	const o2 = new Float32Array(ramp.length + BLOCK);
	for (let b = 0; b < 9; b++) {
		const [oL] = d2.run(ramp.subarray(b * BLOCK, (b + 1) * BLOCK));
		o2.set(oL, b * BLOCK);
	}
	// delta IR => zero-latency passthrough (convolver partitions the IR but the
	// first tap lands immediately, as the two-tap IR test above confirms)
	let corr = true;
	for (let i = 0; i < o2.length - BLOCK; i += 7) {
		if (Math.abs(o2[i] - ramp[i]) > 0.01) corr = false;
	}
	check('delta IR => passthrough', corr);
}

// -- all processors: silence + noise smoke, no NaN/crash -------------------
console.log('\nsmoke (all processors)');
{
	for (const name of names) {
		try {
			const d = makeProc(name);
			const noise = new Float32Array(BLOCK).fill(0.1);
			for (let b = 0; b < 4; b++) d.run(noise);
			const { L, R } = d.drain();
			const nan = [...L, ...R].some((v) => Number.isNaN(v) || !Number.isFinite(v));
			check(name + ' runs clean', !nan);
		} catch (e) {
			check(name + ' runs clean', false, 'THREW: ' + e.message);
		}
	}
}

// -- stopped source => tails must ring out (empty worklet input) -----------
// Safari reports an EMPTY input array once a source stops; the effect must keep
// processing so delay/reverb tails ring out instead of being cut.
console.log('\nstopped source (empty input) => tails ring');
{
	const paramsFor = (p) => {
		const o = {};
		for (const k of Object.keys(p)) o[k] = p[k] instanceof Float32Array ? p[k] : Float32Array.from([p[k]]);
		return o;
	};
	const runEmpty = (proc, p, blocks) => {
		const out = [];
		for (let b = 0; b < blocks; b++) {
			const outL = new Float32Array(BLOCK);
			const outR = new Float32Array(BLOCK);
			proc.process([[], []], [[outL, outR], []], paramsFor(p));
			out.push(...outL);
		}
		return Float32Array.from(out);
	};

	const p = { feedback: 0.8, time: 0.1, mix: 0.5 };
	const d = makeProc('pp-delay', p);
	const tone = sine(220, 0.9, BLOCK * 120);
	for (let b = 0; b < 120; b++) d.run(tone.subarray(b * BLOCK, (b + 1) * BLOCK));
	const tail = runEmpty(d.proc, p, 80);
	check('delay tail keeps sounding after input stops', maxIdx(tail).m > 0.05, `peak=${maxIdx(tail).m.toFixed(4)}`);
	const head = maxIdx(tail.subarray(0, 10 * BLOCK)).m;
	const end = maxIdx(tail.subarray(70 * BLOCK)).m;
	check('delay tail decays', end < head * 0.9, `head=${head.toFixed(3)} end=${end.toFixed(3)}`);

	const ir = new Float32Array(8192);
	ir[0] = 1;
	ir[4000] = 0.8;
	const rp = { mix: 1 };
	const r = makeProc('pp-reverb', rp);
	r.proc.port.onmessage({ data: { type: 'ir', channels: [ir, ir] } });
	const imp = impulse(BLOCK * 2);
	for (let b = 0; b < 2; b++) r.run(imp.subarray(b * BLOCK, (b + 1) * BLOCK));
	const rtail = runEmpty(r.proc, rp, 60);
	check('conv reverb tail keeps sounding after input stops', maxIdx(rtail).m > 0.2, `peak=${maxIdx(rtail).m.toFixed(4)}`);
}

console.log('\n' + (failures === 0 ? 'ALL DSP CHECKS PASSED' : failures + ' CHECKS FAILED'));
process.exit(failures === 0 ? 0 : 1);