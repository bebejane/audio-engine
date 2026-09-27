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
			threshold: {value:-24, max:0, min:-100, type:'integer', name:'Threshold'},
			knee: {value:30, max:40, min:0, type:'integer', name:'Knee'},
			attack: {value:0, max:1, min:0, type:'integer', name:'Attack'},
			release: {value:0.250, max:1, min:0, type:'integer', name:'Release'},
			ratio: {value:1, max:20, min:0, type:'integer', name:'Ratio'}
		}
	},{
		id:'convolver',
		name: 'Convolver',
		defaults: {
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'}
		},
	},{
		id:'delay',
		name: 'Delay',
		defaults:{
			feedback: {value:0.5, max:1, min:0, type:'float', name:'Feedback'},
			time: {value:0.1, max:1.0, min:0, type:'float', name:'Time'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'}
		},
	},{
		id:'distortion',
		name: 'Distortion',
		defaults:{
		gain: {
			value:0.5, max:1, min:0, type:'float', name:'Gain'}
		},
	},{
		id:'dubdelay',
		name: 'Dub Delay',
		defaults:{
			feedback: {value:0.6, max:1, min:0, type:'float', name:'Feedback'},
			time: {value:0.7, max:180.0, min:0, type:'float', name:'Time'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'},
			cutoff: {value:700, max:4000, min:0, type:'integer', name:'Cutoff Frequency'}
		},
	},{
		id:'flanger',
		name: 'Flanger',
		defaults:{
			time: {value:0.45, max:1, min:0, type:'float', name:'Delay Time'},
			speed: {value:0.2, max:1, min:0, type:'float', name:'LFO Rate'},
			depth: {value:0.1, max:1, min:0, type:'float', name:'Depth'},
			feedback: {value:0.5, max:1, min:0, type:'float', name:'Feedback'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'}
		},
	},{
		id:'highpassfilter',
		name: 'Highpass Filter',
		defaults:{
			frequency: {value:350, max:22050, min:10, type:'integer', name:'Frequency'},
			peak: {value:0.0001, max:1000, min:0, type:'float', name:'Peak'}
		},
	},{
		id:'j60chorus',
		name: 'J60 Chorus',
		defaults:{
			chorusI: {value:false, max:true, min:false, type:'boolean', name:'Chorus I'},
			chorusII: {value:true, max:true, min:false, type:'boolean', name:'Chorus II'},
			mix: {value:1, max:1, min:0, type:'float', name:'Mix'}
		},
	},{
		id:'korg35hpf',
		name: 'Korg 35 HPF',
		defaults:{
			cutoff: {value:350, max:20000, min:20, type:'integer', name:'Cutoff'},
			q: {value:1, max:10, min:0.5, type:'float', name:'Q'}
		},
	},{
		id:'korg35lpf',
		name: 'Korg 35 LPF',
		defaults:{
			cutoff: {value:350, max:20000, min:20, type:'integer', name:'Cutoff'},
			q: {value:1, max:10, min:0.5, type:'float', name:'Q'}
		},
	},{
		id:'lowpassfilter',
		name: 'Lopass Filter',
		defaults:{
			frequency: {value:350, max:22050, min:10, type:'integer', name:'Frequency'},
			peak: {value:0.0001, max:1000, min:0, type:'float', name:'Peak'}
		},
	},{
		id:'magnetictape',
		name: 'Magnetic Tape Emulation',
		defaults:{
			inputDrive: {value:0.5, max:1, min:0, type:'float', name:'Input Drive'},
			outputLevel: {value:0.5, max:1, min:0, type:'float', name:'Output Level'},
			shame: {value:0, max:1, min:0, type:'float', name:'Shame'},
			age: {value:0, max:1, min:0, type:'float', name:'Age'},
			hiss: {value:0, max:1, min:0, type:'float', name:'Hiss'},
			mix: {value:1, max:1, min:0, type:'float', name:'Mix'},
			flange: {value:0, max:1, min:0, type:'float', name:'Flange'}
		},
	},{
		id:'pingpongdelay',
		name: 'PingPong Delay',
		defaults:{
			feedback: {value:0.5, max:1, min:0, type:'float', name:'Feedback'},
			time: {value:0.3, max:1, min:0, type:'float', name:'Time'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'}
		},
	},{
		id:'quadrafuzz',
		name: 'QuadraFuzz',
		defaults:{
			lowGain: {value:0.6, max:1, min:0, type:'float', name:'Low Gain'},
			midLowGain: {value:0.8, max:1, min:0, type:'float', name:'Low-Mid Gain'},
			midHighGain: {value:0.5, max:1, min:0, type:'float', name:'High-Mid Gain'},
			highGain: {value:0.6, max:1, min:0, type:'float', name:'High Gain'}
		},
	},{
		id:'reverb',
		name: 'Reverb',
		defaults:{
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'},
			time: {value:0.001, max:1, min:0, type:'float', name:'Time'},
			decay: {value:0.1, max:10, min:0, type:'float', name:'Decay'},
			reverse: {value:false, max:true, min:false, type:'boolean', name:'Reverse'}
		},
	},{
		id:'ringmodulator',
		name: 'Ring Modulator',
		defaults:{
			speed: {value:30, max:2000, min:0, type:'float', name:'Speed'},
			distortion: {value:0.2, max:50, min:0.2, type:'float', name:'Distortion'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'},
		},
	},{
		id: 'stereopanner',
		name: 'Stereo Panner',
		defaults:{
			pan: {value:0, max:1, min:-1, type:'integer', name:'Pan'}
		},
	},{
		id: 'stonephaser',
		name: 'Stone Phaser',
		defaults:{
			speed: {value:0.2, max:5, min:0.01, type:'float', name:'Speed'},
			feedback: {value:0.75, max:0.99, min:0, type:'float', name:'Feedback'},
			feedbackBassCut: {value:500, max:5000, min:10, type:'integer', name:'Feedback Bass Cut'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'},
			color: {value:true, max:true, min:false, type:'boolean', name:'Color'},
			phase: {value:0, max:180, min:-180, type:'integer', name:'Phase'}
		},
	},{
		id: 'tapedelay',
		name: 'Tape Delay',
		defaults:{
			time: {value:220, max:600, min:30, type:'float', name:'Time'},
			feedback: {value:0.5, max:1.05, min:0, type:'float', name:'Feedback'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'},
			head1: {value:true, max:true, min:false, type:'boolean', name:'Head 1'},
			head2: {value:false, max:true, min:false, type:'boolean', name:'Head 2'},
			head3: {value:false, max:true, min:false, type:'boolean', name:'Head 3'},
			density: {value:1, max:2, min:0.5, type:'float', name:'Density'},
			wowFlutter: {value:0.3, max:1, min:0, type:'float', name:'Wow/Flutter'},
			drive: {value:0.3, max:1, min:0, type:'float', name:'Drive'},
			bass: {value:0, max:15, min:-15, type:'float', name:'Bass'},
			treble: {value:0, max:15, min:-15, type:'float', name:'Treble'},
			hiss: {value:0.1, max:1, min:0, type:'float', name:'Hiss'},
			tapeType: {value:0, max:2, min:0, type:'integer', name:'Tape Type'},
			age: {value:0.2, max:1, min:0, type:'float', name:'Age'}
		},
	},{
		id:'tapesaturation',
		name: 'Tape Saturation',
		defaults:{
			drive: {value:0.25, max:1, min:0, type:'float', name:'Drive'},
			warmth: {value:0.35, max:1, min:0, type:'float', name:'Warmth'},
			bias: {value:0, max:1, min:-1, type:'float', name:'Bias'},
			character: {value:0, max:2, min:0, type:'integer', name:'Tape / Console / Valve'},
			quality: {value:true, max:true, min:false, type:'boolean', name:'HQ (ADAA)'},
			mix: {value:1, max:1, min:0, type:'float', name:'Mix'},
			output: {value:0, max:1, min:-1, type:'float', name:'Output'}
		},
	},{
		id: 'tremolo',
		name: 'Tremolo',
		defaults:{
			speed: {value:4, max:20, min:0, type:'integer', name:'Speed'},
			depth: {value:0.5, max:1, min:0, type:'float', name:'Depth'},
			mix: {value:0.5, max:1, min:0, type:'float', name:'Mix'}
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
import MagneticTape from './magnetictape'
import PingPongDelay from './pingpongdelay'
import Quadrafuzz from './quadrafuzz'
import Reverb from './reverb'
import RingModulator from './ringmodulator'
import StereoPanner from './stereopanner'
import StonePhaser from './stonephaser'
import TapeDelay from './tapedelay'
import TapeSaturation from './tapesaturation'
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
	magnetictape: MagneticTape,
	j60chorus: J60Chorus,
	korg35hpf: Korg35HighPassFilter,
	korg35lpf: Korg35LowPassFilter,
	tapedelay: TapeDelay,
	tapesaturation: TapeSaturation,
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