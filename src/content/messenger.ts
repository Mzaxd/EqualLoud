/**
 * Content-script side of the SW communication channel (PRD §6.1.4).
 *
 * Content scripts talk to the SW over `chrome.runtime.sendMessage` (fire and
 * forget for notifications; we never await responses here). The SW talks back
 * over `chrome.tabs.sendMessage`, which is received on the `onMessage` listener
 * the content script registers via {@link onSwMessage}.
 */

import type { ContentToSwMessage, SwToContentMessage } from '@/messages/protocol'

/** Send a notification to the SW. Best-effort; never throws. */
export function notifySw(message: ContentToSwMessage): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      /* SW may be asleep/restarting; that's fine — it'll rebuild state. */
    })
  } catch {
    /* extension context invalidated (page reload racing the CS) — ignore */
  }
}

/** Register a handler for SW→content messages. Returns an unsubscribe fn. */
export function onSwMessage(handler: (msg: SwToContentMessage) => void): () => void {
  const listener = (msg: unknown): boolean | undefined => {
    if (!msg || typeof msg !== 'object') return
    const type = (msg as { type?: unknown }).type
    if (typeof type !== 'string') return
    // Only forward messages we recognise as SW→content directives.
    const known: SwToContentMessage['type'][] = ['SET_GAIN', 'SET_CONFIG', 'SET_LIMITER', 'PING']
    if (!known.includes(type as SwToContentMessage['type'])) return
    handler(msg as SwToContentMessage)
    return false
  }
  chrome.runtime.onMessage.addListener(listener)
  return () => chrome.runtime.onMessage.removeListener(listener)
}
