# Events reference

`AudioEngine` extends Node's `EventEmitter`. Listen with `engine.on(name, fn)`
(and `engine.off`). Per-cell events are suffixed with the sound id
(`state<id>`, `load<id>`, `loop<id>`, `ended<id>`, `change<id>`, `elapsed<id>`,
`loopend<id>`).

> The engine lifts the EventEmitter listener cap (`setMaxListeners(0)`) because
> the grid adds listeners per column; this is intentional, not a leak.

## Engine events

### Lifecycle

| Event | Payload | Meaning |
| --- | --- | --- |
| `create` | `(id, sound)` | `createSound()` built a Sound (before it is registered). |
| `add` | `(id, sound)` | A sound was added to the grid. |
| `remove` | `(id)` | A sound was removed. |
| `ready` | `(id, { total, ready })` | A sound finished loading; counts are grid-wide. |
| `load` | `(id)` | A sound finished loading (engine-level). |
| `load<id>` | `(id, true)` | Same, per cell. |
| `loaderror` | `(error, id)` | A sound failed to load. |
| `change` | `(id, duration)` | A sound's buffer changed (load/crop/reverse). |
| `change<id>` | `(duration)` | Same, per cell. |

### Playback / transport

| Event | Payload | Meaning |
| --- | --- | --- |
| `state<id>` | `(state, updated)` | Full per-sound state snapshot (see below). |
| `elapsed<id>` | `(elapsed)` | Playhead position of one sound, in seconds. |
| `loop` | `(id, on)` | A sound's loop flag changed. |
| `loop<id>` | `({ loop, loopStart, loopEnd })` | Loop bounds state for one cell. |
| `loopend<id>` | `(true)` | The loop wrapped (drives the loop-end flash/animation). |
| `ended` | `(id)` | A sound reached the end of its buffer. |
| `ended<id>` | — | Same, per cell. |
| `solo` | `(id, on)` | A sound was soloed/unsoloed. |
| `masterstate` | `(state, patch?)` | The master transport state changed (see below). |
| `playall` / `stopall` | — | `master.play()` / `master.stop()` ran. |
| `pauseall` | `(on)` | `master.pause()` ran. |
| `muteall` | `(on)` | `master.mute()` ran. |
| `loopall` | `(on)` | `master.loop()` ran. |
| `mastervolume` | `(volume)` | Master volume changed. |
| `masterelapsed` | `(elapsed)` | Master playhead tick (while `enableElapsed`). |

### Input / MIDI

| Event | Payload | Meaning |
| --- | --- | --- |
| `inputdevices` | `MediaDeviceInfoLike[]` | Audio input devices changed/enumerated. |
| `mididevices` | `MidiDeviceInfoLike[]` | MIDI inputs connected/disconnected. |
| `noteon` | `NoteMessageEvent` | A MIDI note-on arrived. |
| `noteoff` | `(noteNumber)` | A MIDI note-off arrived. |

### Recording / encoding / automation

| Event | Payload | Meaning |
| --- | --- | --- |
| `recording` | `(on)` | Master recording started/stopped. |
| `recordingprogress` | `(progress)` | Master recording progress. |
| `sampling` | `(id, on)` | Sampling the input into a cell started/stopped. |
| `samplingprogress` | `(id, progress)` | Sampling progress for a cell. |
| `encodingprogress` | `(progress)` | 0–100 progress of `encodeAudio()`. |
| `automation` | `({ id, recording, playing, count })` | Automation state changed (R/L). |

### Models, presets & errors

| Event | Payload | Meaning |
| --- | --- | --- |
| `models` | `ModelMeta[]` | The model index loaded/changed. |
| `model` | `Model` | The current model changed. |
| `presets` | `PresetSlot[]` | The preset slots changed. |
| `notification` | `{ message, description } \| null` | Transient UI message (download %, extracting…). |
| `error` | `(error)` | An engine-level error (model fetch/decode, recorder). |

## `state` snapshot (`state<id>` / `Sound.emitState`)

```ts
{
  id, ready, loaded, loading, playing, volume, gain, pan, panWidth,
  rate, pitch, loop, loopStart, loopEnd, muted, mutedVol, paused, pausedAt,
  solo, soloOn, locked, duration, sampling, filename, elapsed, midiNote,
  midiMapMode, reversed, effectsEnabled, error, _event,
  effects?: EffectEntry[]   // only on chain-changing events (add/remove/move/…)
}
```

The second argument is the `updated` patch (only the keys this event changed),
so listeners can merge incrementally. The `effects` array is included only for
chain-changing events (`addeffect`, `removeeffect`, `moveeffect`,
`effectbypass`, `effectparams`, `effectsenabled`, `reset`, `add`, `load`) — that
keeps high-frequency scalar writes (volume/pan/elapsed) cheap.

## `masterstate` (`engine.master.state`)

```ts
{
  volume, startedAt, elapsed, duration, rate, locked, muted, playing,
  looping, paused, stopped, recording, sampling, solo, midiMapMode, pan
}
```

`engine.emitMasterState(patch)` merges a patch into the state and emits
`masterstate`; a second argument carries the patch itself for callers that want
to react only to the change.

## Sound (per-cell) events

For finer-grained updates than `state<id>`, listen directly on a Sound
(`engine.get(id).sound.on(event, fn)` — note the `(id, …)` argument order for
events emitted through `Sound._emit`):

`playing(id, on)`, `stop(id)`, `ended(id)`, `pause(id, on)`, `muted(id, on)`,
`volume(id, v)`, `gain(id, g)`, `rate(id, r)`, `pitch(id, semitones)`,
`pan(id, deg)`, `loop(id, on)`, `loopend(id, on)`, `reversed(id, on)`,
`duration(id, d)`, `solo(id, on)`, `locked(id, on)`, `sampling(id, on)`,
`loading(id, true)`, `loaded(id, true)`, `ready(id, true)`,
`loaderror(id, error)`, `load(id)`, `change(id)` (no args),
`reset(id, id)`, `midinote(id, note)`, `midimapmode(id, on)`,
`addeffect(id, type, idx)`, `removeeffect(id, idx)`,
`moveeffect(id, idx, toIdx)`, `effectbypass(id, idx, bypass)`,
`effectparams(id, entries)`, `effectsenabled(id, on)`, and
`elapsed(elapsed)` (this one is emitted with a single argument).
