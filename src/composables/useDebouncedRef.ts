import { onUnmounted } from 'vue'

/**
 * Debounce a writable ref's *writes* so that rapid successive sets (e.g. a
 * slider drag firing @input on every pixel) coalesce into one. The returned
 * ref mirrors the source synchronously for reads; only the watcher that fires
 * the side-effect is throttled.
 *
 * Used by AutoBalance / Limiter sliders so dragging doesn't flood the SW with
 * one SET_* message (each triggering a full rebalance + storage write) per
 * pixel — instead at most one call per `wait` ms trailing the last input.
 */
export function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void | Promise<void>,
  wait = 150,
): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: T
  const flush = () => {
    timer = null
    void fn(...lastArgs)
  }
  const debounced = (...args: T) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, wait)
  }
  onUnmounted(() => {
    if (timer) clearTimeout(timer)
  })
  return debounced
}
