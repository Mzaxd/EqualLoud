# Target LUFS Slider Range [−60, 0] → [−36, −6] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the user-facing target-loudness axis from [−60, 0] to [−36, −6] LUFS across popup meter, options page, the service-worker clamp, and stored-data migration.

**Architecture:** New bounds constants in `src/audio/config.ts` become the single source of truth; both slider surfaces bind to them, the SW clamps writes with them, and a v1→v2 storage migration pulls persisted targets into range. Spec: `docs/superpowers/specs/2026-08-30-target-lufs-slider-range-design.md`.

**Tech Stack:** Vue 3 `<script setup>`, Pinia, Vitest, Playwright (extension e2e).

## Global Constraints

- Bounds: `MIN_TARGET_LUFS = -36`, `MAX_TARGET_LUFS = -6` (exact values).
- `DEFAULT_TARGET_LUFS = -14` and presets −14/−16/−23 stay untouched (all in range).
- `DEFAULT_MIN_GAIN_DB = -60` is a different quantity (per-tab gain floor) — do NOT touch it.
- Storage migration: `CURRENT_SCHEMA_VERSION` 1 → 2, new `migrate_v1_v2`, clamping idempotent.
- Commits follow the repo's conventional style (`feat(scope): …`), one per task.
- Test commands: `npm run test:unit` (vitest), `npm run type-check`, `npm run lint`, `npm run test:e2e` (playwright).

---

### Task 1: Bounds constants in config + pinning tests

**Files:**
- Modify: `src/audio/config.ts` (after the `DEFAULT_TARGET_LUFS` block, ~line 15)
- Test: `src/__tests__/config.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const MIN_TARGET_LUFS = -36` and `export const MAX_TARGET_LUFS = -6` from `@/audio/config` — every later task imports these exact names.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/config.spec.ts`, extend the existing `@/audio/config` import to:

```ts
import {
  BOOST_REPORT_HZ,
  BOOST_REPORT_MS,
  DEFAULT_TARGET_LUFS,
  GAIN_ATTACK_TC,
  GAIN_SMOOTH_TC,
  LOUDNESS_PRESETS,
  LUFS_REPORT_HZ,
  MAX_TARGET_LUFS,
  MIN_TARGET_LUFS,
} from '@/audio/config'
```

and append a new describe block at the end of the file:

```ts
/**
 * Invariants for the target-LUFS slider axis. If the bounds drift away from
 * the presets/default, a preset tap or a factory reset lands the knob where
 * no slider surface can display it.
 */
describe('target-LUFS slider bounds', () => {
  it('spans [−36, −6] with a sane ordering', () => {
    expect(MIN_TARGET_LUFS).toBe(-36)
    expect(MAX_TARGET_LUFS).toBe(-6)
    expect(MIN_TARGET_LUFS).toBeLessThan(MAX_TARGET_LUFS)
  })

  it('covers the factory default and every built-in preset', () => {
    for (const p of LOUDNESS_PRESETS) {
      expect(p.targetLufs).toBeGreaterThanOrEqual(MIN_TARGET_LUFS)
      expect(p.targetLufs).toBeLessThanOrEqual(MAX_TARGET_LUFS)
    }
    expect(DEFAULT_TARGET_LUFS).toBeGreaterThanOrEqual(MIN_TARGET_LUFS)
    expect(DEFAULT_TARGET_LUFS).toBeLessThanOrEqual(MAX_TARGET_LUFS)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/config.spec.ts`
Expected: FAIL — `MIN_TARGET_LUFS` is not exported by `@/audio/config` (import error).

- [ ] **Step 3: Write minimal implementation**

In `src/audio/config.ts`, immediately after the `DEFAULT_TARGET_LUFS` declaration (line ~15), insert:

```ts
/**
 * Slider-range bounds for the user-facing target control (popup meter and
 * options page). The old [−60, 0] axis wasted ~40 % of its travel: above
 * −8 LUFS a target can never converge (a full-scale sine integrates to
 * ≈ −3 LUFS and the −1 dBTP output limiter caps real program material near
 * −9), and below −36 is near-silence nobody targets (lowest real delivery
 * standard: broadcast −23). [−36, −6] covers every preset with ≥ 8 LU
 * headroom above and 13 LU margin below, and roughly doubles the popup
 * track's drag resolution (~5 px/LU → ~10 px/LU on the 348 px popup).
 */
export const MIN_TARGET_LUFS = -36
export const MAX_TARGET_LUFS = -6
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/config.spec.ts`
Expected: PASS (all tests, including the existing latency-tuning invariants).

- [ ] **Step 5: Commit**

```bash
git add src/audio/config.ts src/__tests__/config.spec.ts
git commit -m "feat(config): add [−36,−6] bounds for the target-LUFS slider"
```

---

### Task 2: v1→v2 storage migration clamps stored targetLufs

**Files:**
- Modify: `src/storage/migrate.ts` (version bump at line 29, new step + registration)
- Test: `src/__tests__/migrate.spec.ts`

**Interfaces:**
- Consumes: `MIN_TARGET_LUFS` / `MAX_TARGET_LUFS` from `@/audio/config` (Task 1).
- Produces: `CURRENT_SCHEMA_VERSION === 2`; stored `targetLufs` guaranteed inside [−36, −6] after `hydratePayload`. The SW (Task 3) relies on this on every load.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/migrate.spec.ts`, extend the config import to:

```ts
import { DEFAULT_LIMITER_SETTINGS, DEFAULT_TARGET_LUFS, MAX_TARGET_LUFS, MIN_TARGET_LUFS } from '@/audio/config'
```

Inside `describe('migratePayload')`, update the existing chain test — its `__v` assertion goes from `1` to `2` now that a v0 payload runs through two steps (rename it to match):

```ts
  it('treats a missing __v as v0 and runs the chain to current', () => {
    // Pre-versioning data: no __v, but valid settings/limiter fields.
    const out = migratePayload({
      settings: { enabled: false, targetLufs: -20 },
      limiter: { enabled: true, thresholdDb: -2, kneeDb: 0, ratio: 4, attackMs: 1, releaseMs: 100 },
    })
    expect(out.__v).toBe(2)
    expect(out.settings?.enabled).toBe(false)
    expect(out.settings?.targetLufs).toBe(-20) // in the new range, untouched
    expect(out.limiter?.ratio).toBe(4) // in range, unchanged
  })
```

Then add three new cases after the `clamps ratio below 1 up to 1` test:

```ts
  it('v1→v2 clamps a stored target below the new slider floor', () => {
    const out = migratePayload({ __v: 1, settings: { targetLufs: -50 } })
    expect(out.__v).toBe(2)
    expect(out.settings?.targetLufs).toBe(MIN_TARGET_LUFS) // −50 → −36
    // Idempotent: the clamped value is a fixed point.
    expect(migratePayload(out)).toEqual(out)
  })

  it('v1→v2 clamps a stored target above the new slider ceiling', () => {
    const out = migratePayload({ __v: 1, settings: { targetLufs: 0 } })
    expect(out.settings?.targetLufs).toBe(MAX_TARGET_LUFS) // 0 → −6
  })

  it('v1→v2 passes in-range targets through untouched', () => {
    const out = migratePayload({ __v: 1, settings: { targetLufs: -14 } })
    expect(out.__v).toBe(2)
    expect(out.settings?.targetLufs).toBe(-14)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/migrate.spec.ts`
Expected: FAIL — the new cases get `__v: 1` and unclamped −50 / 0 (no v1→v2 step exists yet), and the updated chain test still sees `__v` 1.

- [ ] **Step 3: Write minimal implementation**

In `src/storage/migrate.ts`:

a) Bump the version and its doc comment:

```ts
export const CURRENT_SCHEMA_VERSION = 2
```

b) Extend the config import at the top:

```ts
import { DEFAULT_LIMITER_SETTINGS, MAX_TARGET_LUFS, MIN_TARGET_LUFS } from '@/audio/config'
```

c) After `migrate_v0_v1`, add:

```ts
/**
 * v1 → v2: the user-facing target-LUFS axis shrank from [−60, 0] to [−36, −6]
 * (docs/superpowers/specs/2026-08-30-target-lufs-slider-range-design.md).
 * Clamp a stored target into the new range so a value no slider surface can
 * display (e.g. a −50 set under the old axis) converges to the nearest
 * reachable setting instead of surviving as an invisible outlier. In-range
 * values — every preset and the −14 factory default — pass through.
 *
 * Idempotent: clamped values are fixed points. Does NOT set __v — the
 * migratePayload() loop owns version bookkeeping.
 */
function migrate_v1_v2(payload: VersionedPayload): VersionedPayload {
  const s = payload.settings
  if (s && typeof s.targetLufs === 'number' && Number.isFinite(s.targetLufs)) {
    return {
      ...payload,
      settings: {
        ...s,
        targetLufs: Math.min(MAX_TARGET_LUFS, Math.max(MIN_TARGET_LUFS, s.targetLufs)),
      },
    }
  }
  return payload
}
```

d) Register it in the `MIGRATIONS` list:

```ts
const MIGRATIONS: { from: number; migrate: (p: VersionedPayload) => VersionedPayload }[] = [
  { from: 0, migrate: migrate_v0_v1 },
  { from: 1, migrate: migrate_v1_v2 },
]
```

Also update the comment above the list that says "To add v1 → v2: append …" to describe appending future steps (v2 → v3).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/migrate.spec.ts`
Expected: PASS (the existing "is a no-op on already-current data" and `hydratePayload` suites use `CURRENT_SCHEMA_VERSION`, so they adapt automatically).

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrate.ts src/__tests__/migrate.spec.ts
git commit -m "feat(storage): v1→v2 migration clamps stored targetLufs into [−36,−6]"
```

---

### Task 3: SW clamp on SET_TARGET_LUFS

**Files:**
- Modify: `src/background.ts:313` (the clamp inside `handleSetTargetLufs`) and the config import block at lines 18–24
- Test: `src/__tests__/background.spec.ts`

**Interfaces:**
- Consumes: `MIN_TARGET_LUFS` / `MAX_TARGET_LUFS` (Task 1).
- Produces: `settings.targetLufs` always clamped to [−36, −6] no matter what a (stale/foreign) popup sends.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/background.spec.ts`, add after the `rebalances immediately when SET_TARGET_LUFS changes` test (same describe block, following the file's `GET_STATE` round-trip pattern):

```ts
  it('clamps SET_TARGET_LUFS into the [−36, −6] slider range', async () => {
    await background.handleMessage({ type: 'SET_TARGET_LUFS', targetLufs: -50 })

    const state = (await background.handleMessage({ type: 'GET_STATE' })) as {
      settings: { targetLufs: number }
    }
    expect(state.settings.targetLufs).toBe(-36)
  })
```

(Use the literal −36 here to match the file's existing literal-driven style; `config.spec.ts` already pins the constant's value.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/background.spec.ts`
Expected: FAIL — the −50 write survives, `state.settings.targetLufs` is −50.

- [ ] **Step 3: Write minimal implementation**

In `src/background.ts`, add the two names to the existing config import block (alphabetical order):

```ts
import {
  ALARM_SCAN_PERIOD_MIN,
  DEFAULT_LIMITER_SETTINGS,
  DEFAULT_MAX_GAIN_DB,
  DEFAULT_MIN_GAIN_DB,
  DEFAULT_TARGET_LUFS,
  MAX_TARGET_LUFS,
  MIN_TARGET_LUFS,
} from '@/audio/config'
```

and change the clamp in `handleSetTargetLufs`:

```ts
async function handleSetTargetLufs(targetLufs: number): Promise<{ settings: Settings }> {
  settings.targetLufs = Math.max(MIN_TARGET_LUFS, Math.min(MAX_TARGET_LUFS, targetLufs))
  await persistSettings()
  maybeBalance(true)
  pushStateToPopups()
  return { settings }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/background.spec.ts`
Expected: PASS (existing cases use −30/−20/−14 — all inside the new range).

- [ ] **Step 5: Commit**

```bash
git add src/background.ts src/__tests__/background.spec.ts
git commit -m "feat(sw): clamp SET_TARGET_LUFS into the [−36,−6] slider range"
```

---

### Task 4: Popup meter + knob on the new axis (AutoBalance.vue)

**Files:**
- Modify: `src/components/AutoBalance.vue` (imports, header doc ~line 14, `pct()` ~line 56, tick arrays ~line 110, template `min`/`max` ~line 138)
- Test: `src/__tests__/components/AutoBalance.spec.ts`

**Interfaces:**
- Consumes: `MIN_TARGET_LUFS` / `MAX_TARGET_LUFS` (Task 1).
- Produces: popup slider renders `min="-36" max="-6"` (e2e in Task 6 pins this); `pct()` maps [−36, −6] → [0, 100] with clamping at both ends.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/components/AutoBalance.spec.ts`:

a) In `renders the combined meter track and target slider` (line ~42), pin the axis:

```ts
    expect(wrapper.find('.c-track').exists()).toBe(true)
    expect(wrapper.find('.target-slider').exists()).toBe(true)
    expect(wrapper.find('.target-slider').attributes('min')).toBe('-36')
    expect(wrapper.find('.target-slider').attributes('max')).toBe('-6')
```

b) In `drives the fill from the loudest balanced tab short-term` (line ~105), update the mapping — short-term −18 now lands at 60 %:

```ts
      // shortTerm -18 → ((-18 − (−36)) / ((−6) − (−36))) × 100 = 60%. A 0.5px
      // tolerance covers the CSS px rounding vs. the JS percentage string.
      expect(fill.attributes('style')).toContain('width: 60%')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/components/AutoBalance.spec.ts`
Expected: FAIL — min/max still read `-60`/`0`, fill still `70%`.

- [ ] **Step 3: Implement**

In `src/components/AutoBalance.vue`:

a) Add the import (before the `@/composables` line, alphabetical):

```ts
import { MAX_TARGET_LUFS, MIN_TARGET_LUFS } from '@/audio/config'
```

b) Update the header doc comment (lines ~14–16) — replace

```
 * [-60, 0] LUFS range so the knob
```
with
```
 * [MIN_TARGET_LUFS, MAX_TARGET_LUFS] (−36/−6) LUFS range so the knob
```
and replace
```
 * A scale row
 * beneath (-60 / -40 / -20 / 0 majors, plus minor ticks) lets you read both
```
with
```
 * A scale row
 * beneath (majors every 6 LU from −36 to −6, plus minor ticks) lets you read both
```

c) Replace `pct()`:

```ts
/** Map a LUFS value in [MIN_TARGET_LUFS, MAX_TARGET_LUFS] to [0, 100] %. */
function pct(lufs: number): number {
  if (!Number.isFinite(lufs)) return 0
  const span = MAX_TARGET_LUFS - MIN_TARGET_LUFS
  return Math.max(0, Math.min(100, ((lufs - MIN_TARGET_LUFS) / span) * 100))
}
```

(Live loudness below −36 or above −6 clamps to the track ends, as −Infinity already clamps to 0 today.)

d) Replace the tick arrays (endpoints anchored to the constants so a future retune shifts the scale with them):

```ts
// Static scale ticks for the [MIN_TARGET_LUFS, MAX_TARGET_LUFS] axis. Majors
// every 6 LU including both endpoints (−24 sits beside the broadcast preset);
// minors every 3 LU offset from them. Percentages are precomputed (the axis is
// fixed-width) so there is zero per-frame work.
const SCALE_MINORS = [MIN_TARGET_LUFS + 3, -27, -21, -15, MAX_TARGET_LUFS - 3]
const SCALE_MAJORS = [MIN_TARGET_LUFS, -30, -24, -18, -12, MAX_TARGET_LUFS]
```

e) In the template, replace the static attributes:

```html
        :min="MIN_TARGET_LUFS"
        :max="MAX_TARGET_LUFS"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/components/AutoBalance.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AutoBalance.vue src/__tests__/components/AutoBalance.spec.ts
git commit -m "feat(popup): retarget meter + knob to the [−36,−6] LUFS axis"
```

---

### Task 5: Options page slider on the new axis

**Files:**
- Modify: `src/options/Options.vue` (script imports, template `min`/`max` at line ~120)

**Interfaces:**
- Consumes: `MIN_TARGET_LUFS` / `MAX_TARGET_LUFS` (Task 1).
- Produces: options-page slider bounded to [−36, −6]. No unit spec exists for this page (verified); correctness is pinned by type-check here and manual/e2e inspection.

- [ ] **Step 1: Implement**

In `src/options/Options.vue`, add the import (before the `@/composables` line, alphabetical):

```ts
import { MAX_TARGET_LUFS, MIN_TARGET_LUFS } from '@/audio/config'
```

and in the template replace the static attributes:

```html
          <input
            type="range"
            class="slider"
            :min="MIN_TARGET_LUFS"
            :max="MAX_TARGET_LUFS"
            step="1"
```

(keep `step="1"` and everything after unchanged).

- [ ] **Step 2: Verify types and lint**

Run: `npm run type-check && npm run lint`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/options/Options.vue
git commit -m "feat(options): bind target slider to the [−36,−6] bounds"
```

---

### Task 6: E2E pins + full verification

**Files:**
- Modify: `e2e/popup.spec.ts` (comment line ~58, assertion line ~64)
- Modify: `e2e/equalloud.spec.ts` (assertions lines ~48–49)

**Interfaces:**
- Consumes: rendered popup with `min="-36" max="-6"` (Task 4).
- Produces: e2e suites green on the new axis.

- [ ] **Step 1: Update the popup e2e**

In `e2e/popup.spec.ts`:

```ts
    // Target slider at production defaults (−14 LUFS inside −36..−6).
```

and

```ts
    expect(slider).toEqual({ min: '-36', max: '-6', value: '-14' })
```

- [ ] **Step 2: Update the smoke e2e**

In `e2e/equalloud.spec.ts`:

```ts
    await expect(slider).toHaveAttribute('min', '-36')
    await expect(slider).toHaveAttribute('max', '-6')
```

- [ ] **Step 3: Full unit suite + type-check + lint**

Run: `npm run test:unit && npm run type-check && npm run lint`
Expected: all green.

- [ ] **Step 4: Run the affected e2e suites**

Run: `npx playwright test e2e/popup.spec.ts e2e/equalloud.spec.ts`
Expected: PASS (both build the real extension and drive the real popup).

- [ ] **Step 5: Commit**

```bash
git add e2e/popup.spec.ts e2e/equalloud.spec.ts
git commit -m "test(e2e): pin the popup slider to the [−36,−6] axis"
```

- [ ] **Step 6: Manual sanity (optional but recommended)**

Load the built extension, open the popup: knob at −14 sits at ≈73 % of the track ((−14+36)/30); scale reads −36/−30/−24/−18/−12/−6; nothing below −36 pegs the fill at 0 % during pauses. On a profile with a stored target of −50, reload → target reads −36.
