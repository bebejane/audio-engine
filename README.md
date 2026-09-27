# audio-engine

The **PurplePurples** audio engine: a Web Audio sampler / sequencer / mixer with
no React dependency. Extracted from the `purplepurples` app so it can be versioned
and consumed as a package.

## Layout

```
src/                     engine code (TypeScript)
  audioengine.ts         AudioEngine class (the public class)
  sound.ts, master.ts, analyser.ts, recorder.ts, automation.ts, model.ts
  types.ts               typed facade + model/effect types (the app-facing API)
  utils.ts               shared helpers (is* guards, DSP utils, peaks, …)
  effects/               per-effect folders: <effect>/{index.ts,source.js}
  worklet/               shared worklet helper fragments (.js)
  workletsource.generated.ts   assembled worklet source (committed)
  encoders/, record/, pitch/
scripts/build-effects-worklet.mjs  assembles the worklet source
tests/verify-effects.mjs           offline DSP regression harness
```

The effect DSP is plain worklet-scope `.js` (`src/effects/*/source.js` +
`src/worklet/*.js`), concatenated into `src/effects/workletsource.generated.ts`
by `pnpm worklet:gen`. **After editing any `source.js`, run `pnpm worklet:gen`**
(`pnpm worklet:check` fails if the generated file is stale).

## Commands

- `pnpm install`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm worklet:gen` / `pnpm worklet:check`
- `pnpm test` — offline DSP harness (all 21 effect processors)
- `pnpm docs:api` — generate the TypeDoc API reference into `docs/api/`

## Documentation

The engine's classes, methods and types are documented with JSDoc comments.
Human-readable guides live in [`docs/`](./docs/README.md):

- [Getting started & architecture](./docs/README.md)
- [Events reference](./docs/events.md)
- [Effects catalog](./docs/effects.md)
- [Models & presets](./docs/models-and-presets.md)
- [Development](./docs/development.md)

## Licensing

This package is distributed under the **AGPL-3.0** — see [`LICENSE`](./LICENSE).
Two effects are ports of copyleft upstream code:

- `magnetictape` ports
  [The Kiss of Shame](https://github.com/hollance/TheKissOfShame) (GPL-3.0) —
  see [`src/effects/magnetictape/LICENSE.txt`](./src/effects/magnetictape/LICENSE.txt).
- `tapesaturation` ports the tape-saturation stage of
  [Aureate](https://github.com/basilica-audio/Aureate) (AGPL-3.0) —
  see [`src/effects/tapesaturation/LICENSE.txt`](./src/effects/tapesaturation/LICENSE.txt).

AGPL-3.0 is a superset of GPL-3.0 (its §13 adds only the network-use clause), so
the two combine cleanly. Because both are copyleft, the assembled effects
worklet — and therefore the whole distributed package — carries the AGPL-3.0.
`tapedelay` (ISC) and `j60chorus` (ISC/MIT) are permissive; the rest is original
to this package.

Note that AGPL §13 obliges anyone who lets users interact with a modified
version **over a network** to offer those users the corresponding source. If you
host a modified build, read that clause first.

`pnpm docs:api` renders the JSDoc into a browsable TypeDoc site at
`docs/api/index.html` (generated, not committed).

## Consuming it

The package ships **TypeScript source**; the consumer transpiles it (Next:
`transpilePackages: ['audio-engine']`).

```ts
import AudioEngine from 'audio-engine';
import type { AudioEngineFacade, AudioEngineOptions } from 'audio-engine';
import { fileToMimeType } from 'audio-engine';
```

The app serves the model zips itself; pass its public paths via
`new AudioEngine({ modelsPath: '/models', audioPath: '/audio' })` (those are the
defaults). Bootstrap is a single opt-in call, and `resume()` must be called from
a user gesture:

```ts
const engine = new AudioEngine();
const { input, midi } = await engine.init({ input: true, midi: true });
// from a click/keydown handler:
await engine.resume();
```

### Local development (linking into the app)

From the app checkout, temporarily point the dependency at this working copy:

```sh
# in the app repo
pnpm link --global                       # no — link the package instead:
cd ../audio-engine && pnpm install && pnpm link --global
cd ../purplepurples && pnpm link --global audio-engine
```

or declare `"audio-engine": "link:../audio-engine"` while developing and switch
back to the pinned git dependency (`github:<owner>/audio-engine#<tag>`) before
committing/deploying.
