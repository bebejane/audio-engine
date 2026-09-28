class FlangerProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		var maxSamp = Math.ceil(sampleRate * 0.05);
		this.dlyL = delayLine(maxSamp);
		this.dlyR = delayLine(maxSamp);
		this.frame = 0;
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var time = paramAt(parameters.time, 0);
		var speed = paramAt(parameters.speed, 0);
		var depth = paramAt(parameters.depth, 0);
		var fb = paramAt(parameters.feedback, 0);
		var mix = paramAt(parameters.mix, 0);
		var levels = mixLevels(mix);
		var base = 0.001 + 0.019 * time;
		var rate = 0.5 + 4.5 * speed;
		var dep = 0.0005 + 0.0045 * depth;
		var feed = 0.8 * fb;
		var i;
		for (i = 0; i < s.n; i++) {
			var t0 = this.frame + i;
			var mod = Math.sin(2 * Math.PI * rate * t0 / sampleRate);
			var tSamp = Math.max(0, (base + dep * mod) * sampleRate);
			var dL = this.dlyL.read(tSamp);
			var dR = this.dlyR.read(tSamp);
			var inFB = s.inL[i] + feed * dL;
			this.dlyL.write(inFB);
			var inFBR = s.inR[i] + feed * dR;
			this.dlyR.write(inFBR);
			s.outL[i] = s.inL[i] * levels.dry + (inFB + dL) * levels.wet;
			if (s.outR) s.outR[i] = s.inR[i] * levels.dry + (inFBR + dR) * levels.wet;
		}
		this.frame += s.n;
		return true;
	}
}
FlangerProcessor.parameterDescriptors = desc([['time', 0.45, 0, 1], ['speed', 0.2, 0, 1], ['depth', 0.1, 0, 1], ['feedback', 0.5, 0, 1], ['mix', 0.5, 0, 1]]);
registerProcessor('flanger', FlangerProcessor);
