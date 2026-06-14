/**
 * Convergence & quality metrics derived from a simulation trace.
 *
 * Each metric answers one specific question a human reviewer cares about when
 * asking "does the balance actually work?":
 *
 *   • converged?     — does output settle at the target at all?
 *   • T_converge     — how long until it does? (latency the user perceives)
 *   • steadyError    — once settled, how far off target on average? (accuracy)
 *   • overshoot      — how badly does it blow past target early on? (transient)
 *   • ripple         — does it keep "hunting" up and down? (stability margin)
 *
 * All metrics operate on the `outputLufs` column of a SimTraceRow, i.e. the
 * measured loudness *after* the decided gain is applied — the quantity that
 * should track `targetLufs`.
 */

import type { SimTraceRow } from './simulate'

export interface QualityMetrics {
  /** True if the trace ever enters and stays within `band` LU of target. */
  converged: boolean
  /**
   * Wall-clock seconds until output first enters `band` LU of target AND never
   * leaves again. `null` if never converged.
   */
  convergeTimeSec: number | null
  /** Mean |output − target| over the last `steadyWindowSec` seconds (LU). */
  steadyError: number
  /** Max amount (LU) by which output overshoots target, considering only the
   *  direction *toward* target from the starting level. See deriveOvershoot. */
  overshoot: number
  /** Standard deviation of output LUFS over the steady window (LU). */
  ripple: number
  /** First finite outputLufs in the trace (the starting level). */
  startLufs: number
  /** Mean output over the steady window (LUFS). */
  steadyMean: number
}

export interface MetricsOptions {
  targetLufs: number
  /** Convergence band half-width in LU (default 1.0: within ±1 LU counts as "there"). */
  band?: number
  /** Length of the trailing window used for steady-state stats (default 5 s). */
  steadyWindowSec?: number
  /** Tick period in seconds (sim tick = 100 ms; default 0.1). */
  tickSec?: number
}

/**
 * Compute the full metric set for one tab's trace.
 *
 * Rows with non-finite `outputLufs` (e.g. during the first 0.4 s before the
 * LUFS calculator has a full block) are skipped for stat purposes but still
 * occupy wall-clock time, so convergence latency is measured in real seconds,
 * not in "valid samples".
 */
export function computeMetrics(trace: SimTraceRow[], opts: MetricsOptions): QualityMetrics {
  const target = opts.targetLufs
  const band = opts.band ?? 1.0
  const steadyWindowSec = opts.steadyWindowSec ?? 5
  const tickSec = opts.tickSec ?? 0.1

  const finite = trace.filter((r) => Number.isFinite(r.outputLufs))
  const startLufs = finite.length > 0 ? finite[0]!.outputLufs : NaN

  // --- convergence: last tick at which output was OUTSIDE the band; the tick
  //     after that (if any) is when it settled for good.
  let convergeTimeSec: number | null = null
  let lastOutsideIdx = -1
  for (let i = 0; i < trace.length; i++) {
    const r = trace[i]!
    const inside = Number.isFinite(r.outputLufs) && Math.abs(r.outputLufs - target) <= band
    if (!inside) lastOutsideIdx = i
  }
  if (lastOutsideIdx < trace.length - 1) {
    // There exists a suffix entirely inside the band.
    const settleIdx = lastOutsideIdx + 1
    convergeTimeSec = trace[settleIdx]!.tSec
  }
  const converged = convergeTimeSec !== null

  // --- steady window: the last `steadyWindowSec` seconds of the trace.
  const windowTicks = Math.max(1, Math.round(steadyWindowSec / tickSec))
  const steadyRows = finite.slice(-windowTicks)
  const steadyOut = steadyRows.map((r) => r.outputLufs)
  const steadyMean = mean(steadyOut)
  const steadyError = mean(steadyOut.map((o) => Math.abs(o - target)))
  const ripple = stddev(steadyOut)

  // --- overshoot: how far output swings *past* target, measured relative to
  //     the direction of approach. If we start below target, overshoot is any
  //     excursion above target+ε; if above, any dip below. We take the max such
  //     excursion across the whole trace (early transients are the concern).
  const overshoot = deriveOvershoot(finite, target, startLufs)

  return {
    converged,
    convergeTimeSec,
    steadyError,
    overshoot,
    ripple,
    startLufs,
    steadyMean,
  }
}

/**
 * Maximum excursion of output *past* the target, measured from the target
 * toward the side opposite the starting level. With a start below target,
 * overshoot = max(0, max(output) − target); with a start above, it's
 * max(0, target − min(output)). Returns 0 if output never crosses.
 */
function deriveOvershoot(rows: SimTraceRow[], target: number, startLufs: number): number {
  if (!Number.isFinite(startLufs) || rows.length === 0) return 0
  if (startLufs < target) {
    // Approaching from below: overshoot is how far above target it goes.
    let maxAbove = target
    for (const r of rows) {
      if (Number.isFinite(r.outputLufs) && r.outputLufs > maxAbove) maxAbove = r.outputLufs
    }
    return maxAbove - target
  } else {
    // Approaching from above: overshoot is how far below target it dips.
    let minBelow = target
    for (const r of rows) {
      if (Number.isFinite(r.outputLufs) && r.outputLufs < minBelow) minBelow = r.outputLufs
    }
    return target - minBelow
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let s = 0
  for (const x of xs) {
    const d = x - m
    s += d * d
  }
  return Math.sqrt(s / xs.length)
}
