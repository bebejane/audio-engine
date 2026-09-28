import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Feedback delay. DSP runs in the delay AudioWorklet; `time` is automated
 * exactly like the old native DelayNode (cancel + exp ramp), `mix` keeps the
 * setTargetAtTime smoothing.
 */
export default class Delay extends Effect {
	/** Build the effect: create the delay worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			feedback: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Feedback' },
			time: { value: 0.1, max: 1.0, min: 0, type: 'float', name: 'Time' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Mix' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'delay',
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

	/** Time between each delayed sound. */
	get time(): number {
		return this.options.time
	}
	set time(time: number) {
		if (!isInRange(time, 0, 180) && this.options.time !== time) return
		const p = this.node.parameters.get('time')
		const ct = this.context.currentTime
		p.cancelScheduledValues(ct)
		p.setValueAtTime(this.options.time || time, ct + 0.2)
		p.exponentialRampToValueAtTime(Math.max(0.0001, time), ct + 0.5)
		this.options.time = time
	}

	/** Strength of each echoed repeat. */
	get feedback(): number {
		return this.options.feedback
	}
	set feedback(feedback: number) {
		if (!isInRange(feedback, 0, 1) && this.options.feedback !== feedback) return
		const p = this.node.parameters.get('feedback')
		const ct = this.context.currentTime
		p.cancelScheduledValues(ct)
		p.setValueAtTime(this.options.feedback || feedback, ct + 0.01)
		p.linearRampToValueAtTime(feedback, ct + 0.5)
		this.options.feedback = feedback
	}
}
