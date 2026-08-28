# Changelog

All notable changes to **EqualLoud** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Mono loudness over-read (2.0.1 regression).** The worklet node's `explicit`
  stereo wiring up-mixed single-channel media to identical L/R before
  measurement, so the mono energy guard never fired and mono LUFS read ~+3 dB
  high — quiet mono podcasts/clips were under-boosted. The node now uses
  `clamped-max`: mono stays natively 1-channel while >2-channel (5.1) input is
  still down-mixed to stereo by Chrome with the speakers table.
- **Volume-fallback elements can re-attach.** Disposing a CORS-tainted or
  takeover-failed handle left the element marked as claimed, so an SPA
  re-inserting the same node never re-attached and stayed unmanaged for the
  rest of the document. Dispose now un-claims on every teardown path.

## [2.0.1] — 2026-08-27

### Added
- **Eval coverage for startup slew.** The balance-algo eval suite gains a D5
  startup-overshoot scenario, slew-rate modelling in the simulator, a
  `warmup-tune` calibration report, and an S1 scenario in the tune suite to
  drive and verify the new warm-up parameters.

### Fixed
- **Startup blast eliminated.** On quiet videos the balancer could apply its
  full +24 dB boost ceiling for the first few hundred ms because the earliest
  measurement window under-reads a quiet intro by 10–20 LU. Two safeguards:
  gain *increases* are now slew-limited (+6 dB ≈ 0.3 s smooth swell, drops
  still instant), and decisions made on fewer than four measurement blocks cap
  boosts at +10 dB until the reading stabilises.

## [1.1.0] — 2026-06-18

### Added
- **Sample-rate-aware K-weighting.** The ITU-R BS.1770 filter coefficients are
  now designed for the runtime `AudioContext.sampleRate` via bilinear-transform
  pre-warping (De Man 2018 / pyloudnorm), instead of the fixed 48 kHz
  constants. Corrects a 0.3–0.7 LU drift on 44.1 kHz contexts (the macOS
  default) that biased every gain decision. At 48 kHz the output is numerically
  identical to the previous constants.
- **Popup long-lived Port.** The popup now streams state from the service
  worker over `chrome.runtime.connect` instead of polling `GET_STATE` at 4 Hz.
  Latency drops to ~10 Hz (tracks the balance loop directly) and the SW stops
  being woken by poll traffic.
- **Storage schema versioning.** Settings and limiter records now carry a
  `__v` tag and run through an idempotent migration chain on load. Existing
  per-field validation + the ratio clamp are formalised as `migrate_v0_v1`.
- **AudioContext lifecycle backstop.** The shared context is closed when the
  extension is invalidated *and* all media elements have detached, preventing
  leaks across extension reloads.
- **CI workflows.** `.github/workflows/ci.yml` runs type-check + lint + test +
  build on every push/PR; `release.yml` publishes `release/release.zip` as a
  GitHub Release asset on `v*` tags.
- **Test coverage gate.** Algorithm core (`src/audio`, `src/storage`,
  `media-manager`) is held to a 70 % line threshold via `pnpm test:coverage`.
- **Favicon privacy.** Tab favicons are now served from Chrome's local
  `_favicon/` cache (new `favicon` permission) or the SW-captured
  `tab.favIconUrl`. Zero network egress — the previous `google.com/s2/favicons`
  path leaked every open domain.
- `LICENSE` (MIT), `PRIVACY.md`, and this `CHANGELOG.md`.

### Changed
- Mono sources are no longer duplicated into both channels before K-weighting,
  fixing a +3 dB bias on podcasts and single-channel clips.
- `pnpm lint` now ignores `scripts/*.cjs`, `tools/*.mjs`, and `eval/**`
  (dev-only harnesses that don't ship).

### Fixed
- Mono input energy doubling (+3.01 dB LUFS bias on single-channel sources).
- K-weighting frequency-response drift on non-48 kHz AudioContexts.
- `loadSettings()` rejection no longer leaves `settingsLoaded` pending
  forever (which would freeze every SW handler).

## [1.0.0] — 2026-06-15

### Added
- Automatic cross-tab loudness balancing toward a configurable target LUFS
  (default −14), with no user interaction.
- ITU-R BS.1770-4 K-weighted loudness measurement via an AudioWorklet.
- Per-tab A/B bypass toggle; output limiter (DynamicsCompressor) on by default.
- Lazy AudioContext takeover to respect Chrome's autoplay policy.
- 「暖夜灯」 dark amber popup theme; bilingual UI (English / 简体中文).
- Unit test suite (vitest), e2e suite (Playwright), offline algorithm tuner.

[Unreleased]: https://github.com/mzaxd/EqualLoud/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/mzaxd/EqualLoud/compare/v2.0.0...v2.0.1
[1.1.0]: https://github.com/mzaxd/EqualLoud/releases/tag/v1.1.0
[1.0.0]: https://github.com/mzaxd/EqualLoud/releases/tag/v1.0.0
