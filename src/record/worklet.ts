/**
 * Recorder AudioWorklet processor source, loaded via a Blob URL (see
 * Recorder#initProcessor). Kept as a string so it can be delivered as
 * text/javascript regardless of how the bundler hashes/emits assets
 * (`audioWorklet.addModule` requires a JS MIME type, which raw `.ts` assets
 * don't get). Input is passed through to the output so the source stays
 * audible while recording, exactly like the old ScriptProcessorNode.
 */
export const RECORDER_WORKLET_SOURCE = `
const CHUNK_SIZE = 16384;
/** AudioWorklet processor that buffers input PCM and posts it in chunks. */
class RecorderProcessor extends AudioWorkletProcessor {
	/** Create the processor with an empty per-channel buffer. */
	constructor() {
		super();
		this.channels = [];
	}
	/** Post the accumulated per-channel chunks to the main thread and clear. */
	flush() {
		if (!this.channels.length || !this.channels[0].length) return;
		const n = Math.max(1, this.channelCount || this.channels.length || 1);
		const buffers = [];
		for (let c = 0; c < n; c++) {
			buffers[c] = this.channels[c] ? new Float32Array(this.channels[c]) : new Float32Array(0);
		}
		this.channels = [];
		this.port.postMessage({ buffer: buffers });
	}
	/** Buffer incoming samples, pass input through, flush every CHUNK_SIZE frames. */
	process(inputs, outputs) {
		const input = inputs[0] || [];
		for (let c = 0; c < input.length; c++) {
			const ch = input[c];
			if (!ch || !ch.length) continue;
			if (!this.channels[c]) this.channels[c] = [];
			const target = this.channels[c];
			for (let i = 0; i < ch.length; i++) target.push(ch[i]);
		}
		const output = outputs[0] || [];
		for (let c = 0; c < output.length; c++) {
			if (input[c] && output[c]) output[c].set(input[c]);
		}
		if (this.channels[0] && this.channels[0].length >= CHUNK_SIZE) this.flush();
		return true;
	}
}
registerProcessor('recorder', RecorderProcessor);
`;

export default RECORDER_WORKLET_SOURCE;

const workletPromises = new WeakMap<AudioContext, Promise<void>>();

/** Blob-URL register the recorder worklet source on `context` once. */
const loadRecorderWorklet = async (context: AudioContext): Promise<void> => {
	const blob = new Blob([RECORDER_WORKLET_SOURCE], { type: 'text/javascript' });
	const url = URL.createObjectURL(blob);
	try {
		await context.audioWorklet.addModule(url);
	} finally {
		URL.revokeObjectURL(url);
	}
};

/**
 * Register the recorder worklet on `context` (idempotent per context).
 *
 * The engine owns two Recorder instances (master + sampler) on the same
 * AudioContext; each one calls `audioWorklet.addModule`, so without this guard
 * the second load re-runs `registerProcessor('recorder')` in the
 * same worklet scope and throws "recorder is already registered".
 */
export const ensureRecorderWorklet = (context: AudioContext): Promise<void> => {
	let promise = workletPromises.get(context);
	if (!promise) {
		promise = loadRecorderWorklet(context).catch((err) => {
			workletPromises.delete(context);
			throw err;
		});
		workletPromises.set(context, promise);
	}
	return promise;
};