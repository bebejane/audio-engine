class CompressorProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.compL = compressorState();
		this.compR = compressorState();
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var threshold = paramAt(parameters.threshold, 0);
		var knee = paramAt(parameters.knee, 0);
		var ratio = paramAt(parameters.ratio, 0);
		var attack = paramAt(parameters.attack, 0);
		var release = paramAt(parameters.release, 0);
		var i;
		for (i = 0; i < s.n; i++) {
			s.outL[i] = this.compL(s.inL[i], sampleRate, threshold, knee, ratio, attack, release);
			if (s.outR) s.outR[i] = this.compR(s.inR[i], sampleRate, threshold, knee, ratio, attack, release);
		}
		return true;
	}
}
CompressorProcessor.parameterDescriptors = desc([['threshold', -24, -100, 0], ['knee', 30, 0, 40], ['attack', 0, 0, 1], ['release', 0.25, 0, 1], ['ratio', 1, 0, 20]]);
registerProcessor('compressor', CompressorProcessor);
