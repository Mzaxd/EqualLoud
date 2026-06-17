/**
 * Offline tuner driver + correctness checks.
 *
 * Two roles in one file:
 *
 *   1. As a spec (`pnpm test:eval`): verifies the tuner runs, ranks correctly,
 *      and the two-stage search produces sensible results. Fast, no verbose
 *      output.
 *
 *   2. As a CLI (`pnpm tune`): sets `TUNE_REPORT=1`, which triggers the full
 *      two-stage parameter sweep + a human-readable report comparing the best
 *      candidates against the production defaults. This is the "self-evolution"
 *      command.
 *
 * Co-locating them keeps the driver next to its contract. The report is gated
 * behind an env var so the normal eval run stays quiet.
 */

import { describe, it, expect } from 'vitest'

import {
  runTune,
  runTuneTwoStage,
  evaluateCandidate,
  buildTuneSuite,
  expandBalanceGrid,
  expandLimiterGrid,
  BALANCE_GRID,
  LIMITER_GRID,
  PRODUCTION_DEFAULTS,
  type TuneCandidate,
} from './tune'

describe('tuner — correctness', () => {
  it('expandBalanceGrid produces the expected number of candidates', () => {
    const n =
      BALANCE_GRID.minBlocks.length *
      BALANCE_GRID.minGainDb.length *
      BALANCE_GRID.attackTc.length *
      BALANCE_GRID.releaseTc.length
    expect(
      expandBalanceGrid(BALANCE_GRID, {
        thresholdDb: -1,
        ratio: 20,
        attackMs: 1,
        releaseMs: 100,
        kneeDb: 0,
      }),
    ).toHaveLength(n)
  })

  it('expandLimiterGrid produces the expected number of candidates', () => {
    const n =
      LIMITER_GRID.thresholdDb.length *
      LIMITER_GRID.ratio.length *
      LIMITER_GRID.attackMs.length *
      LIMITER_GRID.releaseMs.length
    expect(
      expandLimiterGrid(LIMITER_GRID, {
        minBlocks: 1,
        minGainDb: -60,
        attackTc: 0.02,
        releaseTc: 0.05,
      }),
    ).toHaveLength(n)
  })

  it('every candidate is scored with a finite, non-negative cost', () => {
    const suite = buildTuneSuite()
    const candidates = runTune(suite, {
      minBlocks: [3],
      minGainDb: [-60],
      attackTc: [0.02],
      releaseTc: [0.05, 0.1],
    })
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(Number.isFinite(c.totalCost)).toBe(true)
      expect(c.totalCost).toBeGreaterThanOrEqual(0)
    }
  })

  it('zipper penalty is applied — faster time constants cost more', () => {
    const suite = buildTuneSuite()
    const fast = evaluateCandidate(
      { ...PRODUCTION_DEFAULTS, attackTc: 0.005, releaseTc: 0.005 },
      suite,
    )
    const normal = evaluateCandidate(PRODUCTION_DEFAULTS, suite)
    expect(fast.gainRatePenalty).toBeGreaterThan(normal.gainRatePenalty)
    expect(fast.gainRatePenalty).toBeGreaterThan(0)
    expect(normal.gainRatePenalty).toBeGreaterThan(0)
  })

  it('results are sorted best-first (lowest cost at index 0)', () => {
    const candidates = runTune(buildTuneSuite(), {
      minBlocks: [2, 3],
      minGainDb: [-60],
      attackTc: [0.02],
      releaseTc: [0.05, 0.1],
    })
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1]!
      const cur = candidates[i]!
      if (prev.allConverged === cur.allConverged) {
        expect(prev.totalCost).toBeLessThanOrEqual(cur.totalCost)
      } else {
        expect(prev.allConverged).toBe(true)
      }
    }
  })

  it('two-stage search produces both stages and a best candidate', () => {
    const result = runTuneTwoStage(
      buildTuneSuite(),
      { minBlocks: [2, 3], minGainDb: [-60], attackTc: [0.02], releaseTc: [0.05] },
      { thresholdDb: [-1], ratio: [20], attackMs: [1], releaseMs: [100] },
    )
    expect(result.stage1.length).toBeGreaterThan(0)
    expect(result.stage2.length).toBeGreaterThan(0)
    expect(result.baseline.params).toEqual(PRODUCTION_DEFAULTS)
    expect(result.best).not.toBeNull()
    expect(result.bestBalance).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// CLI report — only emitted when invoked via `pnpm tune` (TUNE_REPORT=1).
// ---------------------------------------------------------------------------

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '  ∞ '
}

function scenarioHeaders(result: TwoStageResultLike): string[] {
  return result.baseline.perScenario.map((p) => p.scenario)
}

interface TwoStageResultLike {
  stage1: TuneCandidate[]
  stage2: TuneCandidate[]
  bestBalance: TuneCandidate['params']
  best: TuneCandidate | null
  baseline: TuneCandidate
}

function printCandidateRow(
  rank: number | string,
  c: TuneCandidate,
  baselineCost: number,
  scenarioNames: string[],
): void {
  const delta = c.totalCost - baselineCost
  const deltaStr = delta <= -0.01 ? `${fmt(delta)}` : delta >= 0.01 ? `+${fmt(delta)}` : '  0  '
  const perScn = c.perScenario.map((p) => fmt(p.cost, 1).padStart(5)).join('  ')
  console.log(
    `    ${String(rank).padStart(4)}  ${fmt(c.totalCost).padStart(6)}  ${deltaStr.padStart(6)}  ` +
      `${String(c.params.minBlocks).padStart(5)}  ${fmt(c.params.attackTc, 3).padStart(6)}  ` +
      `${fmt(c.params.releaseTc, 3).padStart(7)}  ` +
      `${fmt(c.params.thresholdDb, 1).padStart(5)}  ${String(c.params.ratio).padStart(3)}  ` +
      `${fmt(c.params.attackMs, 1).padStart(5)}  ${fmt(c.params.releaseMs, 0).padStart(5)}  ` +
      `| ${perScn}  ${c.allConverged ? '' : '⚠'}`,
  )
}

function printReport(result: TwoStageResultLike): void {
  const names = scenarioHeaders(result)
  const baseline = result.baseline
  const sc = names.map((n) => n.slice(0, 5).padEnd(5)).join('  ')

  console.log('\n' + '═'.repeat(120))
  console.log('  EQUALLOUD OFFLINE TUNER — two-stage parameter sweep')
  console.log('═'.repeat(120))
  console.log(`  scenarios in suite: ${names.length}`)
  console.log(`  stage 1 candidates: ${result.stage1.length}  (balance knobs)`)
  console.log(`  stage 2 candidates: ${result.stage2.length}  (limiter knobs)`)
  console.log()

  // --- baseline ---
  console.log('  ▼ PRODUCTION DEFAULTS (current config.ts)')
  console.log(
    `    minBlk=${baseline.params.minBlocks}  attack=${fmt(baseline.params.attackTc, 3)}s  ` +
      `release=${fmt(baseline.params.releaseTc, 3)}s  ` +
      `thr=${baseline.params.thresholdDb}  ratio=${baseline.params.ratio}  ` +
      `lAtk=${baseline.params.attackMs}ms  lRel=${baseline.params.releaseMs}ms`,
  )
  console.log(
    `    cost = ${fmt(baseline.totalCost)}  ` +
      `(zipper ${fmt(baseline.gainRatePenalty, 3)})  ` +
      `(${baseline.allConverged ? 'all converged' : '⚠ SOME FAILED'})`,
  )
  console.log()

  // --- stage 1 ---
  console.log('  ▼ STAGE 1 — balance-loop sweep (top 5)')
  console.log('         cost     Δ     blk   attack  release | scenarios')
  for (let i = 0; i < Math.min(5, result.stage1.length); i++) {
    const c = result.stage1[i]!
    const delta = c.totalCost - baseline.totalCost
    const deltaStr = delta <= -0.01 ? `${fmt(delta)}` : delta >= 0.01 ? `+${fmt(delta)}` : '  0  '
    const perScn = c.perScenario.map((p) => fmt(p.cost, 1).padStart(5)).join('  ')
    console.log(
      `    #${String(i + 1).padStart(2)}  ${fmt(c.totalCost).padStart(6)}  ${deltaStr.padStart(6)}  ` +
        `${String(c.params.minBlocks).padStart(5)}  ${fmt(c.params.attackTc, 3).padStart(6)}  ` +
        `${fmt(c.params.releaseTc, 3).padStart(7)}  | ${perScn}  ${c.allConverged ? '' : '⚠'}`,
    )
  }
  console.log()

  // --- stage 2 ---
  console.log('  ▼ STAGE 2 — limiter sweep (top 5), balance fixed at Stage-1 winner')
  console.log('         cost     Δ     thr  ratio  lAtk   lRel | scenarios')
  for (let i = 0; i < Math.min(5, result.stage2.length); i++) {
    const c = result.stage2[i]!
    const delta = c.totalCost - baseline.totalCost
    const deltaStr = delta <= -0.01 ? `${fmt(delta)}` : delta >= 0.01 ? `+${fmt(delta)}` : '  0  '
    const perScn = c.perScenario.map((p) => fmt(p.cost, 1).padStart(5)).join('  ')
    console.log(
      `    #${String(i + 1).padStart(2)}  ${fmt(c.totalCost).padStart(6)}  ${deltaStr.padStart(6)}  ` +
        `${fmt(c.params.thresholdDb, 1).padStart(5)}  ${String(c.params.ratio).padStart(5)}  ` +
        `${fmt(c.params.attackMs, 1).padStart(5)}  ${fmt(c.params.releaseMs, 0).padStart(5)}  | ${perScn}  ` +
        `${c.allConverged ? '' : '⚠'}`,
    )
  }
  console.log()

  // --- full best candidate ---
  if (result.best && result.best.allConverged) {
    const best = result.best
    const improved = best.totalCost < baseline.totalCost - 0.5
    console.log('  ▼ BEST OVERALL CANDIDATE')
    console.log(
      `    minBlk=${best.params.minBlocks}  attack=${fmt(best.params.attackTc, 3)}s  ` +
        `release=${fmt(best.params.releaseTc, 3)}s`,
    )
    console.log(
      `    thr=${best.params.thresholdDb}  ratio=${best.params.ratio}  ` +
        `lAtk=${best.params.attackMs}ms  lRel=${best.params.releaseMs}ms  knee=${best.params.kneeDb}`,
    )
    console.log(
      `    cost = ${fmt(best.totalCost)}  (zipper ${fmt(best.gainRatePenalty, 3)})  ` +
        `Δ vs baseline = ${fmt(best.totalCost - baseline.totalCost)}`,
    )
    console.log()
    if (improved) {
      const pct = ((baseline.totalCost - best.totalCost) / baseline.totalCost) * 100
      console.log(`  ✦ RECOMMENDATION: adopt best candidate (${fmt(pct, 1)}% cost improvement).`)
      console.log(
        '    Review the parameter changes above, then apply to config.ts after A/B listening test.',
      )
    } else {
      console.log('  ✓ Production defaults are within 0.5 of optimal — no change recommended.')
    }
  } else if (result.best) {
    console.log('  ✗ Best candidate did not converge on all scenarios — review before adopting.')
  }
  console.log('═'.repeat(120) + '\n')
}

// Run the full report only when explicitly requested via env var.
if (process.env.TUNE_REPORT) {
  const result = runTuneTwoStage()
  printReport(result as TwoStageResultLike)
}
