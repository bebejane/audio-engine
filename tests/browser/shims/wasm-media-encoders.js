// Browser shim for `wasm-media-encoders` — only reached if an MP3 encode is
// requested. WAV recording works without it.
export const createEncoder = async () => {
	throw new Error('wasm-media-encoders is not bundled in the stress page');
};

export default { createEncoder };
