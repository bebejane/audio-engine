// Browser stress test for audio-engine. Uses the REAL WebAudio API (via the
// bundle built by ./build.mjs) and measures how the engine behaves as you pile
// on voices, automate parameters, churn effects and record — all at once.
//
// Open through the dev server (see serve.mjs), not file://.

import AudioEngine from './build/index.js';

const $ = (id) => document.getElementById(id);
const EFFECT_TYPES = [
	'delay', 'dubdelay', 'flanger', 'reverb', 'distortion', 'compressor',
	'pingpongdelay', 'tremolo', 'quadrafuzz', 'stereopanner', 'stonephaser',
	'ringmodulator', 'highpassfilter', 'lowpassfilter', 'magnetictape', 'j60chorus',
	'korg35hpf', 'korg35lpf', 'tapedelay', 'tapesaturation',
];

const log = (msg) => {
	const el = $('log');
	el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
	el.scrollTop = el.scrollHeight;
};

// ---- synthetic audio so the page needs no asset files ---------------------
function wavBuffer(seconds, sampleRate, freq) {
	const n = Math.floor(seconds * sampleRate);
	const bytes = 44 + n * 2;
	const dv = new DataView(new ArrayBuffer(bytes));
	const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
	str(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); str(8, 'WAVE');
	str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
	dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
	str(36, 'data'); dv.setUint32(40, n * 2, true);
	for (let i = 0; i < n; i++) {
		const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 0.7 * i) / sampleRate);
		const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.35 * env;
		dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
	}
	return dv.buffer;
}

const rnd = (n) => Math.random() * n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 4000) {
	const t0 = performance.now();
	while (!cond()) {
		if (performance.now() - t0 > timeout) return false;
		await wait(20);
	}
	return true;
}

// ---- click / pop detector -------------------------------------------------
// A click is a waveform discontinuity: a sample-to-sample jump that is large
// relative to the recent slope of the signal. This worklet runs on the audio
// thread (sample-accurate, immune to main-thread jank): it tracks a slow
// envelope of |Δ| and counts jumps over `max(floor, ratio × envelope)`, plus
// the interval's peak |Δ|. `floor` is the configurable threshold.
const CLICK_WORKLET = `
class ClickDetector extends AudioWorkletProcessor {
	constructor() {
		super();
		this.prev = 0;
		this.floor = 0.05;
		this.ratio = 6;
		this.avg = 0.01;
		this.smooth = 1 - Math.exp(-1 / (sampleRate * 0.05));
		this.clicks = 0;
		this.maxDelta = 0;
		this.frames = 0;
		this.port.onmessage = (e) => {
			if (e.data && e.data.type === 'threshold') this.floor = e.data.value;
		};
	}
	process(inputs) {
		var inp = inputs[0] && inputs[0][0];
		if (inp) {
			for (var i = 0; i < inp.length; i++) {
				var x = inp[i];
				var d = Math.abs(x - this.prev);
				if (d > this.maxDelta) this.maxDelta = d;
				var thr = this.floor > this.ratio * this.avg ? this.floor : this.ratio * this.avg;
				if (d > thr) this.clicks++;
				this.avg += (d - this.avg) * this.smooth;
				this.prev = x;
			}
		}
		this.frames += 128;
		if (this.frames >= sampleRate * 0.1) {
			this.frames = 0;
			this.port.postMessage({ clicks: this.clicks, maxDelta: this.maxDelta, threshold: this.floor });
			this.clicks = 0;
			this.maxDelta = 0;
		}
		return true;
	}
}
registerProcessor('click-detector', ClickDetector);
`;

// ---- engine setup ---------------------------------------------------------
let engine = null;
let analyser = null;
let td = null;
let running = false;
let escalating = false;
const timers = new Map();
const ops = { params: 0, effects: 0, events: 0 };
let effectCount = 0;
let clipCount = 0;
let dropouts = 0;
let recording = false;
let clickNode = null;
let clickCount = 0;
let clickMaxDelta = 0;
let clickRate = 0;
let clickPrev = 0;

async function startAudio() {
	if (engine) return;
	engine = new AudioEngine({
		sampleRate: 44100,
		enableAnalysers: true,
		enableLoops: true,
		enableElapsed: true,
		// this page loads hundreds of voices for throughput testing; eager
		// pitch nodes would dominate the numbers, so keep it lazy here
		preloadPitch: false,
	});
	try {
		await engine.init({ resume: true });
	} catch {
		/* fall through to resume() */
	}
	await engine.resume();
	engine.context.onstatechange = updatePill;
	engine.on('elapsed', () => ops.events++);
	window.__engine = engine; // handy for poking from devtools
	window.__stress = {
		clicks: () => ({ count: clickCount, maxDelta: clickMaxDelta }),
		resetClicks: () => {
			clickCount = 0;
			clickMaxDelta = 0;
			clickPrev = 0;
		},
	};

	analyser = engine.context.createAnalyser();
	analyser.fftSize = 2048;
	engine.masterGain.connect(analyser);
	td = new Float32Array(analyser.fftSize);

	// sample-accurate click detector on the master bus (outputs silence)
	try {
		const url = URL.createObjectURL(new Blob([CLICK_WORKLET], { type: 'text/javascript' }));
		await engine.context.audioWorklet.addModule(url);
		URL.revokeObjectURL(url);
		clickNode = new AudioWorkletNode(engine.context, 'click-detector', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
		});
		clickNode.port.onmessage = (e) => {
			clickCount += e.data.clicks || 0;
			if (e.data.maxDelta > clickMaxDelta) clickMaxDelta = e.data.maxDelta;
		};
		engine.masterGain.connect(clickNode);
		clickNode.connect(engine.context.destination);
		applyClickThreshold();
	} catch (err) {
		log('click detector unavailable: ' + err);
	}

	updatePill();
	for (const id of ['start']) $(id).disabled = true;
	for (const id of ['spawn', 'playAll', 'automate', 'effects', 'record', 'ramp', 'soak', 'reset']) $(id).disabled = false;
	log('audio context running · ' + engine.context.sampleRate + ' Hz');
	startMetrics();
}

function updatePill() {
	const el = $('ctx');
	const runningNow = engine && engine.context.state === 'running';
	el.textContent = 'context: ' + (engine ? engine.context.state : 'suspended');
	el.className = 'pill ' + (runningNow ? 'on' : 'off');
}

/** Push the configured click threshold to the detector worklet. */
function applyClickThreshold() {
	const value = Number($('clickThresh').value) || 0.05;
	$('threshLabel').textContent = value.toFixed(2);
	if (clickNode) clickNode.port.postMessage({ type: 'threshold', value });
}

// ---- sounds ---------------------------------------------------------------
async function ensureVoices(n) {
	if (!engine) return;
	for (let i = engine.sounds.length; i < n; i++) {
		engine.add('v' + i, null, 'stress-' + i + '.wav');
		const snd = engine.soundMap['v' + i].sound;
		snd.decodeAudioData(wavBuffer(0.6 + rnd(0.8), 44100, 70 + (i % 40) * 9));
	}
	const ok = await waitFor(() => engine.ready() >= Math.min(n, engine.sounds.length));
	if (!ok) log('warn: some buffers did not finish decoding');
}

function playAll() {
	// sustain the load: enable looping on every voice before playing
	for (const item of engine.sounds) if (!item.sound._loop) engine.loop(item.id, true);
	engine.play();
}
function stopAll() {
	engine.stop();
	engine.master.stop?.();
}

// ---- load generators ------------------------------------------------------
function startAutomation() {
	if (timers.has('automate')) return;
	$('automate').classList.add('on');
	const tick = () => {
		if (!engine.sounds.length) return;
		const i = (rnd(engine.sounds.length)) | 0;
		const id = 'v' + i;
		if (!engine.exist(id)) return;
		switch ((rnd(6)) | 0) {
			case 0: engine.volume(id, rnd(1.2)); break;
			case 1: engine.rate(id, 0.25 + rnd(3)); break;
			case 2: engine.pan(id, -90 + rnd(180)); break;
			case 3: engine.pitch(id, Math.round(-12 + rnd(24))); break;
			case 4: engine.loop(id, Math.random() > 0.3); break;
			case 5: engine.mute(id, Math.random() > 0.8); break;
		}
		ops.params++;
	};
	const t = setInterval(tick, 16);
	timers.set('automate', t);
}

function startEffects() {
	if (timers.has('effects')) return;
	$('effects').classList.add('on');
	const tick = async () => {
		if (!engine.sounds.length) return;
		const i = (rnd(engine.sounds.length)) | 0;
		const id = 'v' + i;
		if (!engine.exist(id)) return;
		const chain = engine.effectParams(id) || [];
		// bound the total chain so the page measures throughput, not an
		// ever-growing pile of AudioWorklet nodes
		if (chain.length < 4 && effectCount < 256 && Math.random() > 0.3) {
			await engine.addEffect(id, EFFECT_TYPES[(rnd(EFFECT_TYPES.length)) | 0], false);
			effectCount++;
		} else if (chain.length) {
			const e = chain[(rnd(chain.length)) | 0];
			if (Math.random() > 0.5) {
				// remove half the time, so chains stay bounded
				if (Math.random() > 0.5) {
					engine.removeEffect(id, e.idx);
					effectCount = Math.max(0, effectCount - 1);
				} else {
					engine.effectBypass(id, e.idx, Math.random() > 0.5);
				}
			} else {
				const keys = Object.keys(e.params || {});
				if (keys.length) {
					const k = keys[(rnd(keys.length)) | 0];
					const cur = e.params[k];
					engine.effectParams(id, e.idx, { [k]: typeof cur === 'number' ? cur * 0.5 + 0.1 : !cur });
				}
			}
		}
		ops.effects++;
	};
	const t = setInterval(tick, 60);
	timers.set('effects', t);
}

function stopAutomation() {
	const t = timers.get('automate');
	if (t) { clearInterval(t); timers.delete('automate'); }
	$('automate').classList.remove('on');
}
function stopEffects() {
	const t = timers.get('effects');
	if (t) { clearInterval(t); timers.delete('effects'); }
	$('effects').classList.remove('on');
}

function toggleRecord() {
	const btn = $('record');
	if (recording) {
		recording = false;
		btn.classList.remove('on');
		engine.record(false);
		log('recording stopped');
		return;
	}
	recording = true;
	btn.classList.add('on');
	engine.record(true).catch((e) => log('record error: ' + e));
	log('master recording started');
}

function stopAllLoad() {
	for (const [, t] of timers) clearInterval(t);
	timers.clear();
	for (const id of ['automate', 'effects']) $(id).classList.remove('on');
	if (recording) toggleRecord();
	escalating = false;
}

// ---- metrics --------------------------------------------------------------
const met = {
	frames: 0, fpsT0: performance.now(), fps: 0, fpsCount: 0,
	frameSum: 0, frameCount: 0, frameMax: 0, avgFrame: 0, long: 0, lastFrame: 0,
	lag: 0, lastCtx: 0, lastPerf: 0, drift: 1,
	opsT0: performance.now(), opsLast: 0, opsRate: 0,
};

function startMetrics() {
	running = true;
	met.lastFrame = performance.now();
	met.lastCtx = engine.context.currentTime;
	met.lastPerf = met.lastFrame;

	// event-loop lag probe
	setInterval(() => {
		const now = performance.now();
		met.lag = now - met.lagExpected;
		met.lagExpected = now + 50;
	}, 50);
	met.lagExpected = performance.now() + 50;

	const frame = () => {
		if (!running) return;
		const now = performance.now();
		const dt = now - met.lastFrame;
		met.lastFrame = now;
		met.frameSum += dt;
		met.frameCount++;
		if (dt > met.frameMax) met.frameMax = dt;
		if (dt > 50) met.long++;
		met.frames++;
		if (met.frames % 10 === 0) readAudio();
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);

	// 1 Hz UI refresh
	setInterval(() => {
		const now = performance.now();
		met.fps = (met.frames * 1000) / (now - met.fpsT0);
		met.frames = 0; met.fpsT0 = now;
		updateUI();
	}, 1000);
}

function readAudio() {
	if (!analyser) return;
	analyser.getFloatTimeDomainData(td);
	let peak = 0, sum = 0, zeros = 0;
	for (let i = 0; i < td.length; i++) {
		const v = td[i];
		const a = v < 0 ? -v : v;
		if (a > peak) peak = a;
		sum += v * v;
		if (a < 1e-5) zeros++;
		if (a > 0.999) clipCount++;
	}
	met.peak = peak;
	met.rms = Math.sqrt(sum / td.length);
	if (engine.sounds.some((s) => s.sound._playing) && zeros === td.length) dropouts++;
}

function cls(v, good, warn) {
	return v >= good ? 'good' : v >= warn ? 'warn' : 'bad';
}

function updateUI() {
	const now = performance.now();
	// audio clock drift (render capacity): ~1.0 means real-time. Measured over
	// the full 1s window so main-thread jitter averages out.
	if (engine) {
		const dPerf = (now - met.lastPerf) / 1000;
		const dCtx = engine.context.currentTime - met.lastCtx;
		if (dPerf > 0.2) { met.drift = dCtx / dPerf; met.lastCtx = engine.context.currentTime; met.lastPerf = now; }
	}
	const playing = engine ? engine.sounds.filter((s) => s.sound._playing).length : 0;
	const total = engine ? engine.sounds.length : 0;
	$('mFps').textContent = met.fps ? met.fps.toFixed(0) : '–';
	$('mFps').className = 'v ' + cls(met.fps, 55, 30);
	const avg = met.frameSum / Math.max(1, met.frameCount);
	met.avgFrame = avg;
	$('mFrame').textContent = `${avg.toFixed(1)} / ${met.frameMax.toFixed(1)}`;
	met.frameSum = 0; met.frameCount = 0; met.frameMax = 0;
	$('mLong').textContent = met.long;
	$('mLong').className = 'v ' + (met.long > 20 ? 'bad' : met.long > 5 ? 'warn' : 'good');
	$('mDrift').textContent = met.drift ? met.drift.toFixed(3) : '–';
	$('mDrift').className = 'v ' + cls(met.drift, 0.995, 0.97);
	$('mLag').textContent = met.lag.toFixed(1);
	$('mLag').className = 'v ' + (met.lag > 40 ? 'bad' : met.lag > 15 ? 'warn' : 'good');
	$('mVoices').textContent = `${playing} / ${total}`;
	$('mLevel').textContent = `${(met.peak || 0).toFixed(2)} / ${(met.rms || 0).toFixed(3)}`;
	$('mLevel').className = 'v ' + (met.peak > 1.0 ? 'bad' : met.peak > 0.9 ? 'warn' : 'good');
	$('mClips').textContent = clipCount + (dropouts ? ` (${dropouts} gaps)` : '');
	$('mClips').className = 'v ' + (clipCount || dropouts ? 'bad' : 'good');
	clickRate = clickCount - clickPrev;
	clickPrev = clickCount;
	$('mClicks').textContent = clickCount ? `${clickCount} (${clickRate}/s)` : '0';
	$('mClicks').className = 'v ' + (clickRate > 20 ? 'bad' : clickCount > 0 ? 'warn' : 'good');
	$('mDelta').textContent = clickMaxDelta.toFixed(3);
	$('mDelta').className = 'v ' + (clickMaxDelta > 0.5 ? 'bad' : clickMaxDelta > 0.2 ? 'warn' : 'good');
	$('mFx').textContent = effectCount;
	met.opsRate = (ops.params + ops.effects - met.opsLast) * 1000 / (now - met.opsT0);
	met.opsLast = ops.params + ops.effects; met.opsT0 = now;
	$('mOps').textContent = met.opsRate.toFixed(0);
	const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
	$('mHeap').textContent = mem ? mem.toFixed(0) : 'n/a';
	const ctx = engine?.context;
	const lat = ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
	$('mLat').textContent = lat ? (lat * 1000).toFixed(1) : '–';
	$('rampNote').textContent = escalating ? 'ramping…' : $('rampNote').textContent;
}

// ---- ramp test ------------------------------------------------------------
const RAMP_KEY = 'ae-stress-ramp';

function renderRampRows(rows) {
	const tb = $('rampTable').querySelector('tbody');
	tb.innerHTML = rows
		.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>')
		.join('');
}
function saveRamp(rows) {
	try { localStorage.setItem(RAMP_KEY, JSON.stringify(rows)); } catch { /* private mode */ }
}
function restoreRamp() {
	try {
		const rows = JSON.parse(localStorage.getItem(RAMP_KEY) || '[]');
		if (Array.isArray(rows) && rows.length) {
			renderRampRows(rows);
			$('rampNote').textContent = `restored ${rows.length} steps from a previous run`;
		}
	} catch { /* ignore */ }
}

async function rampTest() {
	if (!engine) return;
	stopAllLoad();
	escalating = true;
	const rows = [];
	saveRamp(rows);
	$('rampNote').textContent = 'ramping: +16 voices every 2s';
	log('ramp test started');
	const MAX = Number($('voices').max) || 512;
	for (let target = 16; target <= MAX && escalating; target += 16) {
		await ensureVoices(target);
		playAll();
		await wait(2000);
		const row = [String(target), met.fps.toFixed(0), met.avgFrame.toFixed(1), met.drift.toFixed(3), (met.peak || 0).toFixed(2), met.lag.toFixed(1)];
		rows.push(row);
		renderRampRows(rows);
		saveRamp(rows);
		log(`ramp ${target} voices → fps ${row[1]}, drift ${row[3]}, peak ${row[4]}, lag ${row[5]}ms`);
		if (met.drift < 0.9 || met.fps < 20) {
			$('rampNote').textContent = `breaking point ≈ ${target} voices (drift ${met.drift.toFixed(2)}, fps ${met.fps.toFixed(0)})`;
			log(`breaking point at ~${target} voices`);
			break;
		}
	}
	escalating = false;
}

// ---- soak -----------------------------------------------------------------
async function soak(seconds = 15) {
	if (!engine) return;
	log(`soak started (${seconds}s): voices + automation + effects + recording`);
	await ensureVoices(Math.max(32, Math.min(128, Number($('voices').value) || 32)));
	playAll();
	startAutomation();
	startEffects();
	if (!recording) toggleRecord();
	const t0 = performance.now();
	const ops0 = ops.params + ops.effects;
	const clips0 = clipCount, gaps0 = dropouts, long0 = met.long, clicks0 = clickCount;
	await wait(seconds * 1000);
	const secs = (performance.now() - t0) / 1000;
	const opRate = (ops.params + ops.effects - ops0) / secs;
	log(
		`soak done: ${engine.sounds.length} sounds · ${opRate.toFixed(0)} ops/s · ` +
		`clips +${clipCount - clips0} · clicks +${clickCount - clicks0} (maxΔ ${clickMaxDelta.toFixed(3)}) · ` +
		`gaps +${dropouts - gaps0} · long frames +${met.long - long0} · drift ${met.drift.toFixed(3)}`,
	);
	stopAllLoad();
	stopAll();
}

// ---- wiring ---------------------------------------------------------------
$('start').onclick = () => startAudio().catch((e) => log('start failed: ' + e));
$('spawn').onclick = async () => {
	const n = Number($('voices').value) || 32;
	log(`adding/playing up to ${n} voices`);
	await ensureVoices(n);
	playAll();
};
$('playAll').onclick = () => playAll();
$('stopAll').onclick = () => { stopAllLoad(); stopAll(); log('stopped'); };
$('automate').onclick = () => (timers.has('automate') ? stopAutomation() : startAutomation());
$('effects').onclick = () => (timers.has('effects') ? stopEffects() : startEffects());
$('clickThresh').oninput = applyClickThreshold;
$('record').onclick = () => toggleRecord();
$('ramp').onclick = () => rampTest().catch((e) => log('ramp failed: ' + e));
$('soak').onclick = () => soak().catch((e) => log('soak failed: ' + e));
$('reset').onclick = () => {
	stopAllLoad();
	stopAll();
	if (engine) engine.removeAll();
	effectCount = 0; clipCount = 0; dropouts = 0;
	clickCount = 0; clickMaxDelta = 0; clickPrev = 0;
	ops.params = ops.effects = ops.events = 0;
	$('rampTable').querySelector('tbody').innerHTML = '';
	try { localStorage.removeItem(RAMP_KEY); } catch { /* ignore */ }
	$('log').textContent = '';
	log('reset');
};

window.addEventListener('error', (e) => log('window error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => log('unhandled rejection: ' + (e.reason?.message || e.reason)));
restoreRamp();
log('ready — click “Start audio” (browsers require a user gesture)');
