// Browser shim for `webmidi` — the stress page never initializes MIDI.
export const WebMidi = {
	enabled: false,
	inputs: [],
	outputs: [],
	addListener() {},
	removeListener() {},
	enable: async () => {},
	disable: () => {},
};

export default { WebMidi };
