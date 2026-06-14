/**
 * Shared message contract between content scripts, the service worker, and the
 * popup. Keeping the types here means both sides import a single source of
 * truth for the protocol (PRD §6.4).
 *
 * Transport reminder:
 * - Popup ↔ SW:           `chrome.runtime.sendMessage`     (request/response)
 * - Content → SW:         `chrome.runtime.sendMessage`     (notifications)
 * - SW → Content:         `chrome.tabs.sendMessage(tabId)` (directed)
 *                         / broadcast to every attached tab
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export interface LufsReading {
  momentary: number
  shortTerm: number
  integrated: number
  blockCount: number
}

export interface LimiterSettings {
  enabled: boolean
  thresholdDb: number
  kneeDb: number
  ratio: number
  attackMs: number
  releaseMs: number
}

export interface Settings {
  enabled: boolean
  targetLufs: number
}

export interface TabState {
  tabId: number
  title: string
  url: string
  /** Whether the content script has successfully attached to a media element. */
  isCapturing: boolean
  shortTerm: number
  blockCount: number
  /** Most recent gain the SW applied (dB). Displayed live in the popup. */
  appliedGainDb: number
  /** Per-tab positive gain ceiling. */
  maxGainDb: number
  /**
   * Whether auto-balance is applied to this tab. `false` means the SW pushes
   * unity gain (0 dB / passthrough) so the user can A/B the effect, while
   * LUFS measurement keeps running so re-enabling snaps to the right gain.
   * Default `true`; held in SW memory only (reset on SW restart).
   */
  balanceEnabled: boolean
}

// ---------------------------------------------------------------------------
// Content → SW (notifications; no response expected)
// ---------------------------------------------------------------------------

export interface MediaAttachedMessage {
  type: 'MEDIA_ATTACHED'
  tabId: number
  title: string
  url: string
}

export interface LufsReportMessage {
  type: 'LUFS_REPORT'
  tabId: number
  shortTerm: number
  blockCount: number
}

export interface TabUnloadMessage {
  type: 'TAB_UNLOAD'
  tabId: number
}

export type ContentToSwMessage = MediaAttachedMessage | LufsReportMessage | TabUnloadMessage

// ---------------------------------------------------------------------------
// SW → Content (directed via chrome.tabs.sendMessage, or broadcast)
// ---------------------------------------------------------------------------

export interface SetGainMessage {
  type: 'SET_GAIN'
  tabId: number
  gainDb: number
}

export interface SetConfigMessage {
  type: 'SET_CONFIG'
  target: number
  enabled: boolean
}

export interface SetLimiterMessage {
  type: 'SET_LIMITER'
  settings: LimiterSettings
}

/** A tab the SW wants the content script to report state for on demand. */
export interface PingMessage {
  type: 'PING'
}

export type SwToContentMessage = SetGainMessage | SetConfigMessage | SetLimiterMessage | PingMessage

// ---------------------------------------------------------------------------
// Popup ↔ SW (request / response)
// ---------------------------------------------------------------------------

export interface GetStateRequest {
  type: 'GET_STATE'
}
export interface GetStateResponse {
  tabs: TabState[]
  settings: Settings
  limiter: LimiterSettings
}

export interface SetTargetLufsRequest {
  type: 'SET_TARGET_LUFS'
  targetLufs: number
}
export interface SetEnabledRequest {
  type: 'SET_ENABLED'
  enabled: boolean
}
export interface ToggleBalanceRequest {
  type: 'TOGGLE_BALANCE'
  tabId: number
}
export interface SetLimiterRequest {
  type: 'SET_LIMITER_SETTINGS'
  settings: Partial<LimiterSettings>
}
export interface SettingsResponse {
  settings: Settings
}
export interface TabsResponse {
  tabs: TabState[]
}
export interface LimiterResponse {
  limiter: LimiterSettings
}

export type PopupToSwRequest =
  | GetStateRequest
  | SetTargetLufsRequest
  | SetEnabledRequest
  | ToggleBalanceRequest
  | SetLimiterRequest

// ---------------------------------------------------------------------------
// Discriminated unions for the SW message router
// ---------------------------------------------------------------------------

/** Everything the SW's onMessage listener might receive. */
export type IncomingMessage = ContentToSwMessage | PopupToSwRequest | SwToContentMessage

/** Notification message types — fire-and-forget, SW returns `{ acknowledged }`. */
export const NOTIFICATION_MESSAGE_TYPES = new Set<ContentToSwMessage['type']>([
  'LUFS_REPORT',
  'TAB_UNLOAD',
  'MEDIA_ATTACHED',
])

export function isNotification(message: { type: string }): message is ContentToSwMessage {
  return (NOTIFICATION_MESSAGE_TYPES as Set<string>).has(message.type)
}
