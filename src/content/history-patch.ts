/**
 * Wrap `history.pushState` / `replaceState` so SPA route changes fire a
 * callback, used by the content script to re-scan for media elements on
 * client-side-navigating sites (YouTube, Twitter, Reddit, …).
 *
 * Extracted from `content/index.ts` so the idempotency + restore contract can
 * be unit-tested without dragging the whole content-script entry (and its
 * module-level side effects) into the test environment.
 */

/** Marker stashed on `history` to detect a previous, still-active patch. */
const PATCHED = Symbol.for('equalloudHistoryPatched')

/**
 * Wrap pushState/replaceState. Idempotent: if the page is already patched
 * (e.g. the extension was reloaded over an open tab), the second call is a
 * no-op and returns an empty restore — otherwise nav callbacks would stack
 * and fire N times per route change.
 *
 * @returns A restore function that unwraps the originals and clears the
 *   marker. Safe to call multiple times.
 */
export function patchHistoryApi(onNav: () => void): () => void {
  const hist = history as typeof history & Record<symbol, unknown>
  if (hist[PATCHED]) {
    return () => {}
  }
  hist[PATCHED] = true

  // Capture the true originals before wrapping so restore puts them back
  // exactly (identity-equal), which matters if other code checks `===`.
  const originals: Record<'pushState' | 'replaceState', typeof history.pushState> = {
    pushState: history.pushState,
    replaceState: history.replaceState,
  }

  const wrap = (key: 'pushState' | 'replaceState'): void => {
    history[key] = function patched(
      ...args: Parameters<typeof history.pushState>
    ): ReturnType<typeof history.pushState> {
      const r = originals[key].apply(this, args)
      try {
        onNav()
      } catch {
        // A throwing callback must not break the page's own navigation.
      }
      return r
    }
  }
  wrap('pushState')
  wrap('replaceState')

  return () => {
    delete hist[PATCHED]
    history.pushState = originals.pushState
    history.replaceState = originals.replaceState
  }
}
