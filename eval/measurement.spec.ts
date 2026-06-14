/**
 * Group A — Measurement accuracy.
 *
 * These tests check `LufsCalculator` (src/audio/lufs.ts) against closed-form
 * analytic truth values derived in references.ts — NOT against another internal
 * implementation. This is the only place in the suite that pins down *absolute*
 * correctness of the LUFS meter. If these pass, the meter is trustworthy; the
 * convergence/scenario specs can then assume the measurement is right and
 * isolate the *balance decision* as the thing under test.
 *
 * Tolerances:
 *   • Linearity / channel-sum invariants: ±0.05 LU (these are exact in theory;
 *     the small slack is the calculator's block quantisation).
 *   • Absolute anchors vs closed-form K-weighting: ±0.25 LU (the meter uses a
 *     3 s windowed, gated estimate, not the analytic steady-state value, so a
 *     slightly larger tolerance is appropriate).
 */

import { describe, it, expect } from 'vitest'

import {
  sineStereoLufs,
  sineMonoLufs,
  kWeightingMagSq,
  DOUBLE_AMPLITUDE_GAIN_DB,
  MONO_TO_STEREO_GAIN_DB,
  REF_SAMPLE_RATE,
} from './references'
import { sine, monoToStereo, silence, interleave, concatStereo, type MonoSignal } from './signals'
import { LufsCalculator } from '../src/audio/lufs'

const SR = REF_SAMPLE_RATE

/** Feed a mono signal through a single-channel calculator. */
function measureMono(sig: MonoSignal): LufsCalculator {
  const calc = new LufsCalculator({ sampleRate: sig.sampleRate, channels: 1 })
  calc.processInterleaved(sig.samples)
  return calc
}

/** Feed a stereo (interleaved) buffer through a 2-channel calculator. */
function measureStereo(samples: Float32Array, sampleRate = SR): LufsCalculator {
  const calc = new LufsCalculator({ sampleRate, channels: 2 })
  calc.processInterleaved(samples)
  return calc
}

describe('A1 — amplitude linearity', () => {
  // Doubling peak amplitude must raise LUFS by exactly 6.0206 dB, at any
  // frequency and any base level (the meter is a power-domain measurement).
  const cases: Array<{ freq: number; ampDb: number; label: string }> = [
    { freq: 1000, ampDb: -18, label: '1 kHz @ -18' },
    { freq: 1000, ampDb: -6, label: '1 kHz @ -6' },
    { freq: 250, ampDb: -12, label: '250 Hz @ -12' },
  ]
  for (const c of cases) {
    it(`${c.label}: doubling amplitude raises LUFS by 6.02 ±0.05 LU`, () => {
      const a = sine({ sampleRate: SR, durationSec: 6, freqHz: c.freq, amplitudeDb: c.ampDb })
      const b = sine({ sampleRate: SR, durationSec: 6, freqHz: c.freq, amplitudeDb: c.ampDb + 6 })
      const la = measureStereo(monoToStereo(a).samples).getIntegratedLoudness()
      const lb = measureStereo(monoToStereo(b).samples).getIntegratedLoudness()
      expect(lb - la).toBeCloseTo(DOUBLE_AMPLITUDE_GAIN_DB, 1)
    })
  }

  it('4× amplitude raises LUFS by 12.04 ±0.05 LU', () => {
    const a = sine({ sampleRate: SR, durationSec: 6, freqHz: 1000, amplitudeDb: -18 })
    const b = sine({ sampleRate: SR, durationSec: 6, freqHz: 1000, amplitudeDb: -18 + 12 })
    const la = measureStereo(monoToStereo(a).samples).getIntegratedLoudness()
    const lb = measureStereo(monoToStereo(b).samples).getIntegratedLoudness()
    expect(lb - la).toBeCloseTo(2 * DOUBLE_AMPLITUDE_GAIN_DB, 1)
  })
})

describe('A2 — mono→stereo channel summing (+3.01 LU)', () => {
  it('duplicating one channel into stereo raises LUFS by 3.01 ±0.05 LU', () => {
    const mono = sine({ sampleRate: SR, durationSec: 6, freqHz: 1000, amplitudeDb: -18 })
    const monoLufs = measureMono(mono).getIntegratedLoudness()
    const stereoLufs = measureStereo(interleave(mono.samples, mono.samples)).getIntegratedLoudness()
    expect(stereoLufs - monoLufs).toBeCloseTo(MONO_TO_STEREO_GAIN_DB, 1)
  })
})

describe('A3 — K-weighting frequency response direction', () => {
  // K-weighting attenuates low frequencies (high-pass stage) and boosts highs
  // (high-shelf stage). At equal RMS, 80 Hz must measure LOWER than 1 kHz,
  // and 5 kHz HIGHER than 1 kHz — and the differences must match the closed-form
  // |H_K|² ratios.
  it('80 Hz measures ~1.83 dB below 1 kHz (matches closed-form)', () => {
    const a = sine({ sampleRate: SR, durationSec: 6, freqHz: 1000, amplitudeDb: -18 })
    const b = sine({ sampleRate: SR, durationSec: 6, freqHz: 80, amplitudeDb: -18 })
    const la = measureStereo(monoToStereo(a).samples).getIntegratedLoudness()
    const lb = measureStereo(monoToStereo(b).samples).getIntegratedLoudness()
    const expected = 10 * Math.log10(kWeightingMagSq(80) / kWeightingMagSq(1000))
    expect(lb - la).toBeCloseTo(expected, 1)
    // And sanity: it's a real attenuation.
    expect(lb - la).toBeLessThan(-1.0)
  })

  it('5 kHz measures ~+3.3 dB above 1 kHz (matches closed-form)', () => {
    const a = sine({ sampleRate: SR, durationSec: 6, freqHz: 1000, amplitudeDb: -18 })
    const b = sine({ sampleRate: SR, durationSec: 6, freqHz: 5000, amplitudeDb: -18 })
    const la = measureStereo(monoToStereo(a).samples).getIntegratedLoudness()
    const lb = measureStereo(monoToStereo(b).samples).getIntegratedLoudness()
    const expected = 10 * Math.log10(kWeightingMagSq(5000) / kWeightingMagSq(1000))
    expect(lb - la).toBeCloseTo(expected, 1)
    expect(lb - la).toBeGreaterThan(2.5)
  })
})

describe('A4 — absolute anchor vs closed-form K-weighting', () => {
  // The meter's 3 s windowed integrated value should land within ~0.25 LU of
  // the analytic steady-state LUFS for a sustained sine.
  const cases: Array<{ freq: number; ampDb: number; label: string }> = [
    { freq: 1000, ampDb: -18, label: '1 kHz @ -18 dBFS' },
    { freq: 1000, ampDb: -6, label: '1 kHz @ -6 dBFS' },
    { freq: 250, ampDb: -12, label: '250 Hz @ -12 dBFS' },
    { freq: 5000, ampDb: -12, label: '5 kHz @ -12 dBFS' },
  ]
  for (const c of cases) {
    it(`${c.label}: integrated LUFS within 0.25 LU of closed-form`, () => {
      const sig = sine({ sampleRate: SR, durationSec: 6, freqHz: c.freq, amplitudeDb: c.ampDb })
      const measured = measureStereo(monoToStereo(sig).samples).getIntegratedLoudness()
      const truth = sineStereoLufs(c.freq, c.ampDb)
      expect(Math.abs(measured - truth)).toBeLessThanOrEqual(0.25)
    })
  }

  it('mono sine matches mono closed-form within 0.25 LU', () => {
    const sig = sine({ sampleRate: SR, durationSec: 6, freqHz: 1000, amplitudeDb: -18 })
    const measured = measureMono(sig).getIntegratedLoudness()
    const truth = sineMonoLufs(1000, -18)
    expect(Math.abs(measured - truth)).toBeLessThanOrEqual(0.25)
  })
})

describe('A5 — gating rejects leading silence', () => {
  it('2 s of silence before a loud signal does not pull integrated LUFS down', () => {
    const loud = sine({ sampleRate: SR, durationSec: 6, freqHz: 1000, amplitudeDb: -12 })
    const loudStereo = monoToStereo(loud)
    const leadSilence = silence(SR, 2)
    // silence→loud
    const withGap = concatStereo(leadSilence, loudStereo)
    const measuredGap = measureStereo(withGap.samples).getIntegratedLoudness()
    const measuredPure = measureStereo(loudStereo.samples).getIntegratedLoudness()
    // The −70 absolute gate should drop the silent blocks, so integrated LUFS
    // is essentially unchanged (within 0.15 LU) by the leading silence.
    expect(Math.abs(measuredGap - measuredPure)).toBeLessThanOrEqual(0.15)
  })
})

describe('A6 — silence and recovery', () => {
  it('pure silence → integrated LUFS is -∞', () => {
    const s = silence(SR, 4)
    const calc = measureStereo(s.samples)
    expect(calc.getIntegratedLoudness()).toBe(-Infinity)
    expect(calc.getShortTermLoudness()).toBe(-Infinity)
  })

  it('short input does not throw and reports no finite integrated LUFS', () => {
    const calc = measureStereo(new Float32Array(100), SR)
    expect(Number.isFinite(calc.getIntegratedLoudness())).toBe(false)
  })

  it('signal after calculator processes silence becomes finite', () => {
    const calc = new LufsCalculator({ sampleRate: SR, channels: 2 })
    calc.processInterleaved(silence(SR, 1).samples)
    expect(calc.getIntegratedLoudness()).toBe(-Infinity)
    const loud = monoToStereo(
      sine({ sampleRate: SR, durationSec: 5, freqHz: 1000, amplitudeDb: -12 }),
    )
    calc.processInterleaved(loud.samples)
    expect(Number.isFinite(calc.getIntegratedLoudness())).toBe(true)
  })
})
