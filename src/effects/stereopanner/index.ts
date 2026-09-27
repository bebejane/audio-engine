import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Stereo panner (equal-power). DSP in the pp-stereopanner worklet.
 */
export default class StereoPanner extends Effect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			pan: { value: 0, max: 1, min: -1, type: 'integer' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-stereopanner',
			this.collectInit(),
		)
		this.initParams()
	}

	/** Pan position. */
	get pan(): number {
		return this.options.pan
	}
	set pan(pan: number) {
		if (!isInRange(pan, -1, 1)) return
		this.options.pan = pan
		this.node.parameters.get('pan').value = pan
	}
}
