# Development

## Commands

```sh
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm test           # offline DSP harness (all 20 effect processors)
pnpm test:render    # render all 20 effects through a real Web Audio impl
pnpm test:stress    # engine soak vs the Web Audio mock (virtual clock)
pnpm test:stress:real  # engine soak vs real web-audio-api (real clock)
pnpm worklet:gen    # regenerate src/effects/workletsource.generated.ts
pnpm worklet:check  # fail if the generated worklet source is stale
pnpm docs:api       # generate the TypeDoc site into docs/api/
```

## Repository layout

```
src/                     engine code (TypeScript)
  audioengine.ts         AudioEngine class (the public entry point)
  sound.ts master.ts analyser.ts recorder.ts automation.ts model.ts
  types.ts               typed facade + model/effect types (the app-facing API)
  utils.ts               shared helpers (is* guards, DSP utils, peaks, …)
  contract.ts            compile-time assertion that AudioEngine matches the facade
  effects/               per-effect folders: <effect>/{index.ts,source.js}
    core.ts worklet.ts   shared Effect base + worklet loader
    worklet/             shared worklet helper fragments (.js)
  encoders/              wav / mp3 encoders + encoder worker
  record/                recorder worklet source + accumulating worker
  pitch/                 Signalsmith Stretch loader + vendored .mjs
scripts/build-effects-worklet.mjs  assembles the worklet source
tests/verify-effects.mjs           offline DSP regression harness
tests/render-effects.mjs           all 20 effects through a real Web Audio impl
tests/stress-engine.mjs            engine soak vs the Web Audio mock (virtual)
tests/stress-real.mjs              engine soak vs real web-audio-api (wall clock)
tests/web-audio-api-node.mjs       Node environment for the real-engine lane
docs/                              this documentation (+ generated docs/api/)
```

## Worklet source generation

The effect DSP is plain worklet-scope `.js` (`src/effects/*/source.js` +
`src/effects/worklet/*.js`), concatenated into
`src/effects/workletsource.generated.ts` by `pnpm worklet:gen` and registered at
runtime via a Blob URL (see `src/effects/worklet.ts`).

**After editing any `source.js`, run `pnpm worklet:gen`.** `pnpm test` runs the
generator as a `pretest` step; `pnpm worklet:check` fails if the committed
generated file is stale.

## Type safety

The WebAudio-heavy internals (Sound, Analyser, Recorder, …) keep `@ts-nocheck`,
so `src/types.ts` declares the hand-written facade the app programs against and
`src/contract.ts` statically asserts that the concrete `AudioEngine`/`Master`
still satisfy it. Dropping a method the app calls, or letting the facade drift,
fails `pnpm typecheck`.

## Documentation

All public classes, methods, functions and interfaces carry JSDoc comments.
`pnpm docs:api` renders them into `docs/api/` with TypeDoc (configuration in
`typedoc.json`; it expands `src/` to every module, excludes the worklet
`source.js`/vendored `.mjs`, and includes private/protected members). The
hand-written guides live alongside this file.

## Testing

`tests/verify-effects.mjs` loads the generated worklet source into a minimal
AudioWorklet shim and runs each of the 20 processors offline, checking for
finite output, silence handling and known DSP behaviours (e.g. delay tails).
Run it after any DSP change.

`tests/render-effects.mjs` (`pnpm test:render`) is the same idea against a real
Web Audio implementation instead of the shim: it registers the committed worklet
source via a Blob URL into an `OfflineAudioContext`, builds a node for every
effect in the catalog, and renders. It catches what the shim cannot — module
registration, `parameterData` coercion, channel counts, port messaging — plus
`verify-effects.mjs` stays the fast lane for per-processor sample math.

`tests/stress-engine.mjs` (`pnpm test:stress`) drives the real engine against a
permissive Web Audio mock (`tests/mock-web-audio.mjs`) at virtual speed: control
flow, lifetime bookkeeping and bounded caches under load.

`tests/stress-real.mjs` (`pnpm test:stress:real`) drives the same engine against
`web-audio-api` — the pure-JS Web Audio API for Node — on the real audio clock.
It validates the browser-shaped path end to end: real `decodeAudioData`, real
worklet registration, real analyser reads, and the recorder/encoder module
Workers. `tests/web-audio-api-node.mjs` supplies the Node environment (Worker
over `node:worker_threads`, `XMLHttpRequest` over `fetch`, `requestAnimationFrame`,
and the worklet `parameterDescriptors` setter that our sources assume). It is
wall-clock bound, so its soak is much shorter than the mock lane's. On a host
with no audio device, run it with `AUDIO_ENGINE_SINK=none`.


## Consuming the package locally

From the app checkout, temporarily point the dependency at this working copy:

```sh
cd ../audio-engine && pnpm install && pnpm link --global
cd ../purplepurples && pnpm link --global audio-engine
```

or declare `"audio-engine": "link:../audio-engine"` while developing, switching
back to the pinned git dependency before committing/deploying.
