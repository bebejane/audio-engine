class StereoPannerProcessor extends AudioWorkletProcessor {
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		var pan = ppv(parameters.pan, 0);
		var ang = (pan + 1) * Math.PI / 4;
		var gL = Math.cos(ang);
		var gR = Math.sin(ang);
		var i;
		for (i = 0; i < s.n; i++) {
			s.outL[i] = s.inL[i] * gL;
			if (s.outR) s.outR[i] = s.inR[i] * gR;
		}
		return true;
	}
}
StereoPannerProcessor.parameterDescriptors = ppDesc([['pan', 0, -1, 1]]);
registerProcessor('stereopanner', StereoPannerProcessor);
