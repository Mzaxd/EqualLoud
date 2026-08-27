import { onUnmounted } from 'vue'

/**
 * A debounced callback with an explicit escape hatch. `flush()` fires any
 * pending trailing call immediately (and cancels the timer) — used by slider
 * release handlers to commit the final value right away instead of waiting
 * out the trailing window, where a stale read of the store would otherwise
 * snap the control back mid-flight.
 */
export interface DebouncedCallback<T extends unknown[]> {
  (...args: T): void
  /** Fire a pending trailing invocation now; no-op when nothing is pending. */
  flush(): void
}

/**
 * Debounce a writable ref's *writes* so that rapid successive sets (e.g. a
 * slider drag firing @input on every pixel) coalesce into one. The returned
 * ref mirrors the source synchronously for reads; only the watcher that fires
 * the side-effect is throttled.
 *
 * Used by AutoBalance / Limiter sliders so dragging doesn't flood the SW with
 * one SET_* message (each triggering a full rebalance + storage write) per
 * pixel — instead at most one call per `wait` ms trailing the last input.
 *
 * On unmount a PENDING call is flushed, not dropped: adjusting a slider and
 * closing the popup within `wait` ms previously discarded the setting the
 * user had just seen applied on screen. The SW persists messages even as the
 * sender disappears, so the commit lands safely.
 */
export function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void | Promise<void>,
  wait = 150,
): DebouncedCallback<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: T
  const invoke = (): void => {
    timer = null
    void fn(...lastArgs)
  }
  const debounced = (...args: T): void => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(invoke, wait)
  }
  debounced.flush = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    invoke()
  }
  onUnmounted(() => {
    debounced.flush()
  })
  return debounced
}
