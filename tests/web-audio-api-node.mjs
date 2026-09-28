// Node environment that lets the real, browser-oriented engine run on the real
// `web-audio-api` implementation (the pure-JS Web Audio API for Node —
// https://github.com/audiojs/web-audio-api, descendant of the ircam-ismm
// `node-web-audio-api` project).
//
// Import this **before** `src/*.ts`. It installs the handful of globals the
// browser provides for free:
//
//   * `web-audio-api/polyfill`  — AudioContext/AudioWorkletNode/… on globalThis
//   * `parameterDescriptors`    — our worklet sources assign it on the subclass,
//                                 which web-audio-api exposes as a setter-less
//                                 static getter (browser-legal, so we patch the
//                                 environment rather than the DSP)
//   * `Worker`                  — over node:worker_threads, with the module
//                                 bootstrap the worker-scope sources expect
//   * `XMLHttpRequest`          — over fetch/fs, for the engine's audio loader
//   * `requestAnimationFrame`   — for the analyser pump
//   * `navigator.mediaDevices`  — device listener/enumeration no-ops

import 'web-audio-api/polyfill';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TS_HOOK = fileURLToPath(new URL('./register-ts.mjs', import.meta.url));

// --- worklet parameter descriptors ----------------------------------------
// Browser AudioWorkletProcessor subclasses may set a static
// `parameterDescriptors`; web-audio-api models it as a getter without a setter,
// so `Foo.parameterDescriptors = desc([...])` throws in the worklet sources.
// Give the inherited accessor a setter that installs an own data property.
Object.defineProperty(AudioWorkletProcessor, 'parameterDescriptors', {
	configurable: true,
	get() {
		return [];
	},
	set(value) {
		Object.defineProperty(this, 'parameterDescriptors', {
			value,
			writable: true,
			configurable: true,
		});
	},
});

// --- Worker (module workers over node:worker_threads) ---------------------
// The worker sources are browser-shaped: they assign `self.onmessage` and call
// `self.postMessage`. node:worker_threads has neither, so the bootstrap wires
// them to parentPort and buffers messages until the handler is assigned.
// Worker modules are TypeScript, so the thread re-imports the TS hook.
function workerBootstrap(mainUrl) {
	return `
import { parentPort } from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.postMessage = (data) => parentPort.postMessage(data);
let handler = null;
const queue = [];
parentPort.on('message', (data) => {
	if (handler) handler({ data });
	else queue.push(data);
});
Object.defineProperty(globalThis, 'onmessage', {
	configurable: true,
	get() { return handler; },
	set(fn) {
		handler = fn;
		while (queue.length) handler({ data: queue.shift() });
	},
});
await import(${JSON.stringify(mainUrl)});
`;
}

/** Resolve a worker URL the way a bundler would: extensionless specifiers may
 * be a `.ts`, a `.js` or a directory's index. */
function resolveWorkerEntry(url) {
	const base = url instanceof URL ? fileURLToPath(url) : String(url);
	return [base, base + '.ts', base + '.js', base + '/index.ts'].find((p) => existsSync(p));
}

class WorkerShim {
	constructor(url) {
		const found = resolveWorkerEntry(url);
		if (!found) throw new Error('WorkerShim: cannot resolve worker entry ' + url);
		this._worker = new NodeWorker(workerBootstrap(pathToFileURL(found).href), {
			eval: true,
			type: 'module',
			execArgv: ['--import', TS_HOOK],
			name: 'audio-engine-worker',
		});
		this._listeners = { message: new Set(), error: new Set() };
		this._worker.on('message', (data) => {
			this.onmessage?.({ data });
			this._listeners.message.forEach((fn) => fn({ data }));
		});
		this._worker.on('error', (error) => {
			this.onerror?.(error);
			this._listeners.error.forEach((fn) => fn(error));
		});
	}
	addEventListener(type, fn) {
		this._listeners[type]?.add(fn);
	}
	removeEventListener(type, fn) {
		this._listeners[type]?.delete(fn);
	}
	postMessage(data) {
		this._worker.postMessage(data);
	}
	terminate() {
		return this._worker.terminate();
	}
}
globalThis.Worker = WorkerShim;

// --- XMLHttpRequest -------------------------------------------------------
// The engine's audio loader uses XHR with `responseType = 'arraybuffer'`.
class XMLHttpRequestShim {
	constructor() {
		this._listeners = { load: new Set(), error: new Set() };
		this.status = 0;
		this.response = null;
		this.responseType = '';
		this.withCredentials = false;
	}
	open(_method, url) {
		this._url = url;
	}
	addEventListener(type, fn) {
		this._listeners[type]?.add(fn);
	}
	removeEventListener(type, fn) {
		this._listeners[type]?.delete(fn);
	}
	_dispatch(type, event) {
		this._listeners[type]?.forEach((fn) => fn(event));
		this['on' + type]?.(event);
	}
	async send() {
		try {
			const url = this._url;
			let status = 200;
			let buffer;
			if (url.startsWith('data:')) {
				buffer = Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)).buffer;
			} else if (url.startsWith('file:')) {
				buffer = (await readFile(fileURLToPath(url))).buffer;
			} else {
				// http(s): and blob: both go through Node's fetch
				const res = await fetch(decodeURIComponent(url));
				status = res.status;
				buffer = await res.arrayBuffer();
			}
			this.status = status;
			this.response = buffer;
			this._dispatch('load', {});
		} catch (error) {
			this.status = 0;
			this._dispatch('error', { message: String(error) });
		}
	}
}
globalThis.XMLHttpRequest = XMLHttpRequestShim;

// --- animation frame + media devices --------------------------------------
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

if (globalThis.navigator) {
	const devices = (globalThis.navigator.mediaDevices ??= {});
	devices.enumerateDevices ??= async () => [];
	devices.addEventListener ??= () => {};
	devices.removeEventListener ??= () => {};
}

// --- headless sinks -------------------------------------------------------
// The engine creates its own AudioContext, so a CI box with no audio device
// can't pass `sinkId` through. Setting AUDIO_ENGINE_SINK=none injects a null
// writable-stream sink: unlike `{ type: 'none' }` (which never pulls the graph
// and leaves currentTime frozen), a stream is still rendered into and drained,
// so the audio clock advances without an output device.
if (process.env.AUDIO_ENGINE_SINK === 'none') {
	const nullSink = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	const Base = globalThis.AudioContext;
	globalThis.AudioContext = class extends Base {
		constructor(options = {}) {
			super({ ...options, sinkId: nullSink });
		}
	};
}

export {};
