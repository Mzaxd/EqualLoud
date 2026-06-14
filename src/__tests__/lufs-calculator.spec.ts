import { describe, it, expect, beforeEach } from 'vitest'

import { LufsCalculator, dbToGain, gainToDb } from '@/audio/lufs'

describe('LufsCalculator', () => {
  let calc: LufsCalculator

  beforeEach(() => {
    calc = new LufsCalculator({ sampleRate: 48000, channels: 2 })
  })

  describe('construction', () => {
    it('initializes with correct defaults for stereo', () => {
      expect(calc.getMomentaryLoudness()).toBe(-Infinity)
      expect(calc.getShortTermLoudness()).toBe(-Infinity)
      expect(calc.getIntegratedLoudness()).toBe(-Infinity)
      expect(calc.getBlockCount()).toBe(0)
      expect(calc.hasEnoughSamples()).toBe(false)
    })

    it('initializes with correct defaults for mono', () => {
      const mono = new LufsCalculator({ sampleRate: 48000, channels: 1 })
      expect(mono.getMomentaryLoudness()).toBe(-Infinity)
      expect(mono.getBlockCount()).toBe(0)
    })

    it('accepts custom block size and overlap', () => {
      const custom = new LufsCalculator({
        sampleRate: 48000,
        channels: 2,
        blockSize: 200,
        overlap: 0.5,
      })
      expect(custom.getBlockCount()).toBe(0)
    })
  })

  describe('stereo sine wave processing', () => {
    it('produces finite integrated loudness for a 5-second signal', () => {
      const sampleRate = 48000
      const durationSec = 5
      const frames = durationSec * sampleRate
      const freq = 1000
      const ampDb = -18
      const amp = Math.pow(10, ampDb / 20)

      const interleaved = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
        interleaved[i * 2] = s
        interleaved[i * 2 + 1] = s
      }

      calc.processInterleaved(interleaved)
      const integrated = calc.getIntegratedLoudness()
      expect(Number.isFinite(integrated)).toBe(true)
      expect(integrated).toBeGreaterThan(-70)
    })

    it('momentary loudness is finite after processing', () => {
      const sampleRate = 48000
      const frames = sampleRate * 2
      const amp = Math.pow(10, -18 / 20)

      const interleaved = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amp
        interleaved[i * 2] = s
        interleaved[i * 2 + 1] = s
      }

      calc.processInterleaved(interleaved)
      expect(Number.isFinite(calc.getMomentaryLoudness())).toBe(true)
    })

    it('short-term loudness is finite after processing', () => {
      const sampleRate = 48000
      const frames = sampleRate * 3
      const amp = Math.pow(10, -18 / 20)

      const interleaved = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amp
        interleaved[i * 2] = s
        interleaved[i * 2 + 1] = s
      }

      calc.processInterleaved(interleaved)
      expect(Number.isFinite(calc.getShortTermLoudness())).toBe(true)
    })
  })

  describe('mono processing', () => {
    it('processes mono signal correctly', () => {
      const monoCalc = new LufsCalculator({ sampleRate: 48000, channels: 1 })
      const sampleRate = 48000
      const frames = sampleRate * 3
      const amp = Math.pow(10, -18 / 20)

      const mono = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        mono[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amp
      }

      monoCalc.processInterleaved(mono)
      const integrated = monoCalc.getIntegratedLoudness()
      expect(Number.isFinite(integrated)).toBe(true)
    })
  })

  describe('silence and edge cases', () => {
    it('returns -Infinity for silence input', () => {
      const frames = 48000 * 2
      const silence = new Float32Array(frames * 2).fill(0)
      calc.processInterleaved(silence)
      expect(calc.getIntegratedLoudness()).toBe(-Infinity)
      expect(calc.getMomentaryLoudness()).toBe(-Infinity)
    })

    it('handles empty input without error', () => {
      calc.processInterleaved(new Float32Array(0))
      expect(calc.getBlockCount()).toBe(0)
    })

    it('handles very short input without error', () => {
      const short = new Float32Array(100)
      calc.processInterleaved(short)
      // Very short - may not produce any blocks
      expect(calc.getBlockCount()).toBeGreaterThanOrEqual(0)
    })
  })

  describe('hasEnoughSamples', () => {
    it('returns false initially', () => {
      expect(calc.hasEnoughSamples()).toBe(false)
    })

    it('returns true after sufficient audio', () => {
      const sampleRate = 48000
      const frames = sampleRate * 5
      const amp = Math.pow(10, -18 / 20)

      const interleaved = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amp
        interleaved[i * 2] = s
        interleaved[i * 2 + 1] = s
      }

      calc.processInterleaved(interleaved)
      expect(calc.hasEnoughSamples()).toBe(true)
    })
  })

  describe('getProcessedDuration', () => {
    it('returns 0 for no processing', () => {
      expect(calc.getProcessedDuration()).toBe(0)
    })

    it('returns positive duration after processing', () => {
      const sampleRate = 48000
      const frames = sampleRate * 3
      const amp = Math.pow(10, -18 / 20)

      const interleaved = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amp
        interleaved[i * 2] = s
        interleaved[i * 2 + 1] = s
      }

      calc.processInterleaved(interleaved)
      expect(calc.getProcessedDuration()).toBeGreaterThan(0)
    })
  })

  describe('reset', () => {
    it('clears all measurements', () => {
      const sampleRate = 48000
      const frames = sampleRate * 3
      const amp = Math.pow(10, -18 / 20)

      const interleaved = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amp
        interleaved[i * 2] = s
        interleaved[i * 2 + 1] = s
      }

      calc.processInterleaved(interleaved)
      expect(calc.getBlockCount()).toBeGreaterThan(0)

      calc.reset()

      expect(calc.getMomentaryLoudness()).toBe(-Infinity)
      expect(calc.getShortTermLoudness()).toBe(-Infinity)
      expect(calc.getIntegratedLoudness()).toBe(-Infinity)
      expect(calc.getBlockCount()).toBe(0)
      expect(calc.hasEnoughSamples()).toBe(false)
    })
  })

  describe('block count cap', () => {
    it('does not exceed MAX_INTEGRATED_BLOCKS (600)', () => {
      const sampleRate = 48000
      const frames = sampleRate * 120 // 2 minutes - would exceed 600 blocks
      const amp = Math.pow(10, -18 / 20)

      const interleaved = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const s = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amp
        interleaved[i * 2] = s
        interleaved[i * 2 + 1] = s
      }

      calc.processInterleaved(interleaved)
      // blockLoudnesses array should be capped at 600
      expect(calc.getBlockCount()).toBeLessThanOrEqual(600)
    })
  })
})

describe('dbToGain', () => {
  it('returns 1 for 0 dB', () => {
    expect(dbToGain(0)).toBeCloseTo(1.0, 5)
  })

  it('returns > 1 for positive dB', () => {
    expect(dbToGain(6)).toBeCloseTo(1.995, 2)
  })

  it('returns < 1 for negative dB', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.501, 2)
  })

  it('returns ~0 for very negative dB', () => {
    expect(dbToGain(-100)).toBeCloseTo(0, 3)
  })
})

describe('gainToDb', () => {
  it('returns 0 for gain of 1', () => {
    expect(gainToDb(1)).toBeCloseTo(0, 5)
  })

  it('returns positive for gain > 1', () => {
    expect(gainToDb(2)).toBeCloseTo(6.02, 1)
  })

  it('returns negative for gain < 1', () => {
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 1)
  })

  it('is inverse of dbToGain', () => {
    const db = -12
    expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 5)
  })
})
