import { Effect, EffectDefaults } from '../core'
import { isInRange, isBool } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Reverb (simple-reverb style): generates a decaying noise impulse response on
 * the main thread (so Math.random + the time/decay/reverse math stay as
 * before) and ships it to the reverb worklet, which runs a uniform
 * partitioned overlap-save convolution. Rebuilding the impulse replaces the
 * internal state, like the old ConvolverNode swap.
 */
export default class Reverb extends Effect {
	/** Build the effect: create the reverb worklet node and its initial IR. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			mix: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Mix' },
			time: { value: 0.001, max: 1, min: 0, type: 'float', name: 'Time' },
			decay: { value: 0.1, max: 10, min: 0, type: 'float', name: 'Decay' },
			reverse: { value: false, max: true, min: false, type: 'boolean', name: 'Reverse' },
		}
		super(context, options, defaults)
		const init = this.collectInit()
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(context, 'reverb', {
			mix: init.mix,
		})
		this.initParams()
		this.buildImpulse()
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

	/** Impulse response length in seconds (0.0001 - 10). */
	get time(): number {
		return this.options.time
	}
	set time(time: number) {
		if (!isInRange(time, 0.0001, 10)) return
		this.options.time = time
		this.buildImpulse()
	}

	/** Decay exponent of the noise impulse (0.0001 - 10). */
	get decay(): number {
		return this.options.decay
	}
	set decay(decay: number) {
		if (!isInRange(decay, 0.0001, 10)) return
		this.options.decay = decay
		this.buildImpulse()
	}

	/** Reverse the impulse response (swell instead of decay). */
	get reverse(): boolean {
		return this.options.reverse
	}
	set reverse(reverse: boolean) {
		if (!isBool(reverse)) return
		this.options.reverse = reverse
		this.buildImpulse()
	}

	/**
	 * Generate a decaying (optionally reversed) stereo noise impulse from the
	 * current time/decay and ship it to the worklet's convolver.
	 */
	private buildImpulse(): void {
		const length = Math.max(1, Math.round(this.context.sampleRate * this.time))
		const impulseL = new Float32Array(length)
		const impulseR = new Float32Array(length)
		for (let i = 0; i < length; i++) {
			const n = this.reverse ? length - i : i
			impulseL[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, this.decay)
			impulseR[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, this.decay)
		}
		this.node.port.postMessage({ type: 'ir', channels: [impulseL, impulseR] })
	}
}
