import { Korg35FilterEffect } from '../core'

// Korg 35 24 dB low pass: below the cutoff passes, above is attenuated.
export default class Korg35LowPassFilter extends Korg35FilterEffect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		super(context, options, 'korg35lpf', 'pp-korg35lpf')
	}
}
