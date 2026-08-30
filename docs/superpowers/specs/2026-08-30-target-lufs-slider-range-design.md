# Target LUFS Slider Range: [−60, 0] → [−36, −6]

**Date:** 2026-08-30
**Status:** Approved

## Problem

The target-loudness slider exists in two surfaces (popup `AutoBalance.vue`, options page
`Options.vue`) and both span [−60, 0] LUFS. Roughly 40 % of that travel is a dead zone:

- **Top (−8…0):** physically unreachable. A full-scale sine integrates to ≈ −3 LUFS, and
  with the −1 dBTP output limiter real program material tops out around −9/−8 LUFS. A
  target above that can never converge — the balancer would just slam the limiter and
  distort indefinitely.
- **Bottom (−60…−36):** near-silence territory. The lowest real delivery standard is
  broadcast −23 LUFS (a built-in preset); cinema-style dialog mixing sits around
  −27/−31. −60 is already `DEFAULT_MIN_GAIN_DB`'s "effectively silence".

Cost of the dead zones: on the 348 px popup the ~300 px track yields ≈5 px per LU,
making precise dialling (e.g. exactly −16) fiddly.

## Decision

Shrink the whole shared axis to **[−36, −6] LUFS** (30 LU span) everywhere — popup
meter + knob, options slider, service-worker clamp, and stored-data migration.

- Covers all three presets (−14/−16/−23) with ≥ 8 LU headroom above and 13 LU margin
  below. Factory default −14 unchanged.
- Drag resolution roughly doubles to ≈10 px/LU on the popup track.
- Below-range live loudness (pauses, very quiet passages < −36 LUFS short-term) pegs the
  meter fill at 0 % — visually identical to today's paused/silence state. Accepted
  trade-off of keeping the knob and fill on one shared axis (the alternative —
  restricting only the knob's travel — breaks the "knob sits where the target sits
  relative to live loudness" alignment and was rejected; a nonlinear axis was rejected
  as over-complex for a popup).

## Changes

### 1. `src/audio/config.ts` — new constants

```ts
export const MIN_TARGET_LUFS = -36
export const MAX_TARGET_LUFS = -6
```

Documented with the rationale above (physical ceiling, broadcast margin, popup
resolution). `DEFAULT_TARGET_LUFS` and `LOUDNESS_PRESETS` unchanged.

### 2. `src/components/AutoBalance.vue`

- Range input `min`/`max` bound to the constants (currently hardcoded `"-60"`/`"0"`).
- `pct()` maps via `MIN_TARGET_LUFS`/`MAX_TARGET_LUFS`; clamps to [0, 100] as today, so
  live values outside the range pin at the track ends.
- Scale row re-anchored: majors every 6 LU (−36/−30/−24/−18/−12/−6 — six evenly spaced
  labels including both endpoints; −24 sits next to the broadcast preset), minors every
  3 LU offset from them (−33/−27/−21/−15/−9).

### 3. `src/options/Options.vue`

- Range input `min`/`max` bound to the same constants. No scale row exists here; no
  other change.

### 4. `src/background.ts` — SW clamp

`handleSetTargetLufs` clamps into `[MIN_TARGET_LUFS, MAX_TARGET_LUFS]` instead of
`[-60, 0]`, so a stale/foreign popup cannot write an out-of-range target.

### 5. `src/storage/migrate.ts` — v1 → v2 migration

- `CURRENT_SCHEMA_VERSION` 1 → 2.
- New `migrate_v1_v2`: clamps a finite `targetLufs` into the new range. A user who had
  stored e.g. −50 lands at −36 rather than keeping a value no slider surface can
  display or reach. In-range values (including −14/−16/−23) pass through. Idempotent,
  registered in the `MIGRATIONS` chain, doc-commented in the established style.

### 6. Tests

- `src/__tests__/migrate.spec.ts`: new v1→v2 cases — −50 → −36, 0 → −6, in-range
  passthrough, `__v` bump to 2, idempotence.
- `src/__tests__/components/AutoBalance.spec.ts`: the fill-percentage case asserts
  `width: 70%` for short-term −18 under the old mapping; becomes `60 %`
  ((−18+36)/30). Update the inline math comment likewise.
- `src/__tests__/config.spec.ts`: add assertions pinning the new constants (file's
  existing style pins every exported tuning knob).
- `src/__tests__/background.spec.ts` and existing e2e fill values (−30/−20/−14) are
  already inside the new range — unchanged.
- `e2e/popup.spec.ts` (~line 64) and `e2e/equalloud.spec.ts` (~lines 48–49) pin
  `min="-60"`/`max="0"` — update to `-36`/`-6`.

## Out of scope

- `DEFAULT_MIN_GAIN_DB` (−60 per-tab gain floor) — a different quantity, untouched.
- Presets, limiter ceiling, balancing algorithm.

## Verification

- `npm run test` (vitest unit suites) green.
- E2E popup/equalloud specs green; manual check: popup knob at −14 sits at ≈73 % of
  the track ((−14+36)/30), options slider endpoints match, and a pre-v2 stored target
  of −50 clamps to −36 after reload.
