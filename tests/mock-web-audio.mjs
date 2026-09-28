// Minimal, dependency-free Web Audio mock so the real AudioEngine can be
// driven headlessly in Node. It implements the graph/parameter/event surface
// the engine touches — NOT audio rendering (the DSP harness covers processors).
//
// Deliberately permissive: connect/disconnect never throw, AudioParams accept
// every scheduling call, and AudioWorkletNode params are auto-created on
// demand. The point is to exercise the engine's control flow and lifetime
// bookkeeping under load, not to validate Web Audio semantics.

const NODE_SILENCE = () => {};

class AudioParam {
	constructor(value = 0) {
		this.value = value;
		this.defaultValue = value;
		this.minValue = -3.4028234663852886e38;
		this.maxValue = 3.4028234663852886e38;
		this.automationRate = 'a-rate';
	}
	setValueAtTime(v) {
		this.value = v;
		return this;
	}
	linearRampToValueAtTime(v) {
		this.value = v;
		return this;
	}
	exponentialRampToValueAtTime(v) {
		this.value = v;
		return this;
	}
	setTargetAtTime(v) {
		this.value = v;
		return this;
	}
	setValueCurveAtTime(curve) {
		if (curve && curve.length) this.value = curve[curve.length - 1];
		return this;
	}
	cancelScheduledValues() {
		return this;
	}
	cancelAndHoldAtTime() {
		return this;
	}
}

class AudioNode {
	constructor(context) {
		this.context = context;
		this.numberOfInputs = 1;
		this.numberOfOutputs = 1;
		this.channelCount = 2;
		this.channelCountMode = 'max';
		this.channelInterpretation = 'speakers';
		this._outs = new Set();
	}
	connect(dest) {
		this._outs.add(dest);
		return dest;
	}
	disconnect(dest) {
		if (dest === undefined) this._outs.clear();
		else this._outs.delete(dest);
	}
	/** Test helper: number of live outgoing connections. */
	_connectionCount() {
		return this._outs.size;
	}
}

class GainNode extends AudioNode {
	constructor(context) {
		super(context);
		this.gain = new AudioParam(1);
	}
}

class PannerNode extends AudioNode {
	constructor(context) {
		super(context);
		this.panningModel = 'equalpower';
		this.distanceModel = 'inverse';
		this.refDistance = 1;
		this.maxDistance = 10000;
		this.rolloffFactor = 1;
		this.coneInnerAngle = 360;
		this.coneOuterAngle = 360;
		this.coneOuterGain = 0;
		this.positionX = new AudioParam(0);
		this.positionY = new AudioParam(0);
		this.positionZ = new AudioParam(0);
		this.orientationX = new AudioParam(1);
		this.orientationY = new AudioParam(0);
		this.orientationZ = new AudioParam(0);
		this._listeners = new Map();
	}
	setPosition(x, y, z) {
		this.positionX.value = x;
		this.positionY.value = y;
		this.positionZ.value = z;
	}
	setOrientation(x, y, z) {
		this.orientationX.value = x;
		this.orientationY.value = y;
		this.orientationZ.value = z;
	}
	addEventListener(t, cb) {
		if (!this._listeners.has(t)) this._listeners.set(t, new Set());
		this._listeners.get(t).add(cb);
	}
	removeEventListener(t, cb) {
		this._listeners.get(t)?.delete(cb);
	}
}

class AudioBufferSourceNode extends AudioNode {
	constructor(context) {
		super(context);
		this.buffer = null;
		this.loop = false;
		this.loopStart = 0;
		this.loopEnd = 0;
		this.playbackRate = new AudioParam(1);
		this.detune = new AudioParam(0);
		this.onended = null;
		this._listeners = new Map();
		this._stopped = false;
		this._started = false;
	}
	start() {
		this._started = true;
	}
	stop() {
		if (this._stopped) return;
		this._stopped = true;
		// real sources fire 'ended' asynchronously, after the current task — this
		// matters because play() swaps the source and must not be re-entered
		queueMicrotask(() => this._dispatchEnded());
	}
	_dispatchEnded() {
		const ev = { type: 'ended', target: this };
		if (typeof this.onended === 'function') this.onended(ev);
		const set = this._listeners.get('ended');
		if (set) for (const cb of [...set]) cb(ev);
	}
	addEventListener(t, cb) {
		if (!this._listeners.has(t)) this._listeners.set(t, new Set());
		this._listeners.get(t).add(cb);
	}
	removeEventListener(t, cb) {
		this._listeners.get(t)?.delete(cb);
	}
}

class AnalyserNode extends AudioNode {
	constructor(context) {
		super(context);
		this._fftSize = 2048;
		this.minDecibels = -100;
		this.maxDecibels = -30;
		this.smoothingTimeConstant = 0.8;
	}
	get fftSize() {
		return this._fftSize;
	}
	set fftSize(v) {
		this._fftSize = v;
	}
	get frequencyBinCount() {
		return this._fftSize / 2;
	}
	getByteTimeDomainData(arr) {
		arr.fill(128);
	}
	getByteFrequencyData(arr) {
		arr.fill(0);
	}
	getFloatTimeDomainData(arr) {
		arr.fill(0);
	}
	getFloatFrequencyData(arr) {
		arr.fill(-Infinity);
	}
}

class AudioBuffer {
	constructor({ numberOfChannels = 1, length = 1, sampleRate = 44100 } = {}) {
		this.numberOfChannels = numberOfChannels;
		this.length = length;
		this.sampleRate = sampleRate;
		this.duration = length / sampleRate;
		this._ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
	}
	getChannelData(c) {
		return this._ch[c];
	}
	copyToChannel(src, c, offset = 0) {
		this._ch[c].set(src, offset);
	}
	copyFromChannel(dst, c, offset = 0) {
		dst.set(this._ch[c].subarray(offset, offset + dst.length));
	}
}

class AudioParamMap {
	constructor() {
		this._store = new Map();
	}
	/** Auto-create on demand so any effect param setter works without knowing descriptors. */
	get(name) {
		if (!this._store.has(name)) this._store.set(name, new AudioParam(0));
		return this._store.get(name);
	}
	set(name, param) {
		this._store.set(name, param);
	}
	has(name) {
		return this._store.has(name);
	}
	keys() {
		return this._store.keys();
	}
	[Symbol.iterator]() {
		return this._store[Symbol.iterator]();
	}
}

class AudioWorkletNode extends AudioNode {
	constructor(context, name, options = {}) {
		super(context);
		this.name = name;
		this.parameters = new AudioParamMap();
		for (const [k, v] of Object.entries(options.parameterData || {})) {
			this.parameters.set(k, new AudioParam(v));
		}
		this.numberOfInputs = options.numberOfInputs ?? 1;
		this.numberOfOutputs = options.numberOfOutputs ?? 1;
		this.port = { onmessage: null, onmessageerror: null, postMessage: NODE_SILENCE, start: NODE_SILENCE, close: NODE_SILENCE };
	}
}

class AudioContext {
	constructor(options = {}) {
		this.sampleRate = options.sampleRate || 48000;
		this.state = 'running';
		this.destination = new AudioNode(this);
		this.destination.numberOfInputs = 0;
		this.listener = {
			positionX: new AudioParam(0),
			positionY: new AudioParam(0),
			positionZ: new AudioParam(0),
			forwardX: new AudioParam(0),
			forwardY: new AudioParam(0),
			forwardZ: new AudioParam(-1),
			upX: new AudioParam(0),
			upY: new AudioParam(1),
			upZ: new AudioParam(0),
		};
		this._clock = 0;
		this.audioWorklet = { addModule: () => Promise.resolve() };
	}
	get currentTime() {
		return this._clock;
	}
	/** Test helper: advance the audio clock (seconds). */
	advance(sec) {
		this._clock += sec;
	}
	createGain() {
		return new GainNode(this);
	}
	createPanner() {
		return new PannerNode(this);
	}
	createBufferSource() {
		return new AudioBufferSourceNode(this);
	}
	createAnalyser() {
		return new AnalyserNode(this);
	}
	createChannelSplitter() {
		return new AudioNode(this);
	}
	createChannelMerger() {
		return new AudioNode(this);
	}
	createMediaStreamDestination() {
		const node = new AudioNode(this);
		node.stream = { getAudioTracks: () => [], getTracks: () => [] };
		return node;
	}
	createMediaStreamSource() {
		return new AudioNode(this);
	}
	createBuffer(numberOfChannels, length, sampleRate) {
		return new AudioBuffer({ numberOfChannels, length, sampleRate });
	}
	decodeAudioData(arrayBuffer, onSuccess, onError) {
		const frames = Math.max(1, Math.floor((arrayBuffer?.byteLength || 8) / 2));
		const buffer = new AudioBuffer({ numberOfChannels: 1, length: frames, sampleRate: this.sampleRate });
		// seed a waveform so reverse/normalize/peaks have something to chew on
		const data = buffer.getChannelData(0);
		for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 16) * 0.5;
		queueMicrotask(() => {
			try {
				if (onSuccess) onSuccess(buffer);
			} catch (err) {
				if (onError) onError(err);
			}
		});
		return Promise.resolve(buffer);
	}
	resume() {
		this.state = 'running';
		return Promise.resolve();
	}
	suspend() {
		this.state = 'suspended';
		return Promise.resolve();
	}
	close() {
		this.state = 'closed';
		return Promise.resolve();
	}
}

// ---- fake workers / XHR / fetch -----------------------------------------

class FakeWorker {
	constructor() {
		this._listeners = new Map();
		this.posted = [];
	}
	addEventListener(t, cb) {
		if (!this._listeners.has(t)) this._listeners.set(t, new Set());
		this._listeners.get(t).add(cb);
	}
	removeEventListener(t, cb) {
		this._listeners.get(t)?.delete(cb);
	}
	postMessage(msg) {
		this.posted.push(msg);
	}
	terminate() {}
}

class FakeXMLHttpRequest {
	constructor() {
		this.status = 200;
		this.response = null;
		this.responseType = '';
		this.withCredentials = false;
		this._listeners = new Map();
	}
	open() {}
	setRequestHeader() {}
	addEventListener(t, cb) {
		if (!this._listeners.has(t)) this._listeners.set(t, new Set());
		this._listeners.get(t).add(cb);
	}
	send() {
		// 512 frames of fake PCM; Sound.decodeAudioData copies + decodes it
		this.response = new ArrayBuffer(1024);
		queueMicrotask(() => {
			const set = this._listeners.get('load');
			if (set) for (const cb of [...set]) cb({ target: this });
		});
	}
	_emitError(err) {
		const set = this._listeners.get('error');
		if (set) for (const cb of [...set]) cb(err);
	}
}

const fakeFetch = async () => ({
	ok: true,
	status: 200,
	arrayBuffer: async () => new ArrayBuffer(64),
	blob: async () => new Blob([new Uint8Array(64)]),
	json: async () => ({}),
	text: async () => '',
});

// ---- requestAnimationFrame queue (deterministic) -------------------------

const rafQueue = [];
const fakeRAF = (cb) => {
	rafQueue.push(cb);
	return rafQueue.length;
};
const fakeCAF = () => {};

/** Run `n` animation frames, resolving microtasks between them. */
export async function tickFrames(n = 1) {
	for (let i = 0; i < n; i++) {
		const due = rafQueue.splice(0, rafQueue.length);
		for (const cb of due) cb(performance.now());
		await new Promise((r) => setTimeout(r, 0));
	}
}

/** Let pending microtasks / short timers flush. */
export function tick(ms = 0) {
	return new Promise((r) => setTimeout(r, ms));
}

let installed = false;

/** Install every mock global the engine needs. Idempotent. */
export function installMockWebAudio() {
	if (installed) return;
	installed = true;

	globalThis.AudioContext = AudioContext;
	globalThis.AudioBuffer = AudioBuffer;
	globalThis.AudioWorkletNode = AudioWorkletNode;
	if (typeof globalThis.AudioWorkletProcessor === 'undefined')
		globalThis.AudioWorkletProcessor = class {};
	if (typeof globalThis.registerProcessor === 'undefined')
		globalThis.registerProcessor = NODE_SILENCE;
	globalThis.Worker = FakeWorker;
	globalThis.XMLHttpRequest = FakeXMLHttpRequest;
	globalThis.fetch = fakeFetch;
	globalThis.requestAnimationFrame = fakeRAF;
	globalThis.cancelAnimationFrame = fakeCAF;
	if (typeof globalThis.navigator === 'undefined')
		Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

	// Blob + object URLs (worklet module delivery, model export)
	if (typeof globalThis.Blob === 'undefined')
		globalThis.Blob = class Blob {
			constructor(parts = []) {
				this.size = parts.reduce((n, p) => n + (p?.length ?? p?.byteLength ?? 0), 0);
			}
			arrayBuffer() {
				return Promise.resolve(new ArrayBuffer(this.size));
			}
		};
	try {
		globalThis.URL.createObjectURL = () => 'blob:mock';
		globalThis.URL.revokeObjectURL = NODE_SILENCE;
	} catch {
		// URL may be non-writable; ignore
	}

	// localStorage is optional in this harness — leave it undefined (the engine
	// guards with `typeof localStorage !== 'undefined'`).
}

export { AudioContext, AudioBuffer, AudioWorkletNode };
