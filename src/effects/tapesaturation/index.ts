import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Tape Saturation — the asymmetric glue-saturation stage of "Aureate"
 * (basilica-audio/Aureate), running in the `pp-tapesaturation` worklet.
 * Licensed under the AGPL-3.0 — see `LICENSE.txt`.
 *
 * A port of the nonlinear stage only. Per sample: input gain → 4× oversample →
 * a Warmth-driven HF rolloff (tape self-erasure) → an 80 Hz head-bump peak
 * (tape transport resonance) → an asymmetric saturator → downsample →
 * dry/wet → output trim.
 *
 * The nonlinearity is shift-then-recentre, `y = f(x + bias) - f(bias)`. The
 * shift makes the two half-cycles saturate toward *different* ceilings, which
 * is the whole point: that asymmetry is what produces the even-harmonic-rich,
 * DC-shifted "glue". The recentring is what makes `f(0) == 0`, so no DC offset
 * is injected into silence at any bias.
 *
 * `warmth` is the important one — it moves three things at once (rolloff
 * cutoff, head-bump depth, and the saturator's bias ceiling), which is what
 * makes it read as one "how old is this tape" control. `bias` then trims the
 * asymmetry independently, without disturbing the rolloff.
 *
 * Aureate also contains a glue compressor, an iron transformer stage,
 * wow/flutter, hiss, HF/LF trims and auto gain. Those are separate instruments
 * and are not part of this effect.
 */
export default class TapeSaturation extends Effect {
	/** Build the effect: create the pp-tapesaturation worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			drive: { value: 0.25, max: 1, min: 0, type: 'float', name: 'Drive' },
			warmth: { value: 0.35, max: 1, min: 0, type: 'float', name: 'Warmth' },
			bias: { value: 0, max: 1, min: -1, type: 'float', name: 'Bias' },
			character: { value: 0, max: 2, min: 0, type: 'integer', name: 'Tape / Console / Valve' },
			quality: { value: true, max: true, min: false, type: 'boolean', name: 'HQ (ADAA)' },
			mix: { value: 1, max: 1, min: 0, type: 'float', name: 'Mix' },
			output: { value: 0, max: 1, min: -1, type: 'float', name: 'Output' },
		}
		super(context, options, defaults)
		const init = this.collectInit()
		// AudioParam data is numeric; the quality switch is a boolean
		init.quality = init.quality ? 1 : 0
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-tapesaturation',
			init,
		)
		this.initParams()
	}

	/** Gain into the saturator, 0…24 dB. Higher pushes the curve harder. */
	get drive(): number {
		return this.options.drive
	}
	set drive(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.drive = value
		this.node.parameters.get('drive').value = value
	}

	/**
	 * How much tape. 0 is transparent and symmetric; 1 closes the rolloff down
	 * to 3 kHz, adds the full 80 Hz head bump, and drives the saturator to its
	 * Character-dependent bias ceiling.
	 */
	get warmth(): number {
		return this.options.warmth
	}
	set warmth(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.warmth = value
		this.node.parameters.get('warmth').value = value
	}

	/**
	 * Extra saturation asymmetry, ±1, added on top of `warmth`'s own bias
	 * contribution. Lets you skew odd-vs-even harmonic balance without
	 * touching the HF rolloff.
	 */
	get bias(): number {
		return this.options.bias
	}
	set bias(value: number) {
		if (!isInRange(value, -1, 1)) return
		this.options.bias = value
		this.node.parameters.get('bias').value = value
	}

	/**
	 * Transfer-function family: 0 Tape (smooth tanh, least asymmetric),
	 * 1 Console (stays transparent until pushed), 2 Valve (most asymmetric,
	 * even-harmonic-forward).
	 */
	get character(): number {
		return this.options.character
	}
	set character(value: number) {
		if (!Number.isInteger(value) || value < 0 || value > 2) return
		this.options.character = value
		this.node.parameters.get('character').value = value
	}

	/**
	 * HQ applies first-order antiderivative anti-aliasing to the saturator.
	 * Same curve, same oversampling, lower alias floor. Default on — there is
	 * no backwards-compatibility reason to prefer Classic on a new instance.
	 */
	get quality(): boolean {
		return this.options.quality
	}
	set quality(on: boolean) {
		if (typeof on !== 'boolean') return
		this.options.quality = on
		this.node.parameters.get('quality').value = on ? 1 : 0
	}

	/** Dry/wet. 0 is an exact, delay-aligned dry passthrough. */
	get mix(): number {
		return this.options.mix
	}
	set mix(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.mix = value
		this.node.parameters.get('mix').value = value
	}

	/** Output trim, ±24 dB, applied after the dry/wet mix. */
	get output(): number {
		return this.options.output
	}
	set output(value: number) {
		if (!isInRange(value, -1, 1)) return
		this.options.output = value
		this.node.parameters.get('output').value = value
	}
}
