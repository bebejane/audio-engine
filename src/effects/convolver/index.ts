import { Effect, EffectDefaults } from '../core'
import { isInRange, isFunction } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Convolver: loads the impulse file on the main thread (fetch + decode),
 * posts the channel data to the pp-convolver worklet, which runs a uniform
 * partitioned overlap-save convolution. Dry path stays live until the
 * impulse arrives, matching the old ConvolverNode behavior.
 */
export default class Convolver extends Effect {
	/** Optional completion callback (set externally by callers). */
	callback?: (err?: unknown) => void;

	/**
	 * Build the effect: create the pp-convolver worklet node, then fetch +
	 * decode `options.impulse` and post it as the impulse response.
	 */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			mix: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Mix' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-convolver',
			this.collectInit(),
		)
		this.initParams()

		if (!options.impulse) {
			console.error('No impulse file specified.')
			return
		}
		fetch(options.impulse)
			.then((res) => res.arrayBuffer())
			.then((data) => context.decodeAudioData(data))
			.then((buffer) => {
				const channels = []
				const n = Math.min(2, buffer.numberOfChannels)
				for (let i = 0; i < n; i++) channels.push(buffer.getChannelData(i))
				this.node.port.postMessage({ type: 'ir', channels })
				if (this.callback && isFunction(this.callback)) this.callback()
			})
			.catch((error) => {
				error = error || new Error('Error decoding impulse file')
				console.error('Error while fetching impulse file', error)
				if (this.callback && isFunction(this.callback)) this.callback(error)
			})
	}

	/** Dry/wet mix between the input and the convolved signal. */
	get mix(): number {
		return this.options.mix
	}
	set mix(mix: number) {
		if (!isInRange(mix, 0, 1)) return
		this.options.mix = mix
		this.node.parameters.get('mix').setTargetAtTime(mix, this.context.currentTime, 0.02)
	}
}
