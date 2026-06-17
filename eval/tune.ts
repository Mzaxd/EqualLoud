/**
 * Offline parameter tuner for the balance control loop + output limiter.
 *
 * This is the "self-evolution" engine. It sweeps the control-loop knobs over a
 * scenario suite, scores each trial with a scalar cost function, and returns
 * the best-performing parameter set — turning "these constants feel off" into
 * "this set scored 38 vs the default's 71, here is the breakdown".
 *
 * Two layers, kept separate on purpose:
 *
 *   • `buildTuneSuite()`  — the *exam questions*: a fixed, seeded set of
 *     scenarios (steady convergence, dynamic ads, level jumps, silence gaps,
 *     unreachable-quiet, transient bursts, voice-band spectra). This is where
 *     real recorded audio would later be added. The suite is the ground truth.
 *   • `runTune()` / `runTuneTwoStage()` — the *optimiser*: given a search
 *     space and the suite, evaluate every candidate and rank them. Pure,
 *     deterministic, side-effect free — `tune.spec.ts` drives it and prints
 *     the report.
 *
 * # The search space
 *
 * Seven knobs (see `BalanceSimParams`): 4 balance-loop (minBlocks, minGainDb,
 * attackTc, releaseTc) + 3 limiter (thresholdDb, ratio, attackMs, releaseMs;
 * kneeDb held at production default). The grid spans values both more
 * aggressive and more conservative than production defaults, so the optimiser
 * can *disagree* with the current defaults if the suite warrants it.
 *
 * # Two-stage search
 *
 * A full grid of 4 balance × 3 limiter axes would be thousands of candidates.
 * The cost function's balance terms and limiter terms are largely decoupled
 * (the limiter sits after the gain node and has no feedback into the loop), so
 * we search in two stages:
 *
 *   Stage 1: fix limiter at production defaults, sweep the 4 balance knobs
 *            (125 candidates, fast — the limiter model barely engages).
 *   Stage 2: fix balance at Stage-1's winner, sweep the 3 limiter knobs
 *            (fewer candidates, slower per-candidate because the limiter model
 *            now runs at sample level on every scenario).
 *
 * This avoids a combinatorial explosion while still finding a jointly-good set.
 *
 * # Why a grid, not gradient descent
 *
 * The cost surface has flat regions and discontinuities (convergence is a step
 * function of the params; the failPenalty is a cliff). A grid is robust to
 * both and, at this scale, faster to reason about than tuning a step size.
 */

import { scoreScenarioSuite, type ScenarioScore, DEFAULT_COST_WEIGHTS } from './cost'
import {
  pinkNoise,
  pinkNoiseScenario,
  pinkAmpDbFor,
  silence,
  concatStereo,
  transientBurst,
  voiceBandNoise,
  type StereoSignal,
} from './signals'
import { runBalanceSim, type BalanceSimParams, DEFAULT_LIMITER } from './simulate'

const SR = 48000
const TARGET = -14

// ---------------------------------------------------------------------------
// Scenario suite — the exam questions. Mirrors the B/C/D/E spec coverage but
// expressed as plain data so the tuner can run it without vitest. Adding a
// real recorded clip later = appending one entry here.
// ---------------------------------------------------------------------------

/** One scenario: one or more tabs sharing a target, simulated for durationSec.
 *
 *  Two targets, deliberately separate:
 *    • `target`       — the control-loop setpoint passed to computeBalanceGains.
 *                      This is the real system target (-14 LUFS) and must stay
 *                      fixed: the loop's *job* is to chase it.
 *    • `scoreTarget`  — what the *cost function* measures convergence against.
 *                      For reachable scenarios this equals `target`. For a
 *                      structurally-unreachable source (D4: -50 LUFS can at
 *                      best reach -26 with the +12 ceiling), judging "did it
 *                      converge to -14?" would be a category error — the loop
 *                      correctly pins at the ceiling. Setting scoreTarget to
 *                      the reachable ceiling lets us reward "stable at the best
 *                      achievable level" instead of penalising a physical limit.
 */
export interface TuneScenario {
  name: string
  target: number
  /** Cost-function convergence target. Defaults to `target` (reachable case). */
  scoreTarget?: number
  durationSec: number
  tabs: Array<{ id: number; signal: StereoSignal }>
}

/** Static pink-noise signal builder for a tab that measures a given LUFS. */
function tabAt(
  id: number,
  lufs: number,
  durationSec: number,
  seed: number,
): {
  id: number
  signal: StereoSignal
} {
  return {
    id,
    signal: pinkNoise({
      sampleRate: SR,
      durationSec,
      amplitudeDb: pinkAmpDbFor(lufs),
      seed,
      channels: 2,
    }),
  }
}

/**
 * Build the tune suite. Deterministic (seeded). Covers:
 *   • steady single-tab convergence from above and below (the B group)
 *   • multi-tab balancing of a realistic mix (the C group)
 *   • a loud-ad insertion, a level jump, a silence gap, an unreachable-quiet
 *     source (the D group — the dynamic/transient pain points)
 *   • transient bursts, voice-band spectra, extreme-boost ceiling (the T group
 *     — Phase 2 additions that stress the limiter and gain smoother in ways
 *     flat pink noise cannot)
 * The tuner's aggregate cost is the mean across all of these, so a parameter
 * set must do well on *all* of them to win — not just the easy steady case.
 */
export function buildTuneSuite(): TuneScenario[] {
  return [
    { name: 'B1-quiet-24', target: TARGET, durationSec: 14, tabs: [tabAt(1, -24, 14, 1)] },
    { name: 'B2-loud-8', target: TARGET, durationSec: 14, tabs: [tabAt(1, -8, 14, 2)] },
    {
      name: 'C2-realistic',
      target: TARGET,
      durationSec: 14,
      tabs: [
        tabAt(1, -12, 14, 21),
        tabAt(2, -22, 14, 22),
        tabAt(3, -8, 14, 23),
        tabAt(4, -16, 14, 24),
      ],
    },
    {
      name: 'D1-ad-insert',
      target: TARGET,
      durationSec: 18,
      tabs: [
        {
          id: 1,
          signal: pinkNoiseScenario(
            SR,
            [
              { amplitudeDb: pinkAmpDbFor(-20), durationSec: 4 },
              { amplitudeDb: pinkAmpDbFor(-6), durationSec: 5 },
              { amplitudeDb: pinkAmpDbFor(-20), durationSec: 9 },
            ],
            100,
          ),
        },
      ],
    },
    {
      name: 'D2-silence-gap',
      target: TARGET,
      durationSec: 14,
      tabs: [
        {
          id: 1,
          signal: concatStereo(
            concatStereo(
              pinkNoise({
                sampleRate: SR,
                durationSec: 5,
                amplitudeDb: pinkAmpDbFor(-20),
                seed: 200,
                channels: 2,
              }),
              silence(SR, 2),
            ),
            pinkNoise({
              sampleRate: SR,
              durationSec: 7,
              amplitudeDb: pinkAmpDbFor(-20),
              seed: 201,
              channels: 2,
            }),
          ),
        },
      ],
    },
    {
      name: 'D3-level-jump',
      target: TARGET,
      durationSec: 15,
      tabs: [
        {
          id: 1,
          signal: pinkNoiseScenario(
            SR,
            [
              { amplitudeDb: pinkAmpDbFor(-20), durationSec: 6 },
              { amplitudeDb: pinkAmpDbFor(-10), durationSec: 9 },
            ],
            300,
          ),
        },
      ],
    },
    {
      // -50 LUFS-amplitude source. The worklet measures its short-term at
      // ≈ −38 LUFS (pink noise's LUFS sits 11.85 dB below peak dBFS, so
      // pinkAmpDbFor(−50) ⇒ −50 dBFS ⇒ −38 LUFS). With the +12 ceiling the
      // loop pins gain and output settles at −38 + 12 = −26. The loop *must*
      // reach and hold that ceiling; judging convergence to the −14 control
      // target would be a category error. scoreTarget = the reachable steady
      // state, so the cost rewards "stable at the best achievable level".
      name: 'D4-very-quiet-50',
      target: TARGET,
      scoreTarget: -26,
      durationSec: 14,
      tabs: [tabAt(1, -50, 14, 400)],
    },
    // --- Phase 2: transient / spectral / extreme-boost stress tests ---
    {
      // Periodic sharp transients on a quiet bed. Punishes overly-fast gain
      // time constants: if the smoother reacts within the transient's duration
      // it modulates audible gain *during* the hit, producing clicks/breathing.
      // Also stresses the limiter's attack: too-slow attack lets the transient
      // through un-limited (clipping risk); too-fast attack squashes it.
      name: 'T1-transient',
      target: TARGET,
      durationSec: 14,
      tabs: [
        {
          id: 1,
          signal: transientBurst({
            sampleRate: SR,
            durationSec: 14,
            bedAmplitudeDb: pinkAmpDbFor(-20),
            transientDb: -3,
            intervalMs: 500,
            transientMs: 5,
            seed: 500,
          }),
        },
      ],
    },
    {
      // Voice-band spectrum (300 Hz – 3 kHz). Different spectral centroid from
      // flat pink noise → different K-weighting response → can expose parameter
      // biases that only show up on speech-like content.
      name: 'T2-voice-band',
      target: TARGET,
      durationSec: 14,
      tabs: [
        {
          id: 1,
          signal: voiceBandNoise({
            sampleRate: SR,
            durationSec: 14,
            amplitudeDb: pinkAmpDbFor(-18),
            seed: 600,
          }),
        },
      ],
    },
    {
      // Very loud source (-6 LUFS) that needs heavy *attenuation* to reach -14.
      // The mirror of D4: here the limiter's *absence* of work is what we test
      // (gain should pull it down, not push it up), plus the attack/release
      // response when the gain decision swings.
      name: 'T3-loud-attenuate',
      target: TARGET,
      durationSec: 14,
      tabs: [tabAt(1, -6, 14, 700)],
    },
  ]
}

// ---------------------------------------------------------------------------
// Search space
// ---------------------------------------------------------------------------

/** A candidate parameter set the tuner evaluates. */
export interface TuneCandidate {
  params: BalanceSimParams
  totalCost: number
  perScenario: ScenarioScore[]
  /** The zipper penalty (a candidate-level quantity, not per-scenario). */
  gainRatePenalty: number
  /** True iff every scenario converged for these params. */
  allConverged: boolean
}

/** The production defaults, evaluated as a baseline candidate for comparison. */
export const PRODUCTION_DEFAULTS: BalanceSimParams = {
  minBlocks: 1,
  minGainDb: -60,
  attackTc: 0.02,
  releaseTc: 0.05,
  thresholdDb: DEFAULT_LIMITER.thresholdDb,
  ratio: DEFAULT_LIMITER.ratio,
  attackMs: DEFAULT_LIMITER.attackMs,
  releaseMs: DEFAULT_LIMITER.releaseMs,
  kneeDb: DEFAULT_LIMITER.kneeDb,
}

/**
 * Stage-1 search grid: the 4 balance-loop knobs. Coarse on purpose — finds the
 * neighbourhood, not the 4th decimal place. Each axis spans both sides of the
 * production default. minGainDb is held at the production floor because it only
 * binds on extreme content and is more a UX choice than a loop-tune.
 */
export const BALANCE_GRID = {
  minBlocks: [1, 2, 3, 5, 8],
  minGainDb: [-60] as const,
  attackTc: [0.005, 0.01, 0.02, 0.04, 0.08],
  releaseTc: [0.02, 0.05, 0.1, 0.2, 0.4],
}

/**
 * Stage-2 search grid: the limiter knobs. kneeDb is held at production default
 * (0 = hard knee) because it's the least impactful axis and the grid stays
 * manageable. threshold/ratio/attack/release are the knobs that materially
 * change limiter behaviour on transients and loud content.
 */
export const LIMITER_GRID = {
  thresholdDb: [-3, -1, -0.5],
  ratio: [4, 12, 20],
  attackMs: [0.5, 1, 3, 10],
  releaseMs: [50, 100, 200],
}

/** Expand the balance grid into full candidate params, limiter held at defaults. */
export function expandBalanceGrid(
  grid: typeof BALANCE_GRID,
  limiter: BalanceSimParams['thresholdDb'] extends never
    ? never
    : Omit<BalanceSimParams, 'minBlocks' | 'minGainDb' | 'attackTc' | 'releaseTc'>,
): BalanceSimParams[] {
  const out: BalanceSimParams[] = []
  for (const minBlocks of grid.minBlocks) {
    for (const minGainDb of grid.minGainDb) {
      for (const attackTc of grid.attackTc) {
        for (const releaseTc of grid.releaseTc) {
          out.push({ minBlocks, minGainDb, attackTc, releaseTc, ...limiter })
        }
      }
    }
  }
  return out
}

/** Expand the limiter grid into full candidate params, balance held fixed. */
export function expandLimiterGrid(
  grid: typeof LIMITER_GRID,
  balance: Pick<BalanceSimParams, 'minBlocks' | 'minGainDb' | 'attackTc' | 'releaseTc'>,
): BalanceSimParams[] {
  const out: BalanceSimParams[] = []
  for (const thresholdDb of grid.thresholdDb) {
    for (const ratio of grid.ratio) {
      for (const attackMs of grid.attackMs) {
        for (const releaseMs of grid.releaseMs) {
          out.push({
            ...balance,
            thresholdDb,
            ratio,
            attackMs,
            releaseMs,
            kneeDb: DEFAULT_LIMITER.kneeDb,
          })
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Optimiser
// ---------------------------------------------------------------------------

/** Split BalanceSimParams into its balance + limiter + smoother halves. */
function splitParams(p: BalanceSimParams) {
  return {
    balance: { minBlocks: p.minBlocks, minGainDb: p.minGainDb },
    smoother: { attackTc: p.attackTc, releaseTc: p.releaseTc },
    limiter: {
      thresholdDb: p.thresholdDb,
      ratio: p.ratio,
      attackMs: p.attackMs,
      releaseMs: p.releaseMs,
      kneeDb: p.kneeDb,
    },
  }
}

/**
 * Run a single candidate against the suite and score it.
 */
export function evaluateCandidate(params: BalanceSimParams, suite: TuneScenario[]): TuneCandidate {
  const { balance, smoother, limiter } = splitParams(params)
  const scenarioInputs = suite.map((sc) => ({
    scenario: sc.name,
    target: sc.scoreTarget ?? sc.target,
    results: runBalanceSim(
      sc.tabs.map((t) => ({ id: t.id, signal: t.signal })),
      {
        targetLufs: sc.target,
        durationSec: sc.durationSec,
        balanceParams: balance,
        gainSmoother: smoother,
        limiter,
      },
    ),
  }))
  const { totalCost, perScenario, gainRatePenalty } = scoreScenarioSuite(
    scenarioInputs,
    DEFAULT_COST_WEIGHTS,
    { attackTc: params.attackTc, releaseTc: params.releaseTc },
  )
  return {
    params,
    totalCost,
    perScenario,
    gainRatePenalty,
    allConverged: perScenario.every((p) => p.converged),
  }
}

/** Sort helper: converged-first, then ascending cost. */
function rankCandidates(a: TuneCandidate, b: TuneCandidate): number {
  if (a.allConverged !== b.allConverged) return a.allConverged ? -1 : 1
  return a.totalCost - b.totalCost
}

/**
 * Two-stage optimiser — the main entry point.
 *
 * Stage 1: sweep balance-loop knobs with limiter at production defaults.
 * Stage 2: fix balance at Stage-1's winner, sweep limiter knobs.
 * Returns both stages' ranked results so the report can show the progression.
 */
export interface TwoStageResult {
  stage1: TuneCandidate[]
  stage2: TuneCandidate[]
  /** The Stage-1 winner (balance params), carried into Stage 2. */
  bestBalance: BalanceSimParams
  /** The overall winner (best of Stage 2). */
  best: TuneCandidate | null
  /** The production-defaults baseline, for comparison. */
  baseline: TuneCandidate
}

export function runTuneTwoStage(
  suite: TuneScenario[] = buildTuneSuite(),
  balanceGrid: typeof BALANCE_GRID = BALANCE_GRID,
  limiterGrid: typeof LIMITER_GRID = LIMITER_GRID,
): TwoStageResult {
  // Baseline: production defaults.
  const baseline = evaluateCandidate(PRODUCTION_DEFAULTS, suite)

  // Stage 1: sweep balance knobs, limiter fixed at production defaults.
  const stage1 = expandBalanceGrid(balanceGrid, {
    thresholdDb: PRODUCTION_DEFAULTS.thresholdDb,
    ratio: PRODUCTION_DEFAULTS.ratio,
    attackMs: PRODUCTION_DEFAULTS.attackMs,
    releaseMs: PRODUCTION_DEFAULTS.releaseMs,
    kneeDb: PRODUCTION_DEFAULTS.kneeDb,
  })
    .map((p) => evaluateCandidate(p, suite))
    .sort(rankCandidates)

  const stage1Winner = stage1[0] ?? baseline
  const bestBalance: BalanceSimParams = stage1Winner.params

  // Stage 2: fix balance at Stage-1 winner, sweep limiter knobs.
  const stage2 = expandLimiterGrid(limiterGrid, {
    minBlocks: bestBalance.minBlocks,
    minGainDb: bestBalance.minGainDb,
    attackTc: bestBalance.attackTc,
    releaseTc: bestBalance.releaseTc,
  })
    .map((p) => evaluateCandidate(p, suite))
    .sort(rankCandidates)

  const best = stage2[0] ?? null

  return { stage1, stage2, bestBalance, best, baseline }
}

/**
 * Legacy single-stage optimiser (balance knobs only). Kept for backward
 * compatibility with the correctness tests. Prefer `runTuneTwoStage` for full
 * tuning runs.
 */
export function runTune(
  suite: TuneScenario[] = buildTuneSuite(),
  grid: typeof BALANCE_GRID = BALANCE_GRID,
): TuneCandidate[] {
  const candidates = expandBalanceGrid(grid, {
    thresholdDb: PRODUCTION_DEFAULTS.thresholdDb,
    ratio: PRODUCTION_DEFAULTS.ratio,
    attackMs: PRODUCTION_DEFAULTS.attackMs,
    releaseMs: PRODUCTION_DEFAULTS.releaseMs,
    kneeDb: PRODUCTION_DEFAULTS.kneeDb,
  }).map((p) => evaluateCandidate(p, suite))
  candidates.sort(rankCandidates)
  return candidates
}
