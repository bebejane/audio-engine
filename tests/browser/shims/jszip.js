// Browser shim for `jszip`. The stress page does not exercise model
// save/load (that needs real zip I/O), so any use fails loudly.
export default class JSZip {
	constructor() {
		this.files = {};
	}
	file() {
		return this;
	}
	async generateAsync() {
		throw new Error('JSZip is not bundled in the stress page (model I/O disabled)');
	}
	static async loadAsync() {
		throw new Error('JSZip is not bundled in the stress page (model I/O disabled)');
	}
}
