/**
 * Public entry for the PurplePurples audio engine.
 *
 * Exposes the `AudioEngine` class, the typed facade the app programs against
 * (`AudioEngineFacade`), its options, the effect/model types, and the small
 * helpers the app shares with the engine.
 */
export { default } from './audioengine';
export { default as AudioEngine } from './audioengine';
export * from './utils';

export type {
	AudioEngine as AudioEngineFacade,
	AudioEngineOptions,
	AudioEngineEvents,
	EffectDef,
	EffectParamDef,
	EffectEntry,
	EffectSnapshot,
	ProcessSampleOptions,
	MediaDeviceInfoLike,
	MidiDeviceInfoLike,
	MasterLike,
	AutomationLike,
	SoundLike,
	RawSound,
	Model,
	ModelFile,
	ModelMeta,
	Preset,
	PresetSlot,
	PresetSound,
	SoundSettings,
} from './types';
