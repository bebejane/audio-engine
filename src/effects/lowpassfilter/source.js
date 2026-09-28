class LowPassProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.type = 'lowpass';
		this.bqL = biquad();
		this.bqR = biquad();
	}
	process(inputs, outputs, parameters) {
		var s = setupStereo(inputs, outputs);
		if (!s) return true;
		filterProcess(this, s, parameters);
		return true;
	}
}
LowPassProcessor.parameterDescriptors = desc([['frequency', 350, 10, 22050], ['peak', 0.0001, 0, 1000]]);
registerProcessor('lowpassfilter', LowPassProcessor);
