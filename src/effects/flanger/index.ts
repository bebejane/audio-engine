import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Flanger — modulated (sine-LFO) fractional delay with feedback. The DSP
 * (base delay, LFO rate/depth mapping, feed loop, dry/wet) runs in the
 * pp-flanger worklet; the same normalized ranges as the original node graph.
 */
export default class Flanger extends Effect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			time: { value: 0.45, max: 1, min: 0, type: 'float' },
			speed: { value: 0.2, max: 1, min: 0, type: 'float' },
			depth: { value: 0.1, max: 1, min: 0, type: 'float' },
			feedback: { value: 0.5, max: 1, min: 0, type: 'float' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-flanger',
			this.collectInit(),
		)
		this.initParams()
	}

	get time(): number {
		return this.options.time
	}
	set time(time: number) {
		if (!isInRange(time, 0, 1)) return
		this.options.time = time
		this.node.parameters.get('time').value = time
	}

	get speed(): number {
		return this.options.speed
	}
	set speed(speed: number) {
		if (!isInRange(speed, 0, 1)) return
		this.options.speed = speed
		this.node.parameters.get('speed').value = speed
	}

	get depth(): number {
		return this.options.depth
	}
	set depth(depth: number) {
		if (!isInRange(depth, 0, 1)) return
		this.options.depth = depth
		this.node.parameters.get('depth').value = depth
	}

	get feedback(): number {
		return this.options.feedback
	}
	set feedback(feedback: number) {
		if (!isInRange(feedback, 0, 1)) return
		this.options.feedback = feedback
		this.node.parameters.get('feedback').value = feedback
	}

	get mix(): number {
		return this.options.mix
	}
	set mix(mix: number) {
		if (!isInRange(mix, 0, 1)) return
		this.options.mix = mix
		this.node.parameters.get('mix').setTargetAtTime(mix, this.context.currentTime, 0.02)
	}
}
