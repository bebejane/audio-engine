var PPKorg35HPFProcessor = ppKorg35Processor('hpf');
PPKorg35HPFProcessor.parameterDescriptors = ppDesc([['cutoff', 20000, 20, 20000], ['q', 1, 0.5, 10]]);
registerProcessor('pp-korg35hpf', PPKorg35HPFProcessor);
