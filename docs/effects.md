# Effects

Every effect is a class in `src/effects/<id>/index.ts` extending `Effect`
(`src/effects/core.ts`). Its DSP runs in an `AudioWorklet` processor
(`src/effects/<id>/source.js`) registered as `pp-<id>`; the class only exposes
parameter getters/setters that write the worklet's `AudioParam`s.

Effects are added to a cell's chain with:

```ts
await engine.addEffect(id, type, bypass, opt);
//   type   a catalog id below
//   bypass true/undefined → registered bypassed (no worklet node until enabled)
//          false          → built and audible immediately
//   opt    initial param overrides (merged over the catalog defaults)
```

Chain operations: `engine.removeEffect(id, idx)`, `engine.moveEffect(id, idx,
toIdx)`, `engine.effectBypass(id, idx, on)`,
`engine.effectParams(id, idx, params)`, `engine.disableEffects(id)` /
`engine.enableEffects(id)`.

Parameter setters validate against the ranges below and ignore out-of-range
values. Most setters smooth the change (`setTargetAtTime`) or ramp it; a few
(`dubdelay`, `flanger`, `quadrafuzz`, `stereopanner`, `tapedelay`) write the
AudioParam directly.

> The worklet module is assembled from the `source.js` files into
> `src/effects/workletsource.generated.ts`. **After editing any `source.js`, run
> `pnpm worklet:gen`** (`pnpm worklet:check` fails if the generated file is
> stale).

## Catalog

### Compressor — `compressor`

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `threshold` | `-24` | `-100 … 0` dB | Level above which compression starts. |
| `knee` | `30` | `0 … 40` dB | Soft-knee width. |
| `attack` | `0` | `0 … 1` | Attack time. |
| `release` | `0.25` | `0 … 1` | Release time. |
| `ratio` | `1` | `1 … 20` | Compression ratio. |

### Convolver — `convolver`

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `mix` | `0.5` | `0 … 1` | Dry/wet. |

Extra constructor option: `impulse` — URL of the impulse file to fetch, decode
and post to the worklet. The dry path stays live until the impulse arrives.

### Delay — `delay`

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `feedback` | `0.5` | `0 … 1` | Echo regeneration. |
| `time` | `0.1` | `0 … 1` s | Delay time (cancel + exp ramp). |
| `mix` | `0.5` | `0 … 1` | Dry/wet. |

### Distortion — `distortion`

| Param | Default | Range |
| --- | --- | --- |
| `gain` | `0.5` | `0 … 1` |

### Dub Delay — `dubdelay`

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `feedback` | `0.6` | `0 … 1` | |
| `time` | `0.7` | `0 … 180` s | |
| `mix` | `0.5` | `0 … 1` | |
| `cutoff` | `700` | `0 … 4000` Hz | Lowpass on the feedback path. |

### Flanger — `flanger`

| Param | Default | Range |
| --- | --- | --- |
| `time` | `0.45` | `0 … 1` |
| `speed` | `0.2` | `0 … 1` |
| `depth` | `0.1` | `0 … 1` |
| `feedback` | `0.5` | `0 … 1` |
| `mix` | `0.5` | `0 … 1` |

### Highpass Filter — `highpassfilter`

| Param | Default | Range |
| --- | --- | --- |
| `frequency` | `350` | `10 … 22050` Hz |
| `peak` | `0.0001` | `0 … 1000` |

### J60 Chorus — `j60chorus`

| Param | Default | Notes |
| --- | --- | --- |
| `chorusI` | `false` | Chorus I button — 0.513 Hz triangle, mild. |
| `chorusII` | `true` | Chorus II button — 0.863 Hz triangle, deeper. |
| `mix` | `1` | `1` = hardware blend (0.83·dry + BBD wet), `0` = dry. |

### Korg 35 HPF — `korg35hpf`

| Param | Default | Range |
| --- | --- | --- |
| `cutoff` | `350` | `20 … 20000` Hz |
| `q` | `1` | `0.5 … 10` |

### Korg 35 LPF — `korg35lpf`

| Param | Default | Range |
| --- | --- | --- |
| `cutoff` | `350` | `20 … 20000` Hz |
| `q` | `1` | `0.5 … 10` |

### Lowpass Filter — `lowpassfilter`

| Param | Default | Range |
| --- | --- | --- |
| `frequency` | `350` | `10 … 22050` Hz |
| `peak` | `0.0001` | `0 … 1000` |

### PingPong Delay — `pingpongdelay`

| Param | Default | Range |
| --- | --- | --- |
| `feedback` | `0.5` | `0 … 1` |
| `time` | `0.3` | `0 … 180` s |
| `mix` | `0.5` | `0 … 1` |

### QuadraFuzz — `quadrafuzz`

4-band crossover (147 / 587 / 2490 / 4980 Hz) feeding a distortion curve.

| Param | Default | Range |
| --- | --- | --- |
| `lowGain` | `0.6` | `0 … 1` |
| `midLowGain` | `0.8` | `0 … 1` |
| `midHighGain` | `0.5` | `0 … 1` |
| `highGain` | `0.6` | `0 … 1` |

### Reverb — `reverb`

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `mix` | `0.5` | `0 … 1` | |
| `time` | `0.001` | `0 … 1` s | IR length (rebuilds the impulse). |
| `decay` | `0.1` | `0 … 10` | Decay exponent (rebuilds the impulse). |
| `reverse` | `false` | boolean | Reverse the IR (swell instead of decay). |

### Ring Modulator — `ringmodulator`

| Param | Default | Range |
| --- | --- | --- |
| `speed` | `30` | `0 … 2000` |
| `distortion` | `0.2` | `0.2 … 50` |
| `mix` | `0.5` | `0 … 1` |

### Stereo Panner — `stereopanner`

| Param | Default | Range |
| --- | --- | --- |
| `pan` | `0` | `-1 … 1` |

### Stone Phaser — `stonephaser`

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `speed` | `0.2` | `0.01 … 5` Hz | LFO frequency. |
| `feedback` | `0.75` | `0 … 0.99` | Feedback depth. |
| `feedbackBassCut` | `500` | `10 … 5000` Hz | HP in the feedback path. |
| `mix` | `0.5` | `0 … 1` | Equal-power (Faust) crossfade. |
| `color` | `true` | boolean | Deeper vs. lighter voicing. |
| `phase` | `0` | `-180 … 180`° | Stereo LFO phase offset. |

Controls are already smoothed inside the DSP, so setters write AudioParams
directly (no extra `setTargetAtTime`).

### Tape Delay — `tapedelay`

Roland RE-201-style multi-head tape echo (heads at t, 2t, 3t).

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `time` | `220` | `30 … 600` ms | Tape speed with motor ballistics (repitches echoes). |
| `feedback` | `0.5` | `0 … 1.05` | Above ~1 the loop self-oscillates. |
| `mix` | `0.5` | `0 … 1` | Dry/wet. |
| `head1` / `head2` / `head3` | `true` / `false` / `false` | boolean | Playback heads. |
| `density` | `1` | `0.5 … 2` | Head spacing scale (1× / 2× / 3×). |
| `wowFlutter` | `0.3` | `0 … 1` | Wow + flutter + scrape depth. |
| `drive` | `0.3` | `0 … 1` | Record saturation. |
| `bass` / `treble` | `0` / `0` | `-15 … 15` dB | Echo shelves. |
| `hiss` | `0.1` | `0 … 1` | Tape hiss level. |
| `tapeType` | `0` | `0 … 2` | `0` I (ferric), `1` II (chrome), `2` IV (metal). |
| `age` | `0.2` | `0 … 1` | HF self-erasure / dropout / bias-sag macro. |

### Tremolo — `tremolo`

| Param | Default | Range |
| --- | --- | --- |
| `speed` | `4` | `0 … 20` |
| `depth` | `0.5` | `0 … 1` |
| `mix` | `0.5` | `0 … 1` |

## Adding a new effect

1. Create `src/effects/<id>/source.js` with the DSP (`registerProcessor('pp-<id>', …)`).
2. Create `src/effects/<id>/index.ts` with an `Effect` subclass: declare
   `defaults`, build the node via `createWorkletEffectNode(context, 'pp-<id>',
   this.collectInit())`, then call `this.initParams()` and add parameter
   getters/setters.
3. Add the catalog entry to `EFFECTS` and the class to `EFFECT_CLASSES` in
   `src/effects/index.ts`.
4. Run `pnpm worklet:gen` and `pnpm test`.
