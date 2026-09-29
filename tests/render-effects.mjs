// Offline DSP harness that renders every effect through a REAL Web Audio
// implementation (web-audio-api) instead of the hand-rolled processor shim in
// verify-effects.mjs. Where that harness calls `process()` with hand-built
// buffers, this one registers the committed worklet source into an
// OfflineAudioContext, builds AudioWorkletNodes with the catalog defaults and
// renders a graph — the same path a browser takes.
//
// It catches what the processor shim cannot: worklet module registration, blob
// URL delivery, AudioParam wiring, `parameterData` coercion, channel counts,
// port messaging and node teardown. Run after any DSP/effect change:
//   pnpm test:render
//
// (verify-effects.mjs stays the fast lane: it asserts per-processor sample math
// without spinning up a context for each effect.)

import './web-audio-api-node.mjs';
import { OfflineAudioContext } from 'web-audio-api';
import { EFFECTS_WORKLET_SOURCE } from '../src/effects/workletsource.generated.ts';
import { EFFECTS } from '../src/effects/index.ts';

const SR = 44100;

let failures = 0;
const check = (label, cond, extra = '') => {
	console.log(`${cond ? '  ok  ' : '  FAIL'}- ${label}${extra ? ' ' + extra : ''}`);
	if (!cond) failures++;
};

/** Register the generated worklet into a fresh context via a blob URL. */
const register = async (ctx) => {
	const url = URL.createObjectURL(
		new Blob([EFFECTS_WORKLET_SOURCE], { type: 'text/javascript' }),
	);
	await ctx.audioWorklet.addModule(url);
};

/** A mono AudioBufferSourceNode playing `data`. */
const makeSource = (ctx, data) => {
	const buf = ctx.createBuffer(1, data.length, SR);
	buf.getChannelData(0).set(data);
	const src = ctx.createBufferSource();
	src.buffer = buf;
	src.start();
	return src;
};

const impulse = (n) => {
	const a = new Float32Array(n);
	a[0] = 1;
	return a;
};
const ones = (n) => Float32Array.from({ length: n }, () => 1);
const noise = (n, amp = 0.5) => {
	const a = new Float32Array(n);
	let seed = 0x9e3779b9;
	for (let i = 0; i < n; i++) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		a[i] = ((seed / 0xffffffff) * 2 - 1) * amp;
	}
	return a;
};
const mean = (a, from, to) => {
	let s = 0;
	for (let i = from; i < to; i++) s += a[i];
	return s / (to - from);
};
const finite = (buf) => {
	for (let c = 0; c < buf.numberOfChannels; c++) {
		const data = buf.getChannelData(c);
		for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
	}
	return true;
};
const energy = (buf) => {
	let sum = 0;
	for (let c = 0; c < buf.numberOfChannels; c++) {
		const data = buf.getChannelData(c);
		for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
	}
	return sum;
};

/** Numeric `parameterData` from a catalog effect definition. */
const defaultParams = (def) => {
	const params = {};
	for (const [key, spec] of Object.entries(def.defaults)) {
		const value = spec.value;
		params[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
	}
	return params;
};

/** Build one effect node from the catalog and render a graph through it. */
const renderEffect = async (def, { seconds = 0.5, input = 'noise', params } = {}) => {
	const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
	await register(ctx);
	const node = new AudioWorkletNode(ctx, def.id, {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
		parameterData: { ...defaultParams(def), ...params },
	});
	const source =
		input === 'impulse' ? impulse(ctx.length)
			: input === 'dc' ? ones(ctx.length)
				: noise(ctx.length);
	const src = makeSource(ctx, source);
	src.connect(node);
	node.connect(ctx.destination);
	const out = await ctx.startRendering();
	return { out, node };
};

// ------------------------------------------------- A: module registration
console.log('\nA. worklet module registration (blob URL)');
{
	const ctx = new OfflineAudioContext(2, SR, SR);
	let error = null;
	try {
		await register(ctx);
	} catch (e) {
		error = e;
	}
	check('addModule(blob url) resolves', !error, error ? String(error) : '');
}

// ------------------------------------ B: every catalog effect constructs/renders
console.log(`\nB. render all ${EFFECTS.length} catalog effects`);
for (const def of EFFECTS) {
	let error = null;
	let result = null;
	try {
		result = await renderEffect(def);
	} catch (e) {
		error = e;
	}
	const ok =
		!error && result && finite(result.out) && result.out.numberOfChannels === 2;
	check(
		`${def.id}: renders 2ch, finite`,
		ok,
		error ? String(error).slice(0, 80) : result ? `sum=${energy(result.out).toFixed(3)}` : '',
	);
}

// --------------------------------- C: every catalog effect survives max params
console.log('\nC. extreme parameter values');
for (const def of EFFECTS) {
	const maxed = {};
	for (const [key, spec] of Object.entries(def.defaults)) {
		const value = spec.value;
		maxed[key] = typeof value === 'boolean' ? 1 : spec.max;
	}
	let error = null;
	let result = null;
	try {
		result = await renderEffect(def, { params: maxed });
	} catch (e) {
		error = e;
	}
	check(
		`${def.id}: finite at max params`,
		!error && result && finite(result.out),
		error ? String(error).slice(0, 80) : '',
	);
}

// --------------------------------------------------------- D: known behaviours
console.log('\nD. DSP behaviours (impulse / DC)');
{
	const { out } = await renderEffect(
		EFFECTS.find((e) => e.id === 'delay'),
		{ input: 'impulse', seconds: 1, params: { feedback: 0, time: 0.1, mix: 0.5 } },
	);
	const L = out.getChannelData(0);
	check('delay dry impulse at sample 0', Math.abs(L[0]) > 0.4, `L[0]=${L[0].toFixed(3)}`);
	const around = Math.abs(L[4410]) + Math.abs(L[4409]) + Math.abs(L[4411]);
	check('delay tap near sample 4410', around > 0.4, `around=${around.toFixed(3)}`);
}
{
	const measure = async (highpass) => {
		const { out } = await renderEffect(
			EFFECTS.find((e) => e.id === 'korg35filter'),
			{ input: 'dc', seconds: 0.5, params: { cutoff: 1000, q: 0.707, highpass } },
		);
		return mean(out.getChannelData(0), SR / 2 - 2000, SR / 2);
	};
	const lp = await measure(0);
	const hp = await measure(1);
	check('korg35filter lowpass passes DC (~1)', Math.abs(lp - 1) < 0.05, `dc=${lp.toFixed(3)}`);
	check('korg35filter highpass blocks DC (~0)', Math.abs(hp) < 0.02, `dc=${hp.toFixed(3)}`);
}
{
	// gain: dB -> linear multiplier
	const measure = async (gain) => {
		const { out } = await renderEffect(
			EFFECTS.find((e) => e.id === 'gain'),
			{ input: 'dc', seconds: 1, params: { gain } },
		);
		return mean(out.getChannelData(0), SR / 2 - 2000, SR / 2);
	};
	const unity = await measure(0);
	const half = await measure(-6.0206);
	check('gain 0 dB passes DC (~1)', Math.abs(unity - 1) < 0.02, `dc=${unity.toFixed(3)}`);
	check('gain -6 dB halves DC (~0.5)', Math.abs(half - 0.5) < 0.02, `dc=${half.toFixed(3)}`);
}
{
	// reverb takes its impulse response over the message port
	const ctx = new OfflineAudioContext(2, SR, SR);
	await register(ctx);
	const node = new AudioWorkletNode(ctx, 'reverb', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
		parameterData: { mix: 0.5 },
	});
	const ir = new Float32Array(2000);
	for (let i = 0; i < ir.length; i++) ir[i] = Math.pow(1 - i / ir.length, 2);
	node.port.postMessage({ type: 'ir', channels: [ir, ir] });
	await new Promise((r) => setTimeout(r, 20));
	const src = makeSource(ctx, impulse(SR));
	src.connect(node);
	node.connect(ctx.destination);
	const out = await ctx.startRendering();
	const L = out.getChannelData(0);
	let tail = 0;
	for (let i = 500; i < 2000; i++) tail += Math.abs(L[i]);
	check('reverb port IR applied (wet tail)', tail > 0.01, `tail=${tail.toFixed(4)}`);
}

console.log(failures === 0 ? '\nRENDER CHECKS PASSED' : `\nRENDER CHECKS FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
