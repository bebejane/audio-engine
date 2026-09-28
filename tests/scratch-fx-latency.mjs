// scratch: measure each effect processor's group delay with an impulse.
// Runs the generated worklet source through a minimal processor shim (same
// approach as verify-effects.mjs) and reports the first significant output
// sample after an impulse at sample 0.
import { EFFECTS_WORKLET_SOURCE } from '../src/effects/workletsource.generated.ts';

const SR = 44100;
const BLOCK = 128;

globalThis.AudioWorkletProcessor = class {
	constructor() {
		this.port = { postMessage: () => {}, onmessage: null };
	}
};
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.currentFrame = 0;
const registered = {};
globalThis.registerProcessor = (n, c) => {
	registered[n] = c;
};
new Function(EFFECTS_WORKLET_SOURCE)();

// impulse at sample 0, silence after; collect the full output
const measure = (name) => {
	let proc;
	try {
		proc = new registered[name]();
	} catch (e) {
		return { err: String(e) };
	}
	const N = SR; // 1 second
	const out = new Float32Array(N);
	let frame = 0;
	for (let b = 0; b < Math.ceil(N / BLOCK); b++) {
		globalThis.currentTime = frame / SR;
		const inL = new Float32Array(BLOCK);
		const inR = new Float32Array(BLOCK);
		if (frame === 0) {
			inL[0] = 1;
			inR[0] = 1;
		}
		const outL = new Float32Array(BLOCK);
		const outR = new Float32Array(BLOCK);
		// parameters: use defaults via the descriptor list if present
		const params = {};
		const desc = proc.constructor.parameterDescriptors || [];
		for (const d of desc) {
			params[d.name] = Float32Array.from(new Array(BLOCK).fill(d.defaultValue));
		}
		proc.process([[inL, inR], []], [[outL, outR], []], params);
		out.set(outL.subarray(0, Math.min(BLOCK, N - frame)), frame);
		frame += BLOCK;
	}
	// first sample above a threshold
	let first = -1;
	for (let i = 0; i < N; i++) {
		if (Math.abs(out[i]) > 1e-4) {
			first = i;
			break;
		}
	}
	return { delaySamples: first, delayMs: first < 0 ? null : +((first / SR) * 1000).toFixed(1) };
};

const names = Object.keys(registered).sort();
console.log('processor'.padEnd(18), 'first output (samples)', 'ms');
for (const n of names) {
	const r = measure(n);
	console.log(n.padEnd(18), String(r.delaySamples ?? r.err).padEnd(22), r.delayMs ?? '');
}
