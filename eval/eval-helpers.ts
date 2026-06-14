/**
 * Shared helpers for the balance-eval spec files.
 *
 * Each scenario follows the same shape: build signal(s), run the closed-loop
 * simulator, compute metrics per tab, print a readable report row + trace, and
 * (back in the spec) assert against thresholds. Centralising the run+report
 * plumbing keeps the specs focused on *what* is being asserted, not *how* the
 * sim is wired. Assertions stay in the specs so this file has no test-runner
 * dependency.
 */

import { computeMetrics, type MetricsOptions, type QualityMetrics } from './metrics'
import { printHeader, printScenarioRow, printTrace, DEFAULT_THRESHOLDS } from './reporter'
import { runBalanceSim, type SimTabInput, type SimTabResult } from './simulate'

export { DEFAULT_THRESHOLDS }

export interface TabSpec {
  id: number
  label: string
  signal: import('./signals').StereoSignal
  maxGainDb?: number
}

export interface RunOptions {
  scenario: string
  targetLufs: number
  durationSec: number
  /** Show ASCII trace in addition to the metric row. Default true. */
  showTrace?: boolean
}

export interface TabResult {
  id: number
  label: string
  metrics: QualityMetrics
  trace: SimTabResult['trace']
}

/**
 * Run a scenario end-to-end and print its report. Returns per-tab metrics so
 * specs can assert on individual fields. Metrics are computed with the default
 * thresholds (band ±1 LU, 5 s steady window), overridable via `metricOpts`.
 */
export function runScenario(
  tabs: TabSpec[],
  opts: RunOptions,
  metricOpts?: Partial<MetricsOptions>,
): TabResult[] {
  const inputs: SimTabInput[] = tabs.map((t) => ({
    id: t.id,
    signal: t.signal,
    ...(t.maxGainDb !== undefined ? { maxGainDb: t.maxGainDb } : {}),
  }))
  const results = runBalanceSim(inputs, {
    targetLufs: opts.targetLufs,
    durationSec: opts.durationSec,
  })
  const tabResults: TabResult[] = results.map((r) => {
    const spec = tabs.find((t) => t.id === r.id)!
    const metrics = computeMetrics(r.trace, {
      targetLufs: opts.targetLufs,
      ...metricOpts,
    })
    return { id: r.id, label: spec.label, metrics, trace: r.trace }
  })

  printHeader()
  printScenarioRow({
    scenario: opts.scenario,
    targetLufs: opts.targetLufs,
    tabs: tabResults.map((t) => ({ id: t.id, label: t.label, metrics: t.metrics, trace: t.trace })),
  })
  if (opts.showTrace !== false) {
    printTrace({
      scenario: opts.scenario,
      targetLufs: opts.targetLufs,
      tabs: tabResults.map((t) => ({
        id: t.id,
        label: t.label,
        metrics: t.metrics,
        trace: t.trace,
      })),
    })
  }
  return tabResults
}

/**
 * Convenience for the common single-tab case: run a one-tab scenario and
 * return that tab's result directly (non-undefined), so specs can write
 *   `const tab = runSingleScenario([...], {...})`
 * without an array-destructure that TS would narrow to `| undefined`.
 * Throws if the scenario produced no tab (programming error).
 */
export function runSingleScenario(
  tab: TabSpec,
  opts: RunOptions,
  metricOpts?: Partial<MetricsOptions>,
): TabResult {
  const results = runScenario([tab], opts, metricOpts)
  const first = results[0]
  if (!first) throw new Error(`runSingleScenario: scenario "${opts.scenario}" produced no tab`)
  return first
}
