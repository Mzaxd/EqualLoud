import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

import { MIN_BLOCKS_FOR_RELIABLE_LUFS } from '@/audio/balance'
import {
  POPUP_PORT_NAME,
  type LimiterSettings,
  type LogEntry,
  type Settings,
  type TabState,
} from '@/messages/protocol'

/**
 * Popup-side store mirroring the SW's view of the world (PRD §6.3).
 *
 * The popup is short-lived (mounted on each open). It opens a long-lived Port
 * to the SW on mount and receives STATE_PUSH messages whenever the SW's state
 * changes (after each balance pass, setting change, tab attach/detach) — this
 * replaces the old 4 Hz GET_STATE polling with ~10 Hz push that tracks the
 * balance loop directly. An initial GET_STATE call seeds the cold-start
 * snapshot before the first push arrives.
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

/** Render one {@link LogEntry} as a single grep-friendly text line. */
function formatLogEntry(e: LogEntry): string {
  const iso = new Date(e.ts).toISOString()
  const data = e.data === undefined ? '' : ' ' + JSON.stringify(e.data)
  return `${iso} [${e.level}] [${e.scope}] ${e.msg}${data}`
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

  /** The long-lived Port to the SW (null when no popup is mounted). */
  let port: chrome.runtime.Port | null = null
  /**
   * Reconnect backoff timer. The SW can recycle the Port at any time (memory
   * pressure, 5-min cap); we reconnect with exponential backoff capped at 2 s
   * so a brief SW nap doesn't starve the popup.
   */
  let reconnectTimer: number | null = null
  let reconnectDelayMs = 100

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

  // --- diagnostics ---------------------------------------------------------------

  /**
   * Fetch the SW's recent log entries and render them as a plain-text block
   * suitable for pasting into an issue report. Each line:
   *   `2026-06-18T09:12:03.421Z [warn] [sw] balance throttled {"data":...}`
   * Returns the formatted text so the caller (Diagnostics.vue) can show a
   * "copied N entries" toast; rejects (→ null) when the SW is unreachable.
   */
  async function exportLogs(): Promise<string | null> {
    try {
      const resp = (await chrome.runtime.sendMessage({ type: 'GET_LOGS' })) as
        | {
            entries?: LogEntry[]
          }
        | undefined
      if (!resp || !Array.isArray(resp.entries)) return null
      return resp.entries.map(formatLogEntry).join('\n')
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to export logs'
      return null
    }
  }

  /** Delete every buffered entry in the SW. Returns success for the UI toast. */
  async function clearLogs(): Promise<boolean> {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' })
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to clear logs'
      return false
    }
  }

  // --- Port connection (replaces polling) --------------------------------------

  /**
   * Apply a STATE_PUSH snapshot to the reactive refs. Centralised so the
   * initial GET_STATE seed and the Port message stream share one write path.
   */
  function applyState(s: {
    tabs?: TabState[]
    settings?: Settings
    limiter?: LimiterSettings
  }): void {
    if (s.tabs) tabs.value = s.tabs
    if (s.settings) settings.value = s.settings
    if (s.limiter) limiter.value = s.limiter
  }

  function startConnection(): void {
    if (port) return
    // Cold-start seed: one GET_STATE so the popup paints before the first push.
    void fetchState()
    port = chrome.runtime.connect({ name: POPUP_PORT_NAME })
    port.onMessage.addListener((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return
      const m = msg as {
        type?: string
        tabs?: TabState[]
        settings?: Settings
        limiter?: LimiterSettings
      }
      if (m.type !== 'STATE_PUSH') return
      applyState({ tabs: m.tabs, settings: m.settings, limiter: m.limiter })
    })
    port.onDisconnect.addListener(() => {
      port = null
      // SW recycled the Port (memory pressure, idle, or extension reload).
      // Reconnect with capped exponential backoff so we recover without
      // pestering the SW. Cleared on explicit stopConnection().
      if (reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 2000)
          startConnection()
        }, reconnectDelayMs)
      }
    })
    // A fresh successful connect resets the backoff.
    reconnectDelayMs = 100
  }

  function stopConnection(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (port) {
      try {
        port.disconnect()
      } catch {
        // Already disconnected — ignore.
      }
      port = null
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
    startConnection,
    stopConnection,
    clearError,
    exportLogs,
    clearLogs,
  }
})
