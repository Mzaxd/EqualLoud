/* Global AudioWorklet types (provided by browser at runtime) */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, processorCtor: new () => unknown): void

/**
 * K-weighting filter coefficients.
 *
 * ITU-R BS.1770 only publishes these for 48 kHz; the runtime AudioContext often
 * runs at a different rate (44.1 kHz on macOS). We reverse-engineer the analog
 * prototype (De Man 2018, via pyloudnorm) and re-discretise it via the bilinear
 * transform in `designKWeighting()` (see `k-weighting.ts` in the app bundle).
 *
 * The worklet cannot import from the app bundle (it is fetched as a standalone
 * module), so the design routine is inlined here and kept in sync with
 * `src/audio/k-weighting.ts`. At 48 kHz both reproduce the exact ITU constants.
 */

// --- Inlined K-weighting design (mirror of src/audio/k-weighting.ts) ---------
// Stage-1 (high-shelf) analog-prototype parameters.
const HS_GAIN_DB = 3.99984385397
const HS_Q = 0.7071752369554193
const HS_FC = 1681.9744509555319
// Stage-2 (high-pass) analog-prototype parameters.
const HP_Q = 0.5003270373253953
const HP_FC = 38.13547087613982

interface Biquad {
  b: readonly [number, number, number]
  a: readonly [number, number, number]
}

function designHighShelf(fs: number): Biquad {
  const k = Math.tan((Math.PI * HS_FC) / fs)
  const vh = Math.pow(10, HS_GAIN_DB / 20)
  const vb = Math.pow(vh, 0.499666774155)
  const q = HS_Q
  const a0 = 1 + k / q + k * k
  return {
    b: [
      (vh + (vb * k) / q + k * k) / a0,
      (2 * (k * k - vh)) / a0,
      (vh - (vb * k) / q + k * k) / a0,
    ],
    a: [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  }
}

function designHighPass(fs: number): Biquad {
  const k = Math.tan((Math.PI * HP_FC) / fs)
  const q = HP_Q
  const a0 = 1 + k / q + k * k
  return { b: [1, -2, 1], a: [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] }
}

function designKWeighting(sampleRate: number): { highShelf: Biquad; highPass: Biquad } {
  // Clamp so the pre-warping tan() stays finite (f_c ≪ f_s/2). K-weighting has
  // no meaningful variation above 192 kHz or below 8 kHz.
  const fs = Math.max(8000, Math.min(192000, sampleRate))
  return { highShelf: designHighShelf(fs), highPass: designHighPass(fs) }
}

// Channel weights for a stereo (2.0) signal. Per BS.1770-5 stereo L/R both
// carry weight 1.0. Mono is handled in `process()` by NOT duplicating the
// channel into both slots (see the mono-energy fix there).
const CHANNEL_WEIGHTS: number[] = [1.0, 1.0] // Stereo

const ABSOLUTE_THRESHOLD = -70.0
const RELATIVE_THRESHOLD_OFFSET = -10.0
const MAX_INTEGRATED_BLOCKS = 600

/**
 * AudioWorklet processor for LUFS audio analysis
 * Captures audio samples and sends them to the main thread for LUFS calculation,
 * while outputting silence to avoid double audio.
 */
class LufsProcessor extends AudioWorkletProcessor {
  // Config
  readonly channels: number
  readonly blockSizeSamples: number
  readonly hopSizeSamples: number
  readonly shortTermBlockCount: number
  readonly updateIntervalSamples: number
  /**
   * Warm-up threshold (in samples) below which we still emit "early" blocks so
   * balancing can start before the full 400 ms ring buffer is filled. Once
   * `samplesAccumulated` reaches this, the first early block is produced; from
   * there early blocks fire every `hopSizeSamples` until the ring is full, at
   * which point standard hop-based blocks take over. ~50% of the window keeps
   * the early estimate reasonably stable (a half window is far less noisy than
   * a quarter) while cutting time-to-first-measurement from ~400 ms to ~200 ms.
   */
  readonly earlyBlockThreshold: number

  // K-weighting coefficients for the current sample rate. Design at construction
  // (see constructor); the process() loop reads them per-sample. Storing them as
  // flat arrays keeps the hot loop allocation-free.
  readonly hsB: readonly [number, number, number]
  readonly hsA: readonly [number, number, number]
  readonly hpB: readonly [number, number, number]
  readonly hpA: readonly [number, number, number]
  /**
   * Whether the source is actually mono (only one input channel was delivered).
   * When true the R processing branch is skipped entirely instead of feeding it
   * a duplicate of L — duplicating would double the K-weighted energy and bias
   * LUFS ~3 dB high for every mono source (most podcasts, many TikTok/Reels
   * clips). Detected per-quantum in `process()` and cached here so the energy
   * accumulation logic knows whether `sumSquares[1]` holds real data.
   */
  mono: boolean

  // Filter states (typed arrays)
  hs_x1: Float32Array
  hs_x2: Float32Array
  hs_y1: Float32Array
  hs_y2: Float32Array
  hp_x1: Float32Array
  hp_x2: Float32Array
  hp_y1: Float32Array
  hp_y2: Float32Array

  // Rolling block accumulation via circular buffers
  ringIndex: number
  ringSquares: Float32Array[] // per-channel ring of y^2
  sumSquares: Float64Array // per-channel sum of y^2 over window
  samplesSinceLastBlock: number
  samplesSinceLastUpdate: number
  samplesAccumulated: number // Track warm-up: how many samples in ring buffer

  // Histories
  blockLoudnesses: number[]
  shortTermBlocks: number[]
  blockCount: number

  constructor() {
    super()
    this.channels = 2
    const blockMs = 400
    const overlap = 0.75
    const sr = (globalThis as unknown as { sampleRate?: number }).sampleRate ?? 48000
    this.blockSizeSamples = Math.max(128, Math.floor((blockMs / 1000) * sr))
    this.hopSizeSamples = Math.max(1, Math.floor(this.blockSizeSamples * (1 - overlap)))
    this.shortTermBlockCount = Math.ceil(3000 / (blockMs * (1 - overlap)))
    this.updateIntervalSamples = Math.max(128, Math.floor(0.1 * sr)) // ~10 Hz
    // Design the K-weighting filters for THIS context's sample rate instead of
    // using fixed 48 kHz coefficients. At 48 kHz the result is numerically
    // identical to the old hard-coded constants; at 44.1 kHz it corrects a
    // 0.3–0.7 LU drift that biased every gain decision. See k-weighting.ts.
    const kw = designKWeighting(sr)
    this.hsB = kw.highShelf.b
    this.hsA = kw.highShelf.a
    this.hpB = kw.highPass.b
    this.hpA = kw.highPass.a
    // Emit early blocks once half the window has been accumulated. Clamped to
    // at least one hop so we never produce two early blocks from the same
    // quantum of samples.
    this.earlyBlockThreshold = Math.max(
      this.hopSizeSamples,
      Math.floor(this.blockSizeSamples * 0.5),
    )

    this.hs_x1 = new Float32Array(this.channels)
    this.hs_x2 = new Float32Array(this.channels)
    this.hs_y1 = new Float32Array(this.channels)
    this.hs_y2 = new Float32Array(this.channels)
    this.hp_x1 = new Float32Array(this.channels)
    this.hp_x2 = new Float32Array(this.channels)
    this.hp_y1 = new Float32Array(this.channels)
    this.hp_y2 = new Float32Array(this.channels)

    this.ringIndex = 0
    this.ringSquares = Array.from(
      { length: this.channels },
      () => new Float32Array(this.blockSizeSamples),
    )
    this.sumSquares = new Float64Array(this.channels)
    this.samplesSinceLastBlock = 0
    this.samplesSinceLastUpdate = 0
    this.samplesAccumulated = 0
    // Will be (re)detected on the first process() call from the actual input
    // shape. Defaults to stereo; flipped to true if only one channel arrives.
    this.mono = false

    this.blockLoudnesses = []
    this.shortTermBlocks = []
    this.blockCount = 0

    // Control messages
    this.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'reset') {
        this.resetState()
      }
    }
  }

  // inputs: [ inputIndex ][ channelIndex ] -> Float32Array
  // outputs: [ outputIndex ][ channelIndex ] -> Float32Array
  process(
    inputs: ReadonlyArray<ReadonlyArray<Float32Array | undefined>>,
    outputs: ReadonlyArray<ReadonlyArray<Float32Array>>,
  ): boolean {
    const input = inputs[0]

    // If no input, keep processor alive
    if (!input || input.length === 0) {
      return true
    }

    // Detect mono vs stereo from the actual channel count delivered this quantum.
    // The audio graph in audio-graph.ts is wired for stereo (outputChannelCount
    // [2]); for a genuine mono source Chrome delivers a single channel array and
    // we must NOT process it twice — duplicating L into R would double the
    // K-weighted energy and bias LUFS ~3 dB high (10·log10(2) ≈ 3.01).
    const inputL = input[0]
    if (!inputL) return true
    const hasR = input.length >= 2 && input[1] && input[1]!.length > 0
    this.mono = !hasR
    const left: Float32Array = inputL as Float32Array
    const right: Float32Array | null = hasR ? (input[1] as Float32Array) : null
    const frameCount = left.length

    // Hoist the K-weighting coefficients out of the per-sample loop. At 48 kHz
    // these are the exact ITU constants; at other rates they are the
    // bilinear-transformed values from designKWeighting() (see file header).
    const hsB0 = this.hsB[0]!,
      hsB1 = this.hsB[1]!,
      hsB2 = this.hsB[2]!
    const hsA1 = this.hsA[1]!,
      hsA2 = this.hsA[2]!
    const hpB0 = this.hpB[0]!,
      hpB1 = this.hpB[1]!,
      hpB2 = this.hpB[2]!
    const hpA1 = this.hpA[1]!,
      hpA2 = this.hpA[2]!

    // Per-sample filtering and rolling window update
    for (let i = 0; i < frameCount; i++) {
      // Channel 0 (L)
      {
        const ch = 0
        const x = left[i] ?? 0
        const yHs =
          hsB0 * x +
          hsB1 * this.hs_x1[ch]! +
          hsB2 * this.hs_x2[ch]! -
          hsA1 * this.hs_y1[ch]! -
          hsA2 * this.hs_y2[ch]!
        this.hs_x2[ch] = this.hs_x1[ch]!
        this.hs_x1[ch] = x
        this.hs_y2[ch] = this.hs_y1[ch]!
        this.hs_y1[ch] = yHs
        const yHp =
          hpB0 * yHs +
          hpB1 * this.hp_x1[ch]! +
          hpB2 * this.hp_x2[ch]! -
          hpA1 * this.hp_y1[ch]! -
          hpA2 * this.hp_y2[ch]!
        this.hp_x2[ch] = this.hp_x1[ch]!
        this.hp_x1[ch] = yHs
        this.hp_y2[ch] = this.hp_y1[ch]!
        this.hp_y1[ch] = yHp
        const y2 = yHp * yHp
        const ringCh = this.ringSquares[ch]!
        const old = ringCh[this.ringIndex] || 0
        this.sumSquares[ch] = (this.sumSquares[ch] ?? 0) + (y2 - old)
        ringCh[this.ringIndex] = y2
      }
      // Channel 1 (R) — skipped for genuine mono sources to avoid the 3 dB
      // doubling bug. sumSquares[1] stays at 0 and computeCurrentBlockLufs()
      // divides by the effective channel count.
      if (right !== null) {
        const ch = 1
        const x = right[i] ?? 0
        const yHs =
          hsB0 * x +
          hsB1 * this.hs_x1[ch]! +
          hsB2 * this.hs_x2[ch]! -
          hsA1 * this.hs_y1[ch]! -
          hsA2 * this.hs_y2[ch]!
        this.hs_x2[ch] = this.hs_x1[ch]!
        this.hs_x1[ch] = x
        this.hs_y2[ch] = this.hs_y1[ch]!
        this.hs_y1[ch] = yHs
        const yHp =
          hpB0 * yHs +
          hpB1 * this.hp_x1[ch]! +
          hpB2 * this.hp_x2[ch]! -
          hpA1 * this.hp_y1[ch]! -
          hpA2 * this.hp_y2[ch]!
        this.hp_x2[ch] = this.hp_x1[ch]!
        this.hp_x1[ch] = yHs
        this.hp_y2[ch] = this.hp_y1[ch]!
        this.hp_y1[ch] = yHp
        const y2 = yHp * yHp
        const ringCh = this.ringSquares[ch]!
        const old = ringCh[this.ringIndex] || 0
        this.sumSquares[ch] = (this.sumSquares[ch] ?? 0) + (y2 - old)
        ringCh[this.ringIndex] = y2
      }

      // Advance shared ring index and counters
      this.ringIndex++
      if (this.ringIndex >= this.blockSizeSamples) this.ringIndex = 0
      this.samplesSinceLastBlock++
      this.samplesSinceLastUpdate++
      // Track warm-up: ring buffer fills up to blockSizeSamples
      if (this.samplesAccumulated < this.blockSizeSamples) {
        this.samplesAccumulated++
      }

      // Standard hop-based blocks: fire only after the ring is full. These are
      // the accurate, fully-overlapped measurements that drive steady-state
      // balancing.
      const warmedUp = this.samplesAccumulated >= this.blockSizeSamples
      if (warmedUp && this.samplesSinceLastBlock >= this.hopSizeSamples) {
        this.samplesSinceLastBlock -= this.hopSizeSamples
        this.emitBlock(this.computeCurrentBlockLufs())
      } else if (
        !warmedUp &&
        this.samplesAccumulated >= this.earlyBlockThreshold &&
        this.samplesSinceLastBlock >= this.hopSizeSamples
      ) {
        // Early block: ring not full yet, but we have enough samples (≥ half
        // window) to produce a usable estimate. Normalise by the actual count
        // of accumulated samples (NOT blockSize) so the partial window still
        // yields a correct mean square. This cuts time-to-first-measurement
        // from ~400 ms to ~200 ms; once the ring fills, standard blocks take
        // over seamlessly because both paths push identical-shaped values.
        this.samplesSinceLastBlock -= this.hopSizeSamples
        this.emitBlock(this.computeEarlyBlockLufs())
      }

      // Emit ~10 Hz aggregated results
      if (this.samplesSinceLastUpdate >= this.updateIntervalSamples) {
        this.samplesSinceLastUpdate -= this.updateIntervalSamples
        const momentary = this.getMomentary()
        const shortTerm = this.getShortTerm()
        const integrated = this.getIntegrated()
        this.port.postMessage({
          type: 'lufs',
          momentary,
          shortTerm,
          integrated,
          blockCount: this.blockCount,
        })
      }
    }

    // Output silence to avoid double audio
    const output = outputs[0]
    if (output) {
      for (let channel = 0; channel < output.length; channel++) {
        const outputChannel = output[channel]
        if (outputChannel) {
          outputChannel.fill(0)
        }
      }
    }

    return true
  }

  private computeCurrentBlockLufs(): number {
    let sumWeighted = 0
    for (let ch = 0; ch < this.channels; ch++) {
      const channelSum = this.sumSquares[ch] ?? 0
      const meanSquare = channelSum / this.blockSizeSamples
      const weight = CHANNEL_WEIGHTS[ch] ?? 1.0
      sumWeighted += weight * meanSquare
    }
    if (sumWeighted <= 0) return -Infinity
    return -0.691 + 10 * Math.log10(sumWeighted)
  }

  /**
   * Early-block loudness: same K-weighted energy as {@link computeCurrentBlockLufs}
   * but normalised by the number of samples actually accumulated so far (which is
   * < blockSizeSamples during warm-up). This yields a correct mean square over a
   * shorter window — noisier than a full block, but accurate enough to drive a
   * first gain pass ~200 ms in instead of ~400 ms.
   */
  private computeEarlyBlockLufs(): number {
    const n = Math.max(1, this.samplesAccumulated)
    let sumWeighted = 0
    for (let ch = 0; ch < this.channels; ch++) {
      const channelSum = this.sumSquares[ch] ?? 0
      const meanSquare = channelSum / n
      const weight = CHANNEL_WEIGHTS[ch] ?? 1.0
      sumWeighted += weight * meanSquare
    }
    if (sumWeighted <= 0) return -Infinity
    return -0.691 + 10 * Math.log10(sumWeighted)
  }

  /**
   * Push one block loudness into the histories and bump the block counter.
   * Centralised so the warm-up early-block path and the steady-state hop path
   * stay identical in shape (both feed shortTerm + integrated + blockCount).
   */
  private emitBlock(blockLufs: number): void {
    if (blockLufs > ABSOLUTE_THRESHOLD) {
      this.blockLoudnesses.push(blockLufs)
      if (this.blockLoudnesses.length > MAX_INTEGRATED_BLOCKS) {
        this.blockLoudnesses.shift()
      }
    }
    this.shortTermBlocks.push(blockLufs)
    if (this.shortTermBlocks.length > this.shortTermBlockCount) {
      this.shortTermBlocks.shift()
    }
    this.blockCount++
  }

  private getMomentary(): number {
    if (this.shortTermBlocks.length === 0) return -Infinity
    return this.shortTermBlocks[this.shortTermBlocks.length - 1] ?? -Infinity
  }

  private getShortTerm(): number {
    if (this.shortTermBlocks.length === 0) return -Infinity
    const valid = this.shortTermBlocks.filter((l) => l > ABSOLUTE_THRESHOLD)
    if (valid.length === 0) return -Infinity
    let sumPower = 0
    for (const v of valid) {
      sumPower += Math.pow(10, v / 10)
    }
    const meanPower = sumPower / valid.length
    return 10 * Math.log10(meanPower)
  }

  private getIntegrated(): number {
    if (this.blockLoudnesses.length === 0) return -Infinity
    const aboveAbsolute = this.blockLoudnesses.filter((l) => l > ABSOLUTE_THRESHOLD)
    if (aboveAbsolute.length === 0) return -Infinity
    let sumPower1 = 0
    for (const v of aboveAbsolute) {
      sumPower1 += Math.pow(10, v / 10)
    }
    const firstMeanPower = sumPower1 / aboveAbsolute.length
    const relativeThreshold = 10 * Math.log10(firstMeanPower) + RELATIVE_THRESHOLD_OFFSET
    const aboveRelative = aboveAbsolute.filter((l) => l > relativeThreshold)
    if (aboveRelative.length === 0) return -Infinity
    let sumPower2 = 0
    for (const v of aboveRelative) {
      sumPower2 += Math.pow(10, v / 10)
    }
    const finalMeanPower = sumPower2 / aboveRelative.length
    return 10 * Math.log10(finalMeanPower)
  }

  private resetState(): void {
    this.hs_x1.fill(0)
    this.hs_x2.fill(0)
    this.hs_y1.fill(0)
    this.hs_y2.fill(0)
    this.hp_x1.fill(0)
    this.hp_x2.fill(0)
    this.hp_y1.fill(0)
    this.hp_y2.fill(0)
    for (let ch = 0; ch < this.channels; ch++) {
      this.ringSquares[ch]!.fill(0)
      this.sumSquares[ch] = 0
    }
    this.ringIndex = 0
    this.samplesSinceLastBlock = 0
    this.samplesSinceLastUpdate = 0
    this.samplesAccumulated = 0
    this.blockLoudnesses = []
    this.shortTermBlocks = []
    this.blockCount = 0
  }
}

registerProcessor('lufs-processor', LufsProcessor)
