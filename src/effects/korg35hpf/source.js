var Korg35HPFProcessor = korg35Processor('hpf');
Korg35HPFProcessor.parameterDescriptors = desc([['cutoff', 20000, 20, 20000], ['q', 1, 0.5, 10]]);
registerProcessor('korg35hpf', Korg35HPFProcessor);
