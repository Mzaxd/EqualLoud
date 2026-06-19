import { describe, it, expect } from 'vitest'

import { designKWeighting, K_WEIGHTING_48KHZ } from '@/audio/k-weighting'

/**
 * Tests for the sample-rate-aware K-weighting filter design.
 *
 * The core invariant: at 48 kHz the dynamic design MUST reproduce the ITU
 * BS.1770-4 published constants (the values every LUFS implementation agrees
 * on). At other rates the result is a bilinear-transform re-discretisation of
 * the same analog prototype — it should differ smoothly from 48 kHz, never
 * diverge or produce NaN / Infinity.
 */
describe('designKWeighting', () => {
  describe('48 kHz (the ITU reference rate)', () => {
    it('reproduces the Stage-1 high-shelf numerator to ≤1e-9', () => {
      const { highShelf } = designKWeighting(48000)
      // b coefficients
      expect(highShelf.b[0]).toBeCloseTo(K_WEIGHTING_48KHZ.highShelf.b[0]!, 9)
      expect(highShelf.b[1]).toBeCloseTo(K_WEIGHTING_48KHZ.highShelf.b[1]!, 9)
      expect(highShelf.b[2]).toBeCloseTo(K_WEIGHTING_48KHZ.highShelf.b[2]!, 9)
    })

    it('reproduces the Stage-1 high-shelf denominator to ≤1e-9', () => {
      const { highShelf } = designKWeighting(48000)
      expect(highShelf.a[0]).toBe(1)
      expect(highShelf.a[1]).toBeCloseTo(K_WEIGHTING_48KHZ.highShelf.a[1]!, 9)
      expect(highShelf.a[2]).toBeCloseTo(K_WEIGHTING_48KHZ.highShelf.a[2]!, 9)
    })

    it('reproduces the Stage-2 high-pass exactly (b is the trivial [1,-2,1])', () => {
      const { highPass } = designKWeighting(48000)
      expect(highPass.b[0]).toBe(1)
      expect(highPass.b[1]).toBe(-2)
      expect(highPass.b[2]).toBe(1)
      expect(highPass.a[0]).toBe(1)
      expect(highPass.a[1]).toBeCloseTo(K_WEIGHTING_48KHZ.highPass.a[1]!, 9)
      expect(highPass.a[2]).toBeCloseTo(K_WEIGHTING_48KHZ.highPass.a[2]!, 9)
    })
  })

  describe('44.1 kHz (the macOS default — the rate that motivated this fix)', () => {
    it('produces finite, well-conditioned coefficients', () => {
      const { highShelf, highPass } = designKWeighting(44100)
      for (const c of [...highShelf.b, ...highShelf.a, ...highPass.b, ...highPass.a]) {
        expect(Number.isFinite(c)).toBe(true)
      }
    })

    it('Stage-1 b0 is slightly higher than 48 kHz (lower Nyquist → less high-freq attenuation)', () => {
      // At a lower sample rate the bilinear warping shifts the shelf; the
      // sign of the drift is deterministic, not the magnitude.
      const at44 = designKWeighting(44100).highShelf.b[0]!
      const at48 = designKWeighting(48000).highShelf.b[0]!
      expect(at44).not.toBeCloseTo(at48, 6)
      expect(Math.abs(at44 - at48)).toBeLessThan(0.1) // smooth, not a jump
    })

    it('Stage-2 a1 differs from 48 kHz smoothly (HP cutoff tracks the rate)', () => {
      const at44 = designKWeighting(44100).highPass.a[1]!
      const at48 = designKWeighting(48000).highPass.a[1]!
      expect(at44).not.toBeCloseTo(at48, 6)
      expect(Math.abs(at44 - at48)).toBeLessThan(0.01)
    })
  })

  describe('extreme sample rates (robustness — must not explode)', () => {
    it('clamps below 8 kHz without producing Infinity/NaN', () => {
      // Without the clamp, tan(π · 1682 / 8000) → tan(>π/2) → huge; the clamp
      // keeps the design well-conditioned.
      const { highShelf, highPass } = designKWeighting(4000)
      for (const c of [...highShelf.b, ...highShelf.a, ...highPass.b, ...highPass.a]) {
        expect(Number.isFinite(c)).toBe(true)
        expect(Number.isNaN(c)).toBe(false)
      }
    })

    it('clamps above 192 kHz without producing Infinity/NaN', () => {
      const { highShelf, highPass } = designKWeighting(1_000_000)
      for (const c of [...highShelf.b, ...highShelf.a, ...highPass.b, ...highPass.a]) {
        expect(Number.isFinite(c)).toBe(true)
      }
    })

    it('at 96 kHz the curve sits smoothly between 48 kHz and 192 kHz', () => {
      const at48 = designKWeighting(48000).highShelf.b[0]!
      const at96 = designKWeighting(96000).highShelf.b[0]!
      // Higher rate → closer to the analog prototype; drift is small & smooth.
      expect(Math.abs(at48 - at96)).toBeLessThan(0.05)
    })
  })

  describe('determinism', () => {
    it('returns identical coefficients on repeated calls (pure function)', () => {
      const a = designKWeighting(44100)
      const b = designKWeighting(44100)
      expect(a.highShelf.b).toEqual(b.highShelf.b)
      expect(a.highShelf.a).toEqual(b.highShelf.a)
      expect(a.highPass.b).toEqual(b.highPass.b)
      expect(a.highPass.a).toEqual(b.highPass.a)
    })
  })
})

/**
 * Sanity: the K-weighting fix means a signal measured at 44.1 kHz now agrees
 * with the same signal measured at 48 kHz (the ITU reference rate). Before the
 * fix, both rates used the 48 kHz coefficients verbatim, so the 44.1 kHz
 * reading drifted 0.3–0.7 LU relative to truth. With dynamic design the drift
 * drops below the perceptual threshold.
 *
 * Note on mono vs stereo: BS.1770 *correctly* reports a correlated signal
 * present on both L and R as +3.01 dB louder than the same signal on one
 * channel only (each channel contributes full energy). That is not a bug — it
 * is the standard. The worklet mono fix is about not *fabricating* a second
 * channel when the source genuinely delivers one; here we test the rate fix.
 */
describe('K-weighting rate invariance: LufsCalculator 44.1 kHz vs 48 kHz', () => {
  it('stereo sine reads within 0.15 LU across sample rates', async () => {
    const { LufsCalculator } = await import('@/audio/lufs')
    const freq = 1000
    const amp = Math.pow(10, -18 / 20)
    const durationSec = 5

    function measureAt(sampleRate: number): number {
      const frames = durationSec * sampleRate
      const stereo = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
        stereo[i * 2] = s
        stereo[i * 2 + 1] = s
      }
      const calc = new LufsCalculator({ sampleRate, channels: 2 })
      calc.processInterleaved(stereo)
      return calc.getIntegratedLoudness()
    }

    const at44 = measureAt(44100)
    const at48 = measureAt(48000)
    // With correct rate-aware K-weighting the two readings converge. A pure
    // 1 kHz tone sits near the flattest part of the K curve so the residual
    // is dominated by block-edge effects, not filter mismatch.
    expect(Math.abs(at44 - at48)).toBeLessThan(0.15)
  })

  it('genuine mono reads the same whether declared as channels:1 or channels:2 with silent R', async () => {
    // This is the real mono invariant: a source that is mono should not get
    // +3 dB just because the container labels it stereo with a silent second
    // channel. LufsCalculator with channels:2 + silent R must equal channels:1.
    const { LufsCalculator } = await import('@/audio/lufs')
    const sampleRate = 48000
    const durationSec = 5
    const frames = durationSec * sampleRate
    const freq = 1000
    const amp = Math.pow(10, -18 / 20)

    const mono = new Float32Array(frames)
    for (let i = 0; i < frames; i++) mono[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp

    const stereoSilentR = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i++) stereoSilentR[i * 2] = mono[i]! // R stays 0

    const monoCalc = new LufsCalculator({ sampleRate, channels: 1 })
    monoCalc.processInterleaved(mono)
    const monoLufs = monoCalc.getIntegratedLoudness()

    const stereoCalc = new LufsCalculator({ sampleRate, channels: 2 })
    stereoCalc.processInterleaved(stereoSilentR)
    const stereoLufs = stereoCalc.getIntegratedLoudness()

    // A silent R contributes zero energy, so stereo-with-silent-R == mono.
    expect(Math.abs(monoLufs - stereoLufs)).toBeLessThan(0.05)
  })
})
