import { Effect, EffectDefaults } from '../core'
import { isInRange } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Magnetic Tape Emulation — the tape desecration chain from "The Kiss of
 * Shame" (hollance/TheKissOfShame), running in the `pp-magnetictape` worklet.
 * Licensed under the GPL-3.0 — see `LICENSE.txt`.
 *
 * A per-sample chain: input drive → input saturation (odd/even harmonic
 * mixing behind a 4 kHz one-pole) → flange → the `age` macro (lowpass sweep,
 * granular noise, random level dips, noise bursts) → hiss → `shame`
 * (randomly-perturbed cosine modulated delay) → linear dry/wet → output level.
 *
 * Two things to know before reaching for it. The saturation stage is
 * unconditional, so the effect is audible at its defaults even with
 * `shame`/`age`/`hiss` at zero — it is a tape machine, not a damage unit, and
 * `mix` defaults to 1 for that reason. And the three noise sources the original
 * loaded from bundled WAV files are synthesised here, so the hiss and grain
 * beds are plausible rather than authentic.
 *
 * The upstream plugin only behaves correctly at 44100 Hz; the port derives all
 * buffer sizes, envelope domains and modulation depths from the real
 * `sampleRate`, so it holds at 48 kHz and above.
 */
export default class MagneticTape extends Effect {
	/** Build the effect: create the pp-magnetictape worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			inputDrive: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Input Drive' },
			outputLevel: { value: 0.5, max: 1, min: 0, type: 'float', name: 'Output Level' },
			shame: { value: 0, max: 1, min: 0, type: 'float', name: 'Shame' },
			age: { value: 0, max: 1, min: 0, type: 'float', name: 'Age' },
			hiss: { value: 0, max: 1, min: 0, type: 'float', name: 'Hiss' },
			mix: { value: 1, max: 1, min: 0, type: 'float', name: 'Mix' },
			flange: { value: 0, max: 1, min: 0, type: 'float', name: 'Flange' },
		}
		super(context, options, defaults)
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-magnetictape',
			this.collectInit(),
		)
		this.initParams()
	}

	/** Input trim, -18 … +18 dB. Drives how hard the saturation stage works. */
	get inputDrive(): number {
		return this.options.inputDrive
	}
	set inputDrive(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.inputDrive = value
		this.node.parameters.get('inputDrive').value = value
	}

	/** Output trim, -18 … +18 dB. */
	get outputLevel(): number {
		return this.options.outputLevel
	}
	set outputLevel(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.outputLevel = value
		this.node.parameters.get('outputLevel').value = value
	}

	/** Wow/flutter chaos: modulated delay depth, rate and randomness (0..1). */
	get shame(): number {
		return this.options.shame
	}
	set shame(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.shame = value
		this.node.parameters.get('shame').value = value
	}

	/** Storage-environment macro: lowpass sweep, grain wobble, dips, noise bursts. */
	get age(): number {
		return this.options.age
	}
	set age(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.age = value
		this.node.parameters.get('age').value = value
	}

	/** Tape hiss, up to -46 dB (the dry path is trimmed to match). */
	get hiss(): number {
		return this.options.hiss
	}
	set hiss(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.hiss = value
		this.node.parameters.get('hiss').value = value
	}

	/** Linear dry/wet. 0 = clean dry, 1 = the full tape chain. */
	get mix(): number {
		return this.options.mix
	}
	set mix(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.mix = value
		this.node.parameters.get('mix').value = value
	}

	/** Flange depth, 0 = steady, 1 = ~1000 samples of modulated delay. */
	get flange(): number {
		return this.options.flange
	}
	set flange(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.flange = value
		this.node.parameters.get('flange').value = value
	}
}
