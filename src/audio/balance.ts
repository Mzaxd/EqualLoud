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
}

/** Production defaults — the values every caller used before tuning existed. */
export const DEFAULT_BALANCE_PARAMS: BalanceParams = {
  minBlocks: MIN_BLOCKS_FOR_RELIABLE_LUFS,
  minGainDb: DEFAULT_MIN_GAIN,
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
    const clamped = Math.max(params.minGainDb, Math.min(tab.maxGainDb, raw))
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
