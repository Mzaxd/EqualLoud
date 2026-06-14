/* Global AudioWorklet types (provided by browser at runtime) */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, processorCtor: new () => unknown): void

// Exact ITU-R BS.1770 K-weighting coefficients (as used in app runtime)
const HIGH_SHELF_B: [number, number, number] = [
  1.53512485958697, -2.69169618940638, 1.19839281085285,
]
const HIGH_SHELF_A: [number, number, number] = [1.0, -1.69065929318241, 0.73248077421585]
const HIGH_PASS_B: [number, number, number] = [1.0, -2.0, 1.0]
const HIGH_PASS_A: [number, number, number] = [1.0, -1.99004745483398, 0.99007225036621]

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

    const inputL = input[0]
    const inputR = input[1] ?? input[0] // Fallback to mono if missing right channel

    if (!inputL) {
      return true
    }

    const left: Float32Array = inputL as Float32Array
    const right: Float32Array = (inputR ?? inputL) as Float32Array
    const frameCount = left.length

    // Per-sample filtering and rolling window update
    for (let i = 0; i < frameCount; i++) {
      // Channel 0 (L)
      {
        const ch = 0
        const x = left[i] ?? 0
        const yHs =
          HIGH_SHELF_B[0] * x +
          HIGH_SHELF_B[1] * this.hs_x1[ch]! +
          HIGH_SHELF_B[2] * this.hs_x2[ch]! -
          HIGH_SHELF_A[1] * this.hs_y1[ch]! -
          HIGH_SHELF_A[2] * this.hs_y2[ch]!
        this.hs_x2[ch] = this.hs_x1[ch]!
        this.hs_x1[ch] = x
        this.hs_y2[ch] = this.hs_y1[ch]!
        this.hs_y1[ch] = yHs
        const yHp =
          HIGH_PASS_B[0] * yHs +
          HIGH_PASS_B[1] * this.hp_x1[ch]! +
          HIGH_PASS_B[2] * this.hp_x2[ch]! -
          HIGH_PASS_A[1] * this.hp_y1[ch]! -
          HIGH_PASS_A[2] * this.hp_y2[ch]!
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
      // Channel 1 (R)
      {
        const ch = 1
        const x = right[i] ?? 0
        const yHs =
          HIGH_SHELF_B[0] * x +
          HIGH_SHELF_B[1] * this.hs_x1[ch]! +
          HIGH_SHELF_B[2] * this.hs_x2[ch]! -
          HIGH_SHELF_A[1] * this.hs_y1[ch]! -
          HIGH_SHELF_A[2] * this.hs_y2[ch]!
        this.hs_x2[ch] = this.hs_x1[ch]!
        this.hs_x1[ch] = x
        this.hs_y2[ch] = this.hs_y1[ch]!
        this.hs_y1[ch] = yHs
        const yHp =
          HIGH_PASS_B[0] * yHs +
          HIGH_PASS_B[1] * this.hp_x1[ch]! +
          HIGH_PASS_B[2] * this.hp_x2[ch]! -
          HIGH_PASS_A[1] * this.hp_y1[ch]! -
          HIGH_PASS_A[2] * this.hp_y2[ch]!
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

      // Create a new block every hop, but only after ring buffer is full
      if (
        this.samplesSinceLastBlock >= this.hopSizeSamples &&
        this.samplesAccumulated >= this.blockSizeSamples
      ) {
        this.samplesSinceLastBlock -= this.hopSizeSamples
        const blockLufs = this.computeCurrentBlockLufs()
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
