class HighPassProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.type = 'highpass';
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
HighPassProcessor.parameterDescriptors = desc([['frequency', 350, 10, 22050], ['peak', 0.0001, 0, 1000]]);
registerProcessor('highpassfilter', HighPassProcessor);
