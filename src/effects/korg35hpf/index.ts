import { Korg35FilterEffect } from '../core'

// Korg 35 24 dB high pass: below the cutoff is attenuated, above passes.
export default class Korg35HighPassFilter extends Korg35FilterEffect {
	/** Build the Korg 35 high-pass (type 'korg35hpf') backed by pp-korg35hpf. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		super(context, options, 'korg35hpf', 'pp-korg35hpf')
	}
}
