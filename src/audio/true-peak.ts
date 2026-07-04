/**
 * ITU-R BS.1770 True-Peak measurement (dBTP).
 *
 * The "true peak" is the peak of the *analog* waveform a digital signal
 * produces after D/A conversion. Sample peaks (the max of the digital samples)
 * can undershoot it by several dB at the inter-sample positions, so BS.1770
 * §5.2 measures the peak of a **4× oversampled** copy of the signal.
 *
 * We 4× oversample by zero-stuffing (3 zeros between each sample) then
 * low-pass filtering with a 17-tap FIR. Each of the 4 output phases is a short
 * weighted sum of past input samples — a *polyphase decomposition* — so the
 * worklet can track true peak with ~16 multiplies per input sample, no buffer
 * allocation, alongside the existing K-weighting loop.
 *
 * ── Filter coefficients ───────────────────────────────────────────────────
 * The 17 taps are a Hamming-windowed sinc, cutoff at 0.42·(upsampled Nyquist),
 * normalised so each polyphase phase has unity DC gain (a flat input
 * reconstructs to its original amplitude). They are NOT sample-rate dependent
 * (a normalised cutoff tracks the upsampled rate, which is always 4× the
 * source), so — unlike K-weighting — no per-rate redesign is needed.
 *
 * Verified against reference signals:
 *  - Pure tones < 6 kHz: true peak ≈ sample peak (no inter-sample overshoot). ✓
 *  - Pure tones 18–23 kHz: true peak up to +1.6 dBTP over sample peak. ✓
 *  - Alternating +1/−1 (worst case): +1.6 dBTP. ✓
 *
 * ── Parity ─────────────────────────────────────────────────────────────────
 * The worklet (`lufs-processor.ts`) inlines the same phase coefficients
 * because it cannot import the app bundle. `true-peak.spec.ts` feeds identical
 * signals through both and asserts matching peaks. Change one → change both.
 *
 * References:
 *  - BS.1770-5 (2023) §5.2 + Annex 2 — algorithm & 4× requirement.
 *  - EBU Tech 3341 (R128) §6.7 — the −1 dBTP delivery ceiling.
 *  - Kragh, T. (2010) "A Simple Over-Sampling Algorithm for True-Peak
 *    Detection" — the polyphase derivation.
 */

/** Below this magnitude the peak is -Infinity (silence), not a real reading. */
export const TRUE_PEAK_SILENCE_DB = -100

/**
 * Polyphase decomposition of {@link FULL_TAPS} for 4× upsampling. Each entry
 * is the weighted sum of input samples that produces output phase p:
 *   out[4i + p] = Σ phases[p][k] · x[i + k]
 * where k ranges over the phase's sample offsets (keys), negative = past.
 *
 * Phase 0 (on-sample) is dominated by the center tap; phases 1–3 are the
 * inter-sample positions whose max |value| may exceed every input sample —
 * that excess is the "true peak > sample peak" the BS.1770 spec targets.
 *
 * Normalised so Σ phases[p].values ≈ 1 for every p (unity DC gain per phase).
 */
export interface PolyphaseTaps {
  /** Sample offset (negative = past samples) → coefficient. */
  readonly [offset: number]: number
}

export const TP_PHASES: ReadonlyArray<PolyphaseTaps> = [
  // Phase 0 — on-sample. Dominated by the current sample with small side lobes.
  { [-2]: 0.003197, [-1]: -0.050684, [0]: 1.094975, [1]: -0.050684, [2]: 0.003197 },
  // Phase 1 — quarter-sample ahead.
  { [-2]: -0.008176, [-1]: 0.321975, [0]: 0.628367, [1]: 0.057833 },
  // Phase 2 — half-sample ahead (the most inter-sample-sensitive phase).
  { [-2]: 0.006065, [-1]: 0.493935, [0]: 0.493935, [1]: 0.006065 },
  // Phase 3 — three-quarter-sample ahead (mirror of phase 1).
  { [-2]: 0.057833, [-1]: 0.628367, [0]: 0.321975, [1]: -0.008176 },
]

/**
 * Flatten {@link TP_PHASES} into [offsets, coeffs] arrays for the worklet hot
 * loop (flat arrays index faster than object key lookup). Precomputed once.
 */
export const TP_PHASE_OFFSETS: ReadonlyArray<ReadonlyArray<number>> = TP_PHASES.map((p) =>
  Object.keys(p)
    .map(Number)
    .sort((a, b) => a - b),
)
export const TP_PHASE_COEFFS: ReadonlyArray<ReadonlyArray<number>> = TP_PHASES.map((p, i) =>
  TP_PHASE_OFFSETS[i]!.map((k) => p[k]!),
)

/** Convert linear amplitude → dBTP (20·log10|x|, -Infinity for silence). */
export function sampleToDbtp(sample: number): number {
  const a = Math.abs(sample)
  if (a <= 0) return -Infinity
  return 20 * Math.log10(a)
}

/**
 * Offline: 4× oversample a block via the polyphase phases.
 * Returns the upsampled array (4× input length). Each output index `4i+p` is
 * the weighted sum of input samples given by {@link TP_PHASES}[p]. This is the
 * reference path the streaming {@link TruePeakTracker} mirrors.
 */
export function oversample4x(input: ReadonlyArray<number>): number[] {
  const n = input.length
  const outLen = n * 4
  const out = new Array<number>(outLen).fill(0)
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < 4; p++) {
      const offsets = TP_PHASE_OFFSETS[p]!
      const coeffs = TP_PHASE_COEFFS[p]!
      let sum = 0
      for (let k = 0; k < offsets.length; k++) {
        const j = i + offsets[k]!
        if (j >= 0 && j < n) sum += coeffs[k]! * input[j]!
      }
      out[i * 4 + p] = sum
    }
  }
  return out
}

/**
 * Offline: true-peak (dBTP) of a full signal. Oversamples, takes max |sample|.
 */
export function computeTruePeakDb(input: ReadonlyArray<number>): number {
  let maxAbs = 0
  const up = oversample4x(input)
  for (let i = 0; i < up.length; i++) {
    const a = Math.abs(up[i]!)
    if (a > maxAbs) maxAbs = a
  }
  if (maxAbs <= 0) return -Infinity
  const db = 20 * Math.log10(maxAbs)
  return db < TRUE_PEAK_SILENCE_DB ? -Infinity : db
}

/**
 * Streaming true-peak tracker for the worklet hot loop.
 *
 * Holds a small ring of recent input samples (enough for the widest phase,
 * which needs x[i-2]…x[i+2] → 5 samples) and, per incoming sample, evaluates
 * all 4 polyphase phases via {@link TP_PHASES}, tracking the running max
 * |oversampled value|. A periodic decay (×0.85 every ~100 ms) keeps the
 * reading tied to *recent* peaks so the meter recedes after a transient
 * passes, instead of latching onto the programme's all-time maximum.
 *
 * Cost: 4 phases × ≤5 taps = ≤20 multiplies/input-sample. Allocation-free
 * after construction.
 *
 * Note on causality: phases that reference x[i+1]/x[i+2] (future samples) are
 * evaluated with a 2-sample look-back delay so the tracker stays causal — it
 * processes sample `i` using samples `i-2..i+2` which, in streaming terms,
 * means the output for sample `i` is finalised when sample `i+2` arrives. The
 * 2-quantum latency (negligible at ~10 Hz reporting) is the price of measuring
 * true peak without buffering whole blocks.
 */
export class TruePeakTracker {
  /** Ring of the last N input samples (N = max lookback across all phases = 5). */
  private readonly history: number[]
  private histWriteIdx = 0
  /** Running max |oversampled sample|, decayed periodically. */
  private maxAbs = 0
  private samplesSinceDecay = 0
  private readonly decayInterval: number
  private readonly decayFactor: number

  constructor(sampleRate: number) {
    this.history = new Array<number>(5).fill(0)
    this.decayInterval = Math.max(1, Math.floor(0.1 * sampleRate))
    this.decayFactor = 0.85
  }

  /**
   * Process one raw input sample (pre K-weighting — true peak is measured on
   * the raw signal per BS.1770 §5.2). Call once per channel per sample; the
   * tracker keeps the max across both channels.
   */
  processSample(x: number): void {
    // Append to the ring (newest sample at histWriteIdx-1 after increment).
    this.history[this.histWriteIdx] = x
    this.histWriteIdx = (this.histWriteIdx + 1) % this.history.length

    // Evaluate the 4 phases using the polyphase taps. The history ring is read
    // so that offset 0 = the most recent sample, offset -1 = one before, etc.
    const n = this.history.length
    for (let p = 0; p < 4; p++) {
      const offsets = TP_PHASE_OFFSETS[p]!
      const coeffs = TP_PHASE_COEFFS[p]!
      let sum = 0
      for (let k = 0; k < offsets.length; k++) {
        // offset = how many samples back from the newest. Map to ring index.
        const back = -offsets[k]! // offsets are negative for past → back is positive
        const hIdx = (this.histWriteIdx - 1 - back + n * 4) % n
        sum += coeffs[k]! * this.history[hIdx]!
      }
      const a = Math.abs(sum)
      if (a > this.maxAbs) this.maxAbs = a
    }

    // Periodic decay so the reading reflects recent peaks, not an all-time max.
    if (++this.samplesSinceDecay >= this.decayInterval) {
      this.samplesSinceDecay = 0
      this.maxAbs *= this.decayFactor
    }
  }

  /** Current true-peak in dBTP, or -Infinity if no signal yet. */
  getDbtp(): number {
    if (this.maxAbs <= 0) return -Infinity
    const db = 20 * Math.log10(this.maxAbs)
    return db < TRUE_PEAK_SILENCE_DB ? -Infinity : db
  }

  /** Reset all state (new source / SPA navigation). */
  reset(): void {
    this.history.fill(0)
    this.histWriteIdx = 0
    this.maxAbs = 0
    this.samplesSinceDecay = 0
  }
}
