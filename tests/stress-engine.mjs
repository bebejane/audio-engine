// Engine stress / soak test.
//
// Runs the REAL AudioEngine headlessly against a Web Audio mock
// (tests/mock-web-audio.mjs) and drives every subsystem hard: many sounds,
// transport churn, parameter automation storms, the full effect catalog,
// analyser attach/detach, buffer replace + peaks caching, model/preset I/O and
// a mixed soak phase. It asserts nothing throws, caches/listeners stay bounded
// and no EventEmitter "possible memory leak" warnings are emitted.
//
// Run: pnpm test:stress   (node --import ./tests/register-ts.mjs …)

import { installMockWebAudio, tickFrames, tick } from './mock-web-audio.mjs';

installMockWebAudio();

const { default: AudioEngine } = await import('../src/audioengine.ts');

// `--heavy` (or STRESS_HEAVY=1) widens the grid and the soak window; STRESS_COLUMNS
// / STRESS_SOAK_MS override either dimension individually.
const HEAVY = process.argv.includes('--heavy') || process.env.STRESS_HEAVY === '1';

const EFFECT_TYPES = [
	'delay',
	'dubdelay',
	'flanger',
	'reverb',
	'distortion',
	'compressor',
	'convolver',
	'pingpongdelay',
	'tremolo',
	'quadrafuzz',
	'stereopanner',
	'stonephaser',
	'ringmodulator',
	'highpassfilter',
	'lowpassfilter',
	'magnetictape',
	'j60chorus',
	'korg35hpf',
	'korg35lpf',
	'tapedelay',
	'tapesaturation',
];

let failures = 0;
const results = [];
const check = (label, cond, extra = '') => {
	if (cond) {
		results.push('  ok  - ' + label);
	} else {
		failures++;
		results.push('  FAIL- ' + label + (extra ? ' ' + extra : ''));
	}
};

// Capture warnings (MaxListenersExceededWarning etc.) and console noise the
// engine legitimately produces (e.g. the pitch shifter is absent in Node).
const warnings = [];
const consoleErrors = [];
process.on('warning', (w) => warnings.push(w));
const origError = console.error;
const origLog = console.log;
const origTime = console.time;
const origTimeEnd = console.timeEnd;
console.error = (...args) => consoleErrors.push(args.map(String).join(' '));
// the engine carries a few debug console.log/time calls (peaks, normalize) —
// keep them out of the report without hiding errors
console.log = () => {};
console.time = () => {};
console.timeEnd = () => {};

const unexpectedError = (label) => (err) => {
	failures++;
	results.push('  FAIL- ' + label + ' threw: ' + (err && err.stack ? err.stack.split('\n')[0] : err));
};

const COLUMNS = Number(process.env.STRESS_COLUMNS || (HEAVY ? 96 : 48));
const SOAK_MS = Number(process.env.STRESS_SOAK_MS || (HEAVY ? 8000 : 1500));

async function phase(name, fn) {
	try {
		await fn();
	} catch (err) {
		unexpectedError(name)(err);
	}
}

// ---------------------------------------------------------------------------
const engine = new AudioEngine({ sampleRate: 44100, enableAnalysers: true, enableLoops: true, enableElapsed: true, preloadPitch: false });

await phase('construct', async () => {
	check('engine constructs with a mock context', !!engine.context);
	check('sampleRate honored', engine.sampleRate === 44100, `got ${engine.sampleRate}`);
	check('preloadPitch:false honored', engine.preloadPitch === false, `got ${engine.preloadPitch}`);
	// default is true — must construct cleanly even with no window (headless)
	const defaults = new AudioEngine({ sampleRate: 44100 });
	check('preloadPitch defaults to true', defaults.preloadPitch === true, `got ${defaults.preloadPitch}`);
	defaults.destroy(true);
});

// 0. empty model: replace()/sample() must work on cells with no Sound yet ----
await phase('empty-model upload/record', async () => {
	const e = new AudioEngine({ sampleRate: 44100, preloadPitch: false });
	e.replace('0-0', '/audio/drop.wav', 'drop.wav');
	await tick(5);
	const item = e.soundMap['0-0'];
	check('replace() creates a sound for an empty cell', !!item, 'missing');
	check('replace() loads the new sound', !!item && item.sound._loaded, `loaded=${item ? item.sound._loaded : 'n/a'}`);
	// cancel/sample on an unknown id must not throw (empty cells have no Sound)
	let threw = false;
	try {
		e.cancelSample('9-9');
	} catch {
		threw = true;
	}
	check('cancelSample() tolerates an unknown id', !threw);
	let sampleErr = null;
	await Promise.resolve(e.sample('3-3', true)).catch((err) => (sampleErr = err));
	check('sample() rejects cleanly when there is no input', sampleErr !== null, `err=${sampleErr}`);
	e.destroy(true);
});

// 1. many sounds -----------------------------------------------------------
await phase('add sounds', async () => {
	for (let i = 0; i < COLUMNS; i++) {
		engine.add('c' + i, `/audio/loop${i}.wav`, `loop${i}.wav`);
	}
	check('all sounds added', engine.sounds.length === COLUMNS, `got ${engine.sounds.length}`);

	engine.load();
	await tick(5);
	await tickFrames(2);
	check('all sounds decoded/ready', engine.ready() === COLUMNS, `ready=${engine.ready()}`);
});

// 2. transport churn -------------------------------------------------------
await phase('transport churn', async () => {
	for (let pass = 0; pass < 40; pass++) {
		for (let i = 0; i < COLUMNS; i++) {
			const id = 'c' + i;
			engine.play(id);
			engine.pause(id, true);
			engine.pause(id, false);
			engine.stop(id);
		}
	}
	await tick(5);
	check('transport churn survived', true);
});

// 3. parameter storm -------------------------------------------------------
await phase('parameter storm', async () => {
	const rnd = mulberry(0x9e3779b9);
	for (let pass = 0; pass < 200; pass++) {
		for (let i = 0; i < COLUMNS; i++) {
			const id = 'c' + i;
			engine.volume(id, rnd() * 1.5);
			engine.rate(id, 0.25 + rnd() * 3);
			engine.pitch(id, Math.round((rnd() - 0.5) * 24));
			engine.pan(id, Math.round((rnd() - 0.5) * 180));
			engine.mute(id, rnd() > 0.7);
			engine.loop(id, rnd() > 0.3, { start: rnd() * 0.2, end: 0.3 + rnd() * 0.7 });
			engine.reverse(id, rnd() > 0.8);
		}
	}
	check('parameter storm survived', true);
});

// 3b. channel EQ churn -----------------------------------------------------
await phase('eq churn', async () => {
	const rnd = mulberry(0x1234abcd);
	for (let pass = 0; pass < 60; pass++) {
		for (let i = 0; i < COLUMNS; i++) {
			const id = 'c' + i;
			engine.eq(id, 0, { on: rnd() > 0.5, type: 'lowshelf', frequency: 40 + rnd() * 300, gain: (rnd() - 0.5) * 24, q: 0.7 });
			engine.eq(id, 2, { on: rnd() > 0.5, type: 'peaking', frequency: 400 + rnd() * 6000, gain: (rnd() - 0.5) * 24, q: 0.1 + rnd() * 5 });
		}
	}
	const all = engine.eq('c0');
	check('eq() returns 4 bands', Array.isArray(all) && all.length === 4, `len=${Array.isArray(all) ? all.length : 'n/a'}`);
	const b0 = engine.eq('c0', 0);
	check('eq(band) returns one band', !!b0 && typeof b0.frequency === 'number', String(b0));
	check('eq ignores out-of-range band', engine.eq('c0', 9) === undefined, `got ${engine.eq('c0', 9)}`);
	check('eq clamps out-of-range gain', Math.abs(engine.eq('c1', 0, { gain: 999 }).gain) === 18, `gain=${engine.eq('c1', 0).gain}`);
});

// 4. effect catalog churn --------------------------------------------------
await phase('effect churn', async () => {
	// every effect on one sound, both bypassed and active
	for (const type of EFFECT_TYPES) {
		await engine.addEffect('c0', type, false);
	}
	check('all effect types materialize', engine.effectParams('c0').length === EFFECT_TYPES.length, `got ${engine.effectParams('c0').length}`);

	// rapid param writes across the whole chain
	const chain = engine.effectParams('c0');
	for (const entry of chain) {
		const params = entry.params || {};
		for (const k of Object.keys(params)) {
			if (typeof params[k] === 'number') engine.effectParams('c0', entry.idx, { [k]: params[k] * 0.5 + 0.1 });
			else engine.effectParams('c0', entry.idx, { [k]: !params[k] });
		}
	}

	// bypass / enable / disable / reorder / remove
	for (let i = 0; i < chain.length; i++) engine.effectBypass('c0', i, i % 2 === 0);
	engine.disableEffects('c0');
	engine.enableEffects('c0');
	engine.moveEffect('c0', 0, chain.length - 1);
	engine.moveEffect('c0', chain.length - 1, 0);
	for (let i = chain.length - 1; i >= 0; i--) engine.removeEffect('c0', i);
	check('chain empties after removals', (engine.effectParams('c0') || []).length === 0, `got ${engine.effectParams('c0').length}`);

	// spread effects across many sounds and toggle under playback
	for (let i = 0; i < COLUMNS; i++) {
		const type = EFFECT_TYPES[i % EFFECT_TYPES.length];
		await engine.addEffect('c' + i, type, true);
		engine.play('c' + i);
		engine.effectBypass('c' + i, 0, false);
		engine.effectBypass('c' + i, 0, true);
		engine.stop('c' + i);
	}
	await tick(5);
	check('distributed effect churn survived', true);
});

// 5. analyser attach/detach ------------------------------------------------
await phase('analyser churn', async () => {
	const baseline = engine.analysers.length;
	for (let pass = 0; pass < 12; pass++) {
		const attached = [];
		for (let i = 0; i < COLUMNS; i++) {
			const id = 'c' + i;
			for (const type of ['volume', 'timedomain', 'frequency']) {
				const a = engine.analyse(id, type, {}, () => {});
				if (a) attached.push(a);
			}
		}
		engine.play('c0');
		await tickFrames(3);
		for (const a of attached) engine.removeAnalyser(a);
	}
	await tickFrames(2);
	check('analysers return to baseline after detach', engine.analysers.length === baseline, `baseline=${baseline} now=${engine.analysers.length}`);
});

// 6. buffer replace + peaks cache bound ------------------------------------
await phase('peaks cache bound', async () => {
	// _peaksCache lives on the engine's SoundItem (engine.get(id)), not the Sound
	const item = engine.soundMap['c0'];
	for (let i = 0; i < 200; i++) {
		engine.extractPeaks('c0', 50 + i, { mono: i % 2 === 0, bits: i % 3 === 0 ? 16 : 8 });
	}
	check('peaks cache bounded (<= 8)', (item._peaksCache?.size ?? 0) <= 8, `size=${item._peaksCache?.size}`);
	check('peaks data returned', !!engine.extractPeaks('c0'), 'null');
});

// 7. automation record/loop ------------------------------------------------
await phase('automation', async () => {
	engine.play('c0');
	for (let i = 0; i < 500; i++) engine.volume('c0', (i % 10) / 10);
	let recorded = false;
	try {
		engine.automation.record(true);
		for (let i = 0; i < 20; i++) engine.rate('c0', 0.5 + (i % 5) / 5);
		engine.automation.record(false);
		engine.automation.play(true);
		await tick(30);
		engine.automation.play(false);
		recorded = true;
	} catch (err) {
		unexpectedError('automation')(err);
	}
	check('automation record/loop ran', recorded);
});

// 8. presets + model roundtrip --------------------------------------------
await phase('presets + model', async () => {
	engine.createModel('stress', COLUMNS, 1);
	for (let i = 0; i < COLUMNS; i++) engine.volume('c' + i, (i % 8) / 8);
	const preset = engine.savePreset('stress-preset');
	check('preset saved', !!preset);
	engine.randomizePreset(0);
	engine.restorePreset(0);
	check('preset restore survived', true);

	const saved = await engine.saveModel();
	check('model serialized to a blob', !!saved && !!saved.blob, String(saved));
	if (saved && saved.blob && saved.blob.arrayBuffer) {
		const zip = await saved.blob.arrayBuffer();
		check('model zip non-empty', zip.byteLength > 0, `bytes=${zip.byteLength}`);
	}
});

// 9. master race -----------------------------------------------------------
await phase('master transport race', async () => {
	for (let i = 0; i < 40; i++) {
		engine.master.play({ enableElapsed: true });
		engine.master.volume(0.2 + (i % 5) / 5);
		engine.master.play();
		engine.master.pause(true);
		engine.master.pause(false);
		engine.master.stop();
	}
	await tick(5);
	check('master transport race survived', true);
});

// 10. mixed soak -----------------------------------------------------------
await phase('mixed soak', async () => {
	// restorePreset above can shrink the grid and get()-style ops throw on an
	// unknown id by design, so rebuild a full grid first to soak all cells
	engine.removeAll();
	for (let i = 0; i < COLUMNS; i++) engine.add('c' + i, `/audio/loop${i}.wav`, `loop${i}.wav`);
	engine.load();
	await tick(5);
	await tickFrames(1);
	check('grid rebuilt for soak', engine.sounds.length === COLUMNS, `got ${engine.sounds.length}`);

	const rnd = mulberry(12345);
	const start = Date.now();
	const DURATION_MS = SOAK_MS;
	let ops = 0;
	while (Date.now() - start < DURATION_MS) {
		const i = (rnd() * COLUMNS) | 0;
		const id = 'c' + i;
		if (!engine.exist(id)) continue;
		const op = (rnd() * 10) | 0;
		switch (op) {
			case 0:
				await engine.addEffect(id, EFFECT_TYPES[(rnd() * EFFECT_TYPES.length) | 0], rnd() > 0.5);
				break;
			case 1:
				engine.play(id);
				break;
			case 2:
				engine.stop(id);
				break;
			case 3:
				engine.volume(id, rnd());
				break;
			case 4:
				engine.rate(id, 0.5 + rnd() * 2);
				break;
			case 5:
				engine.loop(id, rnd() > 0.5);
				break;
			case 6: {
				const chain = engine.effectParams(id) || [];
				if (chain.length) engine.removeEffect(id, (rnd() * chain.length) | 0);
				break;
			}
			case 7:
				engine.mute(id, rnd() > 0.5);
				break;
			case 8:
				engine.extractPeaks(id, 80 + ((rnd() * 40) | 0));
				break;
			case 9: {
				const a = engine.analyse(id, 'volume', {}, () => {});
				if (a) engine.removeAnalyser(a);
				break;
			}
		}
		ops++;
		if (ops % 200 === 0) await tickFrames(1);
		else await Promise.resolve();
	}
	results.push(`  ..  soak: ${ops} operations in ${Date.now() - start}ms`);
	check('soak ran meaningful load', ops > 500, `ops=${ops}`);
	check('soak survived', true);
});

// 11. teardown -------------------------------------------------------------
await phase('teardown', async () => {
	engine.destroy(true);
	await tick(10);
	check('destroy clears sounds', engine.sounds.length === 0, `got ${engine.sounds.length}`);
	check('destroy clears analysers', engine.analysers.length === 0, `got ${engine.analysers.length}`);
});

// ---- report --------------------------------------------------------------
console.log = origLog;
console.time = origTime;
console.timeEnd = origTimeEnd;
console.error = origError;
const maxListenerWarnings = warnings.filter((w) => /MaxListenersExceededWarning/.test(w.message || ''));
check('no MaxListenersExceededWarning', maxListenerWarnings.length === 0, `${maxListenerWarnings.length} warning(s)`);

const allowedErrors = /signalsmith-stretch unavailable|ERRROR decoding|decoding audio|No impulse file specified/i;
const realErrors = consoleErrors.filter((e) => !allowedErrors.test(e));
check('no unexpected console.error', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

console.log('\nengine stress');
for (const line of results) console.log(line);
if (realErrors.length) {
	console.log('\nunexpected console.error sample:');
	for (const e of realErrors.slice(0, 5)) console.log('  ' + e);
}
console.log('\n' + (failures === 0 ? 'ALL ENGINE STRESS CHECKS PASSED' : failures + ' ENGINE STRESS CHECKS FAILED'));
process.exit(failures === 0 ? 0 : 1);

// Small deterministic PRNG (mulberry32) so runs are reproducible.
function mulberry(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
