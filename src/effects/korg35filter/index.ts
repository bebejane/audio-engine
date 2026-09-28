import { Effect, EffectDefaults } from '../core'
import { isInRange, isBool } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Korg 35 filter — a virtual-analog model of the MS-10 / early MS-20 24 dB
 * low-pass and high-pass filters. The DSP is a 1:1 port of the Faust sources
 * published in the faustfilters project
 * (<https://github.com/SpotlightKid/faustfilters>, `faust/korg35lpf.dsp` /
 * `faust/korg35hpf.dsp`, Faust by Eric Tarr and Christopher Arndt, STK-4.3
 * license). It runs in the `korg35filter` AudioWorklet processor — see
 * [`source.js`](./source.js).
 *
 * Both models share one set of controls: `cutoff` (Hz) and `q` (0.5..10,
 * resonance; 0.707 = flat) plus the `highpass` switch that selects which of
 * the two runs. The upstream plugins default to 20000 Hz / Q 1; we start at
 * the app's filter default (350 Hz) so adding one audibly shapes the sound,
 * Q staying at 1.
 */
export default class Korg35Filter extends Effect {
	/** Build the effect: create the korg35filter worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			cutoff: { value: 350, max: 20000, min: 20, type: 'integer', name: 'Cutoff' },
			q: { value: 1, max: 10, min: 0.5, type: 'float', name: 'Q' },
			highpass: { value: false, max: true, min: false, type: 'boolean', name: 'Highpass' },
		}
		super(context, options, defaults)
		const init = this.collectInit()
		// AudioParam data is numeric; the highpass switch is a boolean
		init.highpass = init.highpass ? 1 : 0
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'korg35filter',
			init,
		)
		this.initParams()
	}

	/** Cutoff frequency in Hertz (20 - 20000). */
	get cutoff(): number {
		return this.options.cutoff
	}
	set cutoff(value: number) {
		if (!isInRange(value, 20, 20000)) return
		this.options.cutoff = value
		this.node.parameters.get('cutoff').value = value
	}

	/** Resonance (0.5 - 10; 0.707 is flat, higher values emphasize the cutoff). */
	get q(): number {
		return this.options.q
	}
	set q(value: number) {
		if (!isInRange(value, 0.5, 10)) return
		this.options.q = value
		this.node.parameters.get('q').value = value
	}

	/** High-pass mode: false = 24 dB low pass (default), true = 24 dB high pass. */
	get highpass(): boolean {
		return this.options.highpass
	}
	set highpass(value: boolean) {
		if (!isBool(value)) return
		this.options.highpass = value
		this.node.parameters.get('highpass').value = value ? 1 : 0
	}
}
