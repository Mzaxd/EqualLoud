/**
 * Group D — realistic dynamic scenarios.
 *
 * Where groups A/B/C test the steady-state question "does it converge?",
 * group D tests the *transient* question: "when real-world things happen — an
 * ad breaks in, a podcast goes silent, the level jumps, the source is too quiet
 * to ever reach target — does the algorithm behave well?"
 *
 * These are the scenarios that map to user pain points:
 *   D1  loud ad interrupting quiet content   (react fast, recover, no runaway)
 *   D2  silence gap in a podcast             (don't pump the noise floor)
 *   D3  mid-stream level jump                (re-converge promptly)
 *   D4  source too quiet for the +12 ceiling (documented, bounded behaviour)
 *
 * # Reading the metrics for dynamic scenarios
 *
 * The whole-trace "steady error" is misleading when the level changes mid-run,
 * so these specs reach into the trace directly to assert on behaviour *after*
 * the change point (runScenario returns the full trace per tab for this).
 */

import { describe, it, expect } from 'vitest'

import { runSingleScenario, type TabResult } from './eval-helpers'
import { pinkNoise, pinkNoiseScenario, silence, concatStereo } from './signals'

const SR = 48000
const TARGET = -14

/** Pink-noise peak amplitude (dBFS) that yields a given measured LUFS. */
function pinkAmpDbFor(lufs: number): number {
  return lufs + 11.85
}

/** Trace rows for a tab. */
function rows(tab: TabResult) {
  return tab.trace
}

/**
 * Time (seconds) of the first tick at or after `tAfter` whose output is within
 * `band` LU of target AND that is followed by a suffix staying inside. Returns
 * null if it never re-settles. Used for post-change-point convergence checks.
 */
function reconvergeTimeSec(
  tab: TabResult,
  target: number,
  tAfter: number,
  band = 1.0,
): number | null {
  const trace = rows(tab)
  let lastOutside = -1
  for (let i = 0; i < trace.length; i++) {
    const r = trace[i]!
    const inside = Number.isFinite(r.outputLufs) && Math.abs(r.outputLufs - target) <= band
    // Only count as "outside" if it's after the change point; before the
    // change point we don't care about re-convergence.
    if (!inside && r.tSec >= tAfter) lastOutside = i
  }
  if (lastOutside >= trace.length - 1) return null
  if (lastOutside < 0) return tAfter // already inside throughout the post window
  return trace[lastOutside + 1]!.tSec
}

// ---------------------------------------------------------------------------
// D1 — loud ad interrupting quiet content
// ---------------------------------------------------------------------------

describe('D1 — loud ad insertion', () => {
  it('quiet podcast (-20), loud ad (-6) for 5s, back to podcast: re-converges without runaway', () => {
    // Build a dynamic signal: 4s podcast → 5s loud ad → rest podcast.
    const sig = pinkNoiseScenario(
      SR,
      [
        { amplitudeDb: pinkAmpDbFor(-20), durationSec: 4 },
        { amplitudeDb: pinkAmpDbFor(-6), durationSec: 5 },
        { amplitudeDb: pinkAmpDbFor(-20), durationSec: 9 },
      ],
      100,
    )
    const tab = runSingleScenario(
      { id: 1, label: 'podcast+ad', signal: sig },
      { scenario: 'D1-ad-insert', targetLufs: TARGET, durationSec: 18 },
    )

    const trace = rows(tab)
    // Sanity: output is finite for most of the run.
    const finiteCount = trace.filter((r) => Number.isFinite(r.outputLufs)).length
    expect(finiteCount).toBeGreaterThan(trace.length * 0.8)

    // After the ad ends (t = 9s) + a grace for the 3s short-term window to
    // flush the loud blocks, output must re-settle to within 2 LU of target.
    const reconv = reconvergeTimeSec(tab, TARGET, 9 + 4, 2.0)
    expect(reconv, 'never re-converged after the ad').not.toBeNull()
    expect(reconv!, 're-convergence too slow after ad').toBeLessThanOrEqual(16)

    // No runaway: gain never exceeds the +12 ceiling or drops below the floor.
    for (const r of trace) {
      expect(r.appliedGainDb).toBeLessThanOrEqual(12 + 0.01)
      expect(r.appliedGainDb).toBeGreaterThanOrEqual(-60 - 0.01)
    }
  })
})

// ---------------------------------------------------------------------------
// D2 — silence gap (regression-protection test)
// ---------------------------------------------------------------------------

describe('D2 — silence gap does not pump the noise floor', () => {
  it('podcast with a 2s silence gap holds gain, recovers, no explosion', () => {
    // The algorithm skips balance for tabs whose shortTerm is non-finite
    // (balance.ts: `if (!Number.isFinite(tab.shortTerm)) continue`). During a
    // silence gap the worklet reports −∞, so computeBalanceGains returns no
    // decision and the SW simply doesn't send a new SET_GAIN — the last gain
    // is held. This test pins that behaviour: a regression that made the
    // decision run on silence (e.g. treating −∞ as "very quiet, boost max")
    // would explode the noise floor and fail here.
    const before = pinkNoise({
      sampleRate: SR,
      durationSec: 5,
      amplitudeDb: pinkAmpDbFor(-20),
      seed: 200,
      channels: 2,
    })
    const gap = silence(SR, 2)
    const after = pinkNoise({
      sampleRate: SR,
      durationSec: 7,
      amplitudeDb: pinkAmpDbFor(-20),
      seed: 201,
      channels: 2,
    })
    const sig = concatStereo(concatStereo(before, gap), after)
    const tab = runSingleScenario(
      { id: 1, label: 'podcast+silence', signal: sig },
      { scenario: 'D2-silence-gap', targetLufs: TARGET, durationSec: 14 },
    )

    const trace = rows(tab)
    // During the silence gap (~t = 5..7s) and a bit after, gain must NOT spike
    // toward the ceiling — that would be the noise-floor-pumping failure mode.
    const duringAndAfterGap = trace.filter((r) => r.tSec >= 5 && r.tSec <= 10)
    for (const r of duringAndAfterGap) {
      // Held gain or modest values only — never a max-boost explosion.
      expect(r.appliedGainDb, `gain ${r.appliedGainDb} at t=${r.tSec}s spiked`).toBeLessThan(12)
    }
    // And the system recovers to target afterwards.
    const reconv = reconvergeTimeSec(tab, TARGET, 9, 1.5)
    expect(reconv, 'never re-converged after silence gap').not.toBeNull()
    if (reconv !== null) {
      expect(reconv).toBeLessThanOrEqual(13)
    }
  })
})

// ---------------------------------------------------------------------------
// D3 — mid-stream level jump
// ---------------------------------------------------------------------------

describe('D3 — mid-stream level jump', () => {
  it('source jumps from -20 to -10 at t=6s: re-converges within a few seconds', () => {
    const sig = pinkNoiseScenario(
      SR,
      [
        { amplitudeDb: pinkAmpDbFor(-20), durationSec: 6 },
        { amplitudeDb: pinkAmpDbFor(-10), durationSec: 9 },
      ],
      300,
    )
    const tab = runSingleScenario(
      { id: 1, label: 'level-jump', signal: sig },
      { scenario: 'D3-level-jump', targetLufs: TARGET, durationSec: 15 },
    )

    // First converge before the jump.
    expect(tab.metrics.converged || reconvergeTimeSec(tab, TARGET, 0) !== null).toBe(true)
    // Re-converge after the jump (with 3s window grace).
    const reconv = reconvergeTimeSec(tab, TARGET, 6 + 4, 1.5)
    expect(reconv, 'never re-converged after level jump').not.toBeNull()
    expect(reconv!).toBeLessThanOrEqual(14)
  })
})

// ---------------------------------------------------------------------------
// D4 — boost ceiling: source too quiet to ever reach target
// ---------------------------------------------------------------------------

describe('D4 — boost ceiling bounds unreachable quiet content', () => {
  it('extremely quiet source (-50 LUFS) pins gain at +12 and does NOT chase forever', () => {
    // -50 LUFS would need +36 dB to reach -14 — far beyond the +12 ceiling.
    // Correct behaviour: gain clamps at +12 and stays there, bounded; output
    // settles at -50 + 12 = -38, NOT at target. This is a documented algorithm
    // characteristic, not a bug — and this test exists to catch a regression
    // where the clamp fails (gain would then runaway toward +Infinity).
    const sig = pinkNoise({
      sampleRate: SR,
      durationSec: 14,
      amplitudeDb: pinkAmpDbFor(-50),
      seed: 400,
      channels: 2,
    })
    const tab = runSingleScenario(
      { id: 1, label: 'very-quiet-50', signal: sig },
      { scenario: 'D4-boost-ceiling', targetLufs: TARGET, durationSec: 14 },
    )

    const trace = rows(tab)
    // Once settled, gain is pinned at the +12 ceiling (within tolerance).
    const tail = trace.slice(-30)
    for (const r of tail) {
      expect(r.appliedGainDb, `gain ${r.appliedGainDb} escaped the ceiling`).toBeLessThanOrEqual(
        12 + 0.01,
      )
    }
    // And it must NOT have diverged to extreme values (clamp is working).
    const maxGain = Math.max(...trace.map((r) => r.appliedGainDb))
    expect(maxGain).toBeLessThanOrEqual(12 + 0.01)

    // Output does NOT reach target (this is expected — it's the whole point).
    // We assert it's bounded and stable, not that it "converged to target".
    const finiteOut = trace.filter((r) => Number.isFinite(r.outputLufs)).slice(-30)
    if (finiteOut.length > 0) {
      const spread =
        Math.max(...finiteOut.map((r) => r.outputLufs)) -
        Math.min(...finiteOut.map((r) => r.outputLufs))
      expect(spread, 'output should be stable even when pinned at ceiling').toBeLessThan(2)
    }
  })
})
