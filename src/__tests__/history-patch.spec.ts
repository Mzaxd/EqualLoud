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
 *  2. The nav callback fires exactly once per call.
 *  3. Idempotency: a second patch on the same history is a no-op (extension
 *     reload over an open tab must not stack callbacks).
 *  4. The restore function unwraps back to the true originals.
 *
 * jsdom provides a real `history`, so we exercise the actual pushState path.
 */
describe('patchHistoryApi', () => {
  beforeEach(() => {
    // Clear any marker left by a previous test so each starts from a clean
    // (unpatched) history. The marker is a well-known Symbol, so we reach it
    // via the same cast the implementation uses.
    const marker = Symbol.for('equalloudHistoryPatched')
    const hist = history as unknown as Record<symbol, unknown>
    delete hist[marker]
  })

  it('fires the nav callback on pushState', () => {
    const onNav = vi.fn()
    const restore = patchHistoryApi(onNav)
    try {
      history.pushState({}, '', '/new-path')
      expect(onNav).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('fires the nav callback on replaceState', () => {
    const onNav = vi.fn()
    const restore = patchHistoryApi(onNav)
    try {
      history.replaceState({}, '', '/replaced')
      expect(onNav).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('still calls the original pushState (returns its value, updates location)', () => {
    const restore = patchHistoryApi(() => {})
    try {
      const result = history.pushState({ x: 1 }, '', '/preserved')
      expect(result).toBeUndefined() // pushState returns void
      expect(location.pathname).toBe('/preserved')
      expect(history.state).toEqual({ x: 1 })
    } finally {
      restore()
    }
  })

  it('does not fire the callback after restore', () => {
    const onNav = vi.fn()
    const restore = patchHistoryApi(onNav)
    restore()
    history.pushState({}, '', '/after-restore')
    expect(onNav).not.toHaveBeenCalled()
  })

  it('restores the true original pushState (re-patch sees an unwrapped method)', () => {
    const before = history.pushState
    const restore = patchHistoryApi(() => {})
    expect(history.pushState).not.toBe(before) // wrapped
    restore()
    expect(history.pushState).toBe(before) // back to the real one
  })

  it('is idempotent: a second patch on already-patched history is a no-op', () => {
    const onNav1 = vi.fn()
    const onNav2 = vi.fn()
    const restore1 = patchHistoryApi(onNav1)
    const restore2 = patchHistoryApi(onNav2) // should detect the marker & bail
    try {
      history.pushState({}, '', '/idempotent')
      // Only the FIRST callback fires; the second patch took the early-return
      // path and never wrapped.
      expect(onNav1).toHaveBeenCalledTimes(1)
      expect(onNav2).not.toHaveBeenCalled()
    } finally {
      restore2() // no-op restore
      restore1() // real restore
    }
    // After both restores, a new pushState fires neither.
    history.pushState({}, '', '/clean')
    expect(onNav1).toHaveBeenCalledTimes(1)
    expect(onNav2).not.toHaveBeenCalled()
  })

  it('survives a throwing nav callback (does not break pushState)', () => {
    const restore = patchHistoryApi(() => {
      throw new Error('boom')
    })
    try {
      // The wrapper swallows the error so the page's own pushState still works.
      expect(() => history.pushState({}, '', '/throwing')).not.toThrow()
      expect(location.pathname).toBe('/throwing')
    } finally {
      restore()
    }
  })
})
