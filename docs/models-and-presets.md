# Models & presets

A **model** is a saved grid of sampler cells. It is stored as a
`.zip` containing an `index.json` plus the audio files (all at the zip
root). `ModelManager` (`src/model.ts`) owns fetching/unzipping/populating models
and reading/writing the per-model preset list; `AudioEngine` exposes it through
thin facade methods and getters (`engine.model`, `engine.models`,
`engine.presets`, `engine.loadModel()`, …).

## `index.json`

```jsonc
{
  "name": "my-model",
  "version": 2,
  "cols": 4,
  "rows": 4,
  "contentLength": 1234567,        // informational
  "files": [
    {
      "filename": "clap.wav",
      "mimeType": "audio/wav",
      "params": { /* SoundSettings */ "volume": 0.8, "effects": [ … ] }
    }
  ],
  "presets": [ /* PresetSlot[] */ null, { "at": 1712345678901, "sounds": [ … ] }, null, … ]
}
```

- A cell's grid id is derived from its index: `row + '-' + col` with
  `row = floor(i / cols)`.
- Runtime-only fields: `ModelFile.buffer` (the decoded bytes) and `Model.new`
  (an unsaved in-memory model) are never serialized.
- `SoundSettings` (per-file `params`) mirrors `Sound.getSaveState()`:

  ```ts
  {
    volume, rate, pitch, pan, panX, panZ, panWidth, loop, loopStart, loopEnd,
    solo, locked, muted, paused, pausedAt, reversed, effectsEnabled,
    effects: [{ idx, type, bypassed, params }]
  }
  ```

  `paused` and `effects` are the keys the current engine reads/writes; the
  deprecated `pause` key is translated to `paused` on load.

### Version history

| Version | Differences |
| --- | --- |
| **1** (legacy, no `version`) | `files[i]` may be a bare filename string; **no presets**; cells always got one active `delay` effect at index 0. |
| **2** (current) | `files[i]` objects, `params.effects` persists the whole chain, `presets` array present. Written by `MODEL_VERSION = 2`. |

Legacy files load transparently: string file entries are upgraded in place, and
cells without a saved `effects` array receive the historical default `delay` so
the grid's hover interaction still has an effect to write to.

## Model API

```ts
await engine.loadModels();                 // GET modelsPath + '/index.json'
await engine.loadModel('my-model');        // fetch + unzip + populate
await engine.loadModelFromFile(file);      // from a user-selected .zip
const model = engine.createModel('new', 4, 4);

const saved = await engine.saveModel();    // { blob, model } — no download
await engine.downloadModel();              // save + trigger download
engine.downloadSound('0-0');               // one cell's original file
```

`populate()` destroys the current sounds, builds one Sound per file (using a
blob URL when the zip carried buffers, or `audioPath/<model>/<filename>`
otherwise) and restores each saved effect chain in order. It is always re-run,
even on a cache hit, so switching models never leaves stale sounds in the graph.

Default paths (overridable via the constructor): `modelsPath = '/models'`,
`audioPath = '/audio'`.

## Presets

Presets are **slot-addressed**: one slot per number key (1–9, then 0), always
`PRESET_SLOTS = 10` long, `null` for an empty slot. A preset snapshots every
sound's settings at the time it was taken (`PresetSound[]`).

```ts
engine.savePreset('verse');     // snapshot into the first free slot
engine.randomizePreset();       // randomize every sound, store the result
engine.restorePreset(0);        // apply slot 0 to every sound
engine.hasPreset(0);            // is the slot occupied?
engine.clearPresets();          // empty all slots
```

`restorePreset` unmutes first, applies volume/rate/pitch/pan/loop/reverse/lock
and then the per-effect chain (enabled flag → per-effect bypass/params), and
re-applies mute last (the engine's `volume()` skips muted sounds, so mute must
come after the level writes). The preset list is persisted inside the model's
`index.json`, so saving a model also saves its presets.
