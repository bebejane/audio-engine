// @ts-nocheck
/**
 * Encoder worker: receives raw PCM (`{ buffer, format, options }`) from
 * `createEncoderWorker()` callers, runs the matching encoder (wav/mp3) and
 * posts back either `{ progress }` messages or the finished Blob.
 *
 * Kept dependency-light and `@ts-nocheck` because it runs in the worker scope
 * where `self` is the global.
 */
import wavEncoder from '../encoders/wav';
import mp3Encoder from '../encoders/mp3';

/** Options forwarded from the last encode request (sample rate, channels…). */
let options = null;

/**
 * Handle one message: progress pings are echoed straight back, otherwise the
 * payload is encoded and the resulting Blob is posted to the main thread.
 */
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