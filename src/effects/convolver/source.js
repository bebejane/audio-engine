class ConvolverProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.convL = convolver();
		this.convR = null;
		this.pending = null;
		this.port.onmessage = function (e) {
			if (e.data && e.data.type === 'ir') {
				var ch = e.data.channels || [];
				if (!this.convR && ch.length > 1) this.convR = convolver();
				this.convL.setIr(ch[0] || new Float32Array(1));
				if (this.convR) this.convR.setIr(ch[1] || ch[0] || new Float32Array(1));
			}
		}.bind(this);
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		var mix = paramAt(parameters.mix, 0);
		var levels = mixLevels(mix);
		this.convL.processBlock(s.inL, s.outL);
		var i;
		for (i = 0; i < s.n; i++) s.outL[i] = s.inL[i] * levels.dry + s.outL[i] * levels.wet;
		if (s.outR) {
			if (this.convR) {
				this.convR.processBlock(s.inR, s.outR);
				for (i = 0; i < s.n; i++) s.outR[i] = s.inR[i] * levels.dry + s.outR[i] * levels.wet;
			} else {
				for (i = 0; i < s.n; i++) s.outR[i] = s.inR[i] * levels.dry + s.inR[i] * levels.wet;
			}
		}
		return true;
	}
}
ConvolverProcessor.parameterDescriptors = desc([['mix', 0.5, 0, 1]]);
registerProcessor('convolver', ConvolverProcessor);
