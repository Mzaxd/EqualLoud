import { describe, it, expect, vi, beforeEach } from 'vitest'

import { patchHistoryApi } from '@/content/history-patch'

/**
 * Tests for the content-script SPA-navigation patch.
 *
 * `patchHistoryApi` wraps `history.pushState` / `replaceState` so route changes
 * on SPAs (YouTube, Twitter, …) fire the content script's rescan. The contract
 * that matters:
 *
 *  1. A wrapped method still calls through to the original (pages rely on it).
 *  2. Every registered nav callback fires exactly once per call (fan-out).
 *  3. Registration is idempotent at the wrapper level: a second patch REUSES
 *     the existing wrapper instead of stacking one — this is what lets a
 *     re-injected content script receive callbacks after an extension reload,
 *     where the old generation's `pagehide` cleanup never ran.
 *  4. Unsubscribe removes that callback; unwrapping happens only when the last
 *     callback leaves (history goes back identity-equal to the true original).
 *
 * jsdom provides a real `history`, so we exercise the actual pushState path.
 */
describe('patchHistoryApi', () => {
  beforeEach(() => {
    // Drop any registry left by a previous test so each starts from an
    // unpatched history. The registry lives under a well-known Symbol.
    const hist = history as unknown as Record<symbol, unknown>
    delete hist[Symbol.for('equalloudHistoryNavRegistry')]
    // A previous test's describe-level failure could leave methods wrapped;
    // nothing else to clean since restores are unconditional in `finally`.
  })

  it('fires the nav callback on pushState', () => {
    const onNav = vi.fn()
    const unsub = patchHistoryApi(onNav)
    try {
      history.pushState({}, '', '/new-path')
      expect(onNav).toHaveBeenCalledTimes(1)
    } finally {
      unsub()
    }
  })

  it('fires the nav callback on replaceState', () => {
    const onNav = vi.fn()
    const unsub = patchHistoryApi(onNav)
    try {
      history.replaceState({}, '', '/replaced')
      expect(onNav).toHaveBeenCalledTimes(1)
    } finally {
      unsub()
    }
  })

  it('still calls the original pushState (returns its value, updates location)', () => {
    const unsub = patchHistoryApi(() => {})
    try {
      const result = history.pushState({ x: 1 }, '', '/preserved')
      expect(result).toBeUndefined() // pushState returns void
      expect(location.pathname).toBe('/preserved')
      expect(history.state).toEqual({ x: 1 })
    } finally {
      unsub()
    }
  })

  it('does not fire a callback after it unsubscribed', () => {
    const onNav = vi.fn()
    const unsub = patchHistoryApi(onNav)
    unsub()
    history.pushState({}, '', '/after-restore')
    expect(onNav).not.toHaveBeenCalled()
  })

  it('restores the true original pushState once the last subscriber leaves', () => {
    const before = history.pushState
    const unsub = patchHistoryApi(() => {})
    expect(history.pushState).not.toBe(before) // wrapped
    unsub()
    expect(history.pushState).toBe(before) // back to the real one

    // And a re-patch after full restore wraps fresh from the true original.
    const beforeAgain = history.pushState
    const unsub2 = patchHistoryApi(() => {})
    expect(history.pushState).not.toBe(beforeAgain)
    unsub2()
    expect(history.pushState).toBe(beforeAgain)
  })

  it('fans out: both generations receive navigation callbacks (reload scenario)', () => {
    // Extension reload over an open tab: generation 1 never runs its cleanup,
    // generation 2 injects fresh. Both must hear navigations (the old boolean
    // marker silently starved generation 2).
    const onNav1 = vi.fn()
    const onNav2 = vi.fn()
    const unsub1 = patchHistoryApi(onNav1)
    const unsub2 = patchHistoryApi(onNav2)
    try {
      history.pushState({}, '', '/fanout')
      expect(onNav1).toHaveBeenCalledTimes(1)
      expect(onNav2).toHaveBeenCalledTimes(1)

      // Generation 1 is gone (its tab closed without pagehide cleanup? or normal
      // unsubscribe) — generation 2 keeps working alone…
      unsub1()
      history.pushState({}, '', '/fanout-2')
      expect(onNav1).toHaveBeenCalledTimes(1)
      expect(onNav2).toHaveBeenCalledTimes(2)

      // …and after BOTH leave, a new registration wraps the true originals
      // again and nobody stale fires.
      unsub2()
      history.pushState({}, '', '/clean')
      expect(onNav1).toHaveBeenCalledTimes(1)
      expect(onNav2).toHaveBeenCalledTimes(2)
    } finally {
      // Idempotent unsubscribes.
      unsub1()
      unsub2()
    }
    const fresh = vi.fn()
    const unsubFresh = patchHistoryApi(fresh)
    try {
      history.pushState({}, '', '/fresh')
      expect(fresh).toHaveBeenCalledTimes(1)
    } finally {
      unsubFresh()
    }
  })

  it('survives a throwing nav callback (does not break pushState or siblings)', () => {
    const healthy = vi.fn()
    const unsubBad = patchHistoryApi(() => {
      throw new Error('boom')
    })
    const unsubGood = patchHistoryApi(healthy)
    try {
      // The wrapper isolates failures so the page's own pushState still works
      // AND later-registered callbacks still run.
      expect(() => history.pushState({}, '', '/throwing')).not.toThrow()
      expect(location.pathname).toBe('/throwing')
      expect(healthy).toHaveBeenCalledTimes(1)
    } finally {
      unsubBad()
      unsubGood()
    }
  })
})
