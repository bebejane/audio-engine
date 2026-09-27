import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Distortion (wave-shaper). The exact per-sample curve from the original
 * `adjustGain`/StackOverflow waveshaper runs in the pp-distortion worklet.
 */
export default class Distortion extends Effect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			gain: { value: 0.5, max: 1, min: 0, type: 'float' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-distortion',
			this.collectInit(),
		)
		this.initParams()
	}

	/** Amount of distortion. */
	get gain(): number {
		return this.options.gain
	}
	set gain(gain: number) {
		if (!isInRange(gain, 0, 1)) return
		this.options.gain = gain
		this.node.parameters.get('gain').value = gain
	}
}
