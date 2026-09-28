import { FilterEffect } from '../core'

// Frequencies below the cutoff pass through; above are attenuated.
export default class LowPassFilter extends FilterEffect {
	/** Build the low-pass filter (type 'lowpass') backed by lowpassfilter. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		super(context, options, 'lowpass', 'lowpassfilter')
	}
}
