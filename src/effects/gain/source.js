// Output gain. `gain` is in decibels (0 dB = unity), converted to a linear
// multiplier per sample so AudioParam automation is honoured sample-accurately.
class GainProcessor extends AudioWorkletProcessor {
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var i, g;
		for (i = 0; i < s.n; i++) {
			g = Math.pow(10, paramAt(parameters.gain, i) / 20);
			s.outL[i] = s.inL[i] * g;
			if (s.outR) s.outR[i] = s.inR[i] * g;
		}
		return true;
	}
}
GainProcessor.parameterDescriptors = desc([['gain', 0, -60, 24]]);
registerProcessor('gain', GainProcessor);
