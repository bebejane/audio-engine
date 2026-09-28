import { Effect, EffectDefaults } from '../core'
import { isInRange, isBool } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Stone Phaser — 4-stage analog phaser ported from the Faust DSP in
 * jpcima/stone-phaser (BSL-1.0 / CC0-1.0). The whole graph (input and feedback
 * high-passes, four share-one-coefficient allpass stages, LFO) runs in the
 * stonephaser worklet.
 *
 * Unlike the other effects, every control here is already one-pole smoothed
 * inside the DSP (100 ms, Faust "tsmooth"), so the setters write the AudioParam
 * value directly rather than layering `setTargetAtTime` on top — double
 * smoothing would make the phaser feel sluggish.
 */
export default class StonePhaser extends Effect {
	/** Build the effect: create the stonephaser worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			speed: { value: 0.2, max: 5, min: 0.01, type: 'float', name: 'Speed' },
			feedback: { value: 0.75, max: 0.99, min: 0, type: 'float', name: 'Feedback' },
			feedbackBassCut: { value: 500, max: 5000, min: 10, type: 'integer', name: 'Feedback Bass Cut' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Mix' },
			color: { value: true, max: true, min: false, type: 'boolean', name: 'Color' },
			phase: { value: 0, max: 180, min: -180, type: 'integer', name: 'Phase' },
		}
		super(context, options, defaults)
		const init = this.collectInit()
		// AudioParam data is numeric; "color" is the usual boolean control
		init.color = init.color ? 1 : 0
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'stonephaser',
			init,
		)
		this.initParams()
	}

	/** LFO frequency in Hz (0.01 - 5). */
	get speed(): number {
		return this.options.speed
	}
	set speed(speed: number) {
		if (!isInRange(speed, 0.01, 5)) return
		this.options.speed = speed
		this.node.parameters.get('speed').value = speed
	}

	/** Feedback depth (0 - 0.99). */
	get feedback(): number {
		return this.options.feedback
	}
	set feedback(feedback: number) {
		if (!isInRange(feedback, 0, 0.99)) return
		this.options.feedback = feedback
		this.node.parameters.get('feedback').value = feedback
	}

	/** Cutoff of the high-pass in the feedback path, in Hz (10 - 5000). */
	get feedbackBassCut(): number {
		return this.options.feedbackBassCut
	}
	set feedbackBassCut(cut: number) {
		if (!isInRange(cut, 10, 5000)) return
		this.options.feedbackBassCut = cut
		this.node.parameters.get('feedbackBassCut').value = cut
	}

	/** Dry/wet, equal-power (Faust sin/cos crossfade, not the shared linear one). */
	get mix(): number {
		return this.options.mix
	}
	set mix(mix: number) {
		if (!isInRange(mix, 0, 1)) return
		this.options.mix = mix
		this.node.parameters.get('mix').value = mix
	}

	/** "Color" voicing: on = deeper feedback and a lower sweep, off = lighter/higher. */
	get color(): boolean {
		return this.options.color
	}
	set color(color: boolean) {
		if (!isBool(color)) return
		this.options.color = color
		this.node.parameters.get('color').value = color ? 1 : 0
	}

	/** Stereo LFO phase offset in degrees (-180 - 180). */
	get phase(): number {
		return this.options.phase
	}
	set phase(phase: number) {
		if (!isInRange(phase, -180, 180)) return
		this.options.phase = phase
		this.node.parameters.get('phase').value = phase
	}
}
