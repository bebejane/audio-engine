var PPKorg35LPFProcessor = ppKorg35Processor('lpf');
PPKorg35LPFProcessor.parameterDescriptors = ppDesc([['cutoff', 20000, 20, 20000], ['q', 1, 0.5, 10]]);
registerProcessor('pp-korg35lpf', PPKorg35LPFProcessor);
