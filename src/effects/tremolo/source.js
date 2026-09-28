class TremoloProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.frame = 0;
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var speed = paramAt(parameters.speed, 0);
		var depth = paramAt(parameters.depth, 0);
		var mix = paramAt(parameters.mix, 0);
		var levels = mixLevels(mix);
		var i;
		for (i = 0; i < s.n; i++) {
			var t0 = this.frame + i;
			var g = (1 - depth) + depth * (0.5 * (1 + Math.sin(2 * Math.PI * speed * t0 / sampleRate)));
			s.outL[i] = s.inL[i] * levels.dry + s.inL[i] * g * levels.wet;
			if (s.outR) s.outR[i] = s.inR[i] * levels.dry + s.inR[i] * g * levels.wet;
		}
		this.frame += s.n;
		return true;
	}
}
TremoloProcessor.parameterDescriptors = desc([['speed', 4, 0, 20], ['depth', 0.5, 0, 1], ['mix', 0.5, 0, 1]]);
registerProcessor('tremolo', TremoloProcessor);
