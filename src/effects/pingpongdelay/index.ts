import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Ping-pong delay (delay L -> delay R, feedback back to L). DSP in the
 * pp-pingpongdelay worklet; wet output is stereo (L tap / R tap).
 */
export default class PingPongDelay extends Effect {
	/** Build the effect: create the pp-pingpongdelay worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			feedback: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Feedback' },
			time: { value: 0.3, max: 1, min: 0, type: 'float', name: 'Time' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Mix' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-pingpongdelay',
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
		if (!isInRange(time, 0, 180)) return
		this.options.time = time
		this.node.parameters.get('time').value = time
	}

	/** Strength of each of the echoed delayed sounds. */
	get feedback(): number {
		return this.options.feedback
	}
	set feedback(feedback: number) {
		if (!isInRange(feedback, 0, 1)) return
		this.options.feedback = parseFloat(String(feedback))
		this.node.parameters.get('feedback').value = this.feedback
	}
}
