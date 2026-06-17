import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

import { MIN_BLOCKS_FOR_RELIABLE_LUFS } from '@/audio/balance'
import type { LimiterSettings, Settings, TabState } from '@/messages/protocol'

/**
 * Popup-side store mirroring the SW's view of the world (PRD §6.3).
 *
 * The popup is short-lived (mounted on each open), so it polls the SW via
 * GET_STATE rather than holding a live connection. We also listen to
 * chrome.storage.onChanged for the limiter/settings keys so changes from other
 * surfaces propagate instantly.
 */

export interface TabLufs {
  shortTerm: number
  blockCount: number
}

/** A tab as seen by the popup — identical shape to the SW's TabState. */
export type CapturedTab = TabState

export { MIN_BLOCKS_FOR_RELIABLE_LUFS }

export function hasEnoughSamples(lufs: TabLufs): boolean {
  return lufs.blockCount >= MIN_BLOCKS_FOR_RELIABLE_LUFS
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<CapturedTab[]>([])
  const settings = ref<Settings>({
    enabled: true,
    targetLufs: -14,
  })
  const limiter = ref<LimiterSettings>({
    enabled: true,
    thresholdDb: -2,
    kneeDb: 0,
    ratio: 20,
    attackMs: 0.7,
    releaseMs: 150,
  })
  const error = ref<string | null>(null)

  let pollInterval: number | null = null
  let storageListener: ((changes: { [key: string]: chrome.storage.StorageChange }) => void) | null =
    null

  const hasCaptures = computed(() => tabs.value.length > 0)
  const isAutoBalancing = computed(() => settings.value.enabled)
  const targetLufs = computed(() => settings.value.targetLufs)

  const isLimiterEnabled = computed(() => limiter.value.enabled)
  const limiterThreshold = computed(() => limiter.value.thresholdDb)
  const limiterAttack = computed(() => limiter.value.attackMs)
  const limiterRelease = computed(() => limiter.value.releaseMs)
  const limiterKnee = computed(() => limiter.value.kneeDb)
  const limiterRatio = computed(() => limiter.value.ratio)

  // --- fetching -----------------------------------------------------------------

  async function fetchState(): Promise<void> {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
      // Guard: the SW may resolve to undefined (asleep/just-restarted) — without
      // this check, `r.tabs` below throws on the undefined and surfaces a
      // spurious error to the user.
      if (!resp || typeof resp !== 'object') return
      const r = resp as { tabs?: CapturedTab[]; settings?: Settings; limiter?: LimiterSettings }
      // Use hasOwnProperty checks rather than truthiness so a legitimate empty
      // array / 0 / null field is applied instead of skipped.
      if ('tabs' in r && r.tabs) tabs.value = r.tabs
      if ('settings' in r && r.settings) settings.value = r.settings
      if ('limiter' in r && r.limiter) limiter.value = r.limiter
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch state'
    }
  }

  // --- actions ------------------------------------------------------------------

  async function setAutoBalanceEnabled(enabled: boolean): Promise<boolean> {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'SET_ENABLED',
        enabled,
      })) as { settings?: Settings }
      if (resp.settings) settings.value = resp.settings
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed'
      return false
    }
  }

  async function toggleAutoBalance(): Promise<void> {
    await setAutoBalanceEnabled(!settings.value.enabled)
  }

  async function setTargetLufs(value: number): Promise<boolean> {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'SET_TARGET_LUFS',
        targetLufs: value,
      })) as { settings?: Settings }
      if (resp.settings) settings.value = resp.settings
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed'
      return false
    }
  }

  async function toggleBalance(tabId: number): Promise<boolean> {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'TOGGLE_BALANCE',
        tabId,
      })) as { tabs?: CapturedTab[] }
      if (resp.tabs) tabs.value = resp.tabs
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed'
      return false
    }
  }

  async function setLimiterEnabled(enabled: boolean): Promise<boolean> {
    return patchLimiter({ enabled })
  }
  async function setLimiterThreshold(thresholdDb: number): Promise<boolean> {
    return patchLimiter({ thresholdDb })
  }
  async function setLimiterAttack(attackMs: number): Promise<boolean> {
    return patchLimiter({ attackMs })
  }
  async function setLimiterRelease(releaseMs: number): Promise<boolean> {
    return patchLimiter({ releaseMs })
  }
  async function setLimiterKnee(kneeDb: number): Promise<boolean> {
    return patchLimiter({ kneeDb })
  }
  async function setLimiterRatio(ratio: number): Promise<boolean> {
    return patchLimiter({ ratio })
  }

  async function patchLimiter(partial: Partial<LimiterSettings>): Promise<boolean> {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'SET_LIMITER_SETTINGS',
        settings: partial,
      })) as { limiter?: LimiterSettings }
      if (resp.limiter) limiter.value = resp.limiter
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed'
      return false
    }
  }

  function clearError(): void {
    error.value = null
  }

  // --- polling ------------------------------------------------------------------

  function startPolling(): void {
    if (pollInterval) return
    void fetchState()
    // 4 Hz is plenty for the loudness meter + gain readouts (human perception
    // of an indicator bar tops out around there); 10 Hz just churned reactive
    // updates and restarted the fill width transition before it could finish.
    pollInterval = window.setInterval(() => void fetchState(), 250)
    if (!storageListener) {
      storageListener = (changes) => {
        if (changes.settings?.newValue) settings.value = changes.settings.newValue as Settings
        if (changes.limiter?.newValue) limiter.value = changes.limiter.newValue as LimiterSettings
      }
      chrome.storage.onChanged.addListener(storageListener)
    }
  }

  function stopPolling(): void {
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    if (storageListener) {
      chrome.storage.onChanged.removeListener(storageListener)
      storageListener = null
    }
  }

  return {
    // state
    tabs,
    settings,
    limiter,
    error,
    // computed
    hasCaptures,
    isAutoBalancing,
    targetLufs,
    isLimiterEnabled,
    limiterThreshold,
    limiterAttack,
    limiterRelease,
    limiterKnee,
    limiterRatio,
    // actions
    fetchState,
    setAutoBalanceEnabled,
    toggleAutoBalance,
    setTargetLufs,
    toggleBalance,
    setLimiterEnabled,
    setLimiterThreshold,
    setLimiterAttack,
    setLimiterRelease,
    setLimiterKnee,
    setLimiterRatio,
    startPolling,
    stopPolling,
    clearError,
  }
})
