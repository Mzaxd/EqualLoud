/**
 * Scalar cost function for the offline tuner.
 *
 * The simulator and metrics module answer "what happened?" in rich, per-tab
 * detail. The tuner needs one number: "how *bad* was this trial, overall, on
 * this whole scenario set?" Lower = better. This module turns quality metrics
 * into that number.
 *
 * # Why a weighted sum (and not something fancier)
 *
 * Each term maps to a distinct user-perceptible quality dimension, and the
 * weights encode the *priority* between them. A weighted sum keeps the
 * contribution of each term readable in the breakdown (`ScoreBreakdown`) — you
 * can see exactly which dimension is costing a trial points, which a black-box
 * scalar (or a learned model) would hide. The weights are the only subjective
 * knob; everything else is measured.
 *
 * # The dimensions
 *
 *   convergeTime — latency the user *feels* before audio settles. Dominant
 *                  pain point on tab-switch / infinite-feed sites.
 *   steadyError  — once settled, how far off target on average. Accuracy.
 *   overshoot    — transient excursion past target at start. The "it got loud
 *                  before it got quiet" failure mode.
 *   ripple       — sustained hunting around target. Listener fatigue.
 *   failPenalty  — a scenario that never converges is a *broken* trial, not a
 *                  merely mediocre one, so it gets a fixed heavy penalty
 *                  instead of a large convergeTime.
 *
 * Units are chosen so that the default weights produce numbers in a human-
 * readable range (~10–100): convergeTime in seconds, errors in LU. The four
 * quality weights are all ≈1× each; failPenalty is deliberately large so a
 * single non-converging scenario can never be out-scored by being fast/stable
 * on the others.
 */

import { computeMetrics, type QualityMetrics } from './metrics'
import type { SimTabResult } from './simulate'

/** Per-trial weights. Override the defaults to shift priority between
 *  speed vs. accuracy vs. transient vs. steady stability. */
export interface CostWeights {
  /** Cost per second of convergence latency. */
  convergeTime: number
  /** Cost per LU of mean |output − target| in the steady window. */
  steadyError: number
  /** Cost per LU of worst transient overshoot past target. */
  overshoot: number
  /** Cost per LU of steady-window output stddev (hunting). */
  ripple: number
  /** Fixed penalty added once for a scenario that never converges. */
  failPenalty: number
  /**
   * Cost per unit of "gain change rate" (1/attackTc + 1/releaseTc). Penalises
   * very fast gain transitions that risk zipper noise / clicks on real audio —
   * a blind spot of the simulator, which can't hear. The penalty is purely
   * analytical: it needs no audio, just the params. Applied once per candidate
   * (not per scenario), since it depends only on the params, not the trace.
   */
  gainRate: number
  /**
   * Quadratic cost per dB that the limiter's output peak exceeds a safe ceiling
   * (−0.3 dBFS). Penalises near-clipping output levels. Derived from the trace.
   */
  clipping: number
  /**
   * Linear cost per dB of limiter gain reduction. Penalises over-compression
   * (the "pumped/squashed" sound when the limiter works too hard). Derived from
   * the trace.
   */
  overCompression: number
}

/** Defaults: all four quality terms ≈ equal weight; a single failure dominates. */
export const DEFAULT_COST_WEIGHTS: CostWeights = {
  convergeTime: 2,
  steadyError: 8,
  overshoot: 4,
  ripple: 10,
  failPenalty: 100,
  // gainRate: tuned so that τ=0.005 (extreme) costs ~1.5 points while τ=0.02
  // (production) costs ~0.4 — a clear gradient away from the extreme without
  // over-penalising reasonable values. (1/0.005 + 1/0.005)·0.001 ≈ 0.4 ... hmm,
  // let's compute: the rate is (1/attackTc + 1/releaseTc). For τ=0.005 both:
  // rate = 400, ×0.001 = 0.4. For τ=0.02/0.05: rate = 50+20 = 70, ×0.001=0.07.
  // That's too gentle. Use 0.002: extreme=0.8, production=0.14. Better.
  gainRate: 0.002,
  clipping: 3,
  overCompression: 0.5,
}

/** The safe output peak level (dBFS). Output exceeding this risks audible
 *  clipping on real hardware. −0.3 dBFS leaves a small headroom margin. */
const SAFE_PEAK_DB = -0.3

/** Breakdown so the tuner can show *why* a trial scored what it did. */
export interface ScoreBreakdown {
  convergeTime: number
  steadyError: number
  overshoot: number
  ripple: number
  failPenalty: number
  /** Clipping penalty (quadratic over safe peak). Derived from limiter stats. */
  clipping: number
  /** Over-compression penalty (limiter working hard). Derived from limiter stats. */
  overCompression: number
  /**
   * Zipper/click penalty for fast gain transitions. NOTE: this is zero at the
   * per-tab level — it is only computed once per candidate (it depends on the
   * params, not the trace) and added in `scoreScenarioSuite`. Kept here so the
   * breakdown has a consistent shape.
   */
  gainRate: number
  /** Sum of all terms — the scalar the tuner minimises. */
  total: number
  /** Whether this scenario's tab ever converged. */
  converged: boolean
}

/**
 * Score one tab's trace against a target.
 *
 * @param result  the sim result for one tab
 * @param target  the target LUFS this tab was trying to reach
 * @param weights cost weights (defaults encode user-priority)
 * @param band    convergence half-band in LU (default 1.0, matching metrics.ts)
 */
export function scoreTab(
  result: SimTabResult,
  target: number,
  weights: CostWeights = DEFAULT_COST_WEIGHTS,
  band = 1.0,
): { metrics: QualityMetrics; breakdown: ScoreBreakdown } {
  const metrics = computeMetrics(result.trace, { targetLufs: target, band })

  const convergeTime = (metrics.convergeTimeSec ?? 30) * weights.convergeTime
  const steadyError = metrics.steadyError * weights.steadyError
  const overshoot = metrics.overshoot * weights.overshoot
  const ripple = metrics.ripple * weights.ripple
  // A non-converging scenario still pays its quality-term cost on top of the
  // flat penalty — there is no reason a broken trial should escape ripple cost.
  const failPenalty = metrics.converged ? 0 : weights.failPenalty

  // Clipping: quadratic penalty for limiter output peaks above the safe ceiling.
  // We take the worst (highest) peak across the whole trace — one clipped tick
  // is enough to sound bad.
  let worstPeakDb = -Infinity
  let worstReductionDb = 0
  for (const r of result.trace) {
    if (Number.isFinite(r.limitedPeakDb) && r.limitedPeakDb > worstPeakDb) {
      worstPeakDb = r.limitedPeakDb
    }
    if (r.limiterReductionDb > worstReductionDb) {
      worstReductionDb = r.limiterReductionDb
    }
  }
  const excess = Number.isFinite(worstPeakDb) ? Math.max(0, worstPeakDb - SAFE_PEAK_DB) : 0
  const clipping = excess * excess * weights.clipping
  const overCompression = worstReductionDb * weights.overCompression

  const total =
    convergeTime + steadyError + overshoot + ripple + failPenalty + clipping + overCompression

  return {
    metrics,
    breakdown: {
      convergeTime,
      steadyError,
      overshoot,
      ripple,
      failPenalty,
      clipping,
      overCompression,
      gainRate: 0, // filled in at candidate level (depends on params, not trace)
      total,
      converged: metrics.converged,
    },
  }
}

/**
 * Per-scenario score: the mean of its tabs' totals. Multi-tab scenarios
 * (where balancing across sources is the whole point) are thus scored on the
 * *average* tab experience, which is what a listener with several open tabs
 * would perceive.
 */
export interface ScenarioScore {
  scenario: string
  /** Mean per-tab total cost across this scenario's tabs. */
  cost: number
  /** True iff every tab in the scenario converged. */
  converged: boolean
  perTab: Array<{ tabId: number; metrics: QualityMetrics; breakdown: ScoreBreakdown }>
}

/**
 * Score a whole scenario suite and return both the aggregate cost (what the
 * tuner minimises) and the per-scenario breakdown (for human inspection).
 *
 * The aggregate is the **mean over scenarios**, plus a one-time zipper penalty
 * (which depends only on the candidate's gain time constants, not on any trace).
 *
 * @param params  The candidate's gain time constants, used for the zipper
 *                penalty. If omitted, the zipper term is skipped (useful for
 *                scoring a trace without knowing the params that produced it).
 */
export function scoreScenarioSuite(
  scenarios: Array<{
    scenario: string
    target: number
    results: SimTabResult[]
  }>,
  weights: CostWeights = DEFAULT_COST_WEIGHTS,
  params?: { attackTc: number; releaseTc: number },
): { totalCost: number; perScenario: ScenarioScore[]; gainRatePenalty: number } {
  const perScenario: ScenarioScore[] = scenarios.map(({ scenario, target, results }) => {
    const perTab = results.map((r) => scoreTab(r, target, weights))
    const cost = perTab.reduce((s, t) => s + t.breakdown.total, 0) / Math.max(1, perTab.length)
    const converged = perTab.every((t) => t.breakdown.converged)
    return {
      scenario,
      cost,
      converged,
      perTab: perTab.map((t) => ({ tabId: 0, metrics: t.metrics, breakdown: t.breakdown })),
    }
  })

  // Repair tabId (lost in the map above because SimTabResult carries it).
  scenarios.forEach(({ results }, i) => {
    const ps = perScenario[i]!
    results.forEach((r, j) => {
      ps.perTab[j]!.tabId = r.id
    })
  })

  // Zipper penalty: once per candidate, based on gain time constants.
  // rate = 1/attackTc + 1/releaseTc (the aggregate gain-change speed).
  // τ=0 is treated as a very large rate (instantaneous = worst case for clicks).
  let gainRatePenalty = 0
  if (params) {
    const atkRate = params.attackTc > 0 ? 1 / params.attackTc : 1000
    const relRate = params.releaseTc > 0 ? 1 / params.releaseTc : 1000
    gainRatePenalty = (atkRate + relRate) * weights.gainRate
    // Stamp it into every per-tab breakdown for display, even though it's a
    // candidate-level quantity — the report iterates per-tab and showing it
    // there is clearer than a detached field.
    for (const ps of perScenario) {
      for (const pt of ps.perTab) {
        pt.breakdown.gainRate = gainRatePenalty
      }
    }
  }

  const scenarioMean =
    perScenario.reduce((s, ps) => s + ps.cost, 0) / Math.max(1, perScenario.length)

  return { totalCost: scenarioMean + gainRatePenalty, perScenario, gainRatePenalty }
}
