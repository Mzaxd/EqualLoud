/**
 * EqualLoud content script entry point (PRD §6.1).
 *
 * Injected into every http(s) page at `document_idle`. If there's no media
 * element we bail almost instantly (near-zero overhead). Otherwise we attach
 * an audio graph to each media element, measure loudness, report it to the
 * service worker ~10 Hz, and apply the gain decisions the SW sends back.
 */

import { LUFS_REPORT_HZ } from '@/audio/config'
import type { SwToContentMessage } from '@/messages/protocol'

import { attachAudioGraph, resumeSharedContext } from './audio-graph'
import { MediaManager } from './media-manager'
import { notifySw, onSwMessage } from './messenger'

// --- early exit: no media, no work ------------------------------------------------
if (document.querySelector('video, audio')) {
  startEqualLoud()
} else {
  // The page might add media later (SPA, lazy player, scroll-triggered embed).
  // Watch the DOM indefinitely: a MutationObserver that fires on no mutations
  // is essentially free, and tearing down after a fixed timeout (the old 60s)
  // meant lazy players appearing later were never attached for the tab's life.
  const probe = new MutationObserver(() => {
    if (document.querySelector('video, audio')) {
      probe.disconnect()
      startEqualLoud()
    }
  })
  probe.observe(document.documentElement, { childList: true, subtree: true })
}

function startEqualLoud(): void {
  const tabId = getTabId()

  const manager = new MediaManager((el) => attachAudioGraph(el))

  // Tracks the handle whose LUFS we report upstream.
  let lastShortTerm = -Infinity
  let lastBlockCount = 0
  let hasPrimary = false
  let unsubLufs: (() => void) | null = null

  // Wire LUFS reporting to whichever element is currently primary.
  manager.onPrimaryChange = (primary) => {
    // Unsubscribe from the previous primary's worklet.
    unsubLufs?.()
    unsubLufs = null
    hasPrimary = primary !== null
    if (primary) {
      const handle = manager.getHandleFor(primary)
      if (handle) {
        lastShortTerm = -Infinity
        lastBlockCount = 0
        unsubLufs = handle.onLufs((u) => {
          lastShortTerm = u.shortTerm
          lastBlockCount = u.blockCount
        })
      }
      notifySw({
        type: 'MEDIA_ATTACHED',
        tabId,
        title: document.title,
        url: location.href,
      })
    }
  }

  // ~10 Hz heartbeat: report LUFS so the SW can balance and survive restarts.
  // Note: per-tab balance bypass does NOT gate this — measurement must keep
  // running while bypassed so re-enabling snaps to the right gain instantly.
  const reportTimer = window.setInterval(() => {
    if (!hasPrimary) return
    notifySw({
      type: 'LUFS_REPORT',
      tabId,
      shortTerm: lastShortTerm,
      blockCount: lastBlockCount,
    })
  }, 1000 / LUFS_REPORT_HZ)

  // React to SW directives.
  const off = onSwMessage((msg: SwToContentMessage) => {
    switch (msg.type) {
      case 'SET_GAIN':
        // Apply to every handle on the page (multi-video sites); the SW
        // computes one gain per tab, which is the right call for the main
        // player and harmless for incidental previews.
        for (const h of manager.getHandles()) h.setGain(msg.gainDb)
        break
      case 'SET_CONFIG':
        // The SW sends config so newly-attached tabs pick up the current
        // target. The content script itself doesn't need target — balancing
        // is centralised in the SW — so this is a no-op apart from ack.
        break
      case 'SET_LIMITER':
        for (const h of manager.getHandles()) h.setLimiter(msg.settings)
        break
      case 'PING':
        // SW is checking we're alive. Re-announce so state rebuilds.
        notifySw({ type: 'MEDIA_ATTACHED', tabId, title: document.title, url: location.href })
        break
    }
  })

  // Start watching the DOM.
  manager.start()

  // SPA navigation: re-scan on URL changes (YouTube, etc.).
  const onNav = () => manager.rescan()
  window.addEventListener('popstate', onNav)
  const restoreHistory = patchHistoryApi(onNav)

  // Autoplay policy: resume the shared AudioContext on first user gesture / play.
  // `play` has no { once } because the context can be re-suspended (e.g. after
  // a long backgrounding); we want every play to nudge it back. The listener is
  // explicitly removed on pagehide below.
  const resumeAll = () => resumeSharedContext()
  window.addEventListener('pointerdown', resumeAll, { once: true })
  window.addEventListener('keydown', resumeAll, { once: true })
  document.addEventListener('play', resumeAll, { capture: true })

  // Clean up on page unload so the SW drops this tab. Capture every listener we
  // added so nothing leaks; also restore the history API patch (important if the
  // extension is reloaded on an open tab — without this, patchHistoryApi would
  // wrap an already-wrapped method and nav callbacks would accumulate).
  const onPageHide = () => {
    window.clearInterval(reportTimer)
    off()
    window.removeEventListener('popstate', onNav)
    window.removeEventListener('pointerdown', resumeAll)
    window.removeEventListener('keydown', resumeAll)
    document.removeEventListener('play', resumeAll, { capture: true } as EventListenerOptions)
    window.removeEventListener('pagehide', onPageHide)
    restoreHistory()
    notifySw({ type: 'TAB_UNLOAD', tabId })
    manager.stop()
  }
  window.addEventListener('pagehide', onPageHide)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The SW can't tell us our own tabId; we don't have it either. Use a stable
 *  per-page sentinel and let the SW key on the sender.tab.id it does know. */
function getTabId(): number {
  // sender.tab.id is authoritative on the SW side; from the content script we
  // don't have it, so send -1 and rely on the SW to overwrite from sender.
  return -1
}

/**
 * Wrap history.pushState/replaceState so SPA route changes fire our callback.
 * Idempotent: a marker on `history` prevents double-wrapping if the extension
 * is reloaded on an already-patched page (otherwise nav callbacks accumulate).
 * Returns a restore function that unwraps the originals.
 */
function patchHistoryApi(onNav: () => void): () => void {
  // Guard against re-patching on extension reload over an open tab.
  const marker = Symbol.for('equalloudHistoryPatched')
  const hist = history as unknown as Record<symbol, unknown>
  if (hist[marker]) {
    // Already patched by a previous injection; nothing to do, no-op restore.
    return () => {}
  }
  hist[marker] = true
  const origs: Record<'pushState' | 'replaceState', typeof history.pushState> = {
    pushState: history.pushState,
    replaceState: history.replaceState,
  }
  const wrap = (key: 'pushState' | 'replaceState') => {
    history[key] = function patched(
      ...args: Parameters<typeof history.pushState>
    ): ReturnType<typeof history.pushState> {
      const r = origs[key].apply(this, args)
      try {
        onNav()
      } catch {
        /* ignore */
      }
      return r
    }
  }
  wrap('pushState')
  wrap('replaceState')
  return () => {
    delete hist[marker]
    history.pushState = origs.pushState
    history.replaceState = origs.replaceState
  }
}
