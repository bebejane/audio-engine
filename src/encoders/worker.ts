// @ts-nocheck
import wavEncoder from '../encoders/wav';
import mp3Encoder from '../encoders/mp3';

let options = null;

self.onmessage = (event: MessageEvent) => {
	if (event.data.progress !== undefined) return self.postMessage(event.data.progress);
	if (event.data.options) options = event.data.options;

	if (!event.data.buffer) return;

	const time = Date.now();
	const encoder = event.data.format === 'mp3' ? mp3Encoder : wavEncoder;
	console.log('WORKER encode', event.data.format, options);
	encoder(event.data.buffer, options || undefined)
		.then((blob) => {
			self.postMessage(blob);
			console.log('encoding time', Date.now() - time);
		})
		.catch((err) => {
			console.error(err);
		});
};

export {};