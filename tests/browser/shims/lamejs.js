// Browser shim for `lamejs` — only reached if an MP3 encode is requested.
class Mp3Encoder {
	constructor() {
		throw new Error('lamejs is not bundled in the stress page');
	}
}

export default { Mp3Encoder };
export { Mp3Encoder };
