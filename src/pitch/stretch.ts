// @ts-nocheck
/**
 * Signalsmith Stretch — official JS/WASM release (MIT, © 2022 Geraint Luff /
 * Signalsmith Audio Ltd). Vendored verbatim as `lib/audio/pitch/signalsmith-stretch.mjs`
 * from `signalsmith-stretch@1.3.2` (https://npmjs.com/package/signalsmith-stretch);
 * see LICENSE.signalsmith-stretch.txt.
 *
 * The `.mjs` is self-contained (the WASM is a data URI) and builds its own
 * AudioWorklet module via a Blob URL. `SignalsmithStretch(context,
 * channelOptions)` resolves to an AudioWorkletNode with `schedule({ semitones,
 * rate, active, output, … })`, `start()/stop()`, `latency()` and `configure()`.
 * With live input, `rate`/`loop*` are ignored, so `semitones` is a pure
 * tempo-preserving pitch shift.
 *
 * It must NOT go through the bundler: Stretch serializes its worklet bootstrap
 * with `registerWorkletProcessor.toString()` + the Emscripten factory source. If
 * SWC down-levels its native `class … extends AudioWorkletProcessor`, that
 * serialized source comes to reference bundler-injected helper bindings (e.g.
 * `…$_inherits`) which don't exist inside the AudioWorklet scope, so
 * registration silently fails and Safari throws "No ScriptProcessor was
 * registered with this name".
 *
 * So we take a URL to the raw file and `import()` it at runtime as a native ES
 * module. `new URL('./signalsmith-stretch.mjs', import.meta.url)` makes the
 * bundler emit the file as an untransformed static asset; the dynamic import is
 * forced to stay a real runtime import (not bundled) via the ignore comments.
 *
 * To update: re-download the upstream `.mjs`, replace
 * `lib/audio/pitch/signalsmith-stretch.mjs` and refresh
 * LICENSE.signalsmith-stretch.txt.
 *
 * @returns {Promise<Function>} the SignalsmithStretch factory
 */
let pending = null;

export default function loadSignalsmithStretch() {
	if (typeof window === 'undefined') {
		return Promise.reject(new Error('signalsmith-stretch requires a browser window'));
	}
	if (window.SignalsmithStretch) return Promise.resolve(window.SignalsmithStretch);
	if (pending) return pending;

	// emit the vendored file as a raw asset and get its URL
	const url = new URL('./signalsmith-stretch.mjs', import.meta.url).href;
	pending = import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url).then(
		(mod) => {
			window.SignalsmithStretch = mod.default;
			return mod.default;
		},
	);
	return pending;
}
