/**
 * EBU R128 Loudness Range (LRA) — "dynamic range" in loudness terms.
 *
 * LRA quantifies the variation in loudness over a programme: a value of 0 LU
 * means a relentless compressed signal ( adverts, loudness-war masters), while
 * 20+ LU means wide dynamics ( classical music, cinema). It is defined
 * (EBU Tech 3342) as the difference between the 95th and 10th percentiles of
 * the short-term loudness distribution, after absolute gating (−70 LUFS) and a
 * 10 LU relative gating pass, with an extra ±20 LU "gating" applied to the
 * range itself for robustness against outliers.
 *
 * ── Why the percentile range (not max−min)? ────────────────────────────────
 * The extremes of short-term loudness are noise: a door slam in a podcast, a
 * silent gap before a track. Percentiles ignore the loudest 5 % and quietest
 * 10 % so LRA reflects the *musical* dynamic range, not accidents.
 *
 * ── Implementation ─────────────────────────────────────────────────────────
 * Both an offline {@link computeLra} (whole-programme, used by the parity test)
 * and a streaming {@link LraTracker} (sliding window, used by the worklet).
 * The streaming version keeps a ring of recent short-term blocks and recomputes
 * the percentile range every update via a partial sort — O(n log k) where
 * k = the percentile window size, cheap at 300 samples × 10 Hz.
 *
 * References:
 *  - EBU Tech 3342 (2016) — LRA definition & gating.
 *  - BS.1770-4 — the short-term block (3 s, 75 % overlap) that feeds LRA.
 */

/** Short-term blocks below this are absolute-gated out (matches LUFS gating). */
const LRA_ABSOLUTE_THRESHOLD = -70.0

/** Minimum number of short-term blocks before LRA is reported (avoid noise). */
const MIN_BLOCKS_FOR_LRA = 4

/**
 * Offline: LRA (LU) over a list of short-term block loudness values (LUFS).
 * Returns 0 if too few valid blocks. Implements the EBU R128 percentile method.
 */
export function computeLra(shortTermBlocks: ReadonlyArray<number>): number {
  // 1. Absolute gate: drop blocks ≤ −70 LUFS.
  const gated = shortTermBlocks.filter((l) => Number.isFinite(l) && l > LRA_ABSOLUTE_THRESHOLD)
  if (gated.length < MIN_BLOCKS_FOR_LRA) return 0

  // 2. Relative gate: compute the mean, then drop blocks > 10 LU below it.
  // (R128 applies the same relative gate as integrated loudness.)
  let sumPower = 0
  for (const v of gated) sumPower += Math.pow(10, v / 10)
  const meanLufs = 10 * Math.log10(sumPower / gated.length)
  const relThreshold = meanLufs - 10
  const relGated = gated.filter((l) => l >= relThreshold)
  if (relGated.length < MIN_BLOCKS_FOR_LRA) return 0

  // 3. Sort and take the 10th / 95th percentiles.
  const sorted = [...relGated].sort((a, b) => a - b)
  const p10 = percentile(sorted, 10)
  const p95 = percentile(sorted, 95)

  // 4. LRA = 95th − 10th. Clamp to ≥ 0 (numerical safety).
  return Math.max(0, p95 - p10)
}

/**
 * Linear-interpolation percentile of a *sorted* ascending array.
 * EBU Tech 3342 uses the "lower" variant for the 10th and 95th; linear
 * interpolation is the common practical approximation (pyloudnorm, libebur128).
 */
function percentile(sorted: ReadonlyArray<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return -Infinity
  if (n === 1) return sorted[0]!
  // Rank, 1-based, linear interpolation (R-7, the default in numpy/Excel).
  const rank = (p / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]!
  const frac = rank - lo
  return sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!)
}

/**
 * Streaming LRA over a sliding window of short-term blocks.
 *
 * The worklet pushes a short-term LUFS value every ~100 ms (each short-term
 * block). This tracker keeps the last {@link windowBlocks} (~30 s) and exposes
 * the current LRA via {@link getLra}. Recomputation is throttled to once per
 * window-block (i.e. ~10 Hz), not per push, to keep cost bounded.
 */
export class LraTracker {
  private readonly window: number[]
  private idx = 0
  private filled = 0
  private cached = 0

  constructor(windowBlocks = 300) {
    // 300 blocks × 100 ms ≈ 30 s — the R128 short-term measurement window.
    this.window = new Array<number>(windowBlocks).fill(-Infinity)
  }

  /** Push one short-term LUFS value (called once per short-term block, ~10 Hz). */
  push(shortTermLufs: number): void {
    this.window[this.idx] = Number.isFinite(shortTermLufs) ? shortTermLufs : -Infinity
    this.idx = (this.idx + 1) % this.window.length
    if (this.filled < this.window.length) this.filled++
    // Recompute on every push — at 300 samples the sort is ~3000 ops, trivial.
    this.cached = this.compute()
  }

  /** Current LRA (LU), or 0 if insufficient data. */
  getLra(): number {
    return this.cached
  }

  private compute(): number {
    if (this.filled < MIN_BLOCKS_FOR_LRA) return 0
    // Copy the filled portion (unfilled slots hold -Infinity, naturally gated).
    const slice = this.window.slice(0, this.filled)
    return computeLra(slice)
  }

  reset(): void {
    this.window.fill(-Infinity)
    this.idx = 0
    this.filled = 0
    this.cached = 0
  }
}
