/**
 * Group B & C — closed-loop convergence.
 *
 * These are the first tests that exercise the *full* balance loop:
 * signal → measure → decide → apply gain → re-measure. The measurement meter
 * is already proven correct (group A), so any failure here isolates the
 * *balance decision* (computeBalanceGains) and the loop dynamics (3 s short-
 * term window delay) as the cause.
 *
 * # Signal-level convention
 *
 * Pink noise's measured LUFS sits a fixed 11.85 dB below its peak dBFS
 * amplitude (verified empirically — see references.ts for why pink noise has
 * a stable LUFS regardless of seed). So to get a tab that *measures* −24 LUFS
 * (the deepest level the +12 dB boost ceiling can still reach −14 from), we
 * generate pink noise at ≈ −12.15 dBFS. Tabs deeper than −26 LUFS cannot be
 * balanced to −14 and are tested explicitly in scenarios.spec.ts (D4).
 *
 * B: single tab — does one source converge to target from above and below?
 * C: multi tab  — do several sources of different loudness all settle to
 *                 within ~1 LU of each other?
 */

import { describe, it, expect } from 'vitest'

import { runScenario, runSingleScenario, DEFAULT_THRESHOLDS, type TabResult } from './eval-helpers'
import { pinkNoise } from './signals'

const SR = 48000
const TARGET = -14

/** Pink-noise peak amplitude (dBFS) that yields a given measured LUFS. */
function pinkAmpDbFor(lufs: number): number {
  return lufs + 11.85
}

/** Single-tab convergence assertion bundle. The target is implied: metrics
 *  were computed against the scenario's target inside runSingleScenario. */
function assertConverged(tab: TabResult): void {
  expect(tab.metrics.converged, `${tab.label}: never converged`).toBe(true)
  expect(tab.metrics.convergeTimeSec, `${tab.label}: too slow`).toBeLessThanOrEqual(
    DEFAULT_THRESHOLDS.maxConvergeSec,
  )
  expect(tab.metrics.steadyError, `${tab.label}: steady error too large`).toBeLessThanOrEqual(
    DEFAULT_THRESHOLDS.maxSteadyError,
  )
  expect(tab.metrics.ripple, `${tab.label}: ripple too large`).toBeLessThanOrEqual(
    DEFAULT_THRESHOLDS.maxRipple,
  )
}

// ---------------------------------------------------------------------------
// B — single tab
// ---------------------------------------------------------------------------

describe('B — single-tab convergence to target', () => {
  it('B1: quiet source (-24 LUFS) is boosted toward -14', () => {
    // -24 LUFS is exactly +10 dB below target — well within the +12 ceiling.
    const sig = pinkNoise({
      sampleRate: SR,
      durationSec: 14,
      amplitudeDb: pinkAmpDbFor(-24),
      seed: 1,
      channels: 2,
    })
    const tab = runSingleScenario(
      { id: 1, label: 'quiet-24', signal: sig },
      { scenario: 'B1-quiet', targetLufs: TARGET, durationSec: 14 },
    )
    assertConverged(tab)
    expect(tab.metrics.startLufs).toBeLessThan(TARGET - 5)
    const finalGain = tab.trace[tab.trace.length - 1]!.appliedGainDb
    expect(finalGain, `gain ${finalGain} should be a positive boost`).toBeGreaterThan(3)
  })

  it('B2: loud source (-8 LUFS) is attenuated toward -14', () => {
    const sig = pinkNoise({
      sampleRate: SR,
      durationSec: 14,
      amplitudeDb: pinkAmpDbFor(-8),
      seed: 2,
      channels: 2,
    })
    const tab = runSingleScenario(
      { id: 1, label: 'loud-8', signal: sig },
      { scenario: 'B2-loud', targetLufs: TARGET, durationSec: 14 },
    )
    assertConverged(tab)
    expect(tab.metrics.startLufs).toBeGreaterThan(TARGET + 2)
    const finalGain = tab.trace[tab.trace.length - 1]!.appliedGainDb
    expect(finalGain, `gain ${finalGain} should be negative (attenuation)`).toBeLessThan(0)
  })

  it('B3: source already near target barely moves', () => {
    const sig = pinkNoise({
      sampleRate: SR,
      durationSec: 14,
      amplitudeDb: pinkAmpDbFor(-14),
      seed: 3,
      channels: 2,
    })
    const tab = runSingleScenario(
      { id: 1, label: 'near-target', signal: sig },
      { scenario: 'B3-near', targetLufs: TARGET, durationSec: 14 },
    )
    assertConverged(tab)
    const finalGain = tab.trace[tab.trace.length - 1]!.appliedGainDb
    expect(Math.abs(finalGain), `gain ${finalGain} should be near zero`).toBeLessThan(2)
  })

  it('B4: moderately quiet source (-20 LUFS) converges with sub-maximal boost', () => {
    // -20 LUFS needs +6 dB — confirms convergence isn't only at the ceiling.
    const sig = pinkNoise({
      sampleRate: SR,
      durationSec: 14,
      amplitudeDb: pinkAmpDbFor(-20),
      seed: 4,
      channels: 2,
    })
    const tab = runSingleScenario(
      { id: 1, label: 'mid-quiet-20', signal: sig },
      { scenario: 'B4-mid-quiet', targetLufs: TARGET, durationSec: 14 },
    )
    assertConverged(tab)
    const finalGain = tab.trace[tab.trace.length - 1]!.appliedGainDb
    expect(finalGain).toBeGreaterThan(3)
    expect(finalGain).toBeLessThan(12) // not pinned at the +12 ceiling
  })
})

// ---------------------------------------------------------------------------
// C — multi tab
// ---------------------------------------------------------------------------

describe('C — multi-tab balancing', () => {
  it('C1: four tabs of different loudness all converge within 1 LU of each other', () => {
    // Levels chosen so all are reachable from target within the +12 boost /
    // unlimited attenuation range: -24 / -18 / -10 / -8 LUFS.
    const tabs = [
      {
        id: 1,
        label: 'quiet-24',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-24),
          seed: 11,
          channels: 2,
        }),
      },
      {
        id: 2,
        label: 'soft-18',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-18),
          seed: 12,
          channels: 2,
        }),
      },
      {
        id: 3,
        label: 'warm-10',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-10),
          seed: 13,
          channels: 2,
        }),
      },
      {
        id: 4,
        label: 'loud-8',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-8),
          seed: 14,
          channels: 2,
        }),
      },
    ]
    const results = runScenario(tabs, {
      scenario: 'C1-four-tabs',
      targetLufs: TARGET,
      durationSec: 14,
    })
    for (const r of results) assertConverged(r)

    // Cross-tab agreement: in the steady window, all tabs' output means are
    // within 1 LU of each other (the whole point of cross-tab balancing).
    const means = results.map((r) => r.metrics.steadyMean)
    const spread = Math.max(...means) - Math.min(...means)
    expect(spread, `steady output spread ${spread.toFixed(2)} LU too wide`).toBeLessThanOrEqual(1.0)
  })

  it('C2: realistic mix all settle into the target band', () => {
    // Realistic streaming-ish levels, all reachable: music, podcast, ad, voice.
    const tabs = [
      {
        id: 1,
        label: 'music',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-12),
          seed: 21,
          channels: 2,
        }),
      },
      {
        id: 2,
        label: 'podcast',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-22),
          seed: 22,
          channels: 2,
        }),
      },
      {
        id: 3,
        label: 'ad',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-8),
          seed: 23,
          channels: 2,
        }),
      },
      {
        id: 4,
        label: 'voice',
        signal: pinkNoise({
          sampleRate: SR,
          durationSec: 14,
          amplitudeDb: pinkAmpDbFor(-16),
          seed: 24,
          channels: 2,
        }),
      },
    ]
    const results = runScenario(tabs, {
      scenario: 'C2-realistic',
      targetLufs: TARGET,
      durationSec: 14,
    })
    for (const r of results) assertConverged(r)
    const means = results.map((r) => r.metrics.steadyMean)
    const spread = Math.max(...means) - Math.min(...means)
    expect(spread, `realistic-mix steady spread too wide`).toBeLessThanOrEqual(1.0)
  })
})
