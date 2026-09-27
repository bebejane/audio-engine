/**
 * Effect catalog and factory.
 *
 * `EFFECTS` is the serializable catalog the app renders (id, name, default
 * params); `EFFECT_CLASSES` maps each id to its concrete `Effect` subclass.
 * `createEffect` builds one instance, filling in any params the caller omitted
 * without overwriting supplied ones.
 */
const EFFECTS: EffectDefinition[] = [
	{
		id: 'compressor',
		name: 'Compressor',
		defaults:{
			threshold: {value:-24, max:0, min:-100, type:'integer'},
			knee: {value:30, max:40, min:0, type:'integer'},
			attack: {value:0, max:1, min:0, type:'integer'},
			release: {value:0.250, max:1, min:0, type:'integer'},
			ratio: {value:1, max:20, min:0, type:'integer'}
		}
	},{
		id:'convolver',
		name: 'Convolver',
		defaults: {
			mix: {value:0.5, max:1, min:0, type:'float'}
		},
	},{
		id:'delay',
		name: 'Delay',
		defaults:{
			feedback: {value:0.5, max:1, min:0, type:'float'},
			time: {value:0.1, max:1.0, min:0, type:'float'},
			mix: {value:0.5, max:1, min:0, type:'float'}
		},
	},{
		id:'distortion',
		name: 'Distortion',
		defaults:{
		gain: {
			value:0.5, max:1, min:0, type:'float'}
		},
	},{
		id:'dubdelay',
		name: 'Dub Delay',
		defaults:{
			feedback: {value:0.6, max:1, min:0, type:'float'},
			time: {value:0.7, max:180.0, min:0, type:'float'},
			mix: {value:0.5, max:1, min:0, type:'float'},
			cutoff: {value:700, max:4000, min:0, type:'integer'}
		},
	},{
		id:'flanger',
		name: 'Flanger',
		defaults:{
			time: {value:0.45, max:1, min:0, type:'float'},
			speed: {value:0.2, max:1, min:0, type:'float'},
			depth: {value:0.1, max:1, min:0, type:'float'},
			feedback: {value:0.5, max:1, min:0, type:'float'},
			mix: {value:0.5, max:1, min:0, type:'float'}
		},
	},{
		id:'highpassfilter',
		name: 'Highpass Filter',
		defaults:{
			frequency: {value:350, max:22050, min:10, type:'integer'},
			peak: {value:0.0001, max:1000, min:0, type:'float'}
		},
	},{
		id:'j60chorus',
		name: 'J60 Chorus',
		defaults:{
			chorusI: {value:false, max:true, min:false, type:'boolean'},
			chorusII: {value:true, max:true, min:false, type:'boolean'},
			mix: {value:1, max:1, min:0, type:'float'}
		},
	},{
		id:'korg35hpf',
		name: 'Korg 35 HPF',
		defaults:{
			cutoff: {value:350, max:20000, min:20, type:'integer'},
			q: {value:1, max:10, min:0.5, type:'float'}
		},
	},{
		id:'korg35lpf',
		name: 'Korg 35 LPF',
		defaults:{
			cutoff: {value:350, max:20000, min:20, type:'integer'},
			q: {value:1, max:10, min:0.5, type:'float'}
		},
	},{
		id:'lowpassfilter',
		name: 'Lopass Filter',
		defaults:{
			frequency: {value:350, max:22050, min:10, type:'integer'},
			peak: {value:0.0001, max:1000, min:0, type:'float'}
		},
	},{
		id:'pingpongdelay',
		name: 'PingPong Delay',
		defaults:{
			feedback: {value:0.5, max:1, min:0, type:'float'},
			time: {value:0.3, max:1, min:0, type:'float'},
			mix: {value:0.5, max:1, min:0, type:'float'}
		},
	},{
		id:'quadrafuzz',
		name: 'QuadraFuzz',
		defaults:{
			lowGain: {value:0.6, max:1, min:0, type:'float'},
			midLowGain: {value:0.8, max:1, min:0, type:'float'},
			midHighGain: {value:0.5, max:1, min:0, type:'float'},
			highGain: {value:0.6, max:1, min:0, type:'float'}
		},
	},{
		id:'reverb',
		name: 'Reverb',
		defaults:{
			mix: {value:0.5, max:1, min:0, type:'float'},
			time: {value:0.001, max:1, min:0, type:'float'},
			decay: {value:0.1, max:10, min:0, type:'float'},
			reverse: {value:false, max:true, min:false, type:'boolean'}
		},
	},{
		id:'ringmodulator',
		name: 'Ring Modulator',
		defaults:{
			speed: {value:30, max:2000, min:0, type:'float'},
			distortion: {value:0.2, max:50, min:0.2, type:'float'},
			mix: {value:0.5, max:1, min:0, type:'float'},
		},
	},{
		id: 'stereopanner',
		name: 'Stereo Panner',
		defaults:{
			pan: {value:0, max:1, min:-1, type:'integer'}
		},
	},{
		id: 'stonephaser',
		name: 'Stone Phaser',
		defaults:{
			speed: {value:0.2, max:5, min:0.01, type:'float'},
			feedback: {value:0.75, max:0.99, min:0, type:'float'},
			feedbackBassCut: {value:500, max:5000, min:10, type:'integer'},
			mix: {value:0.5, max:1, min:0, type:'float'},
			color: {value:true, max:true, min:false, type:'boolean'},
			phase: {value:0, max:180, min:-180, type:'integer'}
		},
	},{
		id: 'tapedelay',
		name: 'Tape Delay',
		defaults:{
			time: {value:220, max:600, min:30, type:'float'},
			feedback: {value:0.5, max:1.05, min:0, type:'float'},
			mix: {value:0.5, max:1, min:0, type:'float'},
			head1: {value:true, max:true, min:false, type:'boolean'},
			head2: {value:false, max:true, min:false, type:'boolean'},
			head3: {value:false, max:true, min:false, type:'boolean'},
			density: {value:1, max:2, min:0.5, type:'float'},
			wowFlutter: {value:0.3, max:1, min:0, type:'float'},
			drive: {value:0.3, max:1, min:0, type:'float'},
			bass: {value:0, max:15, min:-15, type:'float'},
			treble: {value:0, max:15, min:-15, type:'float'},
			hiss: {value:0.1, max:1, min:0, type:'float'},
			tapeType: {value:0, max:2, min:0, type:'integer'},
			age: {value:0.2, max:1, min:0, type:'float'}
		},
	},{
		id: 'tremolo',
		name: 'Tremolo',
		defaults:{
			speed: {value:4, max:20, min:0, type:'integer'},
			depth: {value:0.5, max:1, min:0, type:'float'},
			mix: {value:0.5, max:1, min:0, type:'float'}
		},
	},
]

import Compressor from './compressor'
import Convolver from './convolver'
import Delay from './delay'
import Distortion from './distortion'
import DubDelay from './dubdelay'
import Flanger from './flanger'
import HighPassFilter from './highpassfilter'
import J60Chorus from './j60chorus'
import Korg35HighPassFilter from './korg35hpf'
import Korg35LowPassFilter from './korg35lpf'
import LowPassFilter from './lowpassfilter'
import PingPongDelay from './pingpongdelay'
import Quadrafuzz from './quadrafuzz'
import Reverb from './reverb'
import RingModulator from './ringmodulator'
import StereoPanner from './stereopanner'
import StonePhaser from './stonephaser'
import TapeDelay from './tapedelay'
import Tremolo from './tremolo'
import { Effect, type EffectDefaults } from './core'
import { ensureEffectsWorklet } from './worklet'

/** A catalog entry: an effect that can be added to a chain. */
export interface EffectDefinition {
	id: string;
	name: string;
	defaults: EffectDefaults;
}

/** Constructor for any concrete effect class. */
export type EffectCtor = new (
	context: AudioContext,
	options?: Record<string, any>,
) => Effect;

/** Lookup table: catalog id → concrete effect class. */
const EFFECT_CLASSES: Record<string, EffectCtor> = {
	delay: Delay,
	dubdelay: DubDelay,
	flanger: Flanger,
	reverb: Reverb,
	distortion: Distortion,
	compressor: Compressor,
	convolver: Convolver,
	pingpongdelay: PingPongDelay,
	tremolo: Tremolo,
	quadrafuzz: Quadrafuzz,
	stereopanner: StereoPanner,
	stonephaser: StonePhaser,
	ringmodulator: RingModulator,
	highpassfilter: HighPassFilter,
	lowpassfilter: LowPassFilter,
	j60chorus: J60Chorus,
	korg35hpf: Korg35HighPassFilter,
	korg35lpf: Korg35LowPassFilter,
	tapedelay: TapeDelay,
}

/**
 * Create a concrete effect by catalog id.
 *
 * Caller-supplied options win; only params that are `undefined`/`null` are
 * filled from the catalog defaults (so saved params survive a model load).
 * Awaits the worklet registration before constructing the node.
 *
 * @param id - catalog effect id (e.g. 'delay').
 * @param context - AudioContext the effect belongs to.
 * @param opt - initial parameter values.
 * @throws when `id` is not a known effect.
 */
const createEffect = async (id: string, context: AudioContext, opt: Record<string, any> = {}): Promise<Effect> => {
	const defs = EFFECTS.filter((eff) => eff.id === id)[0];
	if (!defs || !EFFECT_CLASSES[id]) throw new Error('Effect doesnt exist: ' + id);
	const options = { ...opt };
	// only fill in params the caller didn't supply — this used to overwrite
	// every value with the catalog default, so saved effect params passed in
	// from a model load were silently discarded
	Object.keys(defs.defaults).forEach((param) => {
		if (options[param] === undefined || options[param] === null)
			options[param] = defs.defaults[param].value;
	});
	// AudioWorkletNode construction requires the processor to be registered
	await ensureEffectsWorklet(context);
	return new EFFECT_CLASSES[id](context, options);
}

export { createEffect, Effect, EFFECTS, EFFECT_CLASSES }