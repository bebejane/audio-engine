# Effects

Every effect is a class in `src/effects/<id>/index.ts` extending `Effect`
(`src/effects/core.ts`). Its DSP runs in an `AudioWorklet` processor
(`src/effects/<id>/source.js`) registered as `<id>`; the class only exposes
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

Every catalog param is an `EffectParamDef` — `value` / `min` / `max` / `type`
plus a user-facing `name` (the label the UI shows for that control). The
`name` is required, so any new param must declare one.

> The worklet module is assembled from the `source.js` files into
> `src/effects/workletsource.generated.ts`. **After editing any `source.js`, run
> `pnpm worklet:gen`** (`pnpm worklet:check` fails if the generated file is
> stale).

## Licensing

Two effects are ports of copyleft upstream code:

- `magnetictape` ports [The Kiss of Shame][kos], which is **GPL-3.0** — see
  [`src/effects/magnetictape/LICENSE.txt`](../src/effects/magnetictape/LICENSE.txt).
- `tapesaturation` ports the tape-saturation stage of [Aureate][aureate], which
  is **AGPL-3.0** — see
  [`src/effects/tapesaturation/LICENSE.txt`](../src/effects/tapesaturation/LICENSE.txt).

AGPL-3.0 is a superset of GPL-3.0 (its §13 adds only the network-use clause), so
the GPL-3.0 component combines cleanly. Both are copyleft, so the assembled
effects worklet — and therefore the distributed package — is an **AGPL-3.0**
work; see the repository-root [`LICENSE`](../LICENSE). Note that §13 obliges
anyone who lets users interact with a modified version *over a network* to offer
those users the corresponding source, which is the clause to check before
hosting a modified build.

`tapedelay` (ISC) and `j60chorus` (ISC/MIT) are permissively licensed; the
remaining effects are original to this package.

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

### Magnetic Tape Emulation — `magnetictape`

The tape desecration chain from [The Kiss of Shame][kos]
(`hollance/TheKissOfShame`, GPL-3.0 — see
[`src/effects/magnetictape/LICENSE.txt`](../src/effects/magnetictape/LICENSE.txt)).
A per-sample chain: input drive → odd/even harmonic saturation behind a 4 kHz
one-pole → flange → the `age` macro → hiss → `shame` → linear dry/wet →
output level.

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `inputDrive` | `0.5` | `0 … 1` | −18 … +18 dB. Drives how hard the saturation stage works. |
| `outputLevel` | `0.5` | `0 … 1` | −18 … +18 dB. |
| `shame` | `0` | `0 … 1` | Wow/flutter chaos — modulated delay depth, rate and randomness. |
| `age` | `0` | `0 … 1` | Storage-environment macro: lowpass sweep 20 k→2 kHz, granular noise, random level dips, noise bursts above 0.5. |
| `hiss` | `0` | `0 … 1` | Tape hiss up to −46 dB (the dry path is trimmed to match). |
| `mix` | `1` | `0 … 1` | Linear dry/wet. 0 = clean dry, 1 = the full chain. |
| `flange` | `0` | `0 … 1` | Modulated delay depth; 1 ≈ 1000 samples. 0 = steady. |

Two things worth knowing before reaching for it. **The saturation stage is
unconditional**, so the effect is audible at its defaults even with
`shame`/`age`/`hiss` at zero — it is a tape machine, not a damage unit, and
`mix` defaults to `1` for that reason. And the three noise sources the original
loaded from bundled WAV files (`Hiss.wav` 12.7 MB, `PinkNoise.wav` 3.8 MB,
`LowLevelGrainNoise.wav` 7.0 MB) are **synthesised procedurally** here, so the
hiss and grain beds are plausible rather than authentic.

The upstream plugin only behaves correctly at 44100 Hz — it hardcodes its buffer
sizes, envelope domains and modulation depths. This port derives all of them
from the real `sampleRate`, so it holds at 48 kHz and above.

Not ported: `tapeType` and `environment` are dead upstream (the tape-type button
"has no effect" and only the Hurricane Sandy environment is implemented), and
`printThrough` is never implemented.

[kos]: https://github.com/hollance/TheKissOfShame
[aureate]: https://github.com/basilica-audio/Aureate

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

### Tape Saturation — `tapesaturation`

The tape-saturation stage of [Aureate][aureate]
(`basilica-audio/Aureate`, AGPL-3.0 — see
[`src/effects/tapesaturation/LICENSE.txt`](../src/effects/tapesaturation/LICENSE.txt)).
Input Drive → 4× oversampled [Warmth HF rolloff → 80 Hz head bump → asymmetric
Character saturator] → dry/wet → output trim.

| Param | Default | Range | Notes |
| --- | --- | --- | --- |
| `drive` | `0.25` | `0 … 1` | 0 … +24 dB into the saturator. |
| `warmth` | `0.35` | `0 … 1` | Tape self-erasure rolloff (20 k → 3 kHz) plus an 80 Hz head bump, up to +1.5 dB. Also contributes Bias, scaled per Character. |
| `bias` | `0` | `-1 … 1` | Shifts the saturator's operating point. Combined with Warmth's contribution and clamped to ±0.9. |
| `character` | `0` | `0 … 2` | `0` Tape (tanh), `1` Console (2·tanh(v/2)), `2` Valve (sign·(1−e^−\|v\|)). |
| `quality` | `true` | boolean | `true` = ADAA1 inside the oversampler (lower alias floor); `false` = point-sampled. |
| `mix` | `1` | `0 … 1` | Dry/wet. |
| `output` | `0` | `-1 … 1` | −24 … +24 dB on the blended signal. |

The nonlinearity is shift-then-recentre, `y = f(x + bias) − f(bias)`, which is
what makes it genuinely asymmetric — the two half-cycles approach different
ceilings, so a zero-mean input comes out even-harmonic-rich. Subtracting
`f(bias)` is what keeps silence silent at every bias setting. `warmth` at 0 is a
20 kHz Butterworth, not a bypass, so the wet path has a gentle HF droop even
when "off"; that matches upstream.

Two deviations from the C++ original, both deliberate and both documented in
`source.js`: the 4× oversampler is two cascaded linear-phase half-band FIR
stages rather than JUCE's polyphase half-band IIR (an IIR resampler is not
portable to an AudioWorklet), and Aureate's host-reported latency is replaced by
a fixed 48-sample delay on the dry side of the mix so that `mix = 0` is an exact
phase-aligned passthrough. The Warmth/head-bump biquads add a further sub-sample
delay of their own that is **not** compensated, again matching upstream.

Not ported: the glue compressor, iron transformer, wow/flutter, hiss, HF/LF
trim and auto gain — those are separate instruments in Aureate.

### Tremolo — `tremolo`

| Param | Default | Range |
| --- | --- | --- |
| `speed` | `4` | `0 … 20` |
| `depth` | `0.5` | `0 … 1` |
| `mix` | `0.5` | `0 … 1` |

## Channel EQ (per sound)

Every sound's channel processor (`src/effects/worklet/channel.js`) carries a
**4-band EQ** that runs after the effects and before the panner (the channel
strip). It is not a catalog effect — control it through `sound.eq(...)` /
`engine.eq(id, ...)`:

```ts
engine.eq(id);                       // -> EqBand[] (all four bands)
engine.eq(id, 0);                    // -> one band
engine.eq(id, 0, { on: true, type: 'lowshelf', frequency: 100, gain: 4, q: 0.7 });
engine.eq(id, 2, { gain: -3 });      // merge a single field
```

- Bands are `0..3`; types are `lowshelf | peaking | highshelf | lowpass | highpass`.
- `frequency` 20–20000 Hz, `gain` ±18 dB (ignored by low/highpass), `q` 0.1–10.
- Flat (every band off or 0 dB) is bypassed in the DSP, so an unused EQ costs
  nothing; enabling a band lazily creates the channel processor if needed.
- Serialized by `Sound.getSaveState()` (presets and `.zip` models); a saved
  model without `eq` loads flat.

## Adding a new effect

1. Create `src/effects/<id>/source.js` with the DSP (`registerProcessor('<id>', …)`).
2. Create `src/effects/<id>/index.ts` with an `Effect` subclass: declare
   `defaults` (each param's `EffectParamDef` needs a user-facing `name`), build
   the node via `createWorkletEffectNode(context, '<id>',
   this.collectInit())`, then call `this.initParams()` and add parameter
   getters/setters.
3. Add the catalog entry to `EFFECTS` and the class to `EFFECT_CLASSES` in
   `src/effects/index.ts`.
4. Run `pnpm worklet:gen` and `pnpm test`.
5. Document it in the catalog above, and — if the DSP is a port of someone
   else's plugin — add `src/effects/<id>/LICENSE.txt` carrying the upstream
   attribution and license text, following `magnetictape` and `tapesaturation`.
