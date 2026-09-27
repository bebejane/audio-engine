# AGENTS.md

Guidance for AI coding agents working in this repository. Human-facing docs
live in [`docs/`](./docs/README.md); this file is about *how to change the code
safely*.

## What this is

`audio-engine` is the PurplePurples Web Audio sampler / sequencer / mixer,
extracted so it can be consumed as a package. The package ships **TypeScript
source** — there is no build/emit step and no bundler; the consumer transpiles
`src/*.ts` (Next.js: `transpilePackages: ['audio-engine']`). Do not introduce a
build pipeline or change the `exports` map to point at compiled output.

Public entry point: [`src/index.ts`](./src/index.ts).

## Commands

```sh
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm test           # pretest regenerates the worklet, then runs the DSP harness
pnpm worklet:gen    # regenerate src/effects/workletsource.generated.ts
pnpm worklet:check  # fail if the generated worklet source is stale
pnpm docs:api       # TypeDoc -> docs/api/ (generated, gitignored)
```

- **Do not run `pnpm docs`** — that is a pnpm builtin. Use `pnpm docs:api`.
- There is no lint/format config in this package (no eslint/prettier/editorconfig).
  Match the file you are editing: **tabs** for indentation, single quotes, and the
  file's existing semicolon usage (it varies by file).

## Repository map

```
src/
  audioengine.ts   AudioEngine — the public class (context, grid, devices, effects)
  sound.ts         one sampler cell: source -> effects -> fade -> panner
  master.ts        transport controller (engine.master)
  model.ts         ModelManager — .purple.zip + presets
  automation.ts    records/loops engine parameter changes (R/L)
  analyser.ts      level / time-domain / frequency readers
  recorder.ts      master-mix + microphone recording
  types.ts         hand-written facade the app programs against
  contract.ts      compile-time assert: AudioEngine/Master match types.ts
  index.ts         package entry (exports AudioEngine + utils + types)
  utils.ts         type guards, DSP helpers, peaks, array-move
  effects/         <effect>/{index.ts,source.js} + core.ts + worklet.ts
  encoders/        wav/mp3 encoders + encoder worker
  record/          recorder AudioWorklet source + accumulating worker
  pitch/           Signalsmith Stretch loader + vendored .mjs
scripts/build-effects-worklet.mjs   assembles the worklet module
tests/verify-effects.mjs            offline DSP harness
typedoc.json / docs/                documentation
```

## Critical invariants — read before editing

1. **Worklet source is generated and committed.** Effect DSP lives in plain
   worklet-scope `.js` (`src/effects/*/source.js` + `src/effects/worklet/*.js`),
   concatenated into `src/effects/workletsource.generated.ts`.
   **After editing any `source.js` (or a worklet helper), run `pnpm worklet:gen`.**
   `pnpm worklet:check` (and CI) fails if the generated file is stale. Never edit
   `workletsource.generated.ts` by hand.

2. **Type-checking is partial by design.** WebAudio-heavy internals (`sound.ts`,
   `analyser.ts`, `recorder.ts`, `automation.ts`, the workers, `pitch/stretch.ts`)
   start with `// @ts-nocheck`. Only `AudioEngine`, `Master` and `effects/core.ts`
   are type-checked. `src/contract.ts` statically asserts that `AudioEngine` and
   `Master` still satisfy the facade in `src/types.ts`.

3. **Changing the public surface requires updating the facade.** If you add,
   remove, or rename a method/property the app calls, update `src/types.ts` (and
   the sound/effect types there). Otherwise `pnpm typecheck` fails via
   `contract.ts` — that failure is the intended signal, not noise.

4. **Per-sound accessors must be defensive.** Use `engine._sound(id)` for
   id-based accessors that may target a grid cell with no sound (a model can have
   more cells than files). `engine.get(id)` throws for unknown ids; use it only
   where a missing id is a real error.

5. **Web Audio sources are one-shot.** `Sound.play()` rebuilds the source and
   reconnects the chain on every play. When a Sound's node is replaced (sampling,
   upload, `replace()`), re-point analysers via `engine.setAnalysersNode(id, node)`.

6. **`setMaxListeners(0)` on the engine is intentional** — the grid adds one
   listener per column; the "possible memory leak" warning is a false positive.
   Do not "fix" it.

7. **`pnpm test` behavior covers DSP, not UI.** It loads the generated worklet
   source into a shim and runs all 19 processors offline. Run it after any DSP or
   effect change. Comments/typing-only edits do not require it, but `pnpm
   typecheck` should always pass.

## Effects

Each effect is a `class extends Effect` in `src/effects/<id>/index.ts` that builds
its worklet node (`createWorkletEffectNode(context, 'pp-<id>', this.collectInit())`),
calls `this.initParams()`, and exposes parameter getters/setters that validate
ranges and write AudioParams.

To add an effect: add `source.js` + `index.ts`, register it in both `EFFECTS` and
`EFFECT_CLASSES` in `src/effects/index.ts`, then run `pnpm worklet:gen` and
`pnpm test`. See [`docs/effects.md`](./docs/effects.md).

## Conventions

- **Comments/JSDoc:** every class, method, function and exported type carries a
  JSDoc comment. Keep that up when adding code. Regenerate the API docs with
  `pnpm docs:api` when the public surface changes.
- **Event names:** per-cell engine events are suffixed with the sound id
  (`state<id>`, `load<id>`, `loop<id>`, `ended<id>`, `change<id>`, `elapsed<id>`,
  `loopend<id>`). See [`docs/events.md`](./docs/events.md).
- **Runtime deps:** prefer the standard Web Audio API. Small utilities that would
  otherwise be runtime dependencies are vendored into `src/utils.ts`
  (webaudio-peaks, array-move) — keep that pattern rather than adding deps.
- **Defaults:** `modelsPath = '/models'`, `audioPath = '/audio'`; presets are
  slot-addressed (10 slots, one per number key).
- **Initialization:** `engine.init(options)` is the single opt-in bootstrap
  (`input`/`midi` default to `false`; failures are per-feature `status`, never a
  rejection). `engine.resume()` must be called from a user gesture. Keep the
  granular `initInputSource`/`initMidiSource` methods for device switching; see
  [`docs/README.md`](./docs/README.md#initialization).

## Before you finish

1. `pnpm typecheck` passes.
2. If you touched DSP: `pnpm worklet:gen` and `pnpm test` pass, and the generated
   file is committed/updated.
3. If you changed the public surface: `src/types.ts` updated and `pnpm docs:api`
   regenerated (or at least the JSDoc added).
4. `docs/` guides updated if behavior/formats changed.
