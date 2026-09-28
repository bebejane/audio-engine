# Browser stress test

A standalone page that drives the **real** engine on the **real** Web Audio API
(no mocks) and measures how it behaves as you pile on voices, automate
parameters, churn effects and record simultaneously.

## Run

```sh
pnpm stress:browser          # builds the bundle, then serves :8123
# then open http://localhost:8123/
```

`pnpm stress:browser:build` just rebuilds the bundle (into `build/`, gitignored)
without serving.

The page needs `http://` (ES modules + import maps), so use the dev server — not
`file://`. Click **Start audio** once: browsers require a user gesture before an
`AudioContext` will run.

## Stopping a run (important)

A started scenario keeps ticking until it is stopped, and **every open tab is a
separate `AudioContext`** — two live tabs contend for the same audio thread, so
measurements taken with more than one tab open are meaningless.

- **Kill** (or **Esc**) destroys the engine and clears every timer — load
  generators, the metrics loop, recording. Idempotent; latch the page until
  **Reset**.
- Closing/leaving the page stops everything too (`pagehide`).
- `?agent=1` additionally kills on tab-background, for agent-driven runs that
  must not linger. A plain manual run survives a tab switch.

Rules for automated runs:

- **One tab at a time.** Re-navigate the *existing* tab; don't open a second.
  The dev server already sends `cache-control: no-store`, so a reload is enough
  to pick up a rebuild — there is no need for a fresh tab.
- Append a cache-busting query only on the first open, not on every iteration.
- Finish by killing the run, and leave at most one tab behind.

## Why a build step

The package ships TypeScript source for a bundler to transpile; a bare page
can't import it. `build.mjs` transpiles every `src/**/*.ts` with the installed
TypeScript compiler, rewrites bundler-style relative specifiers to real `.js`
paths, and copies the vendored `.mjs` asset. Bare npm imports (`events`, `jszip`,
`moment`, `webmidi`, …) are left alone and resolved by the import map in
`index.html` to the small shims in `shims/`. Nothing here is added to the
package itself — it is a dev-only test harness.

## What it measures

| Metric | Meaning |
| --- | --- |
| **fps** / **frame ms** | main-thread health |
| **audio drift** | `ΔaudioContextTime / ΔwallTime` over 1 s. `1.00` = real-time; `< ~0.99` means the audio clock is falling behind (glitching) |
| **event-loop lag** | jitter of a 50 ms probe (blocks the UI/engine work) |
| **voices** | playing / total sounds |
| **master peak / rms** | summed output level (from an analyser on `masterGain`) |
| **clips** | samples over full scale (`|x| > 0.999`) at the master bus |
| **clicks** | waveform discontinuities on the audio thread: sample-to-sample jumps larger than `max(Δfloor, 6 × recent|Δ|)`. The `Δ` input sets the floor (default 0.05) |
| **max Δ / sample** | largest sample-to-sample jump seen (session max); a click otherwise invisible in peak/rms shows up here |
| **ops/sec** | parameter + effect mutations per second |
| **heap MB** | `performance.memory.usedJSHeapSize` (Chromium) |
| **latency ms** | `baseLatency + outputLatency` |

## Scenarios

- **Add & play** — creates N synthetic sounds (generated WAV → real
  `decodeAudioData`), enables looping and plays them.
- **Automate params** — continuously randomizes volume / rate / pan / pitch /
  loop / mute across voices.
- **Effects churn** — adds random effects, mutates params, toggles bypass.
- **Record** — starts master recording (the recorder AudioWorklet + worker).
- **Ramp test** — adds 16 voices every 2 s, records fps/frame/drift/peak/lag
  until `drift < 0.9` or `fps < 20`, then reports the breaking point. Rows are
  saved to `localStorage` so a tab crash doesn't lose them; **Reset** clears them.
- **Soak 15s** — voices + automation + effects + recording all at once, then
  reports ops/sec, glitches, clips and drift.

### Pitch latency probe (`?pitchprobe=1`)

Opt-in (add `?pitchprobe=1` to the URL) so it never shadows the ramp test. Adds a
**Pitch latency probe** button that plays a steady 220 Hz tone through the
shifter at +12 semitones and reports what the shift actually costs, at the
engine's configured block size and two reference sizes.

This exists because the shifter's **latency equals its block size**, one-for-one:

| `pitchBlockMs` | latency | quality (220 Hz, +12 st) |
| --- | --- | --- |
| 120 (library default) | 120 ms | target 0.040, spread ~0.0001 |
| **40 (engine default)** | **40 ms** | **target 0.040, spread 0.0000** |
| 20 | 20 ms | target **0.008** — the shift breaks up |

Read the log lines as:

- **DRY control** — the same sound at pitch 0. It should read `fund=0.060`,
  `resid=0.060`, `spread=0.0000`, warble under 1%. If this is not clean, the
  measurement is wrong, not the shifter.
- **WET +12** — `target` is energy at the shifted octave (higher is better),
  `resid` is unshifted leakage at the input pitch (should be ~0), `spread` is
  non-harmonic sideband energy (smearing), `snr` is target/spread.
- Warble is ~4–5% for every wet block size vs ~0.8% dry — that is a shifter
  characteristic, not a block-size effect, so it does not discriminate configs.

## Notes

- Results depend heavily on hardware, browser and audio backend. Headless
  Chromium (null sink) is fine for relative comparisons but not absolute limits.
- A big enough ramp can crash the renderer tab; that is the point of the ramp
  test, and why rows are persisted.
- Pitch shifting loads the vendored Signalsmith Stretch worklet; if it fails to
  load the engine logs it and pitch is a no-op (the page keeps working).
- **Clicks** are measured by a small `click-detector` AudioWorklet on the master
  bus (`stress.js`), so detection is sample-accurate and unaffected by
  main-thread jank. Clips and clicks are cumulative and reset with **Reset**; the
  soak summary reports the delta for its window.
