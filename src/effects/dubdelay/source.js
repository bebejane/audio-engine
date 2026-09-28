class DubDelayProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.dlyL = delayLine(Math.ceil(sampleRate * 2));
		this.dlyR = delayLine(Math.ceil(sampleRate * 2));
		this.lpL = biquad();
		this.lpR = biquad();
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var fb = paramAt(parameters.feedback, 0);
		var mix = paramAt(parameters.mix, 0);
		var cutoff = paramAt(parameters.cutoff, 0);
		var levels = mixLevels(mix);
		var maxDelay = this.dlyL.size - 2;
		this.lpL.set('lowpass', cutoff, 1, sampleRate);
		this.lpR.set('lowpass', cutoff, 1, sampleRate);
		var i;
		for (i = 0; i < s.n; i++) {
			var tSamp = Math.max(0, Math.min(maxDelay, paramAt(parameters.time, i) * sampleRate));
			var dL = this.dlyL.read(tSamp);
			var dR = this.dlyR.read(tSamp);
			var fL = this.lpL.process(fb * (s.inL[i] + dL));
			var fR = this.lpR.process(fb * (s.inR[i] + dR));
			this.dlyL.write(fL);
			this.dlyR.write(fR);
			s.outL[i] = s.inL[i] * levels.dry + (s.inL[i] + dL) * levels.wet;
			if (s.outR) s.outR[i] = s.inR[i] * levels.dry + (s.inR[i] + dR) * levels.wet;
		}
		return true;
	}
}
DubDelayProcessor.parameterDescriptors = desc([['feedback', 0.6, 0, 1], ['time', 0.7, 0, 2], ['mix', 0.5, 0, 1], ['cutoff', 700, 0, 4000]]);
registerProcessor('dubdelay', DubDelayProcessor);
