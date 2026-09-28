class LowPassProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.type = 'lowpass';
		this.bqL = ppBiquad();
		this.bqR = ppBiquad();
	}
	process(inputs, outputs, parameters) {
		var s = ppSetupStereo(inputs, outputs);
		if (!s) return true;
		ppFilterProcess(this, s, parameters);
		return true;
	}
}
LowPassProcessor.parameterDescriptors = ppDesc([['frequency', 350, 10, 22050], ['peak', 0.0001, 0, 1000]]);
registerProcessor('lowpassfilter', LowPassProcessor);
