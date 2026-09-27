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
- `pnpm test` — offline DSP harness (all 19 effect processors)

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
defaults).

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
