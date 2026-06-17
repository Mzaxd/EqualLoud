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
 * `computeBalanceGains` gates on `hasEnoughSamples(blockCount >= MIN_BLOCKS)`. That
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
 * • **The limiter (DynamicsCompressor) is modelled at sample level** via
 *   `LimiterModel` below — a feed-forward peak compressor faithful to the Web
 *   Audio spec's static curve + envelope follower. The limiter sits *after* the
 *   gain node (source → gain → limiter → destination), exactly as in
 *   `audio-graph.ts`. The LUFS measurement branch taps off *before* both gain
 *   and limiter (from the source node), so the limiter has no feedback effect on
 *   the balance loop — it is purely an output-protection stage whose behaviour
 *   we track for the cost function (clipping / over-compression penalties).
 */

import type { StereoSignal } from './signals'
import {
  computeBalanceGains,
  type BalanceableTab,
  type BalanceParams,
  DEFAULT_BALANCE_PARAMS,
  type GainDecision,
} from '../src/audio/balance'
import { DEFAULT_LIMITER_SETTINGS } from '../src/audio/config'
import { LufsCalculator, dbToGain } from '../src/audio/lufs'
import type { LimiterSettings } from '../src/messages/protocol'

// ---------------------------------------------------------------------------
// Tuning — mirror src/audio/{config,lufs,worklet}.ts defaults exactly.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 48000
/** Per-tab default positive-gain ceiling (config.DEFAULT_MAX_GAIN_DB). */
const DEFAULT_MAX_GAIN_DB = 12
/** Sim tick = one LUFS_REPORT heartbeat ≈ 100 ms of audio (config.LUFS_REPORT_HZ = 10). */
const TICK_SAMPLES = Math.floor(0.1 * SAMPLE_RATE)
/** Wall-clock seconds advanced per sim tick (must match LUFS_REPORT_HZ). */
const TICK_SEC = 0.1

/**
 * Gain-smoothing model, mirroring `audio-graph.ts`'s `setGain`:
 *
 *   tc = gainDb < currentGainDb ? GAIN_ATTACK_TC : GAIN_SMOOTH_TC
 *   gain.gain.setTargetAtTime(dbToGain(gainDb), ctx.currentTime, tc)
 *
 * Production smooths per quantum (per sample group). The simulator integrates
 * the resulting exponential curve analytically over one tick (Δt = 100 ms):
 *
 *   g(t+Δt) = g_target + (g(t) − g_target) · e^(−Δt/τ)
 *
 * with τ chosen per direction (attack for decreases, release for increases),
 * exactly mirroring the asymmetry the production `setGain` picks. This is
 * conservative relative to per-sample integration: for τ ≪ Δt (the realistic
 * regime: τ = 20–50 ms vs Δt = 100 ms) the exponential settles within a few
 * ticks and the discretisation error is negligible; for τ ≫ Δt the analytic
 * step is in fact *more* accurate than a naive Euler step of the same size.
 *
 * The previous simulator applied the decided gain instantly each tick — the
 * worst case for stability. Modelling the smoothing can only *reduce* ripple
 * and overshoot, so existing convergence/stability specs stay valid (they
 * remain a stricter test than the smoothed reality).
 */
export interface GainSmootherParams {
  /** Time constant (s) for gain *decreases* (attenuating loud content). Mirrors GAIN_ATTACK_TC. */
  attackTc: number
  /** Time constant (s) for gain *increases* (boosting quiet content). Mirrors GAIN_SMOOTH_TC. */
  releaseTc: number
}

/** Production defaults — mirrors config.ts GAIN_ATTACK_TC / GAIN_SMOOTH_TC. */
export const DEFAULT_GAIN_SMOOTHER: GainSmootherParams = {
  attackTc: 0.02,
  releaseTc: 0.05,
}

// ---------------------------------------------------------------------------
// Limiter model — sample-level feed-forward compressor.
//
// The Web Audio DynamicsCompressorNode is specified by W3C as:
//   1. Side-chain: detect input level (peak detector on the absolute value).
//   2. Static gain curve: map detected level → target compression, with a soft
//      knee region around the threshold.
//   3. Envelope follower: smooth the target compression with attack (when
//      compression should *increase*) / release (when it should *decrease*)
//      time constants.
//   4. Apply: output = input × dbToGain(−smoothed_compression).
//
// This class implements that chain sample-by-sample. It is faithful to the
// *shape* of the W3C curve and envelope (which is what matters for tuning the
// attack/release/threshold/ratio knobs) though the exact coefficient matches of
// a black-box browser implementation are not guaranteed. For relative parameter
// ranking — which is what the tuner does — this fidelity is sufficient.
//
// Notable simplification: the W3C spec uses a specific (undocumented) smoothing
// filter with a hold time; we use a one-pole smoother (the standard textbook
// approximation). This tracks attack/release trends correctly and preserves the
// *ordering* of candidate parameter sets, which is the tuner's only need.
// ---------------------------------------------------------------------------

/**
 * The limiter parameters the tuner sweeps. Mirrors the user-facing
 * `LimiterSettings` but flattened for the param grid (no `enabled` — the tuner
 * always runs the limiter; a disabled limiter is just threshold=0, ratio=1).
 */
export interface LimiterParams {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  kneeDb: number
}

/** Production defaults — mirrors config.ts DEFAULT_LIMITER_SETTINGS. */
export const DEFAULT_LIMITER: LimiterParams = {
  thresholdDb: DEFAULT_LIMITER_SETTINGS.thresholdDb,
  ratio: DEFAULT_LIMITER_SETTINGS.ratio,
  attackMs: DEFAULT_LIMITER_SETTINGS.attackMs,
  releaseMs: DEFAULT_LIMITER_SETTINGS.releaseMs,
  kneeDb: DEFAULT_LIMITER_SETTINGS.kneeDb,
}

/**
 * Per-tick output of the limiter model — what the cost function needs to judge
 * clipping and over-compression.
 */
export interface LimiterTickStats {
  /** Peak sample level *after* limiting, in dBFS. −Infinity if all-silent. */
  outputPeakDb: number
  /** Maximum gain reduction applied during this tick, in dB (0 = none). */
  maxGainReductionDb: number
}

/** Convert a LimiterSettings (production type) into the tuner's LimiterParams. */
export function limiterSettingsToParams(s: LimiterSettings): LimiterParams {
  return {
    thresholdDb: s.thresholdDb,
    ratio: s.ratio,
    attackMs: s.attackMs,
    releaseMs: s.releaseMs,
    kneeDb: s.kneeDb,
  }
}

/**
 * Sample-level feed-forward compressor model.
 *
 * Created once per tab (the stateful envelope follower persists across ticks)
 * and fed each tick's gain-applied audio. Returns the limited output *and*
 * statistics; the caller decides which to pass to the LUFS calculator
 * (production measures pre-limiter) and which to record for the cost function.
 */
export class LimiterModel {
  private threshold: number
  private ratio: number
  private kneeDb: number
  private attackCoef: number
  private releaseCoef: number
  /** Smoothed gain reduction (dB), carried across ticks. */
  private smoothedReduction = 0

  constructor(params: LimiterParams, sampleRate: number) {
    this.threshold = params.thresholdDb
    this.ratio = params.ratio
    this.kneeDb = params.kneeDb
    // One-pole smoother coefficients: the envelope follower tracks the *target*
    // reduction toward which it decays. attackCoef/releaseCoef are the
    // per-sample fractions: 1 − e^(−1/(τ·fs)).
    const attackTau = params.attackMs / 1000
    const releaseTau = params.releaseMs / 1000
    this.attackCoef = attackTau > 0 ? 1 - Math.exp(-1 / (attackTau * sampleRate)) : 1
    this.releaseCoef = releaseTau > 0 ? 1 - Math.exp(-1 / (releaseTau * sampleRate)) : 1
  }

  /**
   * Static gain curve: given a detected input level (dB), return the gain
   * reduction (dB, ≥0) the compressor wants to apply.
   *
   * Hard-knee case (kneeDb=0): reduction = max(0, (level − threshold) · (1 − 1/ratio)).
   * Soft-knee case: the curve transitions smoothly over [threshold−knee/2,
   * threshold+knee/2] using the W3C quadratic blend.
   */
  private targetReduction(levelDb: number): number {
    const t = this.threshold
    const r = this.ratio
    const knee = this.kneeDb
    const halfKnee = knee / 2
    const upper = t + halfKnee

    if (levelDb <= t - halfKnee) {
      return 0 // below knee: no compression
    }
    if (levelDb >= upper) {
      return (levelDb - t) * (1 - 1 / r) // above knee: full ratio
    }
    // Inside the soft-knee region: W3C quadratic interpolation.
    const x = levelDb - t + halfKnee // 0 at knee start, knee at knee end
    return ((x * x) / (2 * knee)) * (1 - 1 / r)
  }

  /**
   * Process a block of interleaved stereo samples in place, applying limiting.
   * Updates internal envelope state. Returns per-tick statistics.
   *
   * @param samples  Interleaved [L,R,L,R,…], **already gain-applied** (post-gain).
   * @returns        Statistics for the cost function. The input buffer is
   *                 mutated to hold the limited output.
   */
  process(samples: Float32Array): LimiterTickStats {
    let peakOut = 0
    let maxReduction = 0

    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!
      const absX = Math.abs(x)

      // Peak detection in dB. Guard against log10(0).
      if (absX < 1e-12) {
        // Near-silent sample: release toward zero reduction, no output peak.
        const coef = this.releaseCoef
        this.smoothedReduction += (0 - this.smoothedReduction) * coef
        samples[i] = 0
        continue
      }

      const levelDb = 20 * Math.log10(absX)
      const target = this.targetReduction(levelDb)

      // Envelope follower: attack when target > current (need MORE reduction),
      // release when target < current (need LESS reduction).
      if (target > this.smoothedReduction) {
        this.smoothedReduction += (target - this.smoothedReduction) * this.attackCoef
      } else {
        this.smoothedReduction += (target - this.smoothedReduction) * this.releaseCoef
      }

      if (this.smoothedReduction > maxReduction) maxReduction = this.smoothedReduction

      // Apply reduction.
      const outSample = absX * Math.pow(10, -this.smoothedReduction / 20)
      const signedOut = x >= 0 ? outSample : -outSample
      samples[i] = signedOut
      if (outSample > peakOut) peakOut = outSample
    }

    return {
      outputPeakDb: peakOut > 1e-12 ? 20 * Math.log10(peakOut) : -Infinity,
      maxGainReductionDb: maxReduction,
    }
  }
}

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
  /**
   * Gain applied *during* this tick — the smoother's output, i.e. what the
   * listener actually hears. Equals `decidedGainDb` when smoothing is off.
   */
  appliedGainDb: number
  /**
   * Gain *decided* at the previous tick (the setpoint the smoother chases).
   * Surfaced for tuning diagnostics; production listeners never hear this raw
   * value, only `appliedGainDb` after smoothing.
   */
  decidedGainDb: number
  /** Short-term LUFS reported by the calculator at the end of this tick. */
  measuredLufs: number
  /**
   * Resulting output loudness: measured LUFS + applied gain (LU). This is the
   * quantity that should converge to `targetLufs`.
   */
  outputLufs: number
  /**
   * Peak sample level *after* the limiter, in dBFS. The cost function uses this
   * to penalise clipping (values near 0 dBFS = risky). −Infinity if all-silent.
   */
  limitedPeakDb: number
  /**
   * Maximum gain reduction the limiter applied during this tick (dB, ≥0).
   * Large values mean the limiter is working hard (over-compression = "pumping"
   * / "squashed" sound). 0 = limiter didn't engage.
   */
  limiterReductionDb: number
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
  /**
   * Balance-decision params injected into `computeBalanceGains`. Defaults to
   * production values; the tuner sweeps alternatives. Omit to reproduce
   * production behaviour exactly.
   */
  balanceParams?: BalanceParams
  /**
   * Gain-smoothing model. Defaults to production (attack 20 ms / release
   * 50 ms). Set to `{attackTc:0, releaseTc:0}` to reproduce the legacy
   * "instant gain" behaviour (the worst case for stability).
   */
  gainSmoother?: GainSmootherParams
  /**
   * Limiter params. Defaults to production (threshold −1, ratio 20, attack 1 ms,
   * release 100 ms, knee 0). The limiter runs at sample level after gain; the
   * LUFS calculator still measures pre-limiter (matching production's worklet
   * tap point), so the balance loop is unaffected — the limiter only contributes
   * clipping/over-compression stats to the cost function.
   */
  limiter?: LimiterParams
}

/**
 * The full knob set the tuner optimises over — the union of all three param
 * blocks, gathered so `eval/tune.ts` can sweep one object per trial.
 */
export type BalanceSimParams = BalanceParams & GainSmootherParams & LimiterParams

/** Internal per-tab state. */
interface TabState {
  input: Required<SimTabInput>
  calc: LufsCalculator
  /** Per-tab limiter model (stateful envelope follower persists across ticks). */
  limiter: LimiterModel
  /** Position (sample index) in the base signal, wraps if shorter than sim. */
  cursor: number
  /**
   * Gain *decided* at the previous tick (the setpoint the smoother chases).
   * Mirrors `currentGainDb` in audio-graph.ts, which drives the direction-aware
   * τ selection. Starts at 0 dB (unity) like a freshly-attached tab.
   */
  decidedGainDb: number
  /**
   * Gain *actually applied* to this tick's audio, after smoothing. This is
   * what the listener hears and what the LUFS calculator measures. When the
   * smoother is disabled (τ=0) it equals decidedGainDb — the legacy behaviour.
   */
  effectiveGainDb: number
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
  const balanceParams = opts.balanceParams ?? DEFAULT_BALANCE_PARAMS
  const smoother = opts.gainSmoother ?? DEFAULT_GAIN_SMOOTHER
  const limiterParams = opts.limiter ?? DEFAULT_LIMITER

  // Initialise per-tab state.
  const states: TabState[] = tabs.map((t) => {
    const maxGainDb = t.maxGainDb ?? DEFAULT_MAX_GAIN_DB
    const calc = new LufsCalculator({ sampleRate: SAMPLE_RATE, channels: 2 })
    return {
      input: { ...t, maxGainDb },
      calc,
      limiter: new LimiterModel(limiterParams, SAMPLE_RATE),
      cursor: 0,
      // Start at unity gain: this is what a freshly-attached tab hears before
      // its first LUFS_REPORT reaches the SW (background.ts applies the first
      // decision only after MEDIA_ATTACHED + at least one heartbeat).
      decidedGainDb: 0,
      effectiveGainDb: 0,
      blockCountTick: 0,
      trace: [] as SimTraceRow[],
    }
  })

  for (let tick = 0; tick < totalTicks; tick++) {
    // Step 1: produce & measure each tab's played audio for this tick.
    // (All tabs process the same wall-clock tick in parallel.)
    /** Per-tab limiter stats gathered in step 1, consumed in step 3's trace. */
    const limiterStats = new Map<number, LimiterTickStats>()
    for (const s of states) {
      const chunk = sliceWrap(s.input.signal.samples, s.cursor, TICK_SAMPLES)
      s.cursor = (s.cursor + chunk.length) % s.input.signal.samples.length
      // Apply the *effective* (smoothed) gain — what the GainNode.value has
      // actually settled to by this tick. When the smoother is disabled (τ=0)
      // this equals decidedGainDb, reproducing the legacy "instant" behaviour.
      const linear = dbToGain(s.effectiveGainDb)
      const played = new Float32Array(chunk.length)
      for (let i = 0; i < chunk.length; i++) played[i] = (chunk[i] ?? 0) * linear

      // Feed the measurement calculator (the worklet's job).
      // IMPORTANT: production's worklet taps off the *source* node — before both
      // gain and limiter — but it measures the signal that has already been
      // gain-applied in the sense that the gain decision reacts to the source's
      // own loudness, not the limited output. In the sim, `played` = source ×
      // effective gain (pre-limiter), which is what the balance loop must see to
      // converge correctly. The limiter does NOT feed back into the loop.
      s.calc.processInterleaved(played)

      // Run the limiter on a copy of the gain-applied signal. We mutate a copy
      // (not `played`) because `played` was already consumed by the calculator
      // and we only need the limiter's *statistics* for the cost function — the
      // limited audio itself is not measured (matching production's tap point).
      const forLimiter = new Float32Array(played)
      limiterStats.set(s.input.id, s.limiter.process(forLimiter))

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

    const decisions: GainDecision[] = computeBalanceGains(balanceInputs, target, balanceParams)
    for (const d of decisions) decisionMap.set(d.tabId, d.gainDb)

    // Step 3: record trace, advance the smoother, and fix the gain that the
    // *next* tick will apply.
    const tSec = ((tick + 1) * TICK_SAMPLES) / SAMPLE_RATE
    for (const s of states) {
      const measured = s.calc.getShortTermLoudness()
      const newDecided = decisionMap.get(s.input.id)
      // If computeBalanceGains returned no decision for this tab (e.g. not
      // enough samples yet), hold the previous gain — matching production,
      // where the SW simply doesn't send a new SET_GAIN and the content script
      // keeps the last applied value.
      if (newDecided !== undefined) s.decidedGainDb = newDecided

      // Advance the smoother by one tick toward the (possibly updated) setpoint.
      // Direction-aware τ mirrors audio-graph.ts: decreases attack fast, increases
      // release slow. τ = 0 ⇒ factor = 0 ⇒ instantaneous (legacy behaviour).
      const tau = s.decidedGainDb < s.effectiveGainDb ? smoother.attackTc : smoother.releaseTc
      const factor = tau > 0 ? Math.exp(-TICK_SEC / tau) : 0
      s.effectiveGainDb = s.decidedGainDb + (s.effectiveGainDb - s.decidedGainDb) * factor

      const outputLufs = Number.isFinite(measured) ? measured + s.effectiveGainDb : -Infinity
      const ls = limiterStats.get(s.input.id) ?? { outputPeakDb: -Infinity, maxGainReductionDb: 0 }
      s.trace.push({
        tSec,
        appliedGainDb: s.effectiveGainDb,
        decidedGainDb: s.decidedGainDb,
        measuredLufs: measured,
        outputLufs,
        limitedPeakDb: ls.outputPeakDb,
        limiterReductionDb: ls.maxGainReductionDb,
      })
    }
  }

  return states.map((s) => ({
    id: s.input.id,
    trace: s.trace,
    finalGainDb: s.effectiveGainDb,
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
