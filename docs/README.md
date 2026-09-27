# audio-engine

The **PurplePurples** audio engine: a Web Audio sampler / sequencer / mixer with
no React dependency, extracted from the `purplepurples` app so it can be
versioned and consumed as a package.

```ts
import AudioEngine from 'audio-engine';
import type { AudioEngineFacade, AudioEngineOptions } from 'audio-engine';
import { fileToMimeType } from 'audio-engine';
```

The package ships **TypeScript source**; the consumer transpiles it (Next.js:
`transpilePackages: ['audio-engine']`).

## Documentation map

| Document | Contents |
| --- | --- |
| [Events reference](./events.md) | every engine / master / sound event and its payload |
| [Effects](./effects.md) | the 19-effect catalog with parameters and ranges |
| [Models & presets](./models-and-presets.md) | `.purple.zip` format, index.json, preset slots |
| [Development](./development.md) | typecheck, tests, worklet generation, docs |
| [API reference](./api/index.html) | generated TypeDoc site (classes, methods, types) |

## Quick start

```ts
import AudioEngine from 'audio-engine';

// modelsPath / audioPath are the defaults when omitted
const engine = new AudioEngine({ modelsPath: '/models', audioPath: '/audio' });

// Open the audio input/midi devices (requires a user gesture in most browsers)
await engine.init();

// Observe transport + grid state
engine.on('masterstate', (state) => console.log(state));
engine.on('state0-0', (state) => console.log('cell 0-0', state));

// Add and play a sampler cell
const item = engine.add('0-0', '/audio/kit/clap.wav', 'clap.wav');
engine.play('0-0');
engine.volume('0-0', 0.8);
engine.pan('0-0', -20);

// Effects are added to a cell's chain (bypassed unless bypass === false)
await engine.addEffect('0-0', 'delay', false, { time: 0.2, feedback: 0.4, mix: 0.35 });

// Transport
engine.master.play();
engine.master.volume(0.6);
engine.master.stop();

// Models & presets
await engine.loadModels();
await engine.loadModel('my-model');
engine.savePreset('verse');
engine.restorePreset(0);
```

> Always call `engine.destroy(true)` when tearing the engine down (route change,
> hot reload) so recorders, MIDI, the `devicechange` listener and all event
> listeners are released.

## Architecture

`AudioEngine` is the single public entry point. It owns the `AudioContext`, the
master gain, the grid of sounds and a set of focused helpers:

```
AudioEngine (src/audioengine.ts)
├── Master (src/master.ts)              transport: play/stop/pause/mute/loop/volume
├── ModelManager (src/model.ts)         .purple.zip + preset I/O
├── Automation (src/automation.ts)      record & loop engine parameter changes (R/L)
├── Sound (src/sound.ts) × N            one sampler cell: source → effects → panner
│   └── Effect (src/effects/core.ts) × N   AudioWorklet-backed processors
├── Analyser (src/analyser.ts)          level / time-domain / frequency readers
├── Recorder (src/recorder.ts) × 2      master-mix + microphone sampling
├── input devices (getUserMedia)        microphone selection + input analyser
└── MIDI (WebMidi)                      device list, note mapping, MIDI-learn
```

Supporting modules:

- `src/effects/*` — one folder per effect: `index.ts` (the `Effect` subclass and
  its parameter accessors) + `source.js` (the plain-JS AudioWorklet DSP).
- `src/effects/workletsource.generated.ts` — all `source.js` + shared worklet
  fragments concatenated into one worklet module (run `pnpm worklet:gen` after
  editing any `source.js`).
- `src/encoders/` — wav/mp3 Blob encoders used by the encoder worker.
- `src/record/` — the recorder AudioWorklet source and its accumulating worker.
- `src/pitch/stretch.ts` — lazy loader for the vendored Signalsmith Stretch
  (tempo-preserving pitch shift).
- `src/types.ts` — the typed facade the app programs against; `src/contract.ts`
  statically asserts the engine still satisfies it.

### Signal path

```
AudioBufferSourceNode
  └─▶ [Signalsmith Stretch]        (only while pitch ≠ 0, created lazily)
        └─▶ [effect 0] ▶ [effect 1] ▶ …   (non-bypassed effects, in order)
              └─▶ GainNode (volume × (1 + gain), 0 when muted)
                    └─▶ GainNode (loop anti-click fade envelope)
                          └─▶ PannerNode
                                └─▶ engine.masterGain ▶ context.destination
```

Sources are one-shot in Web Audio, so `Sound.play()` rebuilds the source (and
reconnects the chain) on every play. Effects run inside `AudioWorklet`s, one
node per effect instance.

### State model

- **Sound state** — `Sound` keeps `_<name>` fields (mirroring `SoundDefaults`)
  and emits a full `state` snapshot on every change. The engine forwards it as
  `state<id>`.
- **Master state** — `engine.master.state` is a single object broadcast as
  `masterstate` (and merged via `engine.emitMasterState(patch)`).
- **Presets** — `Sound.getSaveState()` is snapshotted into slot-addressed presets
  (one per number key) and persisted inside a model's `index.json`.

See [Events reference](./events.md) for the full event surface and
[Models & presets](./models-and-presets.md) for the file format.
