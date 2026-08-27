/**
 * Pure balance-decision logic for auto-balance.
 *
 * Extracted from the background service worker so the "given a target LUFS and
 * each tab's measurement, what gain should each tab have?" decision can be
 * unit-tested without the Chrome runtime. The background orchestrates side
 * effects (sending SET_GAIN messages); this module only computes.
 */

// Minimum blocks required before short-term LUFS is trustworthy enough to
// drive a gain decision. Tuned from 3→1 by the offline tuner (eval/tune.ts):
// 1 block ≈ 100 ms, so balancing kicks in within the first heartbeat instead
// of after ~300 ms. This cuts perceived startup latency on tab-switch without
// measurably increasing ripple (Stage-1 sweep confirmed stable convergence).
export const MIN_BLOCKS_FOR_RELIABLE_LUFS = 1

/**
 * Warm-up boost cap: while a tab has fewer than WARMUP_FULL_TRUST_BLOCKS
 * samples, positive gains are additionally clamped to this value. The first
 * early-block readings routinely sit 10+ LU below program loudness (fade-ins,
 * musical intros), so uncapped decisions overshoot toward the boost ceiling
 * for the first few hundred ms — the audible "startup blast". 10 covers the
 * common early-read error band; negative gains are exempt (attenuation is
 * always safe). Disabled when warmupBoostCapDb is undefined (legacy shape).
 * Values finalised by eval/warmup-tune.spec.ts (plan Task 6).
 */
export const WARMUP_BOOST_CAP_DB = 10

/** Blocks after which the warm-up cap lifts (~0.6 s: first block ~0.2 s + 4 hops ×0.1 s). */
export const WARMUP_FULL_TRUST_BLOCKS = 4

// Lower gain floor applied to every balanced tab (matches the slider floor).
export const DEFAULT_MIN_GAIN = -60

/**
 * All knobs of the balance-decision control loop, gathered in one place so
 * the offline tuner (`eval/tune.ts`) can sweep them. Production callers pass
 * nothing and get these defaults; the simulator/tuner inject alternatives.
 *
 * Fields:
 *   minBlocks — blockCount threshold below which shortTerm is untrusted (→ 0 dB).
 *   minGainDb — hard floor on the decided gain (attenuation ceiling).
 *
 * The +12 dB positive-gain ceiling is *not* here: it is per-tab
 * (`BalanceableTab.maxGainDb`) because it is a user setting, not a loop tune.
 */
export interface BalanceParams {
  minBlocks: number
  minGainDb: number
  /** While blockCount < warmupFullTrustBlocks, clamp positive gains to this. Omit to disable. */
  warmupBoostCapDb?: number
  /** Trust threshold for the warm-up cap. Required when warmupBoostCapDb is set. */
  warmupFullTrustBlocks?: number
}

/** Production defaults — the values every caller used before tuning existed. */
export const DEFAULT_BALANCE_PARAMS: BalanceParams = {
  minBlocks: MIN_BLOCKS_FOR_RELIABLE_LUFS,
  minGainDb: DEFAULT_MIN_GAIN,
  warmupBoostCapDb: WARMUP_BOOST_CAP_DB,
  warmupFullTrustBlocks: WARMUP_FULL_TRUST_BLOCKS,
}

// Minimum spacing between auto-balance runs driven by the LUFS_UPDATE heartbeat.
export const BALANCE_THROTTLE_MS = 100

export interface BalanceableTab {
  tabId: number
  isCapturing: boolean
  shortTerm: number
  blockCount: number
  maxGainDb: number
}

export interface GainDecision {
  tabId: number
  gainDb: number
}

export function hasEnoughSamples(
  blockCount: number,
  minBlocks = MIN_BLOCKS_FOR_RELIABLE_LUFS,
): boolean {
  return blockCount >= minBlocks
}

/**
 * Decide the gain to apply to each tab to move its short-term loudness toward
 * `targetLufs`. Tabs that cannot be balanced (not capturing, or no finite
 * measurement) are omitted from the result.
 *
 * Tabs whose LUFS is not yet trustworthy (too few samples — e.g. right after a
 * primary switch on an infinite-feed site) get a **unity (0 dB) decision** rather
 * than being skipped. Skipping used to leave whatever gain the GainNode last held
 * in place; on Reels/Douyin/TikTok the primary jitters so often that a tab never
 * accumulated MIN_BLOCKS samples and the gain froze at its last (possibly loud)
 * value indefinitely — manifesting as the "+0 forever after toggling" bug.
 * Driving these tabs to 0 dB every pass is self-correcting and safe.
 *
 * Per-tab balance bypass is handled by the caller (the SW pushes unity gain
 * for bypassed tabs separately); this function only ever sees tabs that should
 * be balanced.
 */
export function computeBalanceGains(
  tabs: BalanceableTab[],
  targetLufs: number,
  params: BalanceParams = DEFAULT_BALANCE_PARAMS,
): GainDecision[] {
  const decisions: GainDecision[] = []

  for (const tab of tabs) {
    if (!tab.isCapturing) continue

    // Not enough samples yet, or no finite measurement: hold unity rather than
    // inherit a stale gain. Still emit a decision so the caller drives the
    // GainNode to 0 dB on every pass (self-correcting after primary jitter).
    if (!hasEnoughSamples(tab.blockCount, params.minBlocks) || !Number.isFinite(tab.shortTerm)) {
      decisions.push({ tabId: tab.tabId, gainDb: 0 })
      continue
    }

    const raw = targetLufs - tab.shortTerm
    let clamped = Math.max(params.minGainDb, Math.min(tab.maxGainDb, raw))
    if (
      clamped > 0 &&
      params.warmupBoostCapDb !== undefined &&
      tab.blockCount < (params.warmupFullTrustBlocks ?? Infinity)
    ) {
      clamped = Math.min(clamped, params.warmupBoostCapDb, tab.maxGainDb)
    }
    decisions.push({ tabId: tab.tabId, gainDb: clamped })
  }

  return decisions
}

/**
 * Whether a balance run should be skipped because one ran too recently.
 * `lastRunMs` and `nowMs` are epoch milliseconds (e.g. Date.now()).
 */
export function shouldThrottleBalance(lastRunMs: number, nowMs: number): boolean {
  return nowMs - lastRunMs < BALANCE_THROTTLE_MS
}
