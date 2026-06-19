/**
 * EqualLoud content script entry point (PRD §6.1).
 *
 * Injected into every http(s) page at `document_idle`. If there's no media
 * element we bail almost instantly (near-zero overhead). Otherwise we attach
 * an audio graph to each media element, measure loudness, report it to the
 * service worker ~10 Hz, and apply the gain decisions the SW sends back.
 */

import { BOOST_REPORT_HZ, BOOST_REPORT_MS, LUFS_REPORT_HZ } from '@/audio/config'
import type { SwToContentMessage } from '@/messages/protocol'

import { attachAudioGraph, ensureContextAndUpgrade } from './audio-graph'
import { patchHistoryApi } from './history-patch'
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
  // Content scripts can't read their own tab id (it's not exposed to the page
  // context). Every message we send carries this sentinel; the SW overwrites it
  // with `sender.tab.id` on receipt. Kept as a named const for readability.
  const TAB_ID_SENTINEL = -1

  const manager = new MediaManager((el) => attachAudioGraph(el))

  // Tracks the handle whose LUFS we report upstream.
  let lastShortTerm = -Infinity
  let lastBlockCount = 0
  /**
   * The most recent gain (dB) applied to this tab's GainNode(s), captured from
   * `SET_GAIN`. Echoed back in `MEDIA_ATTACHED` / `LUFS_REPORT` so a SW that
   * lost its in-memory `tabs` Map on sleep can seed `appliedGainDb` instead of
   * defaulting to 0 dB — which would briefly blip the tab to full volume before
   * the next heartbeat re-balances it. 0 (unity) until the first decision.
   */
  let lastAppliedGainDb = 0
  let hasPrimary = false
  let unsubLufs: (() => void) | null = null
  /**
   * Epoch ms when the current primary attached. Used to run a faster LUFS
   * heartbeat during the first {@link BOOST_REPORT_MS} so the SW sees the first
   * measurement (and can issue the first gain decision) with ~40 ms alignment
   * instead of ~100 ms. Reset on every primary change.
   */
  let primaryAttachedAt = 0

  // Wire LUFS reporting to whichever element is currently primary.
  manager.onPrimaryChange = (primary) => {
    // Unsubscribe from the previous primary's worklet.
    unsubLufs?.()
    unsubLufs = null
    hasPrimary = primary !== null
    if (primary) {
      primaryAttachedAt = Date.now()
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
        tabId: TAB_ID_SENTINEL,
        title: document.title,
        url: location.href,
        appliedGainDb: lastAppliedGainDb,
      })
    }
  }

  // LUFS heartbeat: report measurements so the SW can balance and survive
  // restarts. We use a self-rescheduling timeout instead of a fixed interval so
  // the period can shrink during warm-up: the first {@link BOOST_REPORT_MS}
  // after a primary attaches runs at {@link BOOST_REPORT_HZ} (≈40 ms alignment),
  // then drops to the steady {@link LUFS_REPORT_HZ} (≈100 ms). This shaves
  // ~60 ms off time-to-first-gain-decision with no steady-state cost.
  let reportTimer: number | null = null
  const scheduleReport = () => {
    const sinceAttach = Date.now() - primaryAttachedAt
    const hz = sinceAttach < BOOST_REPORT_MS ? BOOST_REPORT_HZ : LUFS_REPORT_HZ
    reportTimer = window.setTimeout(reportAndReschedule, 1000 / hz)
  }
  const reportAndReschedule = () => {
    if (hasPrimary) {
      notifySw({
        type: 'LUFS_REPORT',
        tabId: TAB_ID_SENTINEL,
        shortTerm: lastShortTerm,
        blockCount: lastBlockCount,
        appliedGainDb: lastAppliedGainDb,
      })
    }
    scheduleReport()
  }
  scheduleReport()

  // React to SW directives.
  const off = onSwMessage((msg: SwToContentMessage) => {
    switch (msg.type) {
      case 'SET_GAIN':
        // Apply to every handle on the page (multi-video sites); the SW
        // computes one gain per tab, which is the right call for the main
        // player and harmless for incidental previews.
        for (const h of manager.getHandles()) h.setGain(msg.gainDb)
        lastAppliedGainDb = msg.gainDb
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
        // SW is checking we're alive. Re-announce so state rebuilds. Carry the
        // last applied gain so a recovering SW seeds it instead of 0 dB.
        notifySw({
          type: 'MEDIA_ATTACHED',
          tabId: TAB_ID_SENTINEL,
          title: document.title,
          url: location.href,
          appliedGainDb: lastAppliedGainDb,
        })
        break
    }
  })

  // Start watching the DOM.
  manager.start()

  // Session-restore / late-injection recovery: if the content script injected
  // AFTER a media element was already playing (e.g. Chrome restart → tab
  // restored → B站 video resumed autoplay), no NEW `play` event will fire, so
  // the lazy→full takeover would never be triggered. Probe once after the
  // MutationObserver has had a chance to discover and attach the element: if an
  // audibly-playing element exists, ensureContextAndUpgrade() is now authorised
  // (audible playback == playback permission) and lifts it onto a running
  // context. Harmless no-op when nothing is playing yet (gesture path handles
  // it later). Wrapped in setTimeout so the observer's initial rescan callback
  // runs first and populates the pending list.
  setTimeout(() => {
    ensureContextAndUpgrade()
  }, 0)

  // SPA navigation: re-scan on URL changes (YouTube, etc.).
  const onNav = () => manager.rescan()
  window.addEventListener('popstate', onNav)
  const restoreHistory = patchHistoryApi(onNav)

  // Autoplay policy: the shared AudioContext can only become `running` inside a
  // user-gesture handler, and until it does the media elements stay on the lazy
  // volume-only handles (see audio-graph.ts). The first gesture triggers the
  // real takeover: context is created+resumed in-gesture and every pending
  // element is upgraded to the full Web Audio chain — so the first audible
  // sample is already balanced, with no "original then corrected" jump and no
  // "AudioContext was not allowed to start" warning.
  //
  // `pointerdown`/`keydown` are `{ once }` because they're the *initial*
  // handshake — once the context exists and elements are upgraded we don't
  // need to re-trigger takeover. `play` stays persistent: a user-initiated
  // play (e.g. clicking a page's own play button) is also a valid activation,
  // and ensureContextAndUpgrade is idempotent, so firing it repeatedly is free.
  const handshake = () => ensureContextAndUpgrade()
  window.addEventListener('pointerdown', handshake, { once: true })
  window.addEventListener('keydown', handshake, { once: true })
  document.addEventListener('play', handshake, { capture: true })

  // Clean up on page unload so the SW drops this tab. Capture every listener we
  // added so nothing leaks; also restore the history API patch (important if the
  // extension is reloaded on an open tab — without this, patchHistoryApi would
  // wrap an already-wrapped method and nav callbacks would accumulate).
  const onPageHide = () => {
    if (reportTimer !== null) window.clearTimeout(reportTimer)
    off()
    window.removeEventListener('popstate', onNav)
    window.removeEventListener('pointerdown', handshake)
    window.removeEventListener('keydown', handshake)
    document.removeEventListener('play', handshake, { capture: true } as EventListenerOptions)
    window.removeEventListener('pagehide', onPageHide)
    restoreHistory()
    notifySw({ type: 'TAB_UNLOAD', tabId: TAB_ID_SENTINEL })
    manager.stop()
  }
  window.addEventListener('pagehide', onPageHide)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// (The TAB_ID_SENTINEL constant and its rationale live at the top of
// startEqualLoud, where it's first used. No module-level helpers remain — the
// history-patch helper moved to ./history-patch.ts for testability.)
