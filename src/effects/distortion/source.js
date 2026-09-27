class PPDistortionProcessor extends AudioWorkletProcessor {
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		var gain = ppv(parameters.gain, 0) * 100;
		var i;
		for (i = 0; i < s.n; i++) {
			s.outL[i] = ppDistort(s.inL[i], gain);
			if (s.outR) s.outR[i] = ppDistort(s.inR[i], gain);
		}
		return true;
	}
}
PPDistortionProcessor.parameterDescriptors = ppDesc([['gain', 0.5, 0, 1]]);
registerProcessor('pp-distortion', PPDistortionProcessor);
