# Balance Algorithm Evaluation Suite

A dedicated evaluation harness for EqualLoud's loudness-balance algorithm —
the measurement layer (`src/audio/lufs.ts`, ITU-R BS.1770-4) and the decision
layer (`src/audio/balance.ts`, `computeBalanceGains`).

The unit tests under `src/__tests__/` verify *boundary logic* (clamp/skip/solo
behaves, outputs are finite). They do **not** answer the question that
actually matters: *"does this algorithm balance loudness well on real audio?"*
This suite does.

## Run it

```bash
pnpm test:eval        # just the eval suite (~1.5 s, 32 tests)
pnpm test:all         # unit tests + eval suite
```

Each scenario prints a one-line metrics table plus an ASCII output-LUFS trace
so you can eyeball convergence, overshoot, and ringing — not just trust
pass/fail.

## What it checks

| Group | File | Question answered |
|---|---|---|
| **A** Measurement accuracy | `measurement.spec.ts` | Is the LUFS meter *correct*? (vs closed-form analytic truth, not vs another internal implementation) |
| **B** Single-tab convergence | `convergence.spec.ts` | Does one source converge to target from above and below? |
| **C** Multi-tab balancing | `convergence.spec.ts` | Do several sources of different loudness all settle within 1 LU of each other? |
| **D** Realistic scenarios | `scenarios.spec.ts` | Ad insertion, silence gaps, level jumps, boost ceiling — do real-world events behave? |
| **E** Stability & margins | `stability.spec.ts` | No limit-cycle hunting; once settled, stays settled |

## Metrics (printed per scenario)

| Column | Meaning |
|---|---|
| `start` | Output LUFS at the first valid tick (the starting level) |
| `target` | The LUFS the loop is driving toward |
| `Tconv` | Seconds until output enters ±1 LU of target **and never leaves** |
| `SSerr` | Mean \|output − target\| over the last 5 s (steady-state error) |
| `over` | Max excursion *past* target during approach (overshoot) |
| `rippl` | Stddev of output LUFS over the steady window (hunting/ripple) |

`PASS`/`FAIL` colouring uses the default thresholds (`Tconv ≤ 8s`, `SSerr ≤
0.5 LU`, `over ≤ 1.5 LU`, `rippl ≤ 0.5 LU`). **Note:** a small number of
scenarios (notably D4, which deliberately tests the boost ceiling) are
*expected* to show `FAIL` on the convergence columns — their own assertions
check bounded non-convergence, not arrival at target. The vitest test result
(line `✓ eval/scenarios.spec.ts (4 tests)`) is the source of truth; the
table colouring is a visual aid only.

## How it works

The harness is a **deterministic discrete-time closed-loop simulator**
(`simulate.ts`) that reproduces EqualLoud's real data path in pure TypeScript,
with no browser or Chrome:

```
each tick (~100 ms of audio):
  1. chunk     = base audio for this tick
  2. played    = chunk × current appliedGain       ← the gain decision from last tick
  3. calc.processInterleaved(played)                ← LufsCalculator (the worklet's job)
  4. measured  = calc.getShortTermLoudness()
  5. decision  = computeBalanceGains([...], target) ← the service worker's job
  6. appliedGain = decision.gainDb                  ← applied on the next tick
  7. record    trace row
```

It wires together the **real** algorithm modules — `LufsCalculator` and
`computeBalanceGains` are imported from `src/`, not reimplemented. So a change
to the algorithm immediately shows up here.

Signals are generated deterministically (seeded PRNG, `signals.ts`) so every
run produces bit-identical audio and results are reproducible across versions
and machines — essential for regression comparison.

Measurement correctness (group A) is anchored to **closed-form analytic
values** derived in `references.ts` from the K-weighting biquad coefficients
(`|H(e^{jω})|²`), not by comparing two internal implementations to each other.
This is what makes the suite a *correctness* check rather than a *consistency*
check.

## Known simplifications (conservative)

These are documented modelling choices. None of them flatter the algorithm —
each makes the simulation a *harder* stability test than production:

1. **Gain is applied per-tick (instantaneously), not ramped.** Production
   uses `GainNode.setTargetAtTime(…, 50 ms)`, which only ever smooths changes
   and reduces overshoot. The simulator's instantaneous application is the
   worst case for ringing; if the sim is stable, production is at least as
   stable.

2. **The limiter (DynamicsCompressor) is not modelled.** It only affects
   output above −1 dBFS post-boost and is orthogonal to whether the *balance
   decision* converges. Scenarios that would clip are called out in their specs.

3. **blockCount uses the calculator's gated count.** In production the worklet
   reports an ungated per-hop count. For all non-silent test signals these are
   identical, so balance engages at the same wall-clock moment. For genuinely
   silent signals balance correctly never engages (nothing to balance).

## Adding a scenario

1. Generate a signal with `signals.ts` (`pinkNoise`, `sine`,
   `pinkNoiseScenario` for dynamic level changes, `concatStereo` to stitch).
2. Call `runScenario(tabs, { scenario, targetLufs, durationSec })` from
   `eval-helpers.ts` — it runs the sim, computes metrics, and prints the report.
3. Assert on the returned `TabResult[]` (`.metrics` for summary fields,
   `.trace` for per-tick detail on dynamic scenarios).

Use `pinkAmpDbFor(targetLufs)` (= `lufs + 11.85`) to get the pink-noise peak
amplitude that yields a desired measured LUFS — pink noise's LUFS sits a fixed
11.85 dB below its peak dBFS.

## Findings recorded by this suite

- The meter matches closed-form K-weighting to within 0.25 LU across
  frequencies and amplitudes (group A).
- Single and multi-tab sources converge to target in ~1–2 s with **zero**
  steady-state error and **zero** ripple in the sim (groups B/C/E) — the
  algorithm is effectively a clean proportional controller thanks to the
  3 s short-term window providing stable feedback.
- **The +12 dB boost ceiling cannot lift content quieter than ~−26 LUFS up to
  a −14 target** (group D4). This is a documented algorithm characteristic,
  not a bug: gain clamps at +12 and stays bounded. If you want quieter content
  balanced, raise `DEFAULT_MAX_GAIN_DB` (at the cost of amplifying the noise
  floor).
- Silence gaps hold the previous gain and recover cleanly (D2) — the
  `!Number.isFinite(shortTerm)` skip in `computeBalanceGains` is doing its job
  as a noise-floor-pumping guard.
