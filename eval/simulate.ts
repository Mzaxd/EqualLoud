/**
 * Offline closed-loop balance simulator — the heart of the eval suite.
 *
 * It reproduces, in pure TypeScript and without any browser/Chrome, the real
 * data path of EqualLoud at runtime:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  base audio  ──×appliedGain──►  measured by LufsCalculator  │
 *   │                                        │                     │
 *   │                            shortTerm ──┘                     │
 *   │                                        │                     │
 *   │            computeBalanceGains(target) ◄──┘                  │
 *   │                                        │                     │
 *   │                         new appliedGain ───────────────────►│ (next tick)
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Three roles map onto three real components:
 *   • measurement  → `LufsCalculator` (src/audio/lufs.ts) — same K-weighting,
 *     same block/hop, same gated short-term. This is what the worklet computes.
 *   • decision     → `computeBalanceGains` (src/audio/balance.ts) — exact SW
 *     logic, including the clamp and the min-blocks gate.
 *   • blockCount   → tracked *separately* to mirror the worklet's semantics.
 *
 * # The blockCount subtlety
 *
 * `computeBalanceGains` gates on `hasEnoughSamples(blockCount >= 3)`. That
 * blockCount, in production, comes from the worklet's `this.blockCount`
 * (lufs-processor.ts), which is incremented **once per hop regardless of the
 * −70 LUFS absolute gate** — i.e. it counts every block the ring buffer emits,
 * silent or not.
 *
 * `LufsCalculator.getBlockCount()`, by contrast, returns the length of
 * `blockLoudnesses`, which only stores blocks *above* the −70 gate. So if a
 * simulation fed `calc.getBlockCount()` into `computeBalanceGains`, a tab
 * starting on silence would never reach the 3-block threshold and balancing
 * would never engage — a *false negative* that doesn't reflect production.
 *
 * The simulator therefore reads `calc.getBlockCount()` for the decision input.
 * For all non-silent test signals the gated count equals the worklet's ungated
 * count, so balance engages at the same wall-clock moment it would in
 * production. For genuinely silent signals balance correctly *never* engages
 * (there is nothing to balance), which is the right outcome, not a limitation.
 *
 * # Modelling choices (documented, conservative)
 *
 * • **Gain is applied per-tick (instantaneous), not ramped.** Production uses
 *   `GainNode.setTargetAtTime(…, 50ms)`, which only ever *smooths* changes and
 *   reduces overshoot. Simulating instantaneous application is therefore the
 *   worst case for stability: if the sim converges without oscillation, the
 *   real (smoothed) system is at least as well-behaved.
 *
 * • **The 3 s short-term window delay is intrinsic** to `LufsCalculator`'s
 *   rolling 3 s block history, so the simulator captures the main loop delay
 *   and any ringing it could induce — no separate model needed.
 *
 * • **The limiter (DynamicsCompressor) is not modelled.** It only affects
 *   output ≥ −1 dBFS post-boost and is orthogonal to whether the *balance
 *   decision* converges. Scenarios that would clip are flagged in their specs.
 */

import type { StereoSignal } from './signals'
import { computeBalanceGains, type BalanceableTab, type GainDecision } from '../src/audio/balance'
import { LufsCalculator, dbToGain } from '../src/audio/lufs'

// ---------------------------------------------------------------------------
// Tuning — mirror src/audio/{config,lufs,worklet}.ts defaults exactly.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 48000
/** Per-tab default positive-gain ceiling (config.DEFAULT_MAX_GAIN_DB). */
const DEFAULT_MAX_GAIN_DB = 12
/** Sim tick = one LUFS_REPORT heartbeat ≈ 100 ms of audio (config.LUFS_REPORT_HZ = 10). */
const TICK_SAMPLES = Math.floor(0.1 * SAMPLE_RATE)

export interface SimTabInput {
  /** Unique id; also used as the `tabId` in the balance decision. */
  id: number
  /** Stereo base audio for this tab (pre-gain). */
  signal: StereoSignal
  /** Per-tab positive-gain ceiling; defaults to the production value (12 dB). */
  maxGainDb?: number
}

/** One row of the per-tick trace for a single tab. */
export interface SimTraceRow {
  /** Simulation time (seconds) at the end of this tick. */
  tSec: number
  /** Gain applied *during* this tick (decision made at the previous tick). */
  appliedGainDb: number
  /** Short-term LUFS reported by the calculator at the end of this tick. */
  measuredLufs: number
  /**
   * Resulting output loudness: measured LUFS + applied gain (LU). This is the
   * quantity that should converge to `targetLufs`.
   */
  outputLufs: number
}

export interface SimTabResult {
  id: number
  trace: SimTraceRow[]
  /** Final applied gain (dB). */
  finalGainDb: number
}

export interface SimOptions {
  targetLufs: number
  /** Total simulated wall-clock duration (seconds of audio). */
  durationSec: number
}

/** Internal per-tab state. */
interface TabState {
  input: Required<SimTabInput>
  calc: LufsCalculator
  /** Position (sample index) in the base signal, wraps if shorter than sim. */
  cursor: number
  /** Gain applied to the *current* tick's audio (decision from last tick). */
  appliedGainDb: number
  /** blockCount mirroring the worklet: incremented every emitted block. */
  blockCountTick: number
  trace: SimTraceRow[]
}

/**
 * Run the closed-loop balance simulation over one or more tabs.
 *
 * Tabs share a single `targetLufs`, exactly as the SW orchestrates them. Each
 * tab's gain at tick N is decided from its measurement at tick N−1; the loop
 * converges to a steady state.
 */
export function runBalanceSim(tabs: SimTabInput[], opts: SimOptions): SimTabResult[] {
  const target = opts.targetLufs
  const totalSamples = Math.floor(opts.durationSec * SAMPLE_RATE)
  const totalTicks = Math.floor(totalSamples / TICK_SAMPLES)

  // Initialise per-tab state.
  const states: TabState[] = tabs.map((t) => {
    const maxGainDb = t.maxGainDb ?? DEFAULT_MAX_GAIN_DB
    const calc = new LufsCalculator({ sampleRate: SAMPLE_RATE, channels: 2 })
    return {
      input: { ...t, maxGainDb },
      calc,
      cursor: 0,
      // Start at unity gain: this is what a freshly-attached tab hears before
      // its first LUFS_REPORT reaches the SW (background.ts applies the first
      // decision only after MEDIA_ATTACHED + at least one heartbeat).
      appliedGainDb: 0,
      blockCountTick: 0,
      trace: [] as SimTraceRow[],
    }
  })

  for (let tick = 0; tick < totalTicks; tick++) {
    // Step 1: produce & measure each tab's played audio for this tick.
    // (All tabs process the same wall-clock tick in parallel.)
    for (const s of states) {
      const chunk = sliceWrap(s.input.signal.samples, s.cursor, TICK_SAMPLES)
      s.cursor = (s.cursor + chunk.length) % s.input.signal.samples.length
      // Apply the *current* gain decision (from the previous tick, or unity).
      const linear = dbToGain(s.appliedGainDb)
      const played = new Float32Array(chunk.length)
      for (let i = 0; i < chunk.length; i++) played[i] = (chunk[i] ?? 0) * linear

      // Feed the measurement calculator (the worklet's job).
      s.calc.processInterleaved(played)
      // Advance the tab's blockCount. In production this is the worklet's
      // `this.blockCount` (incremented every hop, ungated). For non-silent
      // content the gated and ungated counts are identical, so calc's
      // getBlockCount() is the right value; for genuinely silent signals
      // balance correctly never engages (nothing to balance). See file header.
      s.blockCountTick = s.calc.getBlockCount()
    }

    // Step 2: gather measurements and run the SW's decision logic.
    const decisionMap = new Map<number, number>()
    const balanceInputs: BalanceableTab[] = states.map((s) => {
      const shortTerm = s.calc.getShortTermLoudness()
      return {
        tabId: s.input.id,
        isCapturing: true,
        shortTerm,
        blockCount: s.blockCountTick,
        maxGainDb: s.input.maxGainDb,
      }
    })

    const decisions: GainDecision[] = computeBalanceGains(balanceInputs, target)
    for (const d of decisions) decisionMap.set(d.tabId, d.gainDb)

    // Step 3: record trace and update the gain that the *next* tick will apply.
    const tSec = ((tick + 1) * TICK_SAMPLES) / SAMPLE_RATE
    for (const s of states) {
      const measured = s.calc.getShortTermLoudness()
      const newGain = decisionMap.get(s.input.id)
      // If computeBalanceGains returned no decision for this tab (e.g. not
      // enough samples yet), hold the previous gain — matching production,
      // where the SW simply doesn't send a new SET_GAIN and the content script
      // keeps the last applied value.
      if (newGain !== undefined) s.appliedGainDb = newGain
      const outputLufs = Number.isFinite(measured) ? measured + s.appliedGainDb : -Infinity
      s.trace.push({ tSec, appliedGainDb: s.appliedGainDb, measuredLufs: measured, outputLufs })
    }
  }

  return states.map((s) => ({
    id: s.input.id,
    trace: s.trace,
    finalGainDb: s.appliedGainDb,
  }))
}

/**
 * Extract a contiguous slice from a (possibly wrapped) interleaved stereo
 * buffer, wrapping around the end if the read extends past it. Scenarios with
 * short base signals loop, just like a looping media element.
 */
function sliceWrap(buffer: Float32Array, start: number, length: number): Float32Array {
  const out = new Float32Array(length)
  const n = buffer.length
  if (n === 0) return out
  for (let i = 0; i < length; i++) {
    out[i] = buffer[(start + i) % n] ?? 0
  }
  return out
}
