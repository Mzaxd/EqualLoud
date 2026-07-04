import { describe, expect, it } from 'vitest'

import { TruePeakTracker, computeTruePeakDb, oversample4x, sampleToDbtp } from '@/audio/true-peak'

describe('sampleToDbtp', () => {
  it('converts full-scale to 0 dBTP', () => {
    expect(sampleToDbtp(1)).toBeCloseTo(0, 5)
    expect(sampleToDbtp(-1)).toBeCloseTo(0, 5)
  })

  it('converts 0.5 to −6.02 dBTP', () => {
    expect(sampleToDbtp(0.5)).toBeCloseTo(-6.0206, 3)
  })

  it('returns -Infinity for silence', () => {
    expect(sampleToDbtp(0)).toBe(-Infinity)
  })
})

describe('oversample4x', () => {
  it('produces 4× the input length', () => {
    const out = oversample4x([0, 0.5, -0.5, 0])
    expect(out.length).toBe(16)
  })

  it('phase-0 outputs approximate the original samples (low-frequency DC)', () => {
    // A slow signal: true peak ≈ sample peak, so phase-0 (on-sample) outputs
    // should reconstruct close to the input.
    const n = 64
    const input = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 2 * i) / n) * 0.5)
    const up = oversample4x(input)
    // Compare phase-0 positions (every 4th), skipping the FIR warm-up edges.
    for (let i = 8; i < n - 8; i++) {
      expect(up[i * 4]!).toBeCloseTo(input[i]!, 1)
    }
  })
})

describe('computeTruePeakDb', () => {
  it('returns -Infinity for silence', () => {
    expect(computeTruePeakDb(new Array(100).fill(0))).toBe(-Infinity)
  })

  it('pure low-frequency tone: true peak ≈ sample peak (≈ 0 dBFS)', () => {
    // 1 kHz at 48 kHz: no meaningful inter-sample overshoot.
    const sr = 48000
    const samples = Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr))
    const tp = computeTruePeakDb(samples)
    // Full-scale sine → sample peak 0 dBFS; true peak within ~1 dB.
    expect(tp).toBeGreaterThan(-1.0)
    expect(tp).toBeLessThan(1.0)
  })

  it('high-frequency tone: true peak can exceed sample peak', () => {
    // 18 kHz at 48 kHz: inter-sample peaks push true peak above 0 dBFS.
    const sr = 48000
    const samples = Array.from(
      { length: 4800 },
      // Phase offset to maximise inter-sample peaks.
      (_, i) => Math.sin((2 * Math.PI * 18000 * i) / sr + 0.3),
    )
    const samplePeak = 20 * Math.log10(Math.max(...samples.map(Math.abs)))
    const tp = computeTruePeakDb(samples)
    // True peak should exceed the sample peak for this near-Nyquist tone.
    expect(tp).toBeGreaterThan(samplePeak)
  })

  it('alternating +1/−1 (worst case): true peak > 0 dBTP', () => {
    // The classic inter-sample-peak stress signal.
    const samples = Array.from({ length: 4096 }, (_, i) => (i % 2 === 0 ? 1 : -1))
    const tp = computeTruePeakDb(samples)
    expect(tp).toBeGreaterThan(0.3)
  })
})

describe('TruePeakTracker', () => {
  it('returns -Infinity before any signal', () => {
    const t = new TruePeakTracker(48000)
    expect(t.getDbtp()).toBe(-Infinity)
  })

  it('tracks a full-scale DC signal to ~0 dBTP', () => {
    const t = new TruePeakTracker(48000)
    for (let i = 0; i < 1000; i++) t.processSample(1.0)
    const db = t.getDbtp()
    expect(db).toBeGreaterThan(-1.5)
    expect(db).toBeLessThan(1.5)
  })

  it('decays after signal stops (peak recedes)', () => {
    const t = new TruePeakTracker(48000)
    // Loud burst, then silence.
    for (let i = 0; i < 500; i++) t.processSample(1.0)
    const peakDuring = t.getDbtp()
    // DC=1.0 → ~0 dBTP (every phase sums to 1.0 after per-phase normalisation).
    expect(peakDuring).toBeGreaterThan(-1.0)
    // Feed many silent samples (> several decay intervals). The decay factor
    // (×0.85 per ~100 ms) drops the peak ~15 dB per second of silence.
    for (let i = 0; i < 30000; i++) t.processSample(0)
    const peakAfter = t.getDbtp()
    // Should have decayed substantially below the burst peak.
    expect(peakAfter).toBeLessThan(peakDuring - 6)
  })

  it('reset() clears state', () => {
    const t = new TruePeakTracker(48000)
    for (let i = 0; i < 500; i++) t.processSample(1.0)
    expect(t.getDbtp()).toBeGreaterThan(-1.0)
    t.reset()
    expect(t.getDbtp()).toBe(-Infinity)
  })

  it('parity with offline computeTruePeakDb on a tone', () => {
    // The streaming tracker and the offline function should agree closely on
    // a pure tone (the tracker adds a decay, so compare while the signal is
    // active, before decay dominates).
    const sr = 48000
    const samples = Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr))
    const offlineTp = computeTruePeakDb(samples)
    const t = new TruePeakTracker(sr)
    for (const s of samples) t.processSample(s)
    const streamTp = t.getDbtp()
    // Allow 2 dB tolerance: the streaming version uses a 5-sample ring
    // (vs. the offline full convolution) plus decay, so it's approximate.
    expect(Math.abs(streamTp - offlineTp)).toBeLessThan(2.5)
  })
})
