import { describe, expect, it } from 'vitest'

import { LraTracker, computeLra } from '@/audio/lra'

describe('computeLra', () => {
  it('returns 0 for fewer than MIN_BLOCKS values', () => {
    expect(computeLra([-20, -20, -20])).toBe(0)
  })

  it('returns 0 for a constant signal (no dynamic range)', () => {
    const constant = new Array(100).fill(-14)
    expect(computeLra(constant)).toBeCloseTo(0, 1)
  })

  it('returns a large value for a wide-range signal', () => {
    // A smoothly varying signal from -30 to -10 LUFS: wide dynamics. Using a
    // ramp (not a hard 50/50 split) avoids landing exactly on the relative
    // gate boundary, which would gate out half the data.
    const wide = Array.from({ length: 100 }, (_, i) => -30 + (20 * i) / 99)
    const lra = computeLra(wide)
    expect(lra).toBeGreaterThan(10)
  })

  it('absolute-gates out silence (≤ −70 LUFS)', () => {
    // A -14 signal interspersed with -90 gaps should ignore the gaps.
    const withGaps = new Array(100).fill(-14)
    for (let i = 0; i < 100; i += 10) withGaps[i] = -90
    expect(computeLra(withGaps)).toBeCloseTo(0, 1)
  })

  it('is robust to a single outlier (percentile method)', () => {
    // One very loud sample among otherwise-constant data shouldn't blow up LRA.
    const base = new Array(100).fill(-14)
    base[50] = 0 // 14 LU louder
    const lra = computeLra(base)
    // The 95th percentile is -14 (only 1 sample is 0, which is the 100th),
    // so LRA stays small.
    expect(lra).toBeLessThan(3)
  })
})

describe('LraTracker', () => {
  it('returns 0 before enough data', () => {
    const t = new LraTracker()
    expect(t.getLra()).toBe(0)
    t.push(-14)
    t.push(-14)
    expect(t.getLra()).toBe(0)
  })

  it('tracks the dynamic range of a varying signal', () => {
    const t = new LraTracker()
    // A smooth ramp from quiet to loud exercises a wide LRA without hitting
    // the relative-gate edge case a hard 50/50 split creates.
    for (let i = 0; i < 100; i++) t.push(-30 + (20 * i) / 99)
    expect(t.getLra()).toBeGreaterThan(10)
  })

  it('sliding window forgets old data', () => {
    const t = new LraTracker(20) // small window for the test
    // Wide dynamics (ramp), then constant.
    for (let i = 0; i < 20; i++) t.push(-30 + (20 * i) / 19)
    expect(t.getLra()).toBeGreaterThan(5)
    // Overwrite the window with constant data.
    for (let i = 0; i < 25; i++) t.push(-14)
    expect(t.getLra()).toBeLessThan(2)
  })

  it('reset() clears state', () => {
    const t = new LraTracker()
    for (let i = 0; i < 100; i++) t.push(-30 + (20 * i) / 99)
    expect(t.getLra()).toBeGreaterThan(10)
    t.reset()
    expect(t.getLra()).toBe(0)
  })
})
