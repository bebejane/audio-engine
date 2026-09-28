class QuadrafuzzProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.lpL = ppBiquad();
		this.bp1L = ppBiquad();
		this.bp2L = ppBiquad();
		this.hpL = ppBiquad();
		this.lpR = ppBiquad();
		this.bp1R = ppBiquad();
		this.bp2R = ppBiquad();
		this.hpR = ppBiquad();
	}
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		var low = ppv(parameters.lowGain, 0) * 150;
		var midLow = ppv(parameters.midLowGain, 0) * 150;
		var midHigh = ppv(parameters.midHighGain, 0) * 150;
		var high = ppv(parameters.highGain, 0) * 150;
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
				+ ppDistort(this.lpL.process(xL), low)
				+ ppDistort(this.bp1L.process(xL), midLow)
				+ ppDistort(this.bp2L.process(xL), midHigh)
				+ ppDistort(this.hpL.process(xL), high);
			s.outL[i] = yL;
			if (s.outR) {
				var xR = s.inR[i];
				s.outR[i] = xR
					+ ppDistort(this.lpR.process(xR), low)
					+ ppDistort(this.bp1R.process(xR), midLow)
					+ ppDistort(this.bp2R.process(xR), midHigh)
					+ ppDistort(this.hpR.process(xR), high);
			}
		}
		return true;
	}
}
QuadrafuzzProcessor.parameterDescriptors = ppDesc([['lowGain', 0.6, 0, 1], ['midLowGain', 0.8, 0, 1], ['midHighGain', 0.5, 0, 1], ['highGain', 0.6, 0, 1]]);
registerProcessor('quadrafuzz', QuadrafuzzProcessor);
