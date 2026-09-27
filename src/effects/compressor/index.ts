import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Feed-forward compressor. DSP (envelope follower + gain computer modeling the
 * DynamicsCompressorNode) runs in the pp-compressor worklet.
 */
export default class Compressor extends Effect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			threshold: { value: -24, max: 0, min: -100, type: 'integer' },
			knee: { value: 30, max: 40, min: 0, type: 'integer' },
			attack: { value: 0, max: 1, min: 0, type: 'integer' },
			release: { value: 0.25, max: 1, min: 0, type: 'integer' },
			ratio: { value: 1, max: 20, min: 0, type: 'integer' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-compressor',
			this.collectInit(),
		)
		this.initParams()
	}

	get threshold(): number {
		return this.options.threshold
	}
	set threshold(value: number) {
		if (!isInRange(value, -100, 0)) return
		this.options.threshold = value
		this.node.parameters.get('threshold').value = value
	}

	get knee(): number {
		return this.options.knee
	}
	set knee(value: number) {
		if (!isInRange(value, 0, 40)) return
		this.options.knee = value
		this.node.parameters.get('knee').value = value
	}

	get attack(): number {
		return this.options.attack
	}
	set attack(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.attack = value
		this.node.parameters.get('attack').value = value
	}

	get release(): number {
		return this.options.release
	}
	set release(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.release = value
		this.node.parameters.get('release').value = value
	}

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
