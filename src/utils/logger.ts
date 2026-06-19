/**
 * Centralized logger with an in-memory ring buffer mirrored to
 * `chrome.storage.session`.
 *
 * Why this exists: the MV3 service worker is recycled after ~30s idle, and its
 * DevTools console history dies with it. On top of that, end users can't open
 * DevTools to report a bug. This module keeps the most recent warnings/errors
 * in a ring buffer that survives SW sleep (via `storage.session`) so the popup
 * can offer a "copy diagnostic logs" button — see `src/components/Diagnostics.vue`.
 *
 * Design:
 * - In-memory ring is the source of truth for reads (fast, O(1) write). It is
 *   flushed to `storage.session` in batches (every {@link FLUSH_THRESHOLD}
 *   entries or {@link FLUSH_INTERVAL_MS}, whichever comes first) so high-rate
 *   logging never hammers storage.
 * - Level gating is compile-time: dev builds keep `debug`+; production keeps
 *   `warn`+. Filtered-out levels never enter the buffer, but `error` always
 *   reaches the console regardless of build.
 * - The content script and the SW are separate realms with separate buffers.
 *   Only the SW buffer is wired to `storage.session` and the popup export path;
 *   content-script instances still log to console for local debugging.
 */
import type { LogEntry } from '@/messages/protocol'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Numeric weight for level comparisons (higher = more severe). */
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Maximum entries kept in the ring buffer. Older entries are evicted. */
const MAX_ENTRIES = 1000

/** Flush the session mirror after this many new entries accumulate. */
const FLUSH_THRESHOLD = 20

/** …or after this much idle time, whichever comes first. */
const FLUSH_INTERVAL_MS = 1000

/** Storage key under `chrome.storage.session`. */
const STORAGE_KEY = 'elogs'

/**
 * Minimum level that enters the buffer + console. Read fresh on every call so
 * tests can flip it via `vi.stubEnv('DEV')`; in a real bundle Vite inlines
 * `import.meta.env.DEV` as a boolean literal, so the branch is still eliminated
 * from the production build (no runtime env read).
 */
function minLevel(): LogLevel {
  return import.meta.env.DEV ? 'debug' : 'warn'
}

// ---------------------------------------------------------------------------
// Ring buffer (module-singleton, shared by all loggers in this realm)
// ---------------------------------------------------------------------------

const buffer: LogEntry[] = []
let pendingFlush = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function evict(): void {
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES)
  }
}

/**
 * Persist the current buffer snapshot to `storage.session`. Fire-and-forget:
 * failures (e.g. storage full) only drop the mirror — the in-memory buffer is
 * unaffected, so the popup still reads from memory. Swallowed intentionally.
 */
function flushToSession(): void {
  pendingFlush = false
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    void chrome.storage.session?.set({ [STORAGE_KEY]: buffer.slice() }).catch(() => {
      /* storage.session may be unavailable in some contexts; buffer stays in memory */
    })
  } catch {
    /* chrome.storage.session undefined in non-extension contexts (tests) */
  }
}

function scheduleFlush(): void {
  if (pendingFlush) return
  // Threshold-triggered flush: once enough new entries pile up, write immediately.
  if (buffer.length > 0 && buffer.length % FLUSH_THRESHOLD === 0) {
    flushToSession()
    return
  }
  // Otherwise debounce: coalesce a burst of logs into one write.
  if (flushTimer === null) {
    flushTimer = setTimeout(flushToSession, FLUSH_INTERVAL_MS)
  }
}

/**
 * Normalize the optional `data` arg into something JSON-serializable. Plain
 * errors would otherwise render as `[object Object]` in the exported log.
 */
function serializeData(data: unknown): unknown {
  if (data instanceof Error) {
    const plain: Record<string, unknown> = { message: data.message }
    if (data.stack) plain.stack = data.stack
    return plain
  }
  return data
}

function record(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel()]) return

  const entry: LogEntry = {
    ts: Date.now(),
    level,
    scope,
    msg,
    data: data === undefined ? undefined : serializeData(data),
  }
  buffer.push(entry)
  evict()
  scheduleFlush()

  // Always mirror to console too (respects browser devtools filtering). Keeping
  // the `[EqualLoud]` prefix preserves the existing convention and makes the
  // lines greppable across the SW/content/popup consoles.
  const prefix = `[EqualLoud] ${scope}`
  switch (level) {
    case 'debug':
      console.debug(prefix, msg, data ?? '')
      break
    case 'info':
      console.info(prefix, msg, data ?? '')
      break
    case 'warn':
      console.warn(prefix, msg, data ?? '')
      break
    case 'error':
      console.error(prefix, msg, data ?? '')
      break
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, data?: unknown): void
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
}

/** Create a scoped logger. `scope` tags every entry (e.g. 'sw', 'audio'). */
export function createLogger(scope: string): Logger {
  return {
    debug: (msg, data) => record('debug', scope, msg, data),
    info: (msg, data) => record('info', scope, msg, data),
    warn: (msg, data) => record('warn', scope, msg, data),
    error: (msg, data) => record('error', scope, msg, data),
  }
}

/** Ordered snapshot of the ring buffer (oldest first). Safe to mutate. */
export function getRecentLogs(): LogEntry[] {
  return buffer.slice()
}

/** Empty the in-memory buffer and clear the session mirror. */
export function clearLogs(): void {
  buffer.length = 0
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingFlush = false
  try {
    void chrome.storage.session?.remove(STORAGE_KEY).catch(() => {})
  } catch {
    /* non-extension context */
  }
}

/**
 * Restore the buffer from `storage.session` after the SW wakes from sleep.
 * Callers (the SW) `await` the returned promise before serving `GET_LOGS` so a
 * freshly-woken SW doesn't report an empty history. Idempotent and safe to call
 * from contexts without `chrome.storage.session` (tests) — it just no-ops.
 */
export function loadLogs(): Promise<void> {
  try {
    if (!chrome.storage?.session) return Promise.resolve()
  } catch {
    return Promise.resolve()
  }
  return chrome.storage.session
    .get(STORAGE_KEY)
    .then((result) => {
      const stored = result[STORAGE_KEY]
      if (Array.isArray(stored)) {
        buffer.length = 0
        for (const e of stored) {
          if (e && typeof e === 'object' && 'level' in e && 'msg' in e) buffer.push(e as LogEntry)
        }
        evict()
      }
    })
    .catch(() => {
      /* corrupt or missing — leave buffer as-is */
    })
}
