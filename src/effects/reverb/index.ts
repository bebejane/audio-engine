import { Effect, EffectDefaults } from '../core'
import { isInRange, isBool } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Reverb (simple-reverb style): generates a decaying noise impulse response on
 * the main thread (so Math.random + the time/decay/reverse math stay as
 * before) and ships it to the pp-reverb worklet, which runs a uniform
 * partitioned overlap-save convolution. Rebuilding the impulse replaces the
 * internal state, like the old ConvolverNode swap.
 */
export default class Reverb extends Effect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			mix: { value: 0.5, max: 1, min: 0, type: 'float' },
			time: { value: 0.001, max: 1, min: 0, type: 'float' },
			decay: { value: 0.1, max: 10, min: 0, type: 'float' },
			reverse: { value: false, max: true, min: false, type: 'boolean' },
		}
		super(context, options, defaults)
		const init = this.collectInit()
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(context, 'pp-reverb', {
			mix: init.mix,
		})
		this.initParams()
		this.buildImpulse()
	}

	get mix(): number {
		return this.options.mix
	}
	set mix(mix: number) {
		if (!isInRange(mix, 0, 1)) return
		this.options.mix = mix
		this.node.parameters.get('mix').setTargetAtTime(mix, this.context.currentTime, 0.02)
	}

	get time(): number {
		return this.options.time
	}
	set time(time: number) {
		if (!isInRange(time, 0.0001, 10)) return
		this.options.time = time
		this.buildImpulse()
	}

	get decay(): number {
		return this.options.decay
	}
	set decay(decay: number) {
		if (!isInRange(decay, 0.0001, 10)) return
		this.options.decay = decay
		this.buildImpulse()
	}

	get reverse(): boolean {
		return this.options.reverse
	}
	set reverse(reverse: boolean) {
		if (!isBool(reverse)) return
		this.options.reverse = reverse
		this.buildImpulse()
	}

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
