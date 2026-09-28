import { Effect, EffectDefaults } from '../core'
import { isInRange, isBool } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * J60 Chorus — the Juno-60 chorus, running in the `j60chorus` worklet.
 *
 * The delay is a true switched-capacitor Bucket-Brigade model (256 stages with
 * the measured Juno-60 input/output charge filters), driven by the LFO and mode
 * smoothing of the "Hera Chorus" reference (jpcima/rc-effect-playground, ISC —
 * see `LICENSE.txt`). The I/II mode table is measured in
 * pendragon-andyh/Juno60 (`Chorus/README.md`).
 *
 * The two buttons mirror the hardware and are crossfaded inside the DSP, so the
 * setters just toggle the boolean AudioParams. `mix` is the output dry/wet:
 * 1 = the hardware blend (0.83·dry + BBD wet), 0 = clean dry.
 */
export default class J60Chorus extends Effect {
	/** Build the effect: create the j60chorus worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			chorusI: { value: false, max: true, min: false, type: 'boolean', name: 'Chorus I' },
			chorusII: { value: true, max: true, min: false, type: 'boolean', name: 'Chorus II' },
			mix: { value: 1, max: 1, min: 0, type: 'float', name: 'Mix' },
		}
		super(context, options, defaults)
		const init = this.collectInit()
		// AudioParam data is numeric; the buttons are booleans
		init.chorusI = init.chorusI ? 1 : 0
		init.chorusII = init.chorusII ? 1 : 0
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'j60chorus',
			init,
		)
		this.initParams()
	}

	/** Chorus I button — 0.513 Hz triangle, mild. */
	get chorusI(): boolean {
		return this.options.chorusI
	}
	set chorusI(on: boolean) {
		if (!isBool(on)) return
		this.options.chorusI = on
		this.node.parameters.get('chorusI').value = on ? 1 : 0
	}

	/** Chorus II button — 0.863 Hz triangle, deeper. */
	get chorusII(): boolean {
		return this.options.chorusII
	}
	set chorusII(on: boolean) {
		if (!isBool(on)) return
		this.options.chorusII = on
		this.node.parameters.get('chorusII').value = on ? 1 : 0
	}

	/** Output dry/wet. 1 = hardware blend (0.83·dry + BBD wet), 0 = dry. */
	get mix(): number {
		return this.options.mix
	}
	set mix(mix: number) {
		if (!isInRange(mix, 0, 1)) return
		this.options.mix = mix
		this.node.parameters.get('mix').setTargetAtTime(mix, this.context.currentTime, 0.02)
	}
}
