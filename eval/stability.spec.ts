/**
 * Group E — stability & quality margins.
 *
 * Convergence (B/C) proves the loop *reaches* target. Stability proves it
 * *stays* there cleanly — no limit-cycle oscillation ("hunting"), and once it
 * is within ±1 LU it doesn't subsequently wander far away.
 *
 * These are the metrics that distinguish "works on average" from "feels solid
 * to a listener". A system that converges in mean but ripples ±2 LU every
 * few seconds would be fatiguing; these specs guard against that.
 *
 * The simulator models gain application as instantaneous (worst case for
 * ringing — see simulate.ts header). Real production smooths via
 * setTargetAtTime(50ms), so passing here is a strong stability guarantee.
 */

import { describe, it, expect } from 'vitest'

import { runSingleScenario, DEFAULT_THRESHOLDS, type TabResult } from './eval-helpers'
import { pinkNoise } from './signals'

const SR = 48000
const TARGET = -14

/** Pink-noise peak amplitude (dBFS) that yields a given measured LUFS. */
function pinkAmpDbFor(lufs: number): number {
  return lufs + 11.85
}

/** Steady-state ripple = stddev of output over the trailing window. */
function rippleOf(tab: TabResult): number {
  return tab.metrics.ripple
}

describe('E1 — steady-state ripple stays below 0.5 LU (no hunting)', () => {
  // Run several tabs of different levels; none should hunt in steady state.
  const levels: Array<{ lufs: number; label: string }> = [
    { lufs: -22, label: 'soft-22' },
    { lufs: -18, label: 'soft-18' },
    { lufs: -10, label: 'warm-10' },
    { lufs: -8, label: 'loud-8' },
  ]
  for (const lvl of levels) {
    it(`${lvl.label}: converged with ripple ≤ 0.5 LU`, () => {
      const sig = pinkNoise({
        sampleRate: SR,
        durationSec: 16,
        amplitudeDb: pinkAmpDbFor(lvl.lufs),
        seed: 500 + Math.round(lvl.lufs),
        channels: 2,
      })
      const tab = runSingleScenario(
        { id: 1, label: lvl.label, signal: sig },
        { scenario: `E1-${lvl.label}`, targetLufs: TARGET, durationSec: 16, showTrace: false },
      )
      expect(tab.metrics.converged, `${lvl.label}: never converged`).toBe(true)
      const rip = rippleOf(tab)
      expect(
        rip,
        `${lvl.label}: ripple ${rip.toFixed(3)} LU indicates hunting`,
      ).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.maxRipple)
    })
  }
})

describe('E2 — once within ±1 LU, output never strays beyond ±2 LU', () => {
  it('quiet source (-20 LUFS): no large excursion after first entering the band', () => {
    // Stability margin test: the loop must not "bounce" — once it lands near
    // target it should stay near target. A marginally-stable controller would
    // oscillate with growing or sustained amplitude around the setpoint.
    const sig = pinkNoise({
      sampleRate: SR,
      durationSec: 16,
      amplitudeDb: pinkAmpDbFor(-20),
      seed: 600,
      channels: 2,
    })
    const tab = runSingleScenario(
      { id: 1, label: 'stab-20', signal: sig },
      { scenario: 'E2-stability-margin', targetLufs: TARGET, durationSec: 16, showTrace: false },
    )

    const trace = tab.trace.filter((r) => Number.isFinite(r.outputLufs))
    // Find the first tick inside ±1 LU.
    let firstInside = -1
    for (let i = 0; i < trace.length; i++) {
      if (Math.abs(trace[i]!.outputLufs - TARGET) <= 1) {
        firstInside = i
        break
      }
    }
    expect(firstInside, 'never entered the ±1 LU band').toBeGreaterThan(-1)

    // From that point on, no excursion beyond ±2 LU.
    const tail = trace.slice(firstInside!)
    const maxDev = Math.max(...tail.map((r) => Math.abs(r.outputLufs - TARGET)))
    expect(
      maxDev,
      `output deviated ${maxDev.toFixed(2)} LU from target after settling (limit cycle?)`,
    ).toBeLessThanOrEqual(2.0)
  })

  it('loud source (-8 LUFS): same stability margin holds', () => {
    const sig = pinkNoise({
      sampleRate: SR,
      durationSec: 16,
      amplitudeDb: pinkAmpDbFor(-8),
      seed: 601,
      channels: 2,
    })
    const tab = runSingleScenario(
      { id: 1, label: 'stab-8', signal: sig },
      {
        scenario: 'E2-stability-margin-loud',
        targetLufs: TARGET,
        durationSec: 16,
        showTrace: false,
      },
    )

    const trace = tab.trace.filter((r) => Number.isFinite(r.outputLufs))
    let firstInside = -1
    for (let i = 0; i < trace.length; i++) {
      if (Math.abs(trace[i]!.outputLufs - TARGET) <= 1) {
        firstInside = i
        break
      }
    }
    expect(firstInside, 'never entered the ±1 LU band').toBeGreaterThan(-1)
    const tail = trace.slice(firstInside!)
    const maxDev = Math.max(...tail.map((r) => Math.abs(r.outputLufs - TARGET)))
    expect(
      maxDev,
      `loud source deviated ${maxDev.toFixed(2)} LU after settling`,
    ).toBeLessThanOrEqual(2.0)
  })
})
