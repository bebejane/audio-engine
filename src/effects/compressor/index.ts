import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Feed-forward compressor. DSP (envelope follower + gain computer modeling the
 * DynamicsCompressorNode) runs in the compressor worklet.
 */
export default class Compressor extends Effect {
	/** Build the effect: create the compressor worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			threshold: { value: -24, max: 0, min: -100, type: 'integer', name: 'Threshold' },
			knee: { value: 30, max: 40, min: 0, type: 'integer', name: 'Knee' },
			attack: { value: 0, max: 1, min: 0, type: 'integer', name: 'Attack' },
			release: { value: 0.25, max: 1, min: 0, type: 'integer', name: 'Release' },
			ratio: { value: 1, max: 20, min: 0, type: 'integer', name: 'Ratio' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'compressor',
			this.collectInit(),
		)
		this.initParams()
	}

	/** Level above which compression starts, in dB (-100 - 0). */
	get threshold(): number {
		return this.options.threshold
	}
	set threshold(value: number) {
		if (!isInRange(value, -100, 0)) return
		this.options.threshold = value
		this.node.parameters.get('threshold').value = value
	}

	/** Soft-knee width in dB (0 - 40). */
	get knee(): number {
		return this.options.knee
	}
	set knee(value: number) {
		if (!isInRange(value, 0, 40)) return
		this.options.knee = value
		this.node.parameters.get('knee').value = value
	}

	/** Attack time (0 - 1). */
	get attack(): number {
		return this.options.attack
	}
	set attack(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.attack = value
		this.node.parameters.get('attack').value = value
	}

	/** Release time (0 - 1). */
	get release(): number {
		return this.options.release
	}
	set release(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.release = value
		this.node.parameters.get('release').value = value
	}

	/** Compression ratio (1 - 20). */
	get ratio(): number {
		return this.options.ratio
	}
	set ratio(value: number) {
		if (!isInRange(value, 1, 20)) return
		this.options.ratio = value
		this.node.parameters.get('ratio').value = value
	}

	/** The worklet does not expose live reduction; UI does not use it. */
	getCurrentGainReduction(): number {
		return 0
	}
}
