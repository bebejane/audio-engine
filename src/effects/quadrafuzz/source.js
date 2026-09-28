class QuadrafuzzProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.lpL = biquad();
		this.bp1L = biquad();
		this.bp2L = biquad();
		this.hpL = biquad();
		this.lpR = biquad();
		this.bp1R = biquad();
		this.bp2R = biquad();
		this.hpR = biquad();
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var low = paramAt(parameters.lowGain, 0) * 150;
		var midLow = paramAt(parameters.midLowGain, 0) * 150;
		var midHigh = paramAt(parameters.midHighGain, 0) * 150;
		var high = paramAt(parameters.highGain, 0) * 150;
		this.lpL.set('lowpass', 147, 0.7071, sampleRate);
		this.bp1L.set('bandpass', 587, 0.7071, sampleRate);
		this.bp2L.set('bandpass', 2490, 0.7071, sampleRate);
		this.hpL.set('highpass', 4980, 0.7071, sampleRate);
		this.lpR.set('lowpass', 147, 0.7071, sampleRate);
		this.bp1R.set('bandpass', 587, 0.7071, sampleRate);
		this.bp2R.set('bandpass', 2490, 0.7071, sampleRate);
		this.hpR.set('highpass', 4980, 0.7071, sampleRate);
		var i;
		for (i = 0; i < s.n; i++) {
			var xL = s.inL[i];
			var yL = xL
				+ distort(this.lpL.process(xL), low)
				+ distort(this.bp1L.process(xL), midLow)
				+ distort(this.bp2L.process(xL), midHigh)
				+ distort(this.hpL.process(xL), high);
			s.outL[i] = yL;
			if (s.outR) {
				var xR = s.inR[i];
				s.outR[i] = xR
					+ distort(this.lpR.process(xR), low)
					+ distort(this.bp1R.process(xR), midLow)
					+ distort(this.bp2R.process(xR), midHigh)
					+ distort(this.hpR.process(xR), high);
			}
		}
		return true;
	}
}
QuadrafuzzProcessor.parameterDescriptors = desc([['lowGain', 0.6, 0, 1], ['midLowGain', 0.8, 0, 1], ['midHighGain', 0.5, 0, 1], ['highGain', 0.6, 0, 1]]);
registerProcessor('quadrafuzz', QuadrafuzzProcessor);
