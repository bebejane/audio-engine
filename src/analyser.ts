import { EventEmitter } from 'events';

/** Minimal slice of the public AudioWorklet/analyser options we consume. */
export interface AnalyserOptions {
	fftSize: number;
	minDecibels: number;
	maxDecibels: number;
	smoothingTimeConstant: number;
	bits: number;
	interval: number;
	lowcut?: number;
	hicut?: number;
	tweenIn?: number;
	tweenOut?: number;
}

/** Data emitted to a subscriber: a level, or a spectrum/time-domain buffer. */
export type AnalyserData = number | Float32Array | Uint8Array;

export type AnalyserCallback = (data: AnalyserData, options: AnalyserOptions) => void;

/** One analyser per (sound, type), kept across mounts. */
export interface AnalyserListener {
	type: string;
	analyser: AnalyserNode;
	options: AnalyserOptions;
	analysing: boolean;
	connected: boolean;
	idle: boolean;
	idleAt: number;
	paused: boolean;
	last: number;
	lastValue: number;
	level: number;
	callbacks: AnalyserCallback[];
	tick: (() => void) | null;
	dataArray: Float32Array | Uint8Array | null;
}

const defaults: AnalyserOptions = {
	fftSize: 32,
	minDecibels: -60,
	maxDecibels: 0,
	smoothingTimeConstant: 0.9,
	bits: 8,
	interval: 0,
	lowcut: undefined,
	hicut: undefined,
};
// `interval` is the minimum ms between reads. volume wants every frame (0);
// FFT/time-domain only need ~30Hz, which is plenty for a meter/gradient and
// cuts the analysis work by ~3x.
const typeDefaults: Record<string, AnalyserOptions> = {
	volume: {
		...defaults,
		fftSize: 32,
		interval: 0,
		tweenIn: 1.618,
		tweenOut: 1.618 * 3,
	},
	timedomain: {
		...defaults,
		fftSize: 1024,
		interval: 30,
	},
	frequency: {
		...defaults,
		fftSize: 2048,
		interval: 30,
	},
};

// A sound that isn't playing only needs its visuals to settle. Meters keep
// ticking until their level has actually reached silence (so an effect tail —
// delay/reverb — stays visible after the source stops); other visuals settle on
// this grace alone.
const IDLE_GRACE = 500;

// ---- one shared rAF pump for every listener ------------------------------
// Previously each listener owned a setInterval that scheduled its own rAF, so
// N visuals produced N separate callbacks (often several per frame for the same
// analyser). A single loop now reads each listener at most once per frame and
// only when its own interval is due, and it shuts down when nothing is active.
const active = new Set<AnalyserListener>();
let pumping = false;

function unschedule(listener: AnalyserListener): void {
	active.delete(listener);
}

function schedule(listener: AnalyserListener): void {
	listener.last = 0;
	active.add(listener);
	if (!pumping) {
		pumping = true;
		requestAnimationFrame(pump);
	}
}

function pump(): void {
	const now = performance.now();
	try {
		active.forEach((listener) => {
			if (listener.idle && now - listener.idleAt > IDLE_GRACE) {
				// A meter keeps running while its level is still above silence so
				// an effect tail stays visible; everything else settles on the
				// grace alone. Then drop it from the loop until reactivated.
				const settled = listener.type === 'volume' ? listener.level < 0.5 : true;
				if (settled) {
					unschedule(listener);
					listener.paused = true;
					return;
				}
			}
			if (now - listener.last < listener.options.interval) return;
			listener.last = now;
			if (listener.tick) listener.tick();
		});
	} finally {
		if (active.size) requestAnimationFrame(pump);
		else pumping = false;
	}
}

// One silent gain, shared by every analyser, keeps their output part of the
// rendering graph (so they update in every browser) without a
// MediaStreamDestination + gain node per listener.
const sinks = new WeakMap<AudioContext, GainNode>();
function sinkFor(context: AudioContext): GainNode {
	let sink = sinks.get(context);
	if (!sink) {
		sink = context.createGain();
		sink.gain.value = 0;
		sink.connect(context.destination);
		sinks.set(context, sink);
	}
	return sink;
}

class Analyser extends EventEmitter {
	id: string | number;
	context: AudioContext;
	node: AudioNode;
	sampleRate: number;
	options: Partial<AnalyserOptions>;
	idle: boolean;
	_activeSet: boolean;
	_listeners: Record<string, AnalyserListener>;

	constructor(
		id: string | number,
		context: AudioContext,
		node: AudioNode,
		opt: Partial<AnalyserOptions> = {},
	) {
		super();
		this.id = id;
		this.context = context;
		this.node = node;
		this.sampleRate = context.sampleRate;
		// caller-provided options only — seeding the global defaults here used
		// to leak the default interval (10ms) into _setup and silently override
		// each type's own interval, so frequency ran at 100Hz instead of 30Hz
		this.options = { ...opt };
		const opts = this.options as Record<string, unknown>;
		Object.keys(opts).forEach((k) => ((this as any)['_' + k] = opts[k]));
		this._listeners = {};
		this.idle = false;
	}
	addEventListener(
		type: string,
		opt?: AnalyserOptions | AnalyserCallback,
		cb?: AnalyserCallback,
	): void {
		const callback = typeof opt === 'function' ? opt : cb;
		const options =
			typeof opt === 'function' ? { ...this.options } : { ...this.options, ...opt };
		const listener = this._setup(type, options, callback);
		this._connect(listener);
		this._analyse(listener);
	}
	removeEventListener(type: string, cb?: AnalyserCallback): void {
		const listener = this._listeners[type];
		if (!listener) return;
		// notify only the leaving callback; other subscribers must keep running
		this._end(listener, cb);
		listener.callbacks = listener.callbacks.filter((c) => c !== cb);
		if (!listener.callbacks.length) {
			this._stopAnalyse(listener);
			this._disconnect(listener);
		}
	}
	// NB: returning `this` keeps these assignable to EventEmitter.on/off (the
	// engine's analyser also supports the (type, listener) EventEmitter shape)
	on(type: string, opt?: AnalyserOptions | AnalyserCallback, cb?: AnalyserCallback): this {
		this.addEventListener(type, opt, cb);
		return this;
	}
	off(type: string, cb?: AnalyserCallback): this {
		this.removeEventListener(type, cb);
		return this;
	}
	/** True while any subscriber is still attached (used to refcount reuse). */
	hasListeners(): boolean {
		return Object.keys(this._listeners).some((t) => this._listeners[t].callbacks.length > 0);
	}
	/** Idle analysers stop reading until the sound plays again (see pump). */
	setActive(on: boolean): void {
		const next = !!on;
		if (this._activeSet === next) return;
		this._activeSet = next;
		this.idle = !next;
		const now = performance.now();
		Object.keys(this._listeners).forEach((type) => {
			const listener = this._listeners[type];
			listener.idle = !next;
			listener.idleAt = now;
			if (next && listener.paused && listener.analysing) {
				listener.paused = false;
				schedule(listener);
			}
		});
	}
	setNode(node: AudioNode): void {
		if (node === this.node) return;
		Object.keys(this._listeners).forEach((type) => {
			const listener = this._listeners[type];
			this._disconnect(listener);
		});
		this.node = node;
		Object.keys(this._listeners).forEach((type) => {
			const listener = this._listeners[type];
			this._connect(listener);
			if (listener.analysing) schedule(listener);
		});
	}
	setOptions(type: string, opt: Partial<AnalyserOptions>): void {
		const listener = this._listeners[type];
		if (!listener) return;

		listener.options = { ...listener.options, ...opt };
		listener.analyser.fftSize = listener.options.fftSize;
		listener.analyser.minDecibels = listener.options.minDecibels;
		listener.analyser.maxDecibels = listener.options.maxDecibels;
		listener.analyser.smoothingTimeConstant = listener.options.smoothingTimeConstant;
		if (listener.analysing) this._restartAnalyse(listener);
	}
	pause(): void {
		Object.keys(this._listeners).forEach((type) => {
			const listener = this._listeners[type];
			this._end(listener);
			this._stopAnalyse(listener);
		});
	}
	unpause(): void {
		Object.keys(this._listeners).forEach((type) => this._restartAnalyse(this._listeners[type]));
	}
	close(type: string, cb?: AnalyserCallback): void {
		this._disconnect(this._listeners[type], cb);
	}
	destroy(): void {
		Object.keys(this._listeners).forEach((type) => {
			const listener = this._listeners[type];
			this._end(listener);
			this._stopAnalyse(listener);
			this._disconnect(listener);
		});
	}
	_connect(listener: AnalyserListener): void {
		if (listener.connected) return;
		this.node.connect(listener.analyser);
		listener.analyser.connect(sinkFor(this.context));
		listener.connected = true;
	}
	_disconnect(listener?: AnalyserListener, cb?: AnalyserCallback): void {
		if (!listener || !listener.connected) return;
		this._end(listener, cb);
		try {
			this.node.disconnect(listener.analyser);
		} catch (e) {}
		try {
			listener.analyser.disconnect();
		} catch (e) {}
		listener.connected = false;
	}
	_setup(
		type: string,
		opt: Partial<AnalyserOptions> = {},
		cb?: AnalyserCallback,
	): AnalyserListener {
		const options: AnalyserOptions = { ...(typeDefaults[type] || defaults), ...opt };
		if (!this._listeners[type]) {
			this._listeners[type] = {
				type,
				analyser: this.context.createAnalyser(),
				options,
				analysing: false,
				connected: false,
				idle: this.idle,
				idleAt: 0,
				paused: false,
				last: 0,
				lastValue: 0,
				level: 0,
				callbacks: [],
				tick: null,
				dataArray: null,
			};
		}
		const listener = this._listeners[type];
		this.setOptions(type, options);

		if (cb) listener.callbacks.push(cb);
		return listener;
	}
	_end(listener: AnalyserListener, cb?: AnalyserCallback): void {
		const end: AnalyserData =
			listener.type === 'volume'
				? 0
				: listener.options.bits === 32
					? new Float32Array(listener.analyser.frequencyBinCount)
					: new Uint8Array(listener.analyser.frequencyBinCount);
		if (this.listenerCount(listener.type))
			this.emit(listener.type, end, { ...listener.options, ended: true });
		if (cb) cb(end, listener.options);
		else listener.callbacks.forEach((c) => c(end, listener.options));
	}
	_analyse(listener: AnalyserListener): void {
		if (listener.analysing) return;

		const { options, analyser, type } = listener;
		const length = type === 'volume' ? options.fftSize : analyser.frequencyBinCount;
		listener.dataArray = options.bits === 32 ? new Float32Array(length) : new Uint8Array(length);
		listener.analysing = true;
		listener.paused = false;
		listener.idle = this.idle;
		listener.idleAt = performance.now();
		listener.tick = () => this._read(listener);
		schedule(listener);
	}
	_read(listener: AnalyserListener): void {
		const { options, analyser, type } = listener;
		const dataArray = listener.dataArray as Float32Array | Uint8Array;

		if (type === 'frequency')
			options.bits === 32
				? analyser.getFloatFrequencyData(dataArray as never)
				: analyser.getByteFrequencyData(dataArray as never);
		else if (type === 'timedomain' || type === 'volume')
			options.bits === 32
				? analyser.getFloatTimeDomainData(dataArray as never)
				: analyser.getByteTimeDomainData(dataArray as never);

		let result: AnalyserData = dataArray;
		if (type === 'volume') {
			const range = this._getDynamicRange(dataArray) * (Math.E - 1);
			const next = Math.floor(Math.log1p(range) * 100);
			const tween = (next > listener.lastValue ? options.tweenIn : options.tweenOut) as number;
			listener.lastValue =
				(listener.lastValue + (next - listener.lastValue) / tween) / this.node.numberOfOutputs;
			// remembered so an idle meter can tell a ringing tail from silence
			listener.level = listener.lastValue;
			result = listener.lastValue;
		} else if (
			type === 'frequency' &&
			(options.lowcut !== undefined || options.hicut !== undefined)
		) {
			// lowcut/hicut are frequency bounds (Hz) — only meaningful for the
			// frequency spectrum. Previously the slice was computed and then
			// overwritten by `result = dataArray`, so it never took effect.
			const bands = dataArray.length;
			const freqsPerBand = this.sampleRate / 2 / bands;
			const start =
				options.lowcut === undefined || options.lowcut <= 0
					? 0
					: Math.min(bands - 1, Math.floor(options.lowcut / freqsPerBand));
			const end =
				options.hicut === undefined || options.hicut >= this.sampleRate / 2
					? bands
					: Math.max(
							start + 1,
							bands - Math.floor((this.sampleRate / 2 - options.hicut) / freqsPerBand) - 1,
						);
			result = dataArray.slice(start, end);
		}

		if (this.listenerCount(type)) this.emit(type, result, options);
		listener.callbacks.forEach((cb) => (cb ? cb(result, options) : null));
	}
	_stopAnalyse(listener?: AnalyserListener): void {
		if (!listener || !listener.analysing) return;
		unschedule(listener);
		listener.analysing = false;
		listener.paused = false;
		listener.tick = null;
	}
	_restartAnalyse(listener?: AnalyserListener): void {
		if (!listener) return;
		this._stopAnalyse(listener);
		this._analyse(listener);
	}
	_getDynamicRange(buffer: Uint8Array | Float32Array): number {
		const len = buffer.length;
		let min = 128;
		let max = 128;
		for (let i = 0; i < len; i++) {
			const sample = buffer[i];
			if (sample < min) min = sample;
			else if (sample > max) max = sample;
		}
		return (max - min) / 255;
	}
}
export default Analyser;
