/**
 * Compile-time contract check (type-only, no runtime imports/side effects).
 *
 * The WebAudio-heavy engine internals (Sound, Analyser, Recorder, …) keep
 * `// @ts-nocheck`, so an `implements` clause on them would be ignored. These
 * assertions force the now-checked `AudioEngine`/`Master` classes to satisfy
 * the hand-written facade in `types.ts`, so dropping a method the app calls or
 * letting the facade drift fails `tsc`.
 */
import type { AudioEngine, MasterLike } from './types';

type Assert<T extends true> = T;

export type EngineMatchesFacade = Assert<
	import('./audioengine').default extends AudioEngine ? true : false
>;

export type MasterMatchesFacade = Assert<
	import('./master').default extends MasterLike ? true : false
>;
