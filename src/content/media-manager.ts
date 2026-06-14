/**
 * Media-element discovery for the content script (PRD §6.1.1, §10.4).
 *
 * Video/audio sites are SPAs: `<video>` elements come and go as the user
 * navigates or as ads insert themselves. The MediaManager watches the DOM with
 * a MutationObserver, attaches to every new media element, and detaches from
 * ones that leave. The "which element do we report loudness for?" decision is
 * the pure, unit-tested {@link pickPrimaryMedia} function below.
 */

import type { AudioGraphHandle } from './audio-graph'

/** Minimal shape we need from a media element to pick a primary one. */
export interface MediaCandidate {
  el: HTMLMediaElement
  videoWidth: number
  duration: number
  /** offsetParent === null means the element is not rendered (display:none etc). */
  visible: boolean
  muted: boolean
}

/**
 * Decide which media element on a page should drive the loudness report.
 *
 * Heuristic (PRD §10.4): the primary element is the one that is biggest,
 * longest, visible and not muted — the union-optimal pick. Ads and preview
 * thumbnails lose to the main player.
 *
 * Pure and side-effect free so it can be unit-tested without a DOM.
 */
export function pickPrimaryMedia(candidates: MediaCandidate[]): MediaCandidate | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!

  let best = candidates[0]!
  let bestScore = score(best)
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!
    const sc = score(c)
    if (sc > bestScore) {
      best = c
      bestScore = sc
    }
  }
  // If every candidate is invisible or muted, the "winner" is still penalised
  // (score < 0). Don't promote a muted preview thumbnail to primary — return
  // null so the SW stops balancing against a meaningless target.
  return bestScore < 0 ? null : best
}

/**
 * Score a candidate higher when it is visible, unmuted, larger and longer.
 * Visibility and mutedness are gates (invisible/muted elements are heavily
 * penalised); size/duration break ties.
 */
function score(c: MediaCandidate): number {
  let s = 0
  // Gates: invisible or muted elements are almost certainly not the main media.
  s += c.visible ? 0 : -1_000_000
  s += c.muted ? -1_000_000 : 0
  // videoWidth is the strongest signal for video (a 1280px-wide main player
  // dwarfs a 320px ad). Use 1 for audio (videoWidth is 0).
  s += (c.videoWidth || 0) * 10
  // Duration: the main video is usually minutes long; ads/previews are short.
  if (Number.isFinite(c.duration) && c.duration > 0) {
    s += Math.min(c.duration, 3600)
  }
  return s
}

/**
 * Whether the manager should attach to a media element at all. We skip elements
 * that are far too short to be real media (data: URIs, zero-length beeps) and
 * ones already detached from the DOM. Attaching is cheap but re-creating an
 * AudioContext source for a 0.1s blip is wasteful.
 */
export function shouldAttach(el: HTMLMediaElement): boolean {
  if (!el.isConnected) return false
  // A media element with no source at all can still load one later, so don't
  // reject on missing src; but a finite non-positive duration usually means a
  // decorative blip. NaN duration (streaming, not yet known) is fine.
  const d = el.duration
  if (Number.isFinite(d) && d > 0 && d < 0.2) return false
  return true
}

/**
 * Watches the document for media elements and keeps an {@link AudioGraphHandle}
 * attached to each. Tracks which element is the "primary" one so the content
 * script knows where to read loudness from.
 */
export class MediaManager {
  private readonly handles = new Map<HTMLMediaElement, AudioGraphHandle>()
  private readonly observer: MutationObserver
  private primary: HTMLMediaElement | null = null
  /** Called whenever the primary media element changes (may be null). */
  onPrimaryChange: ((primary: HTMLMediaElement | null) => void) | null = null

  constructor(private readonly attach: (el: HTMLMediaElement) => AudioGraphHandle | null) {
    this.observer = new MutationObserver(() => this.rescan())
  }

  /** Begin watching. Performs an initial scan. */
  start(): void {
    this.rescan()
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  }

  stop(): void {
    this.observer.disconnect()
    for (const handle of this.handles.values()) handle.dispose()
    this.handles.clear()
    this.primary = null
  }

  /** Current primary media element, or null if none attached. */
  getPrimary(): HTMLMediaElement | null {
    return this.primary
  }

  /** All currently-attached handles. */
  getHandles(): AudioGraphHandle[] {
    return Array.from(this.handles.values())
  }

  /** Handle for a specific element, or undefined if not attached. */
  getHandleFor(el: HTMLMediaElement): AudioGraphHandle | undefined {
    return this.handles.get(el)
  }

  /** Re-scan the DOM, attach to new media, detach from gone media, re-pick primary. */
  rescan(): void {
    const elements = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))

    // Detach elements no longer present.
    for (const el of Array.from(this.handles.keys())) {
      if (!elements.includes(el)) {
        this.detach(el)
      }
    }

    // Attach new elements.
    let attached = false
    for (const el of elements) {
      if (this.handles.has(el)) continue
      if (!shouldAttach(el)) continue
      const handle = this.attach(el)
      if (handle) {
        this.handles.set(el, handle)
        attached = true
      }
    }

    // Re-pick primary whenever the candidate set may have changed.
    if (attached || this.primary === null || !document.contains(this.primary)) {
      this.repickPrimary()
    }
  }

  private detach(el: HTMLMediaElement): void {
    const handle = this.handles.get(el)
    if (handle) {
      handle.dispose()
      this.handles.delete(el)
    }
    const wasPrimary = this.primary === el
    if (wasPrimary) this.primary = null
    // If we just removed the primary, re-pick synchronously so the orchestrator
    // is told immediately (it unsubscribes the dead element's LUFS callback and
    // stops reporting stale readings) rather than waiting for the next rescan.
    if (wasPrimary) this.repickPrimary()
  }

  private repickPrimary(): void {
    const candidates: MediaCandidate[] = Array.from(this.handles.keys()).map((el) => ({
      el,
      videoWidth: (el as HTMLVideoElement).videoWidth || 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      visible: el.offsetParent !== null,
      muted: el.muted,
    }))
    const picked = pickPrimaryMedia(candidates)
    const next = picked ? picked.el : null
    if (next !== this.primary) {
      this.primary = next
      this.onPrimaryChange?.(next)
    }
  }
}
