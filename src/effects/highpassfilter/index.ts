import { FilterEffect } from '../core'

// Frequencies below the cutoff are attenuated; above pass through.
export default class HighPassFilter extends FilterEffect {
	/** Build the high-pass filter (type 'highpass') backed by highpassfilter. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		super(context, options, 'highpass', 'highpassfilter')
	}
}
