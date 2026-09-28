var Korg35LPFProcessor = ppKorg35Processor('lpf');
Korg35LPFProcessor.parameterDescriptors = ppDesc([['cutoff', 20000, 20, 20000], ['q', 1, 0.5, 10]]);
registerProcessor('korg35lpf', Korg35LPFProcessor);
