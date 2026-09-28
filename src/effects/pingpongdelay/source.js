class PingPongProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.dlyA = ppDelayLine(Math.ceil(sampleRate * 2));
		this.dlyB = ppDelayLine(Math.ceil(sampleRate * 2));
	}
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		var fb = ppv(parameters.feedback, 0);
		var mix = ppv(parameters.mix, 0);
		var levels = ppMixLevels(mix);
		var maxDelay = this.dlyA.size - 2;
		var i;
		for (i = 0; i < s.n; i++) {
			var tSamp = Math.max(0, Math.min(maxDelay, ppv(parameters.time, i) * sampleRate));
			// single mono chain (like the native mono node graph): the input is
			// downmixed, fed into line A, whose output feeds line B (the ping-pong)
			var m = (s.inL[i] + s.inR[i]) * 0.5;
			var a = this.dlyA.read(tSamp);
			var b = this.dlyB.read(tSamp);
			this.dlyA.write(m + fb * b);
			this.dlyB.write(a);
			s.outL[i] = s.inL[i] * levels.dry + a * levels.wet;
			if (s.outR) s.outR[i] = s.inR[i] * levels.dry + b * levels.wet;
		}
		return true;
	}
}
PingPongProcessor.parameterDescriptors = ppDesc([['feedback', 0.5, 0, 1], ['time', 0.3, 0, 2], ['mix', 0.5, 0, 1]]);
registerProcessor('pingpongdelay', PingPongProcessor);
