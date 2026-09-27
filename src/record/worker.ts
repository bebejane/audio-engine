// @ts-nocheck
import wavEncoder from '../encoders/wav';

let channels = 2;
let sampleR = 44100;
let buffer;
let length = 0;
let stopped = false;
let started = false;

const reset = () => {
	length = 0;
	buffer = [[], []];
	stopped = true;
	started = false;
};

self.onmessage = (event: MessageEvent) => {
	const { stop, start, cancel, numChannels, sampleRate } = event.data;
	if (cancel) {
		console.log('RecordWorker: cancel recorder');
		reset();
		return self.postMessage({ cancelled: true });
	}
	if (numChannels) channels = numChannels;
	if (sampleRate) sampleR = sampleRate;

	if (start) {
		reset();
		stopped = false;
		started = true;
		console.log('RecordWorker: start recorder', 'channels=', channels, sampleR);
	}
	if (stop) {
		if (stopped) return;
		stopped = true;
		if (!buffer || buffer[0].length === 0) return reset();
		console.log('recorderWorker', 'STOPPED');
		const copy = new Array(channels);
		for (var c = 0; c < channels; c++) {
			copy[c] = new Float32Array(length);
			for (var i = 0, pos = 0; i < buffer[c].length; i++)
				for (var x = 0; x < buffer[c][i].length; pos++, x++) copy[c][pos] = buffer[c][i][x];
		}
		console.log('RecorderWorker', 'encode wav');
		wavEncoder(copy, { numChannels: channels, sampleRate: sampleR })
			.then((wav) => {
				self.postMessage({ blob: wav, buffer: copy });
			})
			.catch((err) => {
				self.postMessage({ error: err });
			})
			.then(() => {
				console.log('RecordWorker: Done');
				reset();
			});
		return;
	}

	if (!event.data.buffer || !event.data.buffer.length || !buffer || stopped || !started) return;

	for (var i = 0; i < channels; i++) {
		const ch = event.data.buffer[i];
		// a mono source can deliver fewer channels than `channels`; skip holes
		// so stop() never reads undefined
		if (ch) buffer[i].push(ch);
	}

	length += event.data.buffer[0].length;
	return;
};

export {};