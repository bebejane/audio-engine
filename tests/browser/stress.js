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
	'korg35filter', 'tapedelay', 'tapesaturation',
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

/**
 * A *steady* sine (no amplitude envelope) at 60% full scale — the pitch-quality
 * probe needs a stationary fundamental to analyse, unlike the load-generator
 * signal above.
 */
function toneBuffer(seconds, sampleRate, freq, amp = 0.6) {
	const n = Math.floor(seconds * sampleRate);
	const bytes = 44 + n * 2;
	const dv = new DataView(new ArrayBuffer(bytes));
	const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
	str(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); str(8, 'WAVE');
	str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
	dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
	str(36, 'data'); dv.setUint32(40, n * 2, true);
	for (let i = 0; i < n; i++) {
		dv.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp * 32767, true);
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
// timers that outlive `running` (the lag probe, the 1 Hz UI refresh, the rAF
// loop). Kept so killAll() can actually stop them — previously they ticked
// forever after a stop.
const metricsTimers = [];
let metricsRaf = 0;
// set when killAll() runs so nothing can restart load afterwards
let killed = false;
// ?agent=1 => an agent-driven run: hard-stop on background so it cannot linger
const AGENT = new URLSearchParams(location.search).get('agent') === '1';

async function startAudio() {
	if (engine || killed) return;
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
		/** Simulate a slider drag on `rate` at a given call frequency (ms). */
		rateSweep: (ids, every = 8) => {
			const list = ids && ids.length ? ids : engine.sounds.map((s) => s.id);
			let t = 0;
			return setInterval(() => {
				t += every / 1000;
				const v = 0.5 + 1.5 * (0.5 + 0.5 * Math.sin(t * 2));
				for (const id of list) if (engine.exist(id)) engine.rate(id, v);
			}, every);
		},
		/** Pitch-shift audio quality at the default vs a given block size. */
		pitchProbe,
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
	for (const id of ['spawn', 'playAll', 'automate', 'effects', 'record', 'ramp', 'soak', 'reset', 'kill']) $(id).disabled = false;
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

// ---- pitch quality probe --------------------------------------------------
// Latency of the Signalsmith Stretch node is exactly its `blockMs`, and the
// engine currently leaves that at the default (120 ms). Smaller blocks are a
// straight latency win, but the STFT needs enough context — this measures what
// the trade actually costs in audio quality, live, on the real worklet.
//
// Method: play a steady 220 Hz tone through the shifter at +12 semitones and
// analyse the master output.
//   * targetDoubling — energy at 440 Hz (the shift we asked for). Should be
//     strong if the shift is working.
//   * residualFundamental — energy left at 220 Hz (unshifted). Should be low.
//   * spectralSpread — energy at 340/560 Hz (non-harmonic sidebands). A clean
//     shift puts little there; smearing from too small a block raises it.
//   * warbling — variation of short-window RMS over the capture. A correct
//     steady shift holds level; an artefacting one pumps.

/** Single-bin DFT magnitude at `freq` over `len` samples from `from`. */
function binMag(x, freq, from, len, sr) {
	let re = 0, im = 0;
	for (let i = 0; i < len; i++) {
		const v = x[from + i] || 0;
		const ph = (2 * Math.PI * freq * i) / sr;
		re += v * Math.cos(ph);
		im -= v * Math.sin(ph);
	}
	return Math.sqrt(re * re + im * im) / len;
}

/**
 * Measure a steady tone's spectrum. `samples` is the raw master capture (mono).
 *
 * Everything is computed on a *windowed tail* of the capture: the first part is
 * polluted by the shifter priming for its latency and the last by the capture
 * teardown, so only the settled middle is analysed.
 *
 * All magnitudes are normalised so a full-scale sine reads ~1.0, which makes the
 * numbers comparable across runs and configs.
 */
function analyseTone(samples, sr, fundamental = 220, semitones = 12) {
	const target = fundamental * Math.pow(2, semitones / 12);
	// use the settled middle: skip the first 0.5s and the last 0.25s
	const skip = Math.floor(sr * 0.5);
	const end = Math.max(skip, samples.length - Math.floor(sr * 0.25));
	const len = Math.min(end - skip, 32768);
	if (len < 4096) return { error: 'capture too short', len: samples.length };

	// Hann window applied to the raw signal
	const w = new Float32Array(len);
	for (let i = 0; i < len; i++) {
		const s = samples[skip + i] || 0;
		w[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
	}
	// coherent gain of a Hann window is 0.5; normalise the DFT by that so a
	// full-scale sine gives magnitude ~1
	const norm = 2 / len / 0.5;
	const mag = (f) => {
		let re = 0, im = 0;
		for (let i = 0; i < len; i++) {
			const ph = (2 * Math.PI * f * i) / sr;
			re += w[i] * Math.cos(ph);
			im -= w[i] * Math.sin(ph);
		}
		return (2 * Math.sqrt(re * re + im * im) * norm) / 2;
	};

	const targetDoubling = mag(target);
	const residualFundamental = mag(fundamental);
	// non-harmonic sidebands of both the input and target => smearing
	const spread = (mag(340) + mag(560) + mag(660)) / 3;

	// level stability, measured on short windows of the *unwindowed* tail:
	// pumping/incomplete STFT windows show up as RMS variation
	let minR = Infinity, maxR = 0, sumR = 0, nW = 0;
	const win = 2048;
	for (let s = 0; s + win <= len; s += win) {
		let sum = 0;
		for (let i = 0; i < win; i++) { const v = samples[skip + s + i] || 0; sum += v * v; }
		const r = Math.sqrt(sum / win);
		if (r < minR) minR = r;
		if (r > maxR) maxR = r;
		sumR += r; nW++;
	}
	const meanR = nW ? sumR / nW : 0;
	const warbling = meanR > 1e-6 ? (maxR - minR) / (2 * meanR) : 0;

	// signal-to-junk ratio: how far above the sideband noise the wanted shift is
	const snr = spread > 1e-9 ? targetDoubling / spread : Infinity;

	return { targetDoubling, residualFundamental, spread, warbling, snr };
}

/** Peak absolute sample in a buffer. */
function peakOf(x) {
	let peak = 0;
	for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
	return peak;
}

/** Capture ~`seconds` of the master output as a Float32Array (mono sum). */
async function captureMaster(seconds) {
	const sr = engine.context.sampleRate;
	const n = Math.floor(seconds * sr);
	const proc = engine.context.createScriptProcessor(4096, 2, 2);
	const chunks = [];
	let got = 0;
	proc.onaudioprocess = (e) => {
		if (got >= n) return;
		const l = e.inputBuffer.getChannelData(0);
		const r = e.inputBuffer.getChannelData(1);
		const out = new Float32Array(l.length);
		for (let i = 0; i < out.length; i++) out[i] = (l[i] + r[i]) * 0.5;
		chunks.push(out);
		got += out.length;
		// passthrough (so the graph keeps pulling) at zero to stay silent
		e.outputBuffer.getChannelData(0).fill(0);
		e.outputBuffer.getChannelData(1).fill(0);
	};
	engine.masterGain.connect(proc);
	proc.connect(engine.context.destination);
	await wait(seconds * 1000 + 250);
	engine.masterGain.disconnect(proc);
	proc.disconnect();
	const total = chunks.reduce((a, c) => a + c.length, 0);
	const out = new Float32Array(total);
	let o = 0;
	for (const c of chunks) { out.set(c, o); o += c.length; }
	return out;
}

/**
 * Probe one block size. Reuses a single long-lived sound so the async shifter
 * build isn't restarted per trial, and waits for `_pitchNode` to actually exist
 * rather than guessing with a fixed sleep.
 *
 * @param blockMs - `null` for the engine default, else a block size in ms
 */
async function pitchProbe(blockMs) {
	// one reusable sound, so the lazy shifter is built once across all trials
	const id = 'probe';
	if (!engine.exist(id)) {
		engine.add(id, null, 'probe-tone.wav');
		engine.soundMap[id].sound.decodeAudioData(toneBuffer(4, 44100, 220));
		await waitFor(() => engine.ready() > 0);
	}
	const snd = engine.soundMap[id].sound;

	const diag = {
		hasScriptProcessor: typeof engine.context.createScriptProcessor === 'function',
		loaded: !!snd._loaded,
		duration: typeof snd.duration === 'function' ? snd.duration() : null,
	};
	if (!diag.hasScriptProcessor) return { error: 'createScriptProcessor unavailable', diag };
	if (!diag.loaded) return { error: 'tone buffer did not decode', diag };

	// start playing (dry), then engage pitch and WAIT for the node to exist
	engine.loop(id, true);
	engine.play(id);
	engine.pitch(id, 12);

	const built = await waitFor(() => !!snd._pitchNode || snd._pitchNodeFailed, 4000);
	diag.pitchNodeBuilt = built;
	diag._pitchNodeFailed = snd._pitchNodeFailed;
	diag.pitchNode = !!snd._pitchNode;
	diag.pitchLatency = snd._pitchLatency;
	diag.pitchEngaged = snd._pitchEngaged;
	if (!built) return { error: 'shifter node never built', diag };

	// reconfigure the block size on the live node (public API: configure())
	const node = snd._stretch;
	diag.canConfigure = !!(node && node.configure);
	if (blockMs && node && node.configure) {
		try {
			await node.configure({ blockMs });
			diag.configured = blockMs;
			diag.latencyAfter = await node.latency();
		} catch (e) {
			diag.configError = String(e);
		}
	} else if (node && node.latency) {
		diag.latencyAfter = await node.latency();
	}

	// let the shifter prime for its latency, then settle
	await wait((diag.latencyAfter ? diag.latencyAfter * 1000 : 700) + 400);

	// DRY control: same sound, pitch flat, so the analysis can be validated
	// against a known-clean signal before trusting the shifted numbers
	engine.pitch(id, 0);
	await wait(300);
	const dry = await captureMaster(1.5);
	diag.dryPeak = peakOf(dry);

	// WET: the shift under test
	engine.pitch(id, 12);
	await wait(400);
	const samples = await captureMaster(1.5);
	diag.samples = samples.length;
	diag.capturedPeak = peakOf(samples);

	// leave it stopped but keep the sound (and its shifter) for the next trial
	engine.stop(id);
	engine.pitch(id, 0);

	const result = analyseTone(samples, engine.context.sampleRate, 220, 12);
	result.dry = analyseTone(dry, engine.context.sampleRate, 220, 0);
	result.diag = diag;
	return result;
}

/** Remove the probe sound once all trials are done. */
function pitchProbeCleanup() {
	if (engine.exist('probe')) engine.remove('probe');
}

// ---- load generators ------------------------------------------------------
function startAutomation() {
	if (killed || timers.has('automate')) return;
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
	if (killed || timers.has('effects')) return;
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

/**
 * Full stop: kill every load generator, stop playback, tear the engine down and
 * halt the metrics loop. Idempotent, and latches `killed` so nothing can restart
 * load afterwards. Bound to the Kill button, `pagehide`, auto-background (agent
 * runs only) and Escape — so an abandoned tab cannot keep an audio context
 * running.
 */
function killAll() {
	killed = true;
	stopAllLoad();
	try { stopAll(); } catch { /* engine already gone */ }
	if (engine) {
		try { engine.destroy(true); } catch { /* ignore */ }
	}
	stopMetrics();
	updatePill();
	$('kill').disabled = true;
	for (const id of ['spawn', 'playAll', 'automate', 'effects', 'record', 'ramp', 'soak', 'stopAll'])
		$(id).disabled = true;
	log('KILLED — engine destroyed, all timers cleared');
}

/**
 * Auto-stop hooks. `?agent=1` opts into killing on background — an agent-driven
 * run must not linger, but a manual run should survive a tab switch (reading the
 * docs mid-soak would otherwise come back to a dead page).
 */
function installAutoKill() {
	window.addEventListener('pagehide', () => { stopAllLoad(); stopMetrics(); });
	if (AGENT) {
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) killAll();
		});
	}
	window.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') killAll();
	});
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
	metricsTimers.push(setInterval(() => {
		const now = performance.now();
		met.lag = now - met.lagExpected;
		met.lagExpected = now + 50;
	}, 50));
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
		metricsRaf = requestAnimationFrame(frame);
	};
	metricsRaf = requestAnimationFrame(frame);

	// 1 Hz UI refresh
	metricsTimers.push(setInterval(() => {
		const now = performance.now();
		met.fps = (met.frames * 1000) / (now - met.fpsT0);
		met.frames = 0; met.fpsT0 = now;
		updateUI();
	}, 1000));
}

/** Stop the metrics loop and clear its timers (idempotent). */
function stopMetrics() {
	running = false;
	if (metricsRaf) {
		cancelAnimationFrame(metricsRaf);
		metricsRaf = 0;
	}
	for (const t of metricsTimers) clearInterval(t);
	metricsTimers.length = 0;
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
	// hard deadline: never let a ramp run forever (each step is 2s, +16 voices)
	const deadline = performance.now() + 120000;
	for (let target = 16; target <= MAX && escalating; target += 16) {
		if (performance.now() > deadline) {
			$('rampNote').textContent = 'ramp stopped at deadline (120s)';
			log('ramp stopped: 120s deadline');
			break;
		}
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
	if (!engine || killed) return;
	// hard cap: a soak can never outlive its window
	seconds = Math.min(seconds, 120);
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
$('kill').onclick = () => killAll();
$('automate').onclick = () => (timers.has('automate') ? stopAutomation() : startAutomation());
$('effects').onclick = () => (timers.has('effects') ? stopEffects() : startEffects());
$('clickThresh').oninput = applyClickThreshold;
$('record').onclick = () => toggleRecord();
$('ramp').onclick = () => rampTest().catch((e) => log('ramp failed: ' + e));
$('soak').onclick = () => soak().catch((e) => log('soak failed: ' + e));
// Pitch-quality probe: opt-in via ?pitchprobe=1 so it never shadows the real
// ramp test. Measures shift quality/latency at a few block sizes on the live
// worklet — see pitchProbe().
if (new URLSearchParams(location.search).get('pitchprobe') === '1') {
	const btn = document.createElement('button');
	btn.textContent = 'Pitch latency probe';
	btn.id = 'pitchProbe';
	btn.disabled = true;
	btn.onclick = async () => { await runPitchProbeChain(); };
	$('ramp').after(btn);
	// enable it alongside the other controls
	const origStart = $('start').onclick;
	$('start').onclick = (e) => {
		const r = origStart(e);
		setTimeout(() => (btn.disabled = !engine), 300);
		return r;
	};
}

/** Run the probe across the engine default and two reference block sizes. */
async function runPitchProbeChain() {
	if (!engine) return;
	const show = (label, r) => {
		if (r.error) { log(`${label}: ERROR ${r.error} · ${JSON.stringify(r.diag)}`); return; }
		log(
			`${label}: WET +12 target=${r.targetDoubling.toFixed(3)} resid=${r.residualFundamental.toFixed(3)} ` +
				`spread=${r.spread.toFixed(4)} snr=${r.snr === Infinity ? 'inf' : r.snr.toFixed(1)} ` +
				`warble=${(r.warbling * 100).toFixed(1)}%`,
		);
		if (r.dry) {
			log(
				`   DRY control: fund=${r.dry.targetDoubling.toFixed(3)} ` +
					`resid=${r.dry.residualFundamental.toFixed(3)} spread=${r.dry.spread.toFixed(4)} ` +
					`warble=${(r.dry.warbling * 100).toFixed(1)}%`,
			);
		}
		log(`   diag ${JSON.stringify(r.diag)}`);
	};
	show('engine default', await pitchProbe(null));
	for (const b of [80, 20]) show(`blockMs=${b}`, await pitchProbe(b));
	pitchProbeCleanup();
	log('pitch probe done');
}

$('reset').onclick = () => {
	if (killed) killed = false; // reset re-arms a killed page
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
installAutoKill();
restoreRamp();
log('ready — click “Start audio” (browsers require a user gesture)');
if (AGENT) {
	document.title = 'agent · ' + document.title;
	log('agent mode: will kill on background (Kill button or Esc to stop now)');
}
