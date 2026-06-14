/**
 * Human-readable reporting for balance-eval scenarios.
 *
 * Each scenario prints one row of a metric table plus, optionally, a compact
 * ASCII trace of output LUFS over time so a reviewer can *see* convergence,
 * overshoot, and ringing at a glance — not just trust pass/fail.
 *
 * Output goes to console (stdout via vitest's console). It is deliberately
 * formatted to be readable in a terminal even when interleaved with other
 * tests.
 */

import type { QualityMetrics } from './metrics'
import type { SimTraceRow } from './simulate'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

export interface ScenarioReport {
  scenario: string
  targetLufs: number
  /** Per-tab metrics + trace, keyed by tab id. */
  tabs: Array<{
    id: number
    label?: string
    metrics: QualityMetrics
    trace: SimTraceRow[]
  }>
}

/** Thresholds used both for colouring the table and for default assertions. */
export const DEFAULT_THRESHOLDS = {
  maxConvergeSec: 8,
  maxSteadyError: 0.5,
  maxOvershoot: 1.5,
  maxRipple: 0.5,
} as const

/** Format a dB/LU value to a fixed width, handling ±Infinity. */
function fmt(v: number | null, digits = 2): string {
  if (v === null) return '  —  '
  if (!Number.isFinite(v)) return ' -∞  '
  const s = v.toFixed(digits)
  // Pad to width 6 for alignment.
  return s.padStart(6)
}

/**
 * Print the metric table header. Call once before a group of scenarios.
 */
export function printHeader(): void {
  const line = [
    'scenario'.padEnd(20),
    'tab'.padStart(3),
    'start'.padStart(7),
    'target'.padStart(7),
    'Tconv'.padStart(7),
    'SSerr'.padStart(7),
    'over'.padStart(7),
    'rippl'.padStart(7),
    '  result',
  ].join(' ')
  console.log(`\n${BOLD}${line}${RESET}`)
  console.log(DIM + '─'.repeat(line.length + 8) + RESET)
}

/**
 * Print one table row per tab in the scenario, colouring result by whether
 * the metrics meet the default thresholds.
 */
export function printScenarioRow(report: ScenarioReport): void {
  const t = DEFAULT_THRESHOLDS
  for (const tab of report.tabs) {
    const m = tab.metrics
    const ok =
      m.converged &&
      (m.convergeTimeSec ?? Infinity) <= t.maxConvergeSec &&
      m.steadyError <= t.maxSteadyError &&
      m.overshoot <= t.maxOvershoot &&
      m.ripple <= t.maxRipple
    const result = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`
    const name = tab.label ?? `tab${tab.id}`
    const cols = [
      report.scenario.padEnd(20).slice(0, 20),
      String(tab.id).padStart(3),
      fmt(m.startLufs),
      fmt(report.targetLufs),
      m.convergeTimeSec !== null ? fmt(m.convergeTimeSec, 1) + 's' : '  —  ',
      fmt(m.steadyError),
      fmt(m.overshoot),
      fmt(m.ripple),
      '  ' + result,
    ]
    console.log(`${cols.slice(0, 8).join(' ')}${cols[8]}  ${DIM}${name}${RESET}`)
  }
}

/**
 * Render an ASCII sparkline of output LUFS over time for a tab, with the
 * target line marked. Useful for eyeballing overshoot/ringing in failing
 * scenarios. Height ~ 7 rows; width = trace length (one char per tick).
 *
 * Example:
 *    +3 ┤          ╭─╮
 *    +1 ┤     ╭───╯ ╰──      ░ = target band
 *   -14 ┼──░░░░░░░░░░░░░░░░░░░░░░  (target)
 *    -5 ┤
 */
export function printTrace(report: ScenarioReport): void {
  for (const tab of report.tabs) {
    const trace = tab.trace.filter((r) => Number.isFinite(r.outputLufs))
    if (trace.length === 0) continue
    const name = tab.label ?? `tab${tab.id}`
    const target = report.targetLufs
    const outs = trace.map((r) => r.outputLufs)

    // Y range: cover target ± max deviation seen, with some padding.
    let lo = Math.min(target, Math.min(...outs)) - 1
    let hi = Math.max(target, Math.max(...outs)) + 1
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    if (hi - lo < 4) {
      // Zoom out a bit so tiny wiggles don't look dramatic.
      const c = (hi + lo) / 2
      lo = c - 2
      hi = c + 2
    }

    const rows = 9
    const step = (hi - lo) / (rows - 1)
    const colFor = (v: number) => Math.round(((rows - 1) * (v - lo)) / (hi - lo))

    console.log(`\n  ${BOLD}${report.scenario} / ${name}${RESET}  (target ${target} LUFS)`)
    const targetCol = colFor(target)
    // Build grid.
    const grid: string[][] = Array.from({ length: rows }, () => new Array(trace.length).fill(' '))
    for (let x = 0; x < trace.length; x++) {
      const y = colFor(outs[x]!)
      grid[y]![x] = '●'
    }
    for (let y = 0; y < rows; y++) {
      const val = hi - y * step
      const label = val.toFixed(0).padStart(3)
      const isTarget = y === targetCol
      const prefix = isTarget ? `${label} ┼` : `${label} ┤`
      // Draw target band as ░ on the target row.
      const line = grid[y]!.map((c) => {
        if (isTarget) return c === ' ' ? '░' : c
        return c
      })
      console.log(`  ${DIM}${prefix}${RESET} ${line.join('')}`)
    }
    // X axis: tick marks every ~1 s.
    const tickSec = trace.length > 1 ? trace[1]!.tSec - trace[0]!.tSec : 0.1
    const secPerMark = Math.max(1, Math.round(2 / tickSec))
    const axis = trace.map((_, x) => (x % secPerMark === 0 ? '│' : ' ')).join('')
    console.log(`        ${DIM}${axis}${RESET}`)
    const marks = trace
      .map((r, x) => {
        if (x % secPerMark !== 0) return '   '
        return String(Math.round(r.tSec)).padStart(2) + 's'
      })
      .join('')
    console.log(`        ${DIM}${marks}${RESET}`)
  }
}

/** Convenience: report + trace for a single-scenario result. */
export function printFullReport(report: ScenarioReport, showTrace = true): void {
  printScenarioRow(report)
  if (showTrace) printTrace(report)
}
