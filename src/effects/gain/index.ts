import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Output gain, in decibels. A plain linear amplifier (no colouring); 0 dB is
 * unity, negative values attenuate and positive values boost. DSP in the gain
 * worklet.
 */
export default class Gain extends Effect {
	/** Build the effect: create the gain worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			gain: { value: 0, max: 24, min: -60, type: 'float', name: 'Gain (dB)' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'gain',
			this.collectInit(),
		)
		this.initParams()
	}

	/** Gain in decibels (0 = unity). */
	get gain(): number {
		return this.options.gain
	}
	set gain(gain: number) {
		if (!isInRange(gain, -60, 24)) return
		this.options.gain = gain
		this.node.parameters.get('gain').value = gain
	}
}
