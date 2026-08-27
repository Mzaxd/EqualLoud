/**
 * Wrap `history.pushState` / `replaceState` so SPA route changes fire a
 * callback, used by the content script to re-scan for media elements on
 * client-side-navigating sites (YouTube, Twitter, Reddit, …).
 *
 * Extracted from `content/index.ts` so the idempotency + restore contract can
 * be unit-tested without dragging the whole content-script entry (and its
 * module-level side effects) into the test environment.
 *
 * ── Why a shared registry (not a winner-takes-all marker) ──────────────────
 * A boolean "already patched" marker breaks across extension reloads: the
 * reload does NOT fire `pagehide`, so the old generation's wrapper stays
 * installed holding only ITS nav callback, and a freshly injected script
 * hit the marker and never received pushState/replaceState callbacks for the
 * rest of the page's life. Instead, one shared registry under `Symbol.for`
 * fans each navigation out to every registered callback; generations
 * register/unregister cooperatively. The original methods go back exactly
 * when the last callback unsubscribes.
 */

interface HistoryPatchRegistry {
  /** Every active session's nav callback. */
  readonly cbs: Set<() => void>
  /** Identity-true originals captured before the first wrap. */
  readonly originals: Record<'pushState' | 'replaceState', typeof history.pushState>
}

/** Well-known symbol so independent injections find the same registry. */
const REGISTRY = Symbol.for('equalloudHistoryNavRegistry')

/**
 * Register {@link onNav} to fire on every SPA navigation.
 *
 * Idempotent by design: if no wrapper is installed yet (first injection, or
 * all previous sessions unregistered) the true originals are wrapped once;
 * subsequent registrations reuse it and fan out. Never stacks wrappers.
 *
 * @returns An unsubscribe function that removes this callback and unwraps
 *   history entirely when it was the last one. Safe to call multiple times.
 */
export function patchHistoryApi(onNav: () => void): () => void {
  const hist = history as typeof history & Record<symbol, HistoryPatchRegistry | undefined>
  let reg = hist[REGISTRY]
  if (!reg) {
    reg = {
      cbs: new Set(),
      // Capture the true originals before wrapping so an eventual restore puts
      // them back exactly (identity-equal), which matters if other code checks `===`.
      originals: { pushState: history.pushState, replaceState: history.replaceState },
    }
    hist[REGISTRY] = reg

    const wrap = (key: 'pushState' | 'replaceState'): void => {
      const r = reg!
      history[key] = function patched(
        ...args: Parameters<typeof history.pushState>
      ): ReturnType<typeof history.pushState> {
        const result = r.originals[key].apply(this, args)
        // A throwing callback must not break the page's own navigation, nor
        // starve the other registered generations.
        for (const cb of r.cbs) {
          try {
            cb()
          } catch {
            /* isolated failure */
          }
        }
        return result
      }
    }
    wrap('pushState')
    wrap('replaceState')
  }

  reg.cbs.add(onNav)
  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    const current = hist[REGISTRY]
    if (!current) return
    current.cbs.delete(onNav)
    // Last session out restores the true methods so a later identity check
    // (`history.pushState === before`) still holds for the page.
    if (current.cbs.size === 0) {
      history.pushState = current.originals.pushState
      history.replaceState = current.originals.replaceState
      delete hist[REGISTRY]
    }
  }
}
