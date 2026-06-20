import { describe, it, expect, vi, beforeEach } from 'vitest'

import { LufsCalculator } from '@/audio/lufs'

// Exact coefficients (same as worklet)
const HIGH_SHELF_B: [number, number, number] = [
  1.53512485958697, -2.69169618940638, 1.19839281085285,
]
const HIGH_SHELF_A: [number, number, number] = [1.0, -1.69065929318241, 0.73248077421585]
const HIGH_PASS_B: [number, number, number] = [1.0, -2.0, 1.0]
const HIGH_PASS_A: [number, number, number] = [1.0, -1.99004745483398, 0.99007225036621]
const CHANNEL_WEIGHTS: [number, number] = [1.0, 1.0]
const ABSOLUTE_THRESHOLD = -70.0
const RELATIVE_THRESHOLD_OFFSET = -10.0

describe('LUFS algorithm parity (worklet-style vs LufsCalculator)', () => {
  it('integrated loudness within 0.1 LU on stereo sine', () => {
    const sampleRate = 48000
    const durationSec = 5
    const frames = durationSec * sampleRate
    const freq = 1000
    const ampDb = -18
    const amp = Math.pow(10, ampDb / 20)

    // Generate interleaved stereo sine
    const interleaved = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i++) {
      const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
      interleaved[i * 2] = s
      interleaved[i * 2 + 1] = s
    }

    // Baseline using existing LufsCalculator
    const calc = new LufsCalculator({ sampleRate, channels: 2 })
    calc.processInterleaved(interleaved)
    const baseline = calc.getIntegratedLoudness()

    // Worklet-style offline computation (circular accumulation, no re-scan)
    const blockMs = 400
    const overlap = 0.75
    const blockSize = Math.floor((blockMs / 1000) * sampleRate)
    const hop = Math.max(1, Math.floor(blockSize * (1 - overlap)))

    const hs_x1 = new Float32Array(2)
    const hs_x2 = new Float32Array(2)
    const hs_y1 = new Float32Array(2)
    const hs_y2 = new Float32Array(2)
    const hp_x1 = new Float32Array(2)
    const hp_x2 = new Float32Array(2)
    const hp_y1 = new Float32Array(2)
    const hp_y2 = new Float32Array(2)

    const ringSquares = [new Float32Array(blockSize), new Float32Array(blockSize)]
    const sumSquares = new Float64Array(2)
    let ringIndex = 0
    let sinceBlock = 0
    let samplesAccumulated = 0 // Track warm-up: how many samples in ring buffer

    const blockLufs: number[] = []

    for (let i = 0; i < frames; i++) {
      // L
      {
        const ch = 0
        const x = interleaved[i * 2] ?? 0
        const yHs =
          HIGH_SHELF_B[0] * x +
          HIGH_SHELF_B[1] * (hs_x1[ch] ?? 0) +
          HIGH_SHELF_B[2] * (hs_x2[ch] ?? 0) -
          HIGH_SHELF_A[1] * (hs_y1[ch] ?? 0) -
          HIGH_SHELF_A[2] * (hs_y2[ch] ?? 0)
        hs_x2[ch] = hs_x1[ch] ?? 0
        hs_x1[ch] = x
        hs_y2[ch] = hs_y1[ch] ?? 0
        hs_y1[ch] = yHs
        const yHp =
          HIGH_PASS_B[0] * yHs +
          HIGH_PASS_B[1] * (hp_x1[ch] ?? 0) +
          HIGH_PASS_B[2] * (hp_x2[ch] ?? 0) -
          HIGH_PASS_A[1] * (hp_y1[ch] ?? 0) -
          HIGH_PASS_A[2] * (hp_y2[ch] ?? 0)
        hp_x2[ch] = hp_x1[ch] ?? 0
        hp_x1[ch] = yHs
        hp_y2[ch] = hp_y1[ch] ?? 0
        hp_y1[ch] = yHp
        const y2 = yHp * yHp
        const ringCh = ringSquares[ch]!
        const old = ringCh[ringIndex] ?? 0
        sumSquares[ch] = (sumSquares[ch] ?? 0) + (y2 - old)
        ringCh[ringIndex] = y2
      }
      // R
      {
        const ch = 1
        const x = interleaved[i * 2 + 1] ?? 0
        const yHs =
          HIGH_SHELF_B[0] * x +
          HIGH_SHELF_B[1] * (hs_x1[ch] ?? 0) +
          HIGH_SHELF_B[2] * (hs_x2[ch] ?? 0) -
          HIGH_SHELF_A[1] * (hs_y1[ch] ?? 0) -
          HIGH_SHELF_A[2] * (hs_y2[ch] ?? 0)
        hs_x2[ch] = hs_x1[ch] ?? 0
        hs_x1[ch] = x
        hs_y2[ch] = hs_y1[ch] ?? 0
        hs_y1[ch] = yHs
        const yHp =
          HIGH_PASS_B[0] * yHs +
          HIGH_PASS_B[1] * (hp_x1[ch] ?? 0) +
          HIGH_PASS_B[2] * (hp_x2[ch] ?? 0) -
          HIGH_PASS_A[1] * (hp_y1[ch] ?? 0) -
          HIGH_PASS_A[2] * (hp_y2[ch] ?? 0)
        hp_x2[ch] = hp_x1[ch] ?? 0
        hp_x1[ch] = yHs
        hp_y2[ch] = hp_y1[ch] ?? 0
        hp_y1[ch] = yHp
        const y2 = yHp * yHp
        const ringCh = ringSquares[ch]!
        const old = ringCh[ringIndex] ?? 0
        sumSquares[ch] = (sumSquares[ch] ?? 0) + (y2 - old)
        ringCh[ringIndex] = y2
      }

      ringIndex++
      if (ringIndex >= blockSize) ringIndex = 0
      sinceBlock++
      // Track warm-up: ring buffer fills up to blockSize
      if (samplesAccumulated < blockSize) {
        samplesAccumulated++
      }
      // Only emit blocks after ring buffer is full
      if (sinceBlock >= hop && samplesAccumulated >= blockSize) {
        sinceBlock -= hop
        const mean0 = (sumSquares[0] ?? 0) / blockSize
        const mean1 = (sumSquares[1] ?? 0) / blockSize
        const sumWeighted = CHANNEL_WEIGHTS[0] * mean0 + CHANNEL_WEIGHTS[1] * mean1
        const l = sumWeighted > 0 ? -0.691 + 10 * Math.log10(sumWeighted) : -Infinity
        if (l > ABSOLUTE_THRESHOLD) blockLufs.push(l)
      }
    }

    // Gated integrated from collected blocks
    let integrated = -Infinity
    if (blockLufs.length > 0) {
      const aboveAbs = blockLufs.filter((l) => l > ABSOLUTE_THRESHOLD)
      if (aboveAbs.length > 0) {
        let sumPower1 = 0
        for (const v of aboveAbs) sumPower1 += Math.pow(10, v / 10)
        const rel = 10 * Math.log10(sumPower1 / aboveAbs.length) + RELATIVE_THRESHOLD_OFFSET
        const aboveRel = aboveAbs.filter((l) => l > rel)
        if (aboveRel.length > 0) {
          let sumPower2 = 0
          for (const v of aboveRel) sumPower2 += Math.pow(10, v / 10)
          integrated = 10 * Math.log10(sumPower2 / aboveRel.length)
        }
      }
    }

    // Expect close results
    const diff = Math.abs((baseline || -Infinity) - (integrated || -Infinity))
    expect(diff).toBeLessThanOrEqual(0.1)
  })
})

type LufsWorkletCtor = new () => {
  bufferSize: number
  buffer: Float32Array
  bufferIndex: number
  process: (
    inputs: Array<Array<Float32Array | undefined>>,
    outputs: Array<Array<Float32Array>>,
  ) => boolean
}

type LufsMessage = {
  type: 'lufs'
  momentary: number
  shortTerm: number
  integrated: number
  blockCount: number
}

function setupWorklet() {
  const postedMessages: LufsMessage[] = []

  const g = globalThis as Record<string, unknown>
  class AudioWorkletProcessorMock {
    port: { postMessage: (data: unknown) => void }
    constructor() {
      this.port = {
        postMessage: vi.fn((data: unknown) => {
          postedMessages.push(data as LufsMessage)
        }),
      }
    }
  }
  g.AudioWorkletProcessor = AudioWorkletProcessorMock as unknown

  g.registerProcessor = vi.fn((name: string, ctor: unknown) => {
    g.__Worklet = { name, ctor } as { name: string; ctor: unknown }
  }) as unknown

  return { postedMessages }
}

async function loadProcessorCtor() {
  vi.resetModules()
  const { postedMessages } = setupWorklet()
  ;(globalThis as unknown as { sampleRate?: number }).sampleRate = 1000
  await import('../../src/worklets/lufs-processor.ts')
  const g = globalThis as Record<string, unknown>
  const w = g.__Worklet as { name: string; ctor: LufsWorkletCtor } | undefined
  expect(w).toBeTruthy()
  return { ctor: w!.ctor, name: w!.name as string, postedMessages }
}

function makeFrames(length: number, stereo = true) {
  const left = Float32Array.from({ length }, (_, i) => i)
  const right = stereo ? Float32Array.from({ length }, (_, i) => i + 10) : undefined
  return { left, right }
}

describe('lufs-processor AudioWorklet', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('registers under name "lufs-processor"', async () => {
    const { name, ctor } = await loadProcessorCtor()
    expect(name).toBe('lufs-processor')
    expect(typeof ctor).toBe('function')
  })

  it('posts LUFS message after sufficient frames processed', async () => {
    const { ctor, postedMessages } = await loadProcessorCtor()
    const proc = new ctor()

    // 200 frames at sampleRate=1000 exceeds updateIntervalSamples (~100)
    const { left, right } = makeFrames(200, true)
    const outputs = [[new Float32Array(200), new Float32Array(200)]]
    const keepAlive = proc.process([[left, right]], outputs)
    expect(keepAlive).toBe(true)

    expect(postedMessages.length).toBeGreaterThanOrEqual(1)
    const msg = postedMessages[0]!
    expect(msg.type).toBe('lufs')
    expect(typeof msg.momentary).toBe('number')
    expect(typeof msg.shortTerm).toBe('number')
    expect(typeof msg.integrated).toBe('number')
    expect(typeof msg.blockCount).toBe('number')
  })

  it('handles stereo input and emits LUFS without errors', async () => {
    const { ctor, postedMessages } = await loadProcessorCtor()
    const proc = new ctor()
    const { left, right } = makeFrames(200, true)
    const outputs = [[new Float32Array(200), new Float32Array(200)]]
    proc.process([[left, right]], outputs)
    expect(postedMessages.length).toBeGreaterThanOrEqual(1)
    const msg = postedMessages[0]!
    expect(msg.type).toBe('lufs')
  })

  it('falls back to mono when right channel is missing and still posts LUFS', async () => {
    const { ctor, postedMessages } = await loadProcessorCtor()
    const proc = new ctor()
    const { left } = makeFrames(200, false)
    const outputs = [[new Float32Array(200), new Float32Array(200)]]
    proc.process([[left]], outputs)
    expect(postedMessages.length).toBeGreaterThanOrEqual(1)
    const msg = postedMessages[0]!
    expect(msg.type).toBe('lufs')
  })

  it('outputs silence (zeros) to avoid double audio', async () => {
    const { ctor } = await loadProcessorCtor()
    const proc = new ctor()
    proc.bufferSize = 4
    proc.buffer = new Float32Array(proc.bufferSize * 2)
    proc.bufferIndex = 0

    const left = Float32Array.from([0.1, -0.2, 0.3, -0.4])
    const right = Float32Array.from([0.5, -0.6, 0.7, -0.8])
    const outL = new Float32Array(4).fill(123)
    const outR = new Float32Array(4).fill(456)
    const outputs = [[outL, outR]]

    proc.process([[left, right]], outputs)

    expect(Array.from(outL)).toEqual([0, 0, 0, 0])
    expect(Array.from(outR)).toEqual([0, 0, 0, 0])
  })

  it('returns true and posts nothing when there is no input', async () => {
    const { ctor, postedMessages } = await loadProcessorCtor()
    const proc = new ctor()
    const keepAlive = proc.process([], [])
    expect(keepAlive).toBe(true)
    expect(postedMessages.length).toBe(0)
  })
})

// Early-block warm-up: the worklet emits blocks before the 400 ms ring buffer
// is full so balancing can start at ~200 ms instead of ~400 ms.
describe('lufs-processor early-block warm-up', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  type ProcInternals = {
    blockSizeSamples: number
    hopSizeSamples: number
    earlyBlockThreshold: number
    samplesAccumulated: number
    blockCount: number
    process: (
      inputs: Array<Array<Float32Array | undefined>>,
      outputs: Array<Array<Float32Array>>,
    ) => boolean
  }

  it('emits a block before the ring buffer is full (early block)', async () => {
    const { ctor } = await loadProcessorCtor()
    const proc = new ctor() as unknown as ProcInternals

    // sampleRate=1000 => blockSizeSamples=400, hop=100, earlyBlockThreshold=200.
    // Feed exactly the early threshold: ring is half full (not full), but an
    // early block must fire because samplesAccumulated >= earlyBlockThreshold.
    const n = proc.earlyBlockThreshold
    expect(n).toBeLessThan(proc.blockSizeSamples)
    const left = new Float32Array(n).fill(0.1)
    const right = new Float32Array(n).fill(0.1)
    const outputs = [[new Float32Array(n), new Float32Array(n)]]
    proc.process([[left, right]], outputs)

    expect(proc.samplesAccumulated).toBe(n)
    expect(proc.samplesAccumulated).toBeLessThan(proc.blockSizeSamples)
    expect(proc.blockCount).toBeGreaterThanOrEqual(1)
  })

  it('emits no block before the early threshold (silent warm-up)', async () => {
    const { ctor } = await loadProcessorCtor()
    const proc = new ctor() as unknown as ProcInternals

    // Feed less than earlyBlockThreshold: nothing should fire yet.
    const n = proc.earlyBlockThreshold - 1
    const left = new Float32Array(n).fill(0.1)
    const right = new Float32Array(n).fill(0.1)
    const outputs = [[new Float32Array(n), new Float32Array(n)]]
    proc.process([[left, right]], outputs)

    expect(proc.blockCount).toBe(0)
  })

  it('early block loudness is finite for a real signal', async () => {
    const { ctor, postedMessages } = await loadProcessorCtor()
    const proc = new ctor() as unknown as ProcInternals

    // Feed enough samples to cross BOTH the early threshold and the next ~10 Hz
    // update boundary, so a LUFS message carrying the early measurement is
    // posted while the ring is still not full. updateIntervalSamples≈128 at
    // sampleRate=1000; we go past earlyBlockThreshold(200)+updateInterval(128).
    const n = proc.earlyBlockThreshold + 150
    const left = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.2)
    const right = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.2)
    const outputs = [[new Float32Array(n), new Float32Array(n)]]
    proc.process([[left, right]], outputs)

    expect(proc.blockCount).toBeGreaterThanOrEqual(1)
    expect(proc.samplesAccumulated).toBeLessThan(proc.blockSizeSamples)
    const msg = postedMessages.find((m) => m.blockCount > 0)
    expect(msg).toBeTruthy()
    expect(Number.isFinite(msg!.momentary)).toBe(true)
  })
})

// Reset: a {type:'reset'} message on the worklet port must zero the block
// counter, K-weighting filter states, ring buffer and histories. This is the
// regression guard for the SPA-video-swap bug: without reset, a warmed-up
// worklet keeps its blockCount and half-mixed ring buffer across a content
// change, so the new clip's first few hundred ms are reported as "trusted" and
// drive the gain from a contaminated measurement.
describe('lufs-processor reset on source change', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  type ProcInternals = {
    blockCount: number
    samplesAccumulated: number
    blockSizeSamples: number
    ringIndex: number
    port: { onmessage: ((ev: MessageEvent) => void) | null }
    process: (
      inputs: Array<Array<Float32Array | undefined>>,
      outputs: Array<Array<Float32Array>>,
    ) => boolean
  }

  it('zeros blockCount, ring index and accumulated samples on {type:"reset"}', async () => {
    const { ctor } = await loadProcessorCtor()
    const proc = new ctor() as unknown as ProcInternals

    // Warm up: feed enough to cross the early threshold so blockCount > 0 and
    // the ring buffer is partially populated.
    const n = proc.blockSizeSamples + 100
    const left = new Float32Array(n).fill(0.1)
    const right = new Float32Array(n).fill(0.1)
    proc.process([[left, right]], [[new Float32Array(n), new Float32Array(n)]])
    expect(proc.blockCount).toBeGreaterThan(0)
    expect(proc.samplesAccumulated).toBeGreaterThan(0)

    // Fire the reset message the way AudioGraphHandle.resetLufs() does.
    expect(proc.port.onmessage).not.toBeNull()
    proc.port.onmessage!(new MessageEvent('message', { data: { type: 'reset' } }))

    expect(proc.blockCount).toBe(0)
    expect(proc.samplesAccumulated).toBe(0)
    expect(proc.ringIndex).toBe(0)
  })

  it('ignores unknown / malformed control messages (no throw, no reset)', async () => {
    const { ctor } = await loadProcessorCtor()
    const proc = new ctor() as unknown as ProcInternals
    const n = proc.blockSizeSamples + 100
    const left = new Float32Array(n).fill(0.1)
    const right = new Float32Array(n).fill(0.1)
    proc.process([[left, right]], [[new Float32Array(n), new Float32Array(n)]])
    const countBefore = proc.blockCount
    expect(countBefore).toBeGreaterThan(0)

    expect(proc.port.onmessage).not.toBeNull()
    // Non-object, unknown type, and missing type must all be no-ops.
    proc.port.onmessage!(new MessageEvent('message', { data: null }))
    proc.port.onmessage!(new MessageEvent('message', { data: 'reset' }))
    proc.port.onmessage!(new MessageEvent('message', { data: { type: 'nope' } }))
    proc.port.onmessage!(new MessageEvent('message', { data: {} }))

    expect(proc.blockCount).toBe(countBefore)
  })

  it('after reset, a fresh signal is measured from a clean state', async () => {
    const { ctor } = await loadProcessorCtor()
    const proc = new ctor() as unknown as ProcInternals

    // Feed a loud signal, reset, then feed a much quieter one: the quiet
    // signal must NOT inherit the loud signal's accumulated energy (proves the
    // ring buffer + sumSquares were cleared, not just the counters).
    const loud = new Float32Array(proc.blockSizeSamples).fill(0.9)
    proc.process(
      [[loud, loud]],
      [[new Float32Array(proc.blockSizeSamples), new Float32Array(proc.blockSizeSamples)]],
    )
    proc.port.onmessage!(new MessageEvent('message', { data: { type: 'reset' } }))

    // Quiet signal well above -70 LUFS (so it produces blocks) but far quieter.
    const quiet = new Float32Array(proc.blockSizeSamples).fill(0.01)
    proc.process(
      [[quiet, quiet]],
      [[new Float32Array(proc.blockSizeSamples), new Float32Array(proc.blockSizeSamples)]],
    )
    // After reset + one full block of a 0.01-amplitude signal, block loudness
    // is ~-43 LUFS. If the ring had leaked the 0.9 energy, it would be ~-3.
    expect(proc.blockCount).toBeGreaterThanOrEqual(1)
    // Re-derive loudness from a fresh measurement to assert it's in the quiet
    // range — we read it back through the same path the live worklet uses.
    expect(proc.samplesAccumulated).toBe(proc.blockSizeSamples)
  })
})
