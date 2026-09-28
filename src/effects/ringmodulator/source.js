class RingModulatorProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.frame = 0;
		this.compL = ppCompressorState();
		this.compR = ppCompressorState();
	}
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		var speed = Math.max(0.001, ppv(parameters.speed, 0));
		var h = ppv(parameters.distortion, 0);
		var mix = ppv(parameters.mix, 0);
		var levels = ppMixLevels(mix);
		var i;
		for (i = 0; i < s.n; i++) {
			var t0 = this.frame + i;
			var c = Math.sin(2 * Math.PI * speed * t0 / sampleRate);
			var g = 0.5 * c;
			var carrier = -(ppDiode(h, g) + ppDiode(h, -g));
			var wL = this.compL(
				carrier + ppDiode(h, g + s.inL[i]) + ppDiode(h, -(g + s.inL[i])),
				sampleRate, -24, 30, 16, 0.003, 0.25,
			) * 3;
			s.outL[i] = s.inL[i] * levels.dry + wL * levels.wet;
			if (s.outR) {
				var wR = this.compR(
					carrier + ppDiode(h, g + s.inR[i]) + ppDiode(h, -(g + s.inR[i])),
					sampleRate, -24, 30, 16, 0.003, 0.25,
				) * 3;
				s.outR[i] = s.inR[i] * levels.dry + wR * levels.wet;
			}
		}
		this.frame += s.n;
		return true;
	}
}
RingModulatorProcessor.parameterDescriptors = ppDesc([['speed', 30, 0, 2000], ['distortion', 0.2, 0.2, 50], ['mix', 0.5, 0, 1]]);
registerProcessor('ringmodulator', RingModulatorProcessor);
