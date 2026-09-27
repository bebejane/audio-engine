/**
 * Web Worker factories. The engine always talks to workers through these
 * functions so worker implementation details (ESM module workers under
 * Turbopack/webpack) stay in one place.
 */

/** A `Worker` we can attach a pending-promise `reject` handle to (see Recorder). */
export interface AudioWorker extends Worker {
	/** Reject the promise a worker-backed operation is waiting on. */
	reject?: (reason?: unknown) => void;
}

/** Spawn the module worker that encodes PCM to wav/mp3 (see encoders/worker.ts). */
export function createEncoderWorker(): AudioWorker {
	return new Worker(new URL('./encoders/worker', import.meta.url), {
		type: 'module',
		name: 'encoder-worker',
	});
}

/**
 * Spawn the module worker that accumulates recorder PCM and packs it into a wav
 * (see record/worker.ts).
 */
export function createRecordWorker(): AudioWorker {
	return new Worker(new URL('./record/worker', import.meta.url), {
		type: 'module',
		name: 'record-worker',
	});
}
