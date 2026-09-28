// Throwaway spike: prove web-audio-api drives the real generated effects worklet
// offline. Run: node tests/spike-offline.mjs
import { OfflineAudioContext, AudioWorkletNode, AudioWorkletProcessor } from 'web-audio-api';
import { EFFECTS_WORKLET_SOURCE } from '../src/effects/workletsource.generated.ts';

// Compatibility shim: our worklet fragments set `Foo.parameterDescriptors = …`
// on the subclass (browser-legal). web-audio-api's AudioWorkletProcessor
// exposes `parameterDescriptors` as a static getter without a setter, so that
// assignment throws. Give the inherited accessor a setter that installs an own
// data property on the subclass.
Object.defineProperty(AudioWorkletProcessor, 'parameterDescriptors', {
	configurable: true,
	get() {
		return [];
	},
	set(value) {
		Object.defineProperty(this, 'parameterDescriptors', {
			value,
			writable: true,
			configurable: true,
		});
	},
});

const SR = 44100;
let failures = 0;
const check = (label, cond, extra = '') => {
	console.log(`${cond ? '  ok  ' : '  FAIL'}- ${label}${extra ? ' ' + extra : ''}`);
	if (!cond) failures++;
};

const register = async (ctx) => {
	const url = URL.createObjectURL(
		new Blob([EFFECTS_WORKLET_SOURCE], { type: 'text/javascript' }),
	);
	await ctx.audioWorklet.addModule(url);
};

const makeSource = (ctx, data) => {
	const buf = ctx.createBuffer(1, data.length, SR);
	buf.getChannelData(0).set(data);
	const src = ctx.createBufferSource();
	src.buffer = buf;
	src.start();
	return src;
};
const ones = (n) => Float32Array.from({ length: n }, () => 1);
const impulse = (n) => {
	const a = new Float32Array(n);
	a[0] = 1;
	return a;
};
const mean = (a, from, to) => {
	let s = 0;
	for (let i = from; i < to; i++) s += a[i];
	return s / (to - from);
};

// ---------------------------------------------------------------- A: register
console.log('\nA. worklet module registration (blob URL)');
{
	const ctx = new OfflineAudioContext(2, SR, SR);
	let err = null;
	try {
		await register(ctx);
	} catch (e) {
		err = e;
	}
	check('addModule(blob url) resolves', !err, err ? String(err) : '');
}

// ------------------------------------------------------------- B: delay render
console.log('\nB. delay offline render (impulse -> delayed impulse)');
{
	const ctx = new OfflineAudioContext(2, SR, SR);
	await register(ctx);
	const node = new AudioWorkletNode(ctx, 'delay', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
		parameterData: { feedback: 0, time: 0.1, mix: 0.5 },
	});
	check('delay params exposed', !!node.parameters.get('time'), `time=${node.parameters.get('time')?.value}`);
	const src = makeSource(ctx, impulse(SR));
	src.connect(node);
	node.connect(ctx.destination);
	const out = await ctx.startRendering();
	const L = out.getChannelData(0);
	check('dry impulse at sample 0', Math.abs(L[0]) > 0.4, `L[0]=${L[0].toFixed(3)}`);
	const at4410 = Math.abs(L[4410]) + Math.abs(L[4409]) + Math.abs(L[4411]);
	check('delayed impulse near sample 4410', at4410 > 0.4, `around=${at4410.toFixed(3)}`);
	check('stereo output present', out.numberOfChannels === 2);
}

// ------------------------------------------------- C: korg35filter params/mode
console.log('\nC. korg35filter offline render (DC through LP vs HP)');
{
	const run = async (highpass) => {
		const ctx = new OfflineAudioContext(2, SR / 2, SR);
		await register(ctx);
		const node = new AudioWorkletNode(ctx, 'korg35filter', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			parameterData: { cutoff: 1000, q: 0.707, highpass },
		});
		const src = makeSource(ctx, ones(SR / 2));
		src.connect(node);
		node.connect(ctx.destination);
		const out = await ctx.startRendering();
		return mean(out.getChannelData(0), SR / 2 - 2000, SR / 2);
	};
	const lp = await run(0);
	const hp = await run(1);
	check('lowpass passes DC (~1)', Math.abs(lp - 1) < 0.05, `dc=${lp.toFixed(3)}`);
	check('highpass blocks DC (~0)', Math.abs(hp) < 0.02, `dc=${hp.toFixed(3)}`);
}

// ------------------------------------------------------ D: port (reverb IR)
console.log('\nD. worklet port messaging (reverb IR via postMessage)');
{
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
	// let the MessageChannel port deliver before rendering
	await new Promise((r) => setTimeout(r, 10));
	const src = makeSource(ctx, impulse(SR));
	src.connect(node);
	node.connect(ctx.destination);
	const out = await ctx.startRendering();
	const L = out.getChannelData(0);
	let tail = 0;
	for (let i = 500; i < 2000; i++) tail += Math.abs(L[i]);
	check('reverb IR applied (nonzero wet tail)', tail > 0.01, `tail=${tail.toFixed(4)}`);
}

console.log(failures === 0 ? '\nSPIKE PASSED' : `\nSPIKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
