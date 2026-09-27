import { Effect, EffectDefaults } from '../core'
import { isInRange, isBool } from '../../utils'
import { createWorkletEffectNode } from '../worklet'

/**
 * Tape Delay — a multi-head tape echo in the spirit of the Roland RE-201 Space
 * Echo, running in the `pp-tapedelay` worklet.
 *
 * The delay/feedback/mix base comes from cyrusasfa/TapeDelay; the tape
 * character (wow + flutter + scrape-flutter capstan, Jiles-Atherton hysteresis
 * saturation, record pre-emphasis, level-dependent self-erasure, repro
 * de-emphasis + head bump + speed-dependent gap loss, tape types and an "age"
 * macro) is ported from the ISC-licensed re-deemer DSP (naturarum/re-deemer)
 * after Chowdhury, DAFx-19 — see `LICENSE.txt`.
 *
 * Three playback heads sit at t, 2t and 3t (density scales the spacing) and
 * feedback returns through the record path so every repeat re-saturates. `time`
 * drives the tape speed with motor ballistics, so changing it repitches the
 * echoes like the real machine.
 */
export default class TapeDelay extends Effect {
	/** Build the effect: create the pp-tapedelay worklet node and apply options. */
	constructor(context: AudioContext, options: Record<string, any> = {}) {
		const defaults: EffectDefaults = {
			time: { value: 220, max: 600, min: 30, type: 'float' },
			feedback: { value: 0.5, max: 1.05, min: 0, type: 'float' },
			mix: { value: 0.5, max: 1, min: 0, type: 'float' },
			head1: { value: true, max: true, min: false, type: 'boolean' },
			head2: { value: false, max: true, min: false, type: 'boolean' },
			head3: { value: false, max: true, min: false, type: 'boolean' },
			density: { value: 1, max: 2, min: 0.5, type: 'float' },
			wowFlutter: { value: 0.3, max: 1, min: 0, type: 'float' },
			drive: { value: 0.3, max: 1, min: 0, type: 'float' },
			bass: { value: 0, max: 15, min: -15, type: 'float' },
			treble: { value: 0, max: 15, min: -15, type: 'float' },
			hiss: { value: 0.1, max: 1, min: 0, type: 'float' },
			tapeType: { value: 0, max: 2, min: 0, type: 'integer' },
			age: { value: 0.2, max: 1, min: 0, type: 'float' },
		}
		super(context, options, defaults)
		const init = this.collectInit()
		init.head1 = init.head1 ? 1 : 0
		init.head2 = init.head2 ? 1 : 0
		init.head3 = init.head3 ? 1 : 0
		this.inputNode = this.outputNode = this.node = createWorkletEffectNode(
			context,
			'pp-tapedelay',
			init,
		)
		this.initParams()
	}

	/** Base delay / tape speed, in milliseconds (motor has ballistics). */
	get time(): number {
		return this.options.time
	}
	set time(value: number) {
		if (!isInRange(value, 30, 600)) return
		this.options.time = value
		this.node.parameters.get('time').value = value
	}

	/** Regeneration; above ~1 the loop self-oscillates. */
	get feedback(): number {
		return this.options.feedback
	}
	set feedback(value: number) {
		if (!isInRange(value, 0, 1.05)) return
		this.options.feedback = value
		this.node.parameters.get('feedback').setTargetAtTime(value, this.context.currentTime, 0.02)
	}

	/** Dry/wet. */
	get mix(): number {
		return this.options.mix
	}
	set mix(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.mix = value
		this.node.parameters.get('mix').setTargetAtTime(value, this.context.currentTime, 0.02)
	}

	/** Playback head 1 (shortest delay) on/off. */
	get head1(): boolean {
		return this.options.head1
	}
	set head1(on: boolean) {
		if (!isBool(on)) return
		this.options.head1 = on
		this.node.parameters.get('head1').value = on ? 1 : 0
	}

	/** Playback head 2 (2x spacing) on/off. */
	get head2(): boolean {
		return this.options.head2
	}
	set head2(on: boolean) {
		if (!isBool(on)) return
		this.options.head2 = on
		this.node.parameters.get('head2').value = on ? 1 : 0
	}

	/** Playback head 3 (3x spacing) on/off. */
	get head3(): boolean {
		return this.options.head3
	}
	set head3(on: boolean) {
		if (!isBool(on)) return
		this.options.head3 = on
		this.node.parameters.get('head3').value = on ? 1 : 0
	}

	/** Head spacing scale (1 = 1x / 2x / 3x). */
	get density(): number {
		return this.options.density
	}
	set density(value: number) {
		if (!isInRange(value, 0.5, 2)) return
		this.options.density = value
		this.node.parameters.get('density').value = value
	}

	/** Wow + flutter + scrape-flutter depth (0 = rock steady). */
	get wowFlutter(): number {
		return this.options.wowFlutter
	}
	set wowFlutter(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.wowFlutter = value
		this.node.parameters.get('wowFlutter').value = value
	}

	/** Record saturation (Jiles-Atherton hysteresis drive). */
	get drive(): number {
		return this.options.drive
	}
	set drive(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.drive = value
		this.node.parameters.get('drive').value = value
	}

	/** Echo low shelf, dB (-15..15). */
	get bass(): number {
		return this.options.bass
	}
	set bass(value: number) {
		if (!isInRange(value, -15, 15)) return
		this.options.bass = value
		this.node.parameters.get('bass').value = value
	}

	/** Echo high shelf, dB (-15..15). */
	get treble(): number {
		return this.options.treble
	}
	set treble(value: number) {
		if (!isInRange(value, -15, 15)) return
		this.options.treble = value
		this.node.parameters.get('treble').value = value
	}

	/** Tape hiss level. */
	get hiss(): number {
		return this.options.hiss
	}
	set hiss(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.hiss = value
		this.node.parameters.get('hiss').value = value
	}

	/** Tape type: 0 = I (ferric), 1 = II (chrome), 2 = IV (metal). */
	get tapeType(): number {
		return this.options.tapeType
	}
	set tapeType(value: number) {
		if (!isInRange(value, 0, 2)) return
		this.options.tapeType = value
		this.node.parameters.get('tapeType').value = value
	}

	/** Wear macro: HF self-erasure, dropout rate and bias sag (0..1). */
	get age(): number {
		return this.options.age
	}
	set age(value: number) {
		if (!isInRange(value, 0, 1)) return
		this.options.age = value
		this.node.parameters.get('age').value = value
	}
}
