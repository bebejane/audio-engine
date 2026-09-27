import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Tremolo (sine LFO amplitude modulation). DSP in the pp-tremolo worklet;
 * the depth curve and dry/wet mirror the original shaper + gain graph.
 */
export default class Tremolo extends Effect {
	/** Build the effect: create the pp-tremolo worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			speed: { value: 4, max: 20, min: 0, type: 'integer', name: 'Speed' },
			depth: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Depth' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Mix' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-tremolo',
			this.collectInit(),
		)
		this.initParams()
	}

	/** Dry/wet mix. */
	get mix(): number {
		return this.options.mix
	}
	set mix(mix: number) {
		if (!isInRange(mix, 0, 1)) return
		this.options.mix = mix
		this.node.parameters.get('mix').setTargetAtTime(mix, this.context.currentTime, 0.02)
	}

	/** Speed of the tremolo. */
	get speed(): number {
		return this.options.speed
	}
	set speed(speed: number) {
		if (!isInRange(speed, 0, 20)) return
		this.options.speed = speed
		this.node.parameters.get('speed').value = speed
	}

	/** Depth of the tremolo. */
	get depth(): number {
		return this.options.depth
	}
	set depth(depth: number) {
		if (!isInRange(depth, 0, 1)) return
		this.options.depth = depth
		this.node.parameters.get('depth').value = depth
	}
}
