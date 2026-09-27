import { FilterEffect } from '../core'

// Frequencies below the cutoff are attenuated; above pass through.
export default class HighPassFilter extends FilterEffect {
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		super(context, options, 'highpass', 'pp-highpassfilter')
	}
}
