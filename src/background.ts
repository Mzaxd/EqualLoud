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
  POPUP_PORT_NAME,
  type IncomingMessage,
  type LimiterSettings,
  type Settings,
  type TabState,
} from '@/messages/protocol'
import { CURRENT_SCHEMA_VERSION, hydratePayload } from '@/storage/migrate'
import { clearLogs, createLogger, getRecentLogs, loadLogs } from '@/utils/logger'

const log = createLogger('sw')

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
 * Currently-connected popup Ports. The popup opens one on mount and receives
 * {@link StatePushMessage} pushes whenever the SW's state changes — replacing
 * the old 4 Hz GET_STATE polling with a ~10 Hz push that tracks balance runs.
 * Ports are dropped on disconnect (popup closed / SW recycled).
 */
const popupPorts = new Set<chrome.runtime.Port>()

/**
 * Push the full current state to every connected popup Port. Cheap when there
 * are no popups open (the set is empty). Called from every state-mutation site
 * (balance pass, setting change, tab attach/detach) so the popup never shows
 * stale data and never needs to poll.
 */
function pushStateToPopups(): void {
  if (popupPorts.size === 0) return
  const msg = {
    type: 'STATE_PUSH' as const,
    tabs: Array.from(tabs.values()),
    settings,
    limiter,
  }
  for (const port of popupPorts) {
    try {
      port.postMessage(msg)
    } catch {
      // Port may have disconnected between events; the onDisconnect handler
      // will reap it. Ignore here to avoid blocking the state mutation.
    }
  }
}

/**
 * Resolves once settings have been (re)loaded from storage. Every handler
 * awaits this so a freshly-woken SW answers with the user's real settings,
 * not the defaults.
 */
let settingsLoaded: Promise<void> = loadSettings().catch((err) => {
  // A storage read failure must NOT leave settingsLoaded pending forever —
  // every handler awaits it, so a rejection here would freeze the SW. Fall
  // back to defaults and log so the user has a signal.
  log.error('settings load failed; using defaults', err)
})

/**
 * Resolves once the diagnostic-log ring buffer has been restored from
 * `chrome.storage.session`. Awaited before `GET_LOGS` so a freshly-woken SW
 * (whose in-memory buffer was lost) still reports pre-sleep history.
 */
let logsLoaded: Promise<void> = loadLogs()

// ---------------------------------------------------------------------------
// Storage (versioned — see @/storage/migrate)
// ---------------------------------------------------------------------------

/**
 * Load settings + limiter from storage through the migration chain, then seed
 * the in-memory state. The stored records are version-tagged (`__v`); any
 * pre-versioning data (no `__v`) is run through `migrate_v0_v1`, which is where
 * the old per-field type validation + ratio clamp now live.
 */
async function loadSettings(): Promise<void> {
  const result = await chrome.storage.local.get(['settings', 'limiter', '__v'])
  const hydrated = hydratePayload(
    {
      __v: result.__v as number | undefined,
      settings: result.settings as Partial<Settings> | undefined,
      limiter: result.limiter as Partial<LimiterSettings> | undefined,
    },
    settings,
  )
  settings = hydrated.settings
  limiter = hydrated.limiter
  // Persist the (possibly newly-migrated) version tag so subsequent loads skip
  // the migration chain. Cheap write; only fires once per SW cold start.
  if (hydrated.__v !== (result.__v as number | undefined)) {
    void chrome.storage.local.set({ __v: hydrated.__v })
  }
}

async function persistSettings(): Promise<void> {
  await chrome.storage.local.set({ settings, __v: CURRENT_SCHEMA_VERSION })
}

async function persistLimiter(): Promise<void> {
  await chrome.storage.local.set({ limiter, __v: CURRENT_SCHEMA_VERSION })
}

// ---------------------------------------------------------------------------
// Tab state helpers
// ---------------------------------------------------------------------------

function ensureTab(
  tabId: number,
  title: string,
  url: string,
  seed?: { appliedGainDb?: number; favIconUrl?: string },
): TabState {
  let tab = tabs.get(tabId)
  if (!tab) {
    const seedGain = seed?.appliedGainDb
    tab = {
      tabId,
      title,
      url,
      favIconUrl: seed?.favIconUrl ?? '',
      isCapturing: true,
      shortTerm: -Infinity,
      blockCount: 0,
      // Seed from the content script's last-applied gain when available so a
      // SW recovering from sleep doesn't reset a loud tab to 0 dB (full
      // volume) and blip the user before the next heartbeat re-balances it.
      // Falls back to 0 dB (unity) for first-ever attach or older CS.
      appliedGainDb: typeof seedGain === 'number' && Number.isFinite(seedGain) ? seedGain : 0,
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
  // Reflect the new applied gains to any open popup (live gain readouts).
  pushStateToPopups()
}

/** Balance if enabled and the throttle window has elapsed. Fire-and-forget. */
function maybeBalance(): void {
  const now = Date.now()
  if (shouldThrottleBalance(lastBalanceMs, now)) return
  lastBalanceMs = now
  balanceOnce().catch((err) => log.error('balance failed', err))
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
  pushStateToPopups()
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
  pushStateToPopups()
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
    // maybeBalance is fire-and-forget; push the balanceEnabled flip now so the
    // popup's BYPASS/passthrough label updates without waiting for the gain pass.
    pushStateToPopups()
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
  pushStateToPopups()
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
      // Whether this is a fresh SW-recovery registration (tab was lost from
      // the in-memory Map on sleep) vs. a known tab re-announcing. Determines
      // whether we can trust the echoed gain to suppress the 0 dB blip.
      const wasMissing = !tabs.has(senderTabId)
      const seedGain = message.appliedGainDb
      ensureTab(senderTabId, message.title ?? '', message.url ?? '', {
        appliedGainDb: seedGain,
      })
      await pushConfigToTab(senderTabId)
      if (wasMissing && Number.isFinite(seedGain)) {
        // SW woke up and this tab was missing. Rather than letting
        // maybeBalance() force a unity (0 dB) decision for a cold tab
        // (blockCount: 0) — which would blip the GainNode back to full volume
        // — echo the gain the content script already has applied so the audio
        // graph stays put until a real LUFS_REPORT arrives and re-balances.
        await sendToTab(senderTabId, {
          type: 'SET_GAIN',
          tabId: senderTabId,
          gainDb: seedGain,
        })
      } else {
        // Known tab (normal primary switch) or no gain reported (older CS):
        // recompute and apply the current gain decision as before.
        lastBalanceMs = 0
        maybeBalance()
      }
      await updateBadge()
      // A new tab appeared (or a known one re-announced) — push so the popup's
      // "Now playing" list updates immediately rather than on the next balance.
      pushStateToPopups()
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
        t = ensureTab(senderTabId, sender.tab?.title ?? '', sender.tab?.url ?? '', {
          appliedGainDb: message.appliedGainDb,
        })
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
      // Push so the popup drops the row immediately (no 100 ms wait for a
      // balance pass that will never come for a removed tab).
      pushStateToPopups()
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
  await Promise.all([settingsLoaded, logsLoaded])

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
    case 'GET_LOGS':
      return { entries: getRecentLogs() }
    case 'CLEAR_LOGS':
      clearLogs()
      return { cleared: true as const }
    default:
      return { error: 'Unknown message type' }
  }
}

// ---------------------------------------------------------------------------
// Chrome event wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: IncomingMessage, sender, sendResponse) => {
  // Defensive: a port/message callback can be invoked after the extension
  // context was invalidated; check lastError before touching the channel so we
  // never throw into Chrome's internals (which only surfaces a confusing
  // "Unchecked runtime.lastError" in the page console).
  if (chrome.runtime.lastError) {
    log.warn('onMessage lastError', chrome.runtime.lastError)
    return false
  }
  handleMessage(message, sender)
    .then((resp) => sendResponse(resp))
    .catch((err) => {
      log.error('message handler error', err)
      sendResponse({ error: err instanceof Error ? err.message : String(err) })
    })
  return true // keep the channel open for the async response
})

// Popup long-lived Port: replaces the 4 Hz GET_STATE polling. On connect we
// immediately push the full current state (cold-start sync), then every
// state-mutation site calls pushStateToPopups() to stream updates down.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT_NAME) return
  popupPorts.add(port)
  // Send the current snapshot immediately so the popup doesn't start empty.
  pushStateToPopups()
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port)
  })
})

// Tab lifecycle: drop state when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    removeTab(tabId)
    void updateBadge()
  }
})

// Refresh title/url/favIconUrl as the page navigates.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const t = tabs.get(tabId)
  if (!t) return
  if (info.title) t.title = info.title
  if (info.url) t.url = info.url
  if (info.favIconUrl) t.favIconUrl = info.favIconUrl
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
    // Refresh title/url/favIconUrl from Chrome's authoritative tab record.
    // The content script only knows title+url; favIconUrl comes from here.
    const known = tabs.get(tabId)
    if (known) {
      if (tab.title) known.title = tab.title
      if (tab.url) known.url = tab.url
      if (tab.favIconUrl) known.favIconUrl = tab.favIconUrl
    }
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
chrome.runtime.onInstalled.addListener((details) => {
  void updateBadge()
  // First install: open the onboarding page so the user sees what the
  // extension does and why <all_urls> is needed, before they encounter it in
  // the popup. Skipped on update (UpdateNotice handles that surface) and on
  // Chrome install (details.reason === 'chrome_update').
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })
  }
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
void scanTabs().catch((err) => log.error('initial scan failed', err))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all in-memory state to defaults. Used by tests. */
export function resetState(): void {
  tabs.clear()
  settings = { enabled: true, targetLufs: DEFAULT_TARGET_LUFS }
  limiter = { ...DEFAULT_LIMITER_SETTINGS }
  lastBalanceMs = 0
  popupPorts.clear()
  settingsLoaded = loadSettings()
  logsLoaded = loadLogs()
}

/** Inject a tab directly (test-only). */
export function seedTab(tab: Partial<TabState> & { tabId: number }): TabState {
  const full: TabState = {
    title: 'Tab',
    url: 'https://example.com',
    favIconUrl: '',
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

export {
  DEFAULT_MAX_GAIN_DB,
  DEFAULT_MIN_GAIN_DB,

  // Catch promise rejections that slipped past every per-call .catch() — without
  // this they'd surface only as silent "unchecked" warnings with no buffer entry,
  // meaning the popup export path could never see them.
}
;(self as unknown as { addEventListener: typeof addEventListener }).addEventListener(
  'unhandledrejection',
  (event: PromiseRejectionEvent) => {
    log.error('unhandled rejection', event.reason)
  },
)

log.info('background service worker loaded')
