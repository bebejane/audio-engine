import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Dub delay — feedback through a lowpass, input also folding into the wet
 * mix, exactly like the original node graph. DSP in pp-dubdelay worklet.
 */
export default class DubDelay extends Effect {
	/** Build the effect: create the pp-dubdelay worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			feedback: { value: 0.6, max: 1, min: 0, type: 'float' },
			time: { value: 0.7, max: 180.0, min: 0, type: 'float' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float' },
			cutoff: { value: 700, max: 4000, min: 0, type: 'integer' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-dubdelay',
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

	/** Frequency on delay repeats. */
	get cutoff(): number {
		return this.options.cutoff
	}
	set cutoff(cutoff: number) {
		if (!isInRange(cutoff, 0, 4000)) return
		this.options.cutoff = cutoff
		this.node.parameters.get('cutoff').value = this.cutoff
	}
}
