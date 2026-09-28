/**
 * Effects AudioWorklet loader.
 *
 * `ensureEffectsWorklet` registers every effect processor (delay,
 * flanger, …) on a given AudioContext once, via a Blob URL — the same
 * delivery trick the recorder worklet uses (audioWorklet.addModule requires a
 * JS MIME type). Effect classes then get an AudioWorkletNode per instance.
 */
import { EFFECTS_WORKLET_SOURCE } from './workletsource.generated'

const workletPromises = new WeakMap<AudioContext, Promise<void>>();

/** Fetch the generated source as a Blob URL and register it on `context`. */
const loadEffectsWorklet = async (context: AudioContext): Promise<void> => {
	const blob = new Blob([EFFECTS_WORKLET_SOURCE], { type: 'text/javascript' });
	const url = URL.createObjectURL(blob);
	try {
		await context.audioWorklet.addModule(url);
	} finally {
		URL.revokeObjectURL(url);
	}
};

/**
 * Register the effects worklet on `context` (idempotent per context).
 * Effect construction must await this before creating an AudioWorkletNode.
 */
export const ensureEffectsWorklet = (context: AudioContext): Promise<void> => {
	let promise = workletPromises.get(context);
	if (!promise) {
		promise = loadEffectsWorklet(context).catch((err) => {
			workletPromises.delete(context);
			throw err;
		});
		workletPromises.set(context, promise);
	}
	return promise;
};

/**
 * Build the AudioWorkletNode backing one effect instance. `parameters` maps
 * effect-default keys to initial values (ignored keys are discarded by the
 * AudioWorklet machinery). Prefer stereo output so the chain downstream keeps
 * two channels; fall back gracefully where outputChannelCount is unsupported.
 */
export const createWorkletEffectNode = (
	context: AudioContext,
	processorId: string,
	parameters: Record<string, number>,
): AudioWorkletNode => {
	const base: AudioWorkletNodeOptions = {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		parameterData: parameters,
	};
	try {
		return new AudioWorkletNode(context, processorId, {
			...base,
			outputChannelCount: [2],
		});
	} catch (err) {
		return new AudioWorkletNode(context, processorId, base);
	}
};