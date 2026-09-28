/**
 * Shared primitives for the WebAudio effects. Every effect is now a real class
 * extending `Effect` (the base owns context/options/defaults plus the graph
 * connect/disconnect + param snapshot/reset contract `Sound` relies on).
 *
 * Kept in its own module so effect classes can import from here without a
 * circular import back to effects/index.
 */
import { isInRange } from '../utils';
import { createWorkletEffectNode } from './worklet';

/** One editable parameter, as declared in the engine catalog (EFFECTS). */
export interface EffectParamDef {
	value: number | boolean;
	max: number | boolean;
	min: number | boolean;
	type: 'float' | 'integer' | 'boolean';
	/** User-facing display name for this parameter. */
	name: string;
}

export type EffectDefaults = Record<string, EffectParamDef>;

/**
 * Base effect. Subclasses create their AudioWorkletNode and then call
 * `initParams()` so each param's setter runs against a live node (the same
 * ordering the old `createEffectBase.call(this, …)` relied on).
 */
export abstract class Effect {
	/** Param accessors are dynamic (one per catalog entry) — allow `effect[key]`. */
	[key: string]: any;
	context: AudioContext;
	options: Record<string, any>;
	defaults: EffectDefaults;
	inputNode!: AudioNode;
	outputNode!: AudioNode;
	node!: AudioWorkletNode;
	connected = false;
	_connectedNode: AudioNode | null = null;

	constructor(
		context: AudioContext,
		options: Record<string, any> = {},
		defaults: EffectDefaults = {},
	) {
		this.context = context;
		this.options = { ...options };
		this.defaults = defaults;
	}

	/**
	 * Initial AudioParam values (options over defaults) for node construction.
	 * Used at construction time, before `initParams()` can run through setters.
	 */
	protected collectInit(): Record<string, any> {
		const init: Record<string, any> = {};
		Object.keys(this.defaults).forEach((k) => {
			const v = this.options[k];
			init[k] = v !== undefined && v !== null ? v : this.defaults[k].value;
		});
		return init;
	}

	/** Apply options/defaults through each param setter (call after the node exists). */
	protected initParams(): void {
		Object.keys(this.defaults).forEach((k) => {
			const v = this.options[k];
			(this as any)[k] = v === undefined || v === null ? this.defaults[k].value : v;
		});
	}

	/** Connect this effect's output to `audioNode` (records the target for disconnect). */
	connect(audioNode: AudioNode): this {
		this._connectedNode = audioNode;
		this.outputNode.connect(audioNode);
		this.connected = true;
		return this;
	}

	/** Disconnect from `audioNode` (or the remembered target) if connected. */
	disconnect(audioNode?: AudioNode): this {
		if (this.connected) this.outputNode.disconnect(audioNode || (this._connectedNode as AudioNode));
		this.connected = false;
		return this;
	}

	/** Snapshot the current value of every declared parameter. */
	params(): Record<string, number | boolean> {
		const p: Record<string, number | boolean> = {};
		Object.keys(this.defaults).forEach((k) => (p[k] = (this as any)[k]));
		return p;
	}

	/** Restore every parameter to its catalog default. */
	reset(): boolean {
		Object.keys(this.defaults).forEach((k) => ((this as any)[k] = this.defaults[k].value));
		return true;
	}
}

/**
 * Shared adapter bases for effect families that come in pairs — same parameter
 * surface and node construction, one concrete class per catalog effect.
 */

/**
 * Biquad filters (lowpass / highpass). The RBJ biquad DSP matching the native
 * BiquadFilterNode runs in the lowpassfilter / highpassfilter worklets.
 */
export abstract class FilterEffect extends Effect {
	/** 'lowpass' | 'highpass' — the filter kind this instance was built as. */
	type: string;

	constructor(
		context: AudioContext,
		options: Record<string, any>,
		type: string,
		processorId: string,
	) {
		const defaults: EffectDefaults = {
			frequency: { value: 350, max: 22050, min: 10, type: 'integer', name: 'Frequency' },
			peak: { value: 0.0001, max: 1000, min: 0, type: 'float', name: 'Peak' },
		};
		super(context, options, defaults);
		this.inputNode =
			this.outputNode =
			this.node =
				createWorkletEffectNode(context, processorId, this.collectInit());
		this.type = type;
		this.initParams();
	}

	/** Cutoff frequency. */
	get frequency(): number {
		return this.options.frequency;
	}
	set frequency(value: number) {
		if (isInRange(value, 10, 22050)) {
			this.options.frequency = value;
			this.node.parameters.get('frequency').value = value;
		}
	}

	/** How peaked the response is around the cutoff. */
	get peak(): number {
		return this.options.peak;
	}
	set peak(value: number) {
		if (isInRange(value, 0.0001, 1000)) {
			this.options.peak = value;
			this.node.parameters.get('peak').value = value;
		}
	}
}

/**
 * Korg 35 filters — virtual-analog models of the MS-10 / early MS-20 low-pass
 * and high-pass filters. The DSP is a 1:1 port of the Faust sources published
 * in the faustfilters project (<https://github.com/SpotlightKid/faustfilters>,
 * `faust/korg35lpf.dsp` / `faust/korg35hpf.dsp`, Faust by Eric Tarr and
 * Christopher Arndt, STK-4.3 license). It runs in the `korg35lpf` /
 * `korg35hpf` AudioWorklet processors — see `korg35lpf/source.js` and
 * `korg35hpf/source.js`.
 *
 * Both filters expose the same two controls as the reference plugins:
 * `cutoff` (Hz) and `q` (0.5..10, resonance; 0.707 = flat). The upstream
 * plugins default to 20000 Hz / Q 1; we start at the app's filter default
 * (350 Hz) so adding one audibly shapes the sound, Q staying at 1.
 */
export abstract class Korg35FilterEffect extends Effect {
	/** 'korg35lpf' | 'korg35hpf' — the filter kind this instance was built as. */
	type: string;

	constructor(
		context: AudioContext,
		options: Record<string, any>,
		type: string,
		processorId: string,
	) {
		const defaults: EffectDefaults = {
			cutoff: { value: 350, max: 20000, min: 20, type: 'integer', name: 'Cutoff' },
			q: { value: 1, max: 10, min: 0.5, type: 'float', name: 'Q' },
		};
		super(context, options, defaults);
		this.inputNode =
			this.outputNode =
			this.node =
				createWorkletEffectNode(context, processorId, this.collectInit());
		this.type = type;
		this.initParams();
	}

	/** Cutoff frequency in Hertz (20 - 20000). */
	get cutoff(): number {
		return this.options.cutoff;
	}
	set cutoff(value: number) {
		if (isInRange(value, 20, 20000)) {
			this.options.cutoff = value;
			this.node.parameters.get('cutoff').value = value;
		}
	}

	/** Resonance (0.5 - 10; 0.707 is flat, higher values emphasize the cutoff). */
	get q(): number {
		return this.options.q;
	}
	set q(value: number) {
		if (isInRange(value, 0.5, 10)) {
			this.options.q = value;
			this.node.parameters.get('q').value = value;
		}
	}
}
