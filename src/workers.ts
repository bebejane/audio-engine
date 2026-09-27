/**
 * Web Worker factories. The engine always talks to workers through these
 * functions so worker implementation details (ESM module workers under
 * Turbopack/webpack) stay in one place.
 */

export interface AudioWorker extends Worker {
	reject?: (reason?: unknown) => void;
}

export function createEncoderWorker(): AudioWorker {
	return new Worker(new URL('./encoders/worker', import.meta.url), {
		type: 'module',
		name: 'encoder-worker',
	});
}

export function createRecordWorker(): AudioWorker {
	return new Worker(new URL('./record/worker', import.meta.url), {
		type: 'module',
		name: 'record-worker',
	});
}
