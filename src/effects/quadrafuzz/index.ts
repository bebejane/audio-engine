import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * QuadraFuzz — 4-band crossover (147/587/2490/4980 Hz) feeding the same
 * distortion curve as the original, summed over the input. DSP in the
 * pp-quadrafuzz worklet.
 */
export default class Quadrafuzz extends Effect {
	/** Build the effect: create the pp-quadrafuzz worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			lowGain: { value: 0.6, max: 1, min: 0, type: 'float', name: 'Low Gain' },
			midLowGain: { value: 0.8, max: 1, min: 0, type: 'float', name: 'Low-Mid Gain' },
			midHighGain: { value: 0.5, max: 1, min: 0, type: 'float', name: 'High-Mid Gain' },
			highGain: { value: 0.6, max: 1, min: 0, type: 'float', name: 'High Gain' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-quadrafuzz',
			this.collectInit(),
		)
		this.initParams()
	}

	/** Validate and write one band's gain to the worklet. */
	private setBand(name: string, value: number): void {
		if (!isInRange(value, 0, 1)) return
		this.options[name] = value
		this.node.parameters.get(name).value = value
	}

	/** Low band gain (below 147 Hz). */
	get lowGain(): number {
		return this.options.lowGain
	}
	set lowGain(value: number) {
		this.setBand('lowGain', value)
	}

	/** Low-mid band gain (147 - 587 Hz). */
	get midLowGain(): number {
		return this.options.midLowGain
	}
	set midLowGain(value: number) {
		this.setBand('midLowGain', value)
	}

	/** High-mid band gain (587 - 2490 Hz). */
	get midHighGain(): number {
		return this.options.midHighGain
	}
	set midHighGain(value: number) {
		this.setBand('midHighGain', value)
	}

	/** High band gain (above 2490 Hz). */
	get highGain(): number {
		return this.options.highGain
	}
	set highGain(value: number) {
		this.setBand('highGain', value)
	}
}
