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
  /**
   * Whether the element is actively playing. On infinite-feed sites (Instagram
   * Reels, Douyin, TikTok) several `<video>` elements coexist in the DOM — the
   * currently visible reel plus pre-loaded neighbours. They share the same
   * videoWidth and similar durations, so size/duration scoring alone can't tell
   * them apart and the primary jitters between elements as the user scrolls,
   * which starves the LUFS pipeline. `!paused && !ended` is the only reliable
   * "this is the one the user is hearing right now" signal.
   */
  paused: boolean
  ended: boolean
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
  // Playing gate: on multi-video feed pages (Reels/Douyin/TikTok) many elements
  // coexist with identical size/duration, so the deciding signal is "which one
  // is actually playing". A paused/ended element is almost never what the user
  // is hearing — penalise it harder than muted (which is -1e6) but below the
  // "all candidates bad" threshold so a single paused element can still win if
  // nothing else is playing (e.g. between reels). Picked via 1e6 > x > 5e5.
  s += c.paused || c.ended ? -500_000 : 0
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

  /**
   * Document-level delegate for media events that change which element is
   * "playing" or change its scored attributes (duration, videoWidth). Wired in
   * {@link start}, removed in {@link stop}. Capture phase so we hear events
   * from elements that stopPropagation (some SPAs do). One listener for all
   * elements — cheaper than per-element addEventListener and survives DOM
   * recycling without re-binding.
   */
  private readonly onMediaEvent = (ev: Event): void => {
    const el = ev.target as HTMLMediaElement | null
    if (!el || !this.handles.has(el)) return
    // A new source loaded into an existing media element (SPA video swap,
    // Reels/TikTok next clip, ad insert, …). The worklet's block counter, ring
    // buffer and K-weighting states still reflect the PREVIOUS content; without
    // a reset the new clip's first few hundred ms would be measured against a
    // half-mixed window and reported as "trusted" (blockCount > 0), driving the
    // gain from a contaminated reading. Reset BEFORE the repick so a primary
    // change driven by loadstart (the common Reels case) sees a clean pipeline.
    if (ev.type === 'loadstart' || ev.type === 'emptied') {
      this.handles.get(el)?.resetLufs()
    }
    // play/pause/durationchange/loadedmetadata all shift the primary scoring
    // (F4 weights !paused heavily; duration/videoWidth feed the tie-breakers).
    // A cheap repick — no DOM query, no attach/detach — so firing on every
    // play/pause is fine even on Reels/Douyin where these fire constantly.
    this.repickPrimary()
  }

  constructor(private readonly attach: (el: HTMLMediaElement) => AudioGraphHandle | null) {
    // attributeFilter on 'src': Reels/Douyin recycle <video> nodes by swapping
    // src rather than creating new elements, so childList-only observation
    // missed the "new clip loaded into the same node" transition entirely.
    // Without this the primary stayed glued to a stale clip's LUFS readings.
    //
    // Mutation coalescing: on DOM-busy sites (Twitter, Reddit, infinite-scroll)
    // the observer can fire dozens of times per frame. Each synchronous rescan()
    // does a querySelectorAll + full diff, which is wasteful when the next
    // mutation is already queued. We set a dirty flag and schedule ONE rescan
    // per microtask via queueMicrotask — within a single JS turn every batched
    // mutation collapses into a single query.
    let rescanQueued = false
    let pendingRepick = false
    this.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'src') {
          pendingRepick = true
        }
      }
      if (!rescanQueued) {
        rescanQueued = true
        queueMicrotask(() => {
          rescanQueued = false
          const shouldRepick = pendingRepick
          pendingRepick = false
          this.rescan()
          if (shouldRepick) this.repickPrimary()
        })
      }
    })
  }

  /** Begin watching. Performs an initial scan. */
  start(): void {
    this.rescan()
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    })
    // Media-event delegation: these fire before/around DOM mutations on feed
    // sites and carry the "which element is actually playing now" truth that
    // neither childList nor src-attribute observation can infer.
    for (const type of MEDIA_REPICK_EVENTS) {
      document.addEventListener(type, this.onMediaEvent, { capture: true })
    }
  }

  stop(): void {
    this.observer.disconnect()
    for (const type of MEDIA_REPICK_EVENTS) {
      document.removeEventListener(type, this.onMediaEvent, { capture: true })
    }
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
      paused: el.paused,
      ended: el.ended,
    }))
    const picked = pickPrimaryMedia(candidates)
    const next = picked ? picked.el : null
    if (next !== this.primary) {
      // Before the new primary's loudness drives anything, reset its LUFS
      // pipeline. A newly-promoted element was previously a non-primary (or a
      // detached neighbour on a feed page): its worklet has been accumulating
      // blocks against whatever it was playing before, and those stale readings
      // would bleed into the first balance decisions after the switch. The
      // loadstart/emptied handler above covers src swaps on the SAME element;
      // this covers a switch BETWEEN elements. The volume-only fallback's
      // resetLufs() is a no-op, so this is safe unconditionally.
      if (next) this.handles.get(next)?.resetLufs()
      this.primary = next
      this.onPrimaryChange?.(next)
    }
  }
}

/**
 * Media events whose firing should trigger a primary re-pick. Each changes a
 * scored attribute: play/pause flip the dominant `!paused` signal;
 * durationchange/loadedmetadata fill in duration (and videoWidth for video)
 * which break size/duration ties; loadstart fires when a recycled node loads a
 * new src. Captured at the document level by {@link MediaManager.start}.
 */
const MEDIA_REPICK_EVENTS = [
  'play',
  'pause',
  'durationchange',
  'loadedmetadata',
  'loadstart',
  'emptied',
] as const
