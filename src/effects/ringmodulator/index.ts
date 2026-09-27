import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Ring modulator (BBC design): carrier oscillator through diode saturation,
 * summed with the audio, compressed, gain x3. DSP (LFO, diode curves,
 * internal compressor) runs in the pp-ringmodulator worklet.
 */
export default class RingModulator extends Effect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			speed: { value: 30, max: 2000, min: 0, type: 'float' },
			distortion: { value: 0.2, max: 50, min: 0.2, type: 'float' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-ringmodulator',
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

	/** Speed of the input oscillator. */
	get speed(): number {
		return this.options.speed
	}
	set speed(speed: number) {
		if (!isInRange(speed, 0, 2000)) return
		this.options.speed = speed
		this.node.parameters.get('speed').value = speed
	}

	/** Level of distortion. */
	get distortion(): number {
		return this.options.distortion
	}
	set distortion(distortion: number) {
		if (!isInRange(distortion, 0.2, 50)) return
		this.options.distortion = parseFloat(String(distortion))
		this.node.parameters.get('distortion').value = this.options.distortion
	}
}
