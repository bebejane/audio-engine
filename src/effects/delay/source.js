class PPDelayProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		var maxSamp = Math.ceil(sampleRate * 2);
		this.dlyL = ppDelayLine(maxSamp);
		this.dlyR = ppDelayLine(maxSamp);
	}
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		var fb = ppv(parameters.feedback, 0);
		var mix = ppv(parameters.mix, 0);
		var levels = ppMixLevels(mix);
		var maxDelay = this.dlyL.size - 2;
		var i;
		for (i = 0; i < s.n; i++) {
			var tSamp = Math.max(0, Math.min(maxDelay, ppv(parameters.time, i) * sampleRate));
			var dL = this.dlyL.read(tSamp);
			var dR = this.dlyR.read(tSamp);
			this.dlyL.write(s.inL[i] + fb * dL);
			this.dlyR.write(s.inR[i] + fb * dR);
			s.outL[i] = s.inL[i] * levels.dry + dL * levels.wet;
			if (s.outR) s.outR[i] = s.inR[i] * levels.dry + dR * levels.wet;
		}
		return true;
	}
}
PPDelayProcessor.parameterDescriptors = ppDesc([['feedback', 0.5, 0, 1], ['time', 0.1, 0, 2], ['mix', 0.5, 0, 1]]);
registerProcessor('pp-delay', PPDelayProcessor);
