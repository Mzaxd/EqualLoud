/**
 * EqualLoud background service worker — the coordinator (PRD §6.2).
 *
 * Responsibilities:
 *  - Aggregate per-tab state reported by content scripts (LUFS heartbeat).
 *  - Run the pure {@link computeBalanceGains} decision and push each gain back
 *    to the owning content script via `chrome.tabs.sendMessage`.
 *  - Persist user settings (target LUFS, enabled, limiter) to
 *    `chrome.storage.local` so they survive SW restarts.
 *  - Answer popup requests.
 *
 * The SW never touches audio: content scripts own the per-element audio graphs
 * and the SW only sees LUFS numbers in and sends gain numbers out. No offscreen
 * document, no tabCapture.
 */

import { computeBalanceGains, shouldThrottleBalance, type BalanceableTab } from '@/audio/balance'
import {
  ALARM_SCAN_PERIOD_MIN,
  DEFAULT_LIMITER_SETTINGS,
  DEFAULT_MAX_GAIN_DB,
  DEFAULT_MIN_GAIN_DB,
  DEFAULT_TARGET_LUFS,
} from '@/audio/config'
import {
  isNotification,
  type IncomingMessage,
  type LimiterSettings,
  type Settings,
  type TabState,
} from '@/messages/protocol'

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const tabs = new Map<number, TabState>()

let settings: Settings = {
  enabled: true,
  targetLufs: DEFAULT_TARGET_LUFS,
}

let limiter: LimiterSettings = { ...DEFAULT_LIMITER_SETTINGS }

/** Epoch ms of the last balance run; throttle per BALANCE_THROTTLE_MS. */
let lastBalanceMs = 0

/**
 * Resolves once settings have been (re)loaded from storage. Every handler
 * awaits this so a freshly-woken SW answers with the user's real settings,
 * not the defaults.
 */
let settingsLoaded: Promise<void> = loadSettings()

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const result = await chrome.storage.local.get(['settings', 'limiter'])
  const storedSettings = result.settings as Partial<Settings> | undefined
  if (storedSettings) {
    // Validate before spreading: a corrupt or future-version object could put
    // a non-number into targetLufs, which would propagate to computeBalanceGains
    // as a NaN gain and silently mute tabs. Drop any field of the wrong type.
    const picked: Partial<Settings> = {}
    if (typeof storedSettings.enabled === 'boolean') picked.enabled = storedSettings.enabled
    if (
      typeof storedSettings.targetLufs === 'number' &&
      Number.isFinite(storedSettings.targetLufs)
    ) {
      picked.targetLufs = storedSettings.targetLufs
    }
    settings = { ...settings, ...picked }
  }
  const storedLimiter = result.limiter as Partial<LimiterSettings> | undefined
  if (storedLimiter) {
    const picked: Partial<LimiterSettings> = {}
    if (typeof storedLimiter.enabled === 'boolean') picked.enabled = storedLimiter.enabled
    for (const k of ['thresholdDb', 'kneeDb', 'attackMs', 'releaseMs'] as const) {
      const v = storedLimiter[k]
      if (typeof v === 'number' && Number.isFinite(v)) picked[k] = v
    }
    if (typeof storedLimiter.ratio === 'number' && Number.isFinite(storedLimiter.ratio)) {
      // Clamp to the Web Audio DynamicsCompressorNode range [1, 20]. Older
      // versions defaulted to ratio=30; without this, the stale value is read
      // back on every SW restart and re-triggers the "value 30 outside nominal
      // range [1, 20]" console warning when applied to the node.
      picked.ratio = Math.min(20, Math.max(1, storedLimiter.ratio))
    }
    limiter = { ...limiter, ...picked }
  }
}

async function persistSettings(): Promise<void> {
  await chrome.storage.local.set({ settings })
}

async function persistLimiter(): Promise<void> {
  await chrome.storage.local.set({ limiter })
}

// ---------------------------------------------------------------------------
// Tab state helpers
// ---------------------------------------------------------------------------

function ensureTab(tabId: number, title: string, url: string): TabState {
  let tab = tabs.get(tabId)
  if (!tab) {
    tab = {
      tabId,
      title,
      url,
      isCapturing: true,
      shortTerm: -Infinity,
      blockCount: 0,
      appliedGainDb: 0,
      maxGainDb: DEFAULT_MAX_GAIN_DB,
      balanceEnabled: true,
    }
    tabs.set(tabId, tab)
  } else {
    tab.title = title
    tab.url = url
    tab.isCapturing = true
  }
  return tab
}

function removeTab(tabId: number): void {
  tabs.delete(tabId)
}

// ---------------------------------------------------------------------------
// Balance decision + dispatch
// ---------------------------------------------------------------------------

/** Run one balance pass and push each gain decision to its content script. */
async function balanceOnce(): Promise<void> {
  if (!settings.enabled) return
  if (tabs.size === 0) return

  // Partition tabs: balanced ones feed the decision; bypassed ones get unity.
  // Bypass is purely a SW-level concept — the content script just receives
  // SET_GAIN 0 and passes audio through, exactly like the global-off path.
  // LUFS measurement keeps running for bypassed tabs so re-enabling snaps to
  // the right gain without a cold start.
  const inputs: BalanceableTab[] = []
  const bypassed: number[] = []
  for (const t of tabs.values()) {
    if (!t.balanceEnabled) {
      bypassed.push(t.tabId)
      continue
    }
    inputs.push({
      tabId: t.tabId,
      isCapturing: t.isCapturing,
      shortTerm: t.shortTerm,
      blockCount: t.blockCount,
      maxGainDb: t.maxGainDb,
    })
  }

  const decisions = computeBalanceGains(inputs, settings.targetLufs)
  // Append unity-gain decisions for bypassed tabs so they're driven to 0 dB
  // on every pass (self-correcting after SW restart / re-attach).
  for (const tabId of bypassed) {
    decisions.push({ tabId, gainDb: 0 })
  }
  // Apply to in-memory state synchronously, then dispatch SET_GAIN in parallel
  // (serial dispatch delayed the last tab's update by a round-trip per prior tab).
  const sends: Promise<void>[] = []
  for (const d of decisions) {
    const t = tabs.get(d.tabId)
    if (!t) continue
    t.appliedGainDb = d.gainDb
    sends.push(sendToTab(d.tabId, { type: 'SET_GAIN', tabId: d.tabId, gainDb: d.gainDb }))
  }
  await Promise.all(sends)
}

/** Balance if enabled and the throttle window has elapsed. Fire-and-forget. */
function maybeBalance(): void {
  const now = Date.now()
  if (shouldThrottleBalance(lastBalanceMs, now)) return
  lastBalanceMs = now
  balanceOnce().catch((err) => console.error('[EqualLoud] balance failed', err))
}

// ---------------------------------------------------------------------------
// Messaging: SW → content script
// ---------------------------------------------------------------------------

async function sendToTab(tabId: number, message: unknown): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message)
  } catch {
    // Tab may have navigated/closed before we could deliver; it'll either
    // re-attach on next MEDIA_ATTACHED or get cleaned up on the next alarm.
  }
}

/** Push current settings + limiter to a content script (used on attach/ping). */
async function pushConfigToTab(tabId: number): Promise<void> {
  await sendToTab(tabId, {
    type: 'SET_CONFIG',
    target: settings.targetLufs,
    enabled: settings.enabled,
  })
  await sendToTab(tabId, { type: 'SET_LIMITER', settings: limiter })
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function updateBadge(): Promise<void> {
  // Default (enabled) state shows no badge at all — keeps the toolbar icon clean.
  // Only when the user has explicitly turned balancing OFF do we mark the icon,
  // so it's obvious at a glance that nothing is being balanced.
  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: 'OFF' })
    await chrome.action.setBadgeBackgroundColor({ color: '#718096' })
  } else {
    await chrome.action.setBadgeText({ text: '' })
  }
}

// ---------------------------------------------------------------------------
// Popup request handlers (each returns a serialisable response)
// ---------------------------------------------------------------------------

function handleGetState() {
  return { tabs: Array.from(tabs.values()), settings, limiter }
}

async function handleSetTargetLufs(targetLufs: number): Promise<{ settings: Settings }> {
  settings.targetLufs = Math.max(-60, Math.min(0, targetLufs))
  await persistSettings()
  lastBalanceMs = 0 // force an immediate rebalance
  maybeBalance()
  return { settings }
}

async function handleSetEnabled(enabled: boolean): Promise<{ settings: Settings }> {
  settings.enabled = enabled
  await persistSettings()
  if (!enabled) {
    // When disabled, restore unity gain on every tab so we stop touching audio.
    for (const t of tabs.values()) {
      t.appliedGainDb = 0
      await sendToTab(t.tabId, { type: 'SET_GAIN', tabId: t.tabId, gainDb: 0 })
    }
  } else {
    lastBalanceMs = 0
    maybeBalance()
  }
  await updateBadge()
  return { settings }
}

async function handleToggleBalance(tabId: number): Promise<{ tabs: TabState[] }> {
  const t = tabs.get(tabId)
  if (t) {
    t.balanceEnabled = !t.balanceEnabled
    // Force an immediate rebalance so the toggle is heard instantly: enabling
    // needs to push the computed gain, disabling needs to push unity.
    lastBalanceMs = 0
    maybeBalance()
  }
  return { tabs: Array.from(tabs.values()) }
}

async function handleSetLimiter(
  partial: Partial<LimiterSettings>,
): Promise<{ limiter: LimiterSettings }> {
  limiter = { ...limiter, ...partial }
  await persistLimiter()
  // Broadcast to every content script so their DynamicsCompressor updates.
  await Promise.all(
    Array.from(tabs.values()).map((t) =>
      sendToTab(t.tabId, { type: 'SET_LIMITER', settings: limiter }),
    ),
  )
  return { limiter }
}

// ---------------------------------------------------------------------------
// Content-script notification handlers
// ---------------------------------------------------------------------------

async function handleNotification(
  message: Extract<IncomingMessage, { type: string }> & { tabId?: number },
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const senderTabId = sender.tab?.id
  switch (message.type) {
    case 'MEDIA_ATTACHED': {
      // Content scripts don't know their own tabId; use the sender's.
      if (senderTabId == null) return
      ensureTab(senderTabId, message.title ?? '', message.url ?? '')
      await pushConfigToTab(senderTabId)
      // Apply current gain decision immediately so the tab doesn't blip at 0 dB.
      lastBalanceMs = 0
      maybeBalance()
      await updateBadge()
      return
    }
    case 'LUFS_REPORT': {
      if (senderTabId == null) return
      let t = tabs.get(senderTabId)
      if (!t) {
        // SW was asleep and lost this tab from the in-memory Map. The content
        // script is clearly still alive (it's heartbeating), so recover:
        // re-register it from the sender, accept this LUFS reading, and push
        // current config so the tab resumes balancing immediately.
        t = ensureTab(senderTabId, sender.tab?.title ?? '', sender.tab?.url ?? '')
        void pushConfigToTab(senderTabId)
      }
      t.shortTerm = message.shortTerm ?? -Infinity
      t.blockCount = message.blockCount ?? 0
      maybeBalance()
      return
    }
    case 'TAB_UNLOAD': {
      if (senderTabId == null) return
      removeTab(senderTabId)
      await updateBadge()
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Single message router (popup + content) — exported for unit testing
// ---------------------------------------------------------------------------

export async function handleMessage(
  message: IncomingMessage,
  sender: chrome.runtime.MessageSender = {} as chrome.runtime.MessageSender,
): Promise<unknown> {
  await settingsLoaded

  if (isNotification(message)) {
    await handleNotification(message, sender)
    return { acknowledged: true }
  }

  switch (message.type) {
    case 'GET_STATE':
      return handleGetState()
    case 'SET_TARGET_LUFS':
      return handleSetTargetLufs(message.targetLufs)
    case 'SET_ENABLED':
      return handleSetEnabled(message.enabled)
    case 'TOGGLE_BALANCE':
      return handleToggleBalance(message.tabId)
    case 'SET_LIMITER_SETTINGS':
      return handleSetLimiter(message.settings)
    default:
      return { error: 'Unknown message type' }
  }
}

// ---------------------------------------------------------------------------
// Chrome event wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: IncomingMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((resp) => sendResponse(resp))
    .catch((err) => {
      console.error('[EqualLoud] message handler error', err)
      sendResponse({ error: err instanceof Error ? err.message : String(err) })
    })
  return true // keep the channel open for the async response
})

// Tab lifecycle: drop state when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    removeTab(tabId)
    void updateBadge()
  }
})

// Refresh title/url as the page navigates.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const t = tabs.get(tabId)
  if (!t) return
  if (info.title) t.title = info.title
  if (info.url) t.url = info.url
})

// Prerender/swap replaces the tab id without onRemoved firing in the order we
// expect; drop the stale id so it doesn't linger as a ghost entry (the new id
// re-registers itself via MEDIA_ATTACHED on its next heartbeat).
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  if (tabs.has(removedTabId)) {
    removeTab(removedTabId)
    void updateBadge()
  }
})

// Fallback alarm: ping every attached tab so state rebuilds after a SW nap,
// and prune tabs that are no longer there.
chrome.alarms.create('equalloud-scan', { periodInMinutes: ALARM_SCAN_PERIOD_MIN })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'equalloud-scan') return
  void scanTabs()
})

async function scanTabs(): Promise<void> {
  // Query every real http(s) tab in Chrome (not chrome://, not the popup).
  // This is the source of truth after a SW restart — the in-memory Map is
  // empty and useless in that case. Iterating it (the old code) meant the
  // post-wake rebuild loop ran zero times, so PINGs were never sent and
  // state stayed empty forever.
  const allTabs = await chrome.tabs.query({})
  const knownTabIds = new Set(tabs.keys())
  for (const tab of allTabs) {
    const tabId = tab.id
    if (tabId == null) continue
    // Skip non-http(s) pages — content scripts don't run there, so PING
    // would just throw "Receiving end does not exist".
    if (!tab.url || !/^https?:/i.test(tab.url)) continue
    try {
      await sendToTab(tabId, { type: 'PING' })
    } catch {
      // Tab exists in Chrome but has no content script yet. Not an error.
    }
    knownTabIds.delete(tabId)
  }
  // Any tabId we knew but Chrome no longer lists is gone — drop it.
  for (const staleTabId of knownTabIds) {
    removeTab(staleTabId)
  }
  await updateBadge()
}

// (Re)load on install/startup.
chrome.runtime.onInstalled.addListener(() => {
  void updateBadge()
})
chrome.runtime.onStartup.addListener(() => {
  void updateBadge()
})

// Eagerly update badge on every wake-up (module re-execution).
void updateBadge()

// On SW wake-up the in-memory `tabs` Map is empty. The 1-minute alarm would
// eventually rebuild it, but that's up to 60s of dead audio. Kick an immediate
// scan so PINGs go out within ~1s and tabs re-announce within a few seconds.
// (scanTabs is async and self-contained; fire-and-forget on module load.)
void scanTabs().catch((err) => console.error('[EqualLoud] initial scan failed', err))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all in-memory state to defaults. Used by tests. */
export function resetState(): void {
  tabs.clear()
  settings = { enabled: true, targetLufs: DEFAULT_TARGET_LUFS }
  limiter = { ...DEFAULT_LIMITER_SETTINGS }
  lastBalanceMs = 0
  settingsLoaded = loadSettings()
}

/** Inject a tab directly (test-only). */
export function seedTab(tab: Partial<TabState> & { tabId: number }): TabState {
  const full: TabState = {
    title: 'Tab',
    url: 'https://example.com',
    isCapturing: true,
    shortTerm: -14,
    blockCount: 50,
    appliedGainDb: 0,
    maxGainDb: DEFAULT_MAX_GAIN_DB,
    balanceEnabled: true,
    ...tab,
  }
  tabs.set(full.tabId, full)
  return full
}

export { DEFAULT_MAX_GAIN_DB, DEFAULT_MIN_GAIN_DB }

console.log('[EqualLoud] background service worker loaded')
