class CompressorProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.compL = ppCompressorState();
		this.compR = ppCompressorState();
	}
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		var threshold = ppv(parameters.threshold, 0);
		var knee = ppv(parameters.knee, 0);
		var ratio = ppv(parameters.ratio, 0);
		var attack = ppv(parameters.attack, 0);
		var release = ppv(parameters.release, 0);
		var i;
		for (i = 0; i < s.n; i++) {
			s.outL[i] = this.compL(s.inL[i], sampleRate, threshold, knee, ratio, attack, release);
			if (s.outR) s.outR[i] = this.compR(s.inR[i], sampleRate, threshold, knee, ratio, attack, release);
		}
		return true;
	}
}
CompressorProcessor.parameterDescriptors = ppDesc([['threshold', -24, -100, 0], ['knee', 30, 0, 40], ['attack', 0, 0, 1], ['release', 0.25, 0, 1], ['ratio', 1, 0, 20]]);
registerProcessor('compressor', CompressorProcessor);
