/**
 * Pure balance-decision logic for auto-balance.
 *
 * Extracted from the background service worker so the "given a target LUFS and
 * each tab's measurement, what gain should each tab have?" decision can be
 * unit-tested without the Chrome runtime. The background orchestrates side
 * effects (sending SET_GAIN messages); this module only computes.
 */

// Minimum blocks required before short-term LUFS is trustworthy enough to
// drive a gain decision. Kept low (3 ≈ 300 ms of audio) so balancing kicks
// in quickly after capture starts, instead of waiting ~1.3 s for 10 blocks.
export const MIN_BLOCKS_FOR_RELIABLE_LUFS = 3

// Lower gain floor applied to every balanced tab (matches the slider floor).
export const DEFAULT_MIN_GAIN = -60

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

export function hasEnoughSamples(blockCount: number): boolean {
  return blockCount >= MIN_BLOCKS_FOR_RELIABLE_LUFS
}

/**
 * Decide the gain to apply to each tab to move its short-term loudness toward
 * `targetLufs`. Tabs that cannot be balanced (not capturing, too few samples,
 * or no finite measurement yet) are omitted from the result.
 *
 * Per-tab balance bypass is handled by the caller (the SW pushes unity gain
 * for bypassed tabs separately); this function only ever sees tabs that should
 * be balanced.
 */
export function computeBalanceGains(tabs: BalanceableTab[], targetLufs: number): GainDecision[] {
  const decisions: GainDecision[] = []

  for (const tab of tabs) {
    if (!tab.isCapturing) continue
    if (!hasEnoughSamples(tab.blockCount)) continue
    if (!Number.isFinite(tab.shortTerm)) continue

    const raw = targetLufs - tab.shortTerm
    const clamped = Math.max(DEFAULT_MIN_GAIN, Math.min(tab.maxGainDb, raw))
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
