class DistortionProcessor extends AudioWorkletProcessor {
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var gain = paramAt(parameters.gain, 0) * 100;
		var i;
		for (i = 0; i < s.n; i++) {
			s.outL[i] = distort(s.inL[i], gain);
			if (s.outR) s.outR[i] = distort(s.inR[i], gain);
		}
		return true;
	}
}
DistortionProcessor.parameterDescriptors = desc([['gain', 0.5, 0, 1]]);
registerProcessor('distortion', DistortionProcessor);
