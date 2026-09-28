// Engine stress test against the REAL Web Audio implementation (web-audio-api),
// on the real audio clock — the counterpart to tests/stress-engine.mjs, which
// drives the same engine against a permissive mock at virtual speed.
//
// The mock validates control flow and lifetime bookkeeping but never renders and
// deliberately accepts invalid Web Audio. This lane validates that the engine
// produces a working graph when the API means what it says: real decodeAudioData,
// real AudioWorklet module registration, real analyser reads, real module
// Workers (recorder/encoder), and a genuinely running context.
//
// It is wall-clock bound, so the soak is much shorter than the mock lane's.
//   pnpm test:stress:real
// On a host with no audio device: AUDIO_ENGINE_SINK=none pnpm test:stress:real

import './web-audio-api-node.mjs';

const { default: AudioEngine } = await import('../src/audioengine.ts');
const { EFFECTS } = await import('../src/effects/index.ts');

const COLUMNS = 8;
const EFFECT_TYPES = EFFECTS.map((e) => e.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
const check = (label, cond, extra = '') => {
	if (cond) results.push('  ok  - ' + label);
	else {
		failures++;
		results.push('  FAIL- ' + label + (extra ? ' ' + extra : ''));
	}
};

async function phase(name, fn) {
	const started = Date.now();
	try {
		await fn();
	} catch (error) {
		failures++;
		results.push('  FAIL- ' + name + ' threw: ' + String(error).slice(0, 160));
	}
	results.push(`  (${name}: ${Date.now() - started}ms)`);
}

// Capture engine noise (the pitch shifter is absent without preloadPitch, and
// the encoders log as they work) but keep real errors visible.
const consoleErrors = [];
const origError = console.error;
const origLog = console.log;
const origTime = console.time;
const origTimeEnd = console.timeEnd;
console.error = (...args) => consoleErrors.push(args.map(String).join(' '));
console.log = () => {};
console.time = () => {};
console.timeEnd = () => {};

/** A tiny 16-bit PCM WAV as a base64 data URL — the engine decodes these for
 * real, so the lane needs no HTTP server and no XHR. */
function wavDataUrl(seconds = 0.4, freq = 220, sampleRate = 44100) {
	const n = Math.floor(sampleRate * seconds);
	const bytes = n * 2;
	const buffer = new ArrayBuffer(44 + bytes);
	const view = new DataView(buffer);
	const write = (offset, string) => {
		for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
	};
	write(0, 'RIFF');
	view.setUint32(4, 36 + bytes, true);
	write(8, 'WAVE');
	write(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	write(36, 'data');
	view.setUint32(40, bytes, true);
	for (let i = 0; i < n; i++) {
		const envelope = Math.min(1, i / 200) * Math.exp((-3 * i) / n);
		view.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / sampleRate) * envelope * 20000, true);
	}
	return 'data:audio/wav;base64,' + Buffer.from(buffer).toString('base64');
}

console.log = origLog;
const engine = new AudioEngine({
	sampleRate: 44100,
	enableAnalysers: true,
	enableLoops: true,
	enableElapsed: true,
	preloadPitch: false,
});
console.log = () => {};

// 1. construct + resume ----------------------------------------------------
await phase('construct + resume', async () => {
	check('engine constructs a real context', !!engine.context);
	check('sampleRate honored', engine.sampleRate === 44100, `got ${engine.sampleRate}`);
	const state = await engine.resume();
	check('context reaches running', engine.context.state === 'running', `state=${state}`);
});

// 2. real decodeAudioData --------------------------------------------------
await phase('decode data URLs', async () => {
	for (let i = 0; i < COLUMNS; i++) engine.add('c' + i, wavDataUrl(0.4, 200 + i * 40), `loop${i}.wav`);
	engine.load();
	const deadline = Date.now() + 5000;
	while (engine.ready() < COLUMNS && Date.now() < deadline) await sleep(50);
	check('all sounds decoded', engine.ready() === COLUMNS, `ready=${engine.ready()}/${COLUMNS}`);
	const duration = engine.get('c0').sound.duration();
	check('decoded duration is right', Math.abs(duration - 0.4) < 0.02, `duration=${duration}`);
});

// 3. real clock advances while rendering -----------------------------------
await phase('transport churn on the audio clock', async () => {
	const before = engine.context.currentTime;
	for (let pass = 0; pass < 10; pass++) {
		for (let i = 0; i < COLUMNS; i++) {
			const id = 'c' + i;
			engine.play(id);
			engine.pause(id, true);
			engine.pause(id, false);
			engine.stop(id);
		}
	}
	await sleep(200);
	check('currentTime advances', engine.context.currentTime > before, `${before.toFixed(3)} -> ${engine.context.currentTime.toFixed(3)}`);
});

// 4. every catalog effect in the real graph --------------------------------
await phase('effect catalog in the graph', async () => {
	let built = 0;
	for (const type of EFFECT_TYPES) {
		try {
			await engine.addEffect('c0', type, false);
			built++;
		} catch (error) {
			check(`${type}: constructs in the real graph`, false, String(error).slice(0, 120));
		}
	}
	check('all effects construct in the real graph', built === EFFECT_TYPES.length, `built=${built}/${EFFECT_TYPES.length}`);

	// play through the full chain, then tear it down while playing
	engine.play('c0');
	await sleep(300);
	check('plays through a 20-effect chain', engine.get('c0').sound._playing === true);

	let removed = 0;
	while (engine.get('c0').sound.effects.length) {
		engine.removeEffect('c0', 0);
		removed++;
		if (removed > EFFECT_TYPES.length + 4) break;
	}
	check('effect chain tears down', engine.get('c0').sound.effects.length === 0, `removed=${removed}`);
	engine.stop('c0');
});

// 5. real analyser read ----------------------------------------------------
await phase('analyser reads rendered audio', async () => {
	engine.play('c0');
	let peak = 0;
	let reads = 0;
	// `analyse()` returns the (cached) Analyser; subscribe on it.
	const analyser = engine.analyse('c0', 'timedomain', { fftSize: 1024, bits: 32 });
	analyser.addEventListener('timedomain', { fftSize: 1024, bits: 32 }, (data) => {
		if (!data || typeof data.length !== 'number') return;
		for (let i = 0; i < data.length; i++) {
			const v = Math.abs(data[i]);
			if (v > peak) peak = v;
		}
		reads++;
	});
	await sleep(600);
	engine.stop('c0');
	check('analyser delivers frames', reads > 0, `reads=${reads}`);
	check(
		'analyser sees non-silent audio',
		peak > 0.001,
		`peak=${peak.toFixed(5)} (0 means the render is silent on this host)`,
	);
});

// 6. record round-trip through the module workers --------------------------
// The record worklet flushes in CHUNK_SIZE (16384 frames ≈ 0.37s) blocks, so
// the take must outlast one chunk or stop() sees an empty buffer.
await phase('record round-trip (worker + worklet)', async () => {
	engine.play('c0');
	await sleep(150);
	let resolved = null;
	let error = null;
	const pending = engine.record(true);
	if (pending && typeof pending.then === 'function') {
		pending.then((r) => (resolved = r)).catch((e) => (error = e));
	}
	await sleep(1600);
	engine.record(false);
	const deadline = Date.now() + 10000;
	while (!resolved && !error && Date.now() < deadline) await sleep(100);
	engine.stop('c0');
	if (error) {
		check('recording resolves', false, String(error).slice(0, 120));
	} else {
		const samples = resolved && resolved.buffer && resolved.buffer[0] && resolved.buffer[0].length;
		check('recording resolves', !!resolved, `resolved=${!!resolved}`);
		check('recording captured samples', samples > 0, `samples=${samples}`);
	}
});

// 7. parameter + transport storm on the real graph -------------------------
await phase('parameter + transport storm', async () => {
	let seed = 0x9e3779b9;
	const rnd = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 0xffffffff;
	};
	for (let pass = 0; pass < 30; pass++) {
		for (let i = 0; i < COLUMNS; i++) {
			const id = 'c' + i;
			engine.volume(id, rnd() * 1.5);
			engine.rate(id, 0.25 + rnd() * 3);
			engine.pan(id, Math.round((rnd() - 0.5) * 180));
			engine.mute(id, rnd() > 0.7);
			engine.loop(id, rnd() > 0.3, { start: rnd() * 0.2, end: 0.3 + rnd() * 0.7 });
			engine.reverse(id, rnd() > 0.8);
		}
		engine.master.play();
		engine.master.pause(true);
		engine.master.pause(false);
		engine.master.stop();
	}
	await sleep(200);
	check('parameter + transport storm survived', true);
});

// 8. teardown --------------------------------------------------------------
await phase('teardown', async () => {
	engine.destroy(true);
	await sleep(50);
	check('destroy clears sounds', engine.sounds.length === 0, `got ${engine.sounds.length}`);
	try {
		await engine.context.close();
		check('context closes', engine.context.state === 'closed', `state=${engine.context.state}`);
	} catch (error) {
		check('context closes', false, String(error).slice(0, 120));
	}
});

// ---- report --------------------------------------------------------------
console.log = origLog;
console.time = origTime;
console.timeEnd = origTimeEnd;
console.error = origError;

const allowedErrors = /signalsmith-stretch unavailable|ERRROR decoding|decoding audio|No impulse file specified|already registered/i;
const realErrors = consoleErrors.filter((e) => !allowedErrors.test(e));
check('no unexpected console.error', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

console.log('\nengine stress (real web-audio-api)');
for (const line of results) console.log(line);
if (realErrors.length) {
	console.log('\nunexpected console.error sample:');
	for (const e of realErrors.slice(0, 5)) console.log('  ' + e);
}
console.log('\n' + (failures === 0 ? 'ALL REAL-ENGINE CHECKS PASSED' : failures + ' REAL-ENGINE CHECKS FAILED'));
process.exit(failures === 0 ? 0 : 1);
