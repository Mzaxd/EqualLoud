/**
 * LUFS (Loudness Units Full Scale) calculation module
 * Implements ITU-R BS.1770-5 algorithm for integrated loudness measurement
 */

// K-weighting filter coefficients for 48kHz sample rate
// Stage 1: High-shelf filter (+4dB at high frequencies)
const HIGH_SHELF_B: [number, number, number] = [
  1.53512485958697, -2.69169618940638, 1.19839281085285,
]
const HIGH_SHELF_A: [number, number, number] = [1.0, -1.69065929318241, 0.73248077421585]

// Stage 2: High-pass filter (removes DC and sub-bass)
const HIGH_PASS_B: [number, number, number] = [1.0, -2.0, 1.0]
const HIGH_PASS_A: [number, number, number] = [1.0, -1.99004745483398, 0.99007225036621]

// Channel weights for surround (stereo uses only L/R at 1.0)
const CHANNEL_WEIGHTS: Record<number, number[]> = {
  1: [1.0], // Mono
  2: [1.0, 1.0], // Stereo
  // 5.1 (L, R, C, LFE, Ls, Rs) per BS.1770-5: surrounds have higher weight; LFE excluded
  6: [1.0, 1.0, 1.0, 0.0, 1.5, 1.5],
}

// Absolute threshold for gating (-70 LUFS)
const ABSOLUTE_THRESHOLD = -70.0
// Relative threshold offset (-10 LU)
const RELATIVE_THRESHOLD_OFFSET = -10.0

// Cap for integrated loudness block history to prevent unbounded growth.
// With 400ms blocks at 75% overlap, hop is ~100ms => 10 blocks/sec.
// 600 blocks ≈ 1 minutes window.
const MAX_INTEGRATED_BLOCKS = 600

export interface LufsCalculatorOptions {
  sampleRate: number
  channels: number
  blockSize?: number // in milliseconds, default 400ms
  overlap?: number // overlap ratio, default 0.75
}

interface FilterState {
  x1: number
  x2: number
  y1: number
  y2: number
}

/**
 * Real-time LUFS calculator using ITU-R BS.1770-4 algorithm
 */
export class LufsCalculator {
  private sampleRate: number
  private channels: number
  private blockSizeSamples: number
  private hopSizeSamples: number
  private channelWeights: number[]

  // Filter states per channel (two stages)
  private highShelfStates: FilterState[]
  private highPassStates: FilterState[]

  // Buffers for block processing
  private channelBuffers: Float32Array[]
  private bufferIndex: number

  // Accumulated mean square values for integrated loudness
  private blockLoudnesses: number[] = []

  // Short-term loudness (last 3 seconds)
  private shortTermBlocks: number[] = []
  private readonly shortTermBlockCount: number

  constructor(options: LufsCalculatorOptions) {
    this.sampleRate = options.sampleRate
    this.channels = options.channels
    const blockMs = options.blockSize ?? 400
    const overlap = options.overlap ?? 0.75

    this.blockSizeSamples = Math.floor((blockMs / 1000) * this.sampleRate)
    this.hopSizeSamples = Math.floor(this.blockSizeSamples * (1 - overlap))
    this.shortTermBlockCount = Math.ceil(3000 / (blockMs * (1 - overlap)))

    this.channelWeights =
      CHANNEL_WEIGHTS[this.channels] ?? (Array(this.channels).fill(1.0) as number[])

    // Initialize filter states
    this.highShelfStates = Array.from({ length: this.channels }, () => ({
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
    }))
    this.highPassStates = Array.from({ length: this.channels }, () => ({
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
    }))

    // Initialize channel buffers
    this.channelBuffers = Array.from(
      { length: this.channels },
      () => new Float32Array(this.blockSizeSamples),
    )
    this.bufferIndex = 0
  }

  /**
   * Apply biquad filter to a sample
   */
  private applyBiquad(
    x: number,
    b: [number, number, number],
    a: [number, number, number],
    state: FilterState,
  ): number {
    const y = b[0] * x + b[1] * state.x1 + b[2] * state.x2 - a[1] * state.y1 - a[2] * state.y2

    state.x2 = state.x1
    state.x1 = x
    state.y2 = state.y1
    state.y1 = y

    return y
  }

  /**
   * Process audio samples and update LUFS measurements
   * @param samples Interleaved audio samples [L, R, L, R, ...] or per-channel arrays
   */
  processInterleaved(samples: Float32Array): void {
    const frameCount = Math.floor(samples.length / this.channels)

    for (let frame = 0; frame < frameCount; frame++) {
      for (let ch = 0; ch < this.channels; ch++) {
        const sample = samples[frame * this.channels + ch] ?? 0
        const highShelfState = this.highShelfStates[ch]
        const highPassState = this.highPassStates[ch]
        const channelBuffer = this.channelBuffers[ch]

        if (!highShelfState || !highPassState || !channelBuffer) continue

        // Apply K-weighting (high-shelf then high-pass)
        const afterHighShelf = this.applyBiquad(sample, HIGH_SHELF_B, HIGH_SHELF_A, highShelfState)
        const filtered = this.applyBiquad(afterHighShelf, HIGH_PASS_B, HIGH_PASS_A, highPassState)

        channelBuffer[this.bufferIndex] = filtered
      }

      this.bufferIndex++

      // Process block when we have enough samples
      if (this.bufferIndex >= this.blockSizeSamples) {
        this.processBlock()
        // Shift buffers by hop size
        this.shiftBuffers()
      }
    }
  }

  /**
   * Process a complete block and calculate block loudness
   */
  private processBlock(): void {
    let sumWeighted = 0

    for (let ch = 0; ch < this.channels; ch++) {
      const channelBuffer = this.channelBuffers[ch]
      const weight = this.channelWeights[ch]

      if (!channelBuffer || weight === undefined) continue

      // Calculate mean square for this channel
      let sumSquare = 0
      for (let i = 0; i < this.blockSizeSamples; i++) {
        const sample = channelBuffer[i] ?? 0
        sumSquare += sample * sample
      }
      const meanSquare = sumSquare / this.blockSizeSamples
      sumWeighted += weight * meanSquare
    }

    // Convert to LUFS
    const blockLoudness = sumWeighted > 0 ? -0.691 + 10 * Math.log10(sumWeighted) : -Infinity

    // Store for integrated loudness calculation (only if above absolute threshold)
    if (blockLoudness > ABSOLUTE_THRESHOLD) {
      this.blockLoudnesses.push(blockLoudness)
      // Prevent unbounded growth for live streams
      if (this.blockLoudnesses.length > MAX_INTEGRATED_BLOCKS) {
        this.blockLoudnesses.shift()
      }
    }

    // Store for short-term loudness
    this.shortTermBlocks.push(blockLoudness)
    if (this.shortTermBlocks.length > this.shortTermBlockCount) {
      this.shortTermBlocks.shift()
    }
  }

  /**
   * Shift buffers by hop size for overlapping analysis
   */
  private shiftBuffers(): void {
    const keepSamples = this.blockSizeSamples - this.hopSizeSamples

    for (let ch = 0; ch < this.channels; ch++) {
      const channelBuffer = this.channelBuffers[ch]
      if (!channelBuffer) continue

      // Copy the last part to the beginning
      channelBuffer.copyWithin(0, this.hopSizeSamples, this.blockSizeSamples)
    }

    this.bufferIndex = keepSamples
  }

  /**
   * Get momentary loudness (last 400ms block)
   */
  getMomentaryLoudness(): number {
    if (this.shortTermBlocks.length === 0) return -Infinity
    return this.shortTermBlocks[this.shortTermBlocks.length - 1] ?? -Infinity
  }

  /**
   * Get short-term loudness (last 3 seconds, gated)
   */
  getShortTermLoudness(): number {
    if (this.shortTermBlocks.length === 0) return -Infinity

    // Filter blocks above absolute threshold
    const validBlocks = this.shortTermBlocks.filter((l) => l > ABSOLUTE_THRESHOLD)
    if (validBlocks.length === 0) return -Infinity

    // Calculate mean power
    const meanPower =
      validBlocks.reduce((sum, lufs) => sum + Math.pow(10, lufs / 10), 0) / validBlocks.length

    return 10 * Math.log10(meanPower)
  }

  /**
   * Get integrated loudness (full measurement, gated per BS.1770-4)
   */
  getIntegratedLoudness(): number {
    if (this.blockLoudnesses.length === 0) return -Infinity

    // First pass: calculate mean above absolute threshold
    const aboveAbsolute = this.blockLoudnesses.filter((l) => l > ABSOLUTE_THRESHOLD)
    if (aboveAbsolute.length === 0) return -Infinity

    const firstPassMeanPower =
      aboveAbsolute.reduce((sum, lufs) => sum + Math.pow(10, lufs / 10), 0) / aboveAbsolute.length
    const relativeThreshold = 10 * Math.log10(firstPassMeanPower) + RELATIVE_THRESHOLD_OFFSET

    // Second pass: calculate mean above relative threshold
    const aboveRelative = aboveAbsolute.filter((l) => l > relativeThreshold)
    if (aboveRelative.length === 0) return -Infinity

    const finalMeanPower =
      aboveRelative.reduce((sum, lufs) => sum + Math.pow(10, lufs / 10), 0) / aboveRelative.length

    return 10 * Math.log10(finalMeanPower)
  }

  /**
   * Reset all measurements
   */
  reset(): void {
    this.bufferIndex = 0
    this.blockLoudnesses = []
    this.shortTermBlocks = []

    // Reset filter states
    for (let ch = 0; ch < this.channels; ch++) {
      const highShelfState = this.highShelfStates[ch]
      const highPassState = this.highPassStates[ch]
      const channelBuffer = this.channelBuffers[ch]

      if (highShelfState) {
        highShelfState.x1 = 0
        highShelfState.x2 = 0
        highShelfState.y1 = 0
        highShelfState.y2 = 0
      }
      if (highPassState) {
        highPassState.x1 = 0
        highPassState.x2 = 0
        highPassState.y1 = 0
        highPassState.y2 = 0
      }
      if (channelBuffer) {
        channelBuffer.fill(0)
      }
    }
  }

  /**
   * Get the number of blocks that have been processed for integrated loudness
   * (only blocks above absolute threshold are counted)
   */
  getBlockCount(): number {
    return this.blockLoudnesses.length
  }

  /**
   * Check if there are enough samples for reliable LUFS-I measurement
   * Requires at least ~3 seconds of audio above threshold (about 30 blocks at default settings)
   */
  hasEnoughSamples(): boolean {
    // Need at least 10 blocks (~4 seconds at 400ms blocks with 75% overlap)
    // to get a meaningful integrated loudness measurement
    const MIN_BLOCKS_FOR_RELIABLE_LUFS = 10
    return this.blockLoudnesses.length >= MIN_BLOCKS_FOR_RELIABLE_LUFS
  }

  /**
   * Get the approximate duration of audio processed (in seconds)
   */
  getProcessedDuration(): number {
    // Each block is 400ms with 75% overlap, so each hop adds 100ms
    const hopDurationMs = (this.blockSizeSamples / this.sampleRate) * 1000 * 0.25
    return (this.blockLoudnesses.length * hopDurationMs) / 1000
  }
}

/**
 * Convert dB value to linear gain
 */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * Convert linear gain to dB
 */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain)
}
