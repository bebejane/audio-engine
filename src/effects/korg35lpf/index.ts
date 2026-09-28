import { Korg35FilterEffect } from '../core'

// Korg 35 24 dB low pass: below the cutoff passes, above is attenuated.
export default class Korg35LowPassFilter extends Korg35FilterEffect {
	/** Build the Korg 35 low-pass (type 'korg35lpf') backed by korg35lpf. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		super(context, options, 'korg35lpf', 'korg35lpf')
	}
}
