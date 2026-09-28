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
