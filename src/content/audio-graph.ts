/**
 * Per-media-element audio graph (PRD §6.1.2).
 *
 * For each `<video>`/`<audio>` we attach to, we:
 *
 *   mediaElement
 *      │ createMediaElementSource  (intercepts the element's audio output)
 *      ▼
 *   MediaElementSource ──► GainNode ──► DynamicsCompressor ──► destination
 *      │                   (balance)    (limiter)              (speaker)
 *      └──► AudioWorklet("lufs-processor") ──► destination (silence)
 *
 * The worklet branch is parallel: it consumes the same source purely to
 * measure short-term LUFS and outputs silence, so the user never hears double.
 *
 * All media elements on a page share ONE AudioContext (Chrome caps concurrent
 * contexts at 6; per-element contexts broke multi-video sites instantly). Each
 * element gets its own source→gain→limiter→destination chain on that shared
 * context; dispose() tears down only that element's nodes and never closes the
 * shared context.
 *
 * If `createMediaElementSource` throws (the page already took the element, or
 * it's DRM-protected), we fall back to plain `element.volume` control so we can
 * at least attenuate (PRD §10.1, §10.5).
 *
 * ── Autoplay policy / lazy takeover ──────────────────────────────────────
 * Calling `createMediaElementSource` on a *suspended* AudioContext routes the
 * media's audio into a graph that isn't running → the element goes **silent**
 * until the context resumes. The context can only become `running` inside a
 * user-gesture handler (Chrome autoplay policy). Auto-play pages (Instagram
 * Reels, YouTube, etc.) therefore need us to *defer* the takeover:
 *
 *   1. Before the first user gesture we hand back a "lazy" handle that controls
 *      `element.volume` only (attenuate, never boost) and reports no LUFS. The
 *      SW still sees `isCapturing`/heartbeats and keeps the tab at a safe 0 dB.
 *   2. On the first gesture the content script calls `ensureContextAndUpgrade()`
 *      (this module), which creates+resumes the context *inside the gesture*
 *      and upgrades every pending element to the full Web Audio chain. The very
 *      first audible sample is already balanced — no "original then corrected"
 *      jump. The autoplay warning disappears because creation happens in-gesture.
 */

import { GAIN_ATTACK_TC, GAIN_SMOOTH_TC } from '@/audio/config'
import { dbToGain } from '@/audio/lufs'
import type { LimiterSettings } from '@/messages/protocol'
import { createLogger } from '@/utils/logger'
import lufsProcessorUrl from '@/worklets/lufs-processor?worker&url'

const log = createLogger('audio')

/** What a successful measurement update looks like to the content script. */
export interface LufsUpdate {
  shortTerm: number
  blockCount: number
}

export interface AudioGraphHandle {
  /** Apply a gain decision (dB). Smoothed over GAIN_SMOOTH_TC. */
  setGain(gainDb: number): void
  /** Update the output limiter. */
  setLimiter(settings: LimiterSettings): void
  /** Subscribe to LUFS measurements (~LUFS_REPORT_HZ). Returns unsubscribe. */
  onLufs(cb: (u: LufsUpdate) => void): () => void
  /**
   * Reset the LUFS pipeline (block counter, K-weighting filter states, ring
   * buffer, histories). Call when the element loads a new source (SPA video
   * swap, Reels/TikTok next clip, ad insert) or when this element becomes the
   * new primary — otherwise a warmed-up worklet keeps reporting stale block
   * counts and a half-mixed ring buffer from the *previous* content, so the
   * new clip's first few hundred ms read as "trusted" and drive the gain from
   * a contaminated measurement. No-op on the volume-only fallback (no
   * worklet) and safe to call before the worklet has loaded.
   */
  resetLufs(): void
  /** Tear everything down and release the element. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Shared AudioContext (per page). Chrome caps concurrent AudioContexts at ~6;
// creating one per media element broke multi-video sites (Twitter, Reddit,
// infinite-scroll YouTube) within seconds. One context serves N element
// chains — source nodes are independent.
//
// The context is NOT created at attach time (see the lazy-takeover note in the
// file header). It springs to life on the first user gesture, inside the
// gesture handler, so Chrome's autoplay policy lets it become `running`.
// ---------------------------------------------------------------------------

let sharedCtx: AudioContext | null = null
let workletReady: Promise<void> | null = null
const attachedSources = new WeakSet<HTMLMediaElement>()

/**
 * Elements that received a lazy (volume-only) handle and are waiting for the
 * first user gesture to be upgraded to a full Web Audio chain. Each entry
 * keeps the upgrade target alive so a late gesture still wires up the element.
 */
interface PendingTakeover {
  el: HTMLMediaElement
  /** Set once upgraded/disposed so a racing late gesture can't double-wire. */
  done: boolean
}
const pending: PendingTakeover[] = []
let contextHandshaken = false

/**
 * Number of currently-attached handles (lazy + upgraded). The shared
 * AudioContext is closed only when this drops to zero AND the extension
 * context is gone — never while a tab is actively producing audio. This is
 * the lifetime backstop the old code lacked: `pagehide` disposed each
 * element's nodes but the shared context lived forever, leaking across
 * extension reloads.
 */
let activeHandleCount = 0

/**
 * Close the shared AudioContext if (a) the extension context has been
 * invalidated (reload/disable) and (b) no handles remain attached. Safe to
 * call any time — it re-checks both conditions. Closing while handles are
 * live would cut their audio, so we only close on the teardown path.
 */
function maybeCloseSharedContext(): void {
  if (!sharedCtx) return
  if (sharedCtx.state === 'closed') return
  if (activeHandleCount > 0) return
  // Only close when the extension is actually going away; a transient
  // zero-handle state (e.g. between two videos on an SPA) should keep the
  // context warm for the next attach. `chrome.runtime.contextInvalidated` is
  // a boolean property (Chrome 116+); once true it stays true and every
  // chrome.* call starts throwing.
  const rt = chrome.runtime as typeof chrome.runtime & { contextInvalidated?: boolean }
  if (!rt.contextInvalidated) return
  try {
    void sharedCtx.close()
    sharedCtx = null
    workletReady = null
    contextHandshaken = false
  } catch {
    /* already closed — ignore */
  }
}

// The extension-reload / disable signal. When this fires, every chrome.* call
// starts throwing; we respond by closing the context once handles drain.
// `onContextInvalidated` is Chrome 116+ and not in @types/chrome yet, hence
// the cast. Guarded so the module loads in test/jsdom contexts where `chrome`
// may be undefined.
if (typeof chrome !== 'undefined') {
  const onContextInvalidated = (
    chrome.runtime as typeof chrome.runtime & {
      onContextInvalidated?: { addListener: (cb: () => void) => void }
    }
  ).onContextInvalidated
  if (onContextInvalidated) {
    onContextInvalidated.addListener(() => {
      // If handles are still attached (audio playing), defer — each handle's
      // dispose() decrements the counter and re-checks. If none are attached,
      // close immediately.
      maybeCloseSharedContext()
    })
  }
}

/**
 * Whether any media element awaiting takeover is currently playing AND unmuted.
 * Such an element is already producing audible sound, which means Chrome has
 * granted the page playback permission (session-restore autoplay, a prior
 * gesture, …) — and that permission is what lets a take-over AudioContext reach
 * `running`. Used to authorise context creation without a live userActivation.
 */
function hasAudiblePlayback(): boolean {
  for (const p of pending) {
    const el = p.el
    // `paused`/`ended`/`muted` are the standard "is this making sound?" signals.
    // readyState check avoids treating a not-yet-playing element as audible.
    if (!el.paused && !el.ended && !el.muted && el.readyState >= 2) return true
  }
  return false
}

/**
 * Whether it is currently legal to *create* the AudioContext and expect it to
 * reach `running`. Chrome's autoplay policy allows this only while the document
 * has a transient user activation. A muted-autoplay `play` event does NOT carry
 * that activation, so we must NOT create the context from it — that is exactly
 * what produced the "AudioContext was not allowed to start" warning.
 *
 * `navigator.userActivation` (Chrome/Edge) is the reliable signal; we fall back
 * to `true` where it's absent (older browsers) so we never get permanently stuck
 * — the worst case there is the original warning, not a dead feature.
 *
 * `audiblePlayback` is the escape hatch for the session-restore case: when
 * Chrome reopens with a restored tab, the page's media element autoplays
 * NON-MUTED (Chrome inherited playback permission on restore), but
 * `userActivation.isActive` is still `false`. Treating that as "no permission"
 * — the old behaviour — left EqualLoud permanently dead until the user happened
 * to click the page. But an element already producing audible sound IS proof
 * that Chrome granted playback permission, and `createMediaElementSource` lifts
 * that permission onto the AudioContext. So a live, unmuted, playing element
 * authorises context creation regardless of `userActivation`. (Muted autoplay
 * stays gated: a muted element's privilege doesn't cover an audio graph.)
 */
export function canCreateContext(hint?: { audiblePlayback?: boolean }): boolean {
  // An audibly-playing media element already carries playback permission that
  // extends to a take-over AudioContext — allow creation even without a live
  // gesture. Checked first so it overrides the muted-autoplay gate below.
  if (hint?.audiblePlayback) return true
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return ua ? ua.isActive : true
}

/**
 * Create + resume the shared AudioContext, then upgrade every pending element
 * to the full source→gain→limiter→worklet chain. MUST be called from within a
 * user-gesture handler (pointerdown/keydown) — that is the whole point: it is
 * what lets the context leave the `suspended` state.
 *
 * Guards the first creation with {@link canCreateContext} so that an autoplay
 * `play` event (no user activation) can't trigger a warning-spewing creation.
 * Once the context exists, repeated calls only resume + upgrade new pending
 * elements (idempotent), which is safe regardless of activation state.
 *
 * @returns `true` if the context is (or got) `running` and takeovers happened.
 */
export function ensureContextAndUpgrade(): boolean {
  // First-time creation is gesture-gated. Subsequent calls (context already
  // exists) may resume/upgrade without an active gesture — cheap and harmless.
  if (!sharedCtx || sharedCtx.state === 'closed') {
    // If any pending media element is already producing audible sound, the page
    // already holds playback permission (session-restore autoplay, a prior
    // gesture on the element, …) and that permission lifts onto a take-over
    // context — so we may create it even without a *live* userActivation. This
    // is what unblocks the "tab restored, video autoplays, EqualLoud dead"
    // case. Muted autoplay stays gated (audible playback == false).
    if (!canCreateContext({ audiblePlayback: hasAudiblePlayback() })) return false
    // Created here, synchronously, inside the gesture → Chrome permits running.
    sharedCtx = new AudioContext()
    const workletUrl = chrome.runtime.getURL(lufsProcessorUrl)
    workletReady = sharedCtx.audioWorklet.addModule(workletUrl).catch((err) => {
      log.warn('LUFS worklet failed to load', err)
      workletReady = null // allow retry on next attach
    })
  }
  // resume() is the gesture-gated call; ignore the rare rejection (the context
  // is already running, or the gesture wasn't accepted).
  void sharedCtx.resume().catch(() => {
    /* retried on next gesture */
  })
  if (sharedCtx.state === 'closed') return false
  contextHandshaken = true

  // Upgrade every still-pending element. A successful takeover swaps the lazy
  // handle's internal impl in place (see attachAudioGraph) so MediaManager's
  // map reference stays valid.
  for (const p of pending) {
    if (p.done) continue
    p.done = true
    upgradeTakeover(p.el)
  }
  return true
}

/**
 * Attach an audio graph to a media element.
 *
 * Returns a **lazy** handle. Before the first user gesture (see the
 * lazy-takeover note in the file header) it controls `element.volume` only;
 * `ensureContextAndUpgrade()` later swaps its internal `current` impl to the
 * full Web Audio chain (source→gain→limiter→worklet). The handle object itself
 * is stable and owns a single LUFS callback set that is shared with the full
 * chain on upgrade, so MediaManager's reference never changes and every
 * subscriber (plus its unsubscribe fn) keeps working across the swap.
 *
 * @returns A handle, or `null` if the element was already taken over.
 */
export function attachAudioGraph(el: HTMLMediaElement): AudioGraphHandle | null {
  if (attachedSources.has(el)) return null
  // Claim the element up front so any concurrent attach for the same element
  // short-circuits regardless of which internal path (web-audio vs volume
  // fallback) this one ends up on. buildWebAudioHandle used to do this only on
  // the successful createMediaElementSource branch, which left DRM/fallback
  // elements un-marked and theoretically double-attachable via a direct call.
  attachedSources.add(el)

  // Track active handles so the shared context can be closed when the extension
  // is invalidated and all elements have detached (see maybeCloseSharedContext).
  activeHandleCount++

  // Already handshaken (e.g. SPA adds media after the first gesture): build the
  // full chain right away, no lazy phase needed. Wrap the dispose so the
  // counter still decrements on teardown.
  if (contextHandshaken && sharedCtx && sharedCtx.state !== 'closed') {
    const direct = buildWebAudioHandle(el) ?? makeVolumeFallback(el)
    const origDispose = direct.dispose.bind(direct)
    direct.dispose = () => {
      origDispose()
      activeHandleCount = Math.max(0, activeHandleCount - 1)
      maybeCloseSharedContext()
    }
    return direct
  }

  // Lazy phase. `current` holds the active impl (volume fallback → full chain);
  // `lufsCbs` is the SINGLE source of truth for this handle's subscribers. On
  // upgrade we hand that very set to buildWebAudioHandle so the worklet writes
  // measurements into it directly — no re-subscription loop, and the
  // unsubscribe functions returned before the upgrade keep working because
  // they all close over this one set. The handle object never changes, so
  // MediaManager's map reference stays valid across the swap.
  let current: AudioGraphHandle = makeVolumeFallback(el)
  let disposed = false
  const lufsCbs = new Set<(u: LufsUpdate) => void>()

  const pendingEntry: PendingTakeover = { el, done: false }
  pending.push(pendingEntry)
  // Stash the upgrade hook + the shared callback set on the entry so
  // module-scope upgradeTakeover can build the chain against this handle's
  // subscribers without leaking internals through the public API.
  type PendingWithHooks = PendingTakeover & {
    upgrade?: (full: AudioGraphHandle) => void
    lufsCbs?: Set<(u: LufsUpdate) => void>
  }
  const hooks = pendingEntry as PendingWithHooks
  hooks.lufsCbs = lufsCbs
  hooks.upgrade = (full: AudioGraphHandle): void => {
    if (disposed) {
      // Element was disposed before the gesture arrived; tear down the chain we
      // just built so its nodes don't leak.
      full.dispose()
      return
    }
    current = full
  }

  const handle: AudioGraphHandle = {
    setGain(gainDb) {
      current.setGain(gainDb)
    },
    setLimiter(settings) {
      current.setLimiter(settings)
    },
    onLufs(cb) {
      lufsCbs.add(cb)
      return () => lufsCbs.delete(cb)
    },
    resetLufs() {
      current.resetLufs()
    },
    dispose() {
      if (disposed) return
      disposed = true
      pendingEntry.done = true
      lufsCbs.clear()
      current.dispose()
      attachedSources.delete(el)
      activeHandleCount = Math.max(0, activeHandleCount - 1)
      // If the extension is being torn down and this was the last handle,
      // release the shared AudioContext rather than leaking it.
      maybeCloseSharedContext()
    },
  }
  return handle
}

/**
 * Build the full Web Audio chain for an element on the shared context.
 * Returns `null` if `createMediaElementSource` throws (page took the element /
 * DRM) — caller then falls back to volume control.
 *
 * @param sharedLufsCbs When upgrading a lazy handle, pass its callback set so
 *   the worklet fans its measurements out to the *already-subscribed* listeners
 *   through that very set — no re-subscription is needed on upgrade, and the
 *   lazy handle's unsubscribe functions keep working unchanged. Omit it for a
 *   standalone build and a fresh set is created.
 */
function buildWebAudioHandle(
  el: HTMLMediaElement,
  sharedLufsCbs?: Set<(u: LufsUpdate) => void>,
): AudioGraphHandle | null {
  if (!sharedCtx) return null
  const ctx = sharedCtx
  let source: MediaElementAudioSourceNode
  try {
    // This can throw: InvalidStateError if the page already took the element,
    // or silent DRM-mute on protected content.
    source = ctx.createMediaElementSource(el)
  } catch (err) {
    log.warn('createMediaElementSource failed; degrading to volume', err)
    return null
  }

  const gain = ctx.createGain()
  const limiter = ctx.createDynamicsCompressor()
  applyLimiter(limiter, ctx.currentTime, DEFAULT_LIMITER_OFF)

  // Tracks the last gain we applied (dB) so setGain can pick a time constant
  // based on direction: attack fast when pulling a loud tab down, release slow
  // when boosting a quiet one up. Initial GainNode.gain.value is 1.0 == 0 dB.
  let currentGainDb = 0

  // Playback chain: source -> gain -> limiter -> destination
  source.connect(gain)
  gain.connect(limiter)
  limiter.connect(ctx.destination)

  // Measurement chain (parallel). We must connect the worklet to destination
  // or Chrome will not pull samples through it. The processor outputs silence.
  let worklet: AudioWorkletNode | null = null
  let listener: ((ev: MessageEvent) => void) | null = null
  // Use the caller's set when upgrading (so existing subscribers + their
  // unsubscribes keep working against the same set); otherwise a fresh one.
  const lufsCbs = sharedLufsCbs ?? new Set<(u: LufsUpdate) => void>()
  // Guard against the async worklet-ready firing after dispose(): without this,
  // a fast SPA navigation that removes the element before the worklet finishes
  // loading would resurrect nodes on a torn-down chain and throw.
  let disposed = false

  void (workletReady ?? Promise.resolve()).then(() => {
    if (disposed || ctx.state === 'closed') return
    try {
      worklet = new AudioWorkletNode(ctx, 'lufs-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
    } catch (err) {
      // Worklet construct failed (e.g. module never registered under that name).
      log.warn('LUFS worklet node creation failed', err)
      return
    }
    listener = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; shortTerm?: number; blockCount?: number }
      if (data?.type !== 'lufs') return
      const update: LufsUpdate = {
        shortTerm: data.shortTerm ?? -Infinity,
        blockCount: data.blockCount ?? 0,
      }
      for (const cb of lufsCbs) cb(update)
    }
    worklet.port.onmessage = listener
    source.connect(worklet)
    worklet.connect(ctx.destination)
  })

  return {
    setGain(gainDb: number) {
      if (ctx.state === 'closed') return
      // Direction-aware smoothing: a decrease (loud → target) attacks fast
      // because reducing gain never clicks; an increase (quiet → target)
      // releases slowly to avoid zipper noise. This is the asymmetry you want
      // for a loudness balancer — the painful case is a too-loud source, and
      // that's the one we now resolve in ~60 ms instead of ~150 ms.
      const tc = gainDb < currentGainDb ? GAIN_ATTACK_TC : GAIN_SMOOTH_TC
      gain.gain.setTargetAtTime(dbToGain(gainDb), ctx.currentTime, tc)
      currentGainDb = gainDb
    },
    setLimiter(settings) {
      applyLimiter(limiter, ctx.currentTime, settings)
    },
    onLufs(cb) {
      lufsCbs.add(cb)
      return () => lufsCbs.delete(cb)
    },
    resetLufs() {
      // The worklet may not have been wired up yet (async addModule). Guard so
      // a reset racing the upgrade path can't throw into the audio thread.
      if (worklet) {
        try {
          worklet.port.postMessage({ type: 'reset' })
        } catch {
          /* port closed mid-teardown — ignore */
        }
      }
    },
    dispose() {
      disposed = true
      lufsCbs.clear()
      try {
        if (worklet && listener) worklet.port.removeEventListener('message', listener)
        worklet?.disconnect()
      } catch {
        /* ignore */
      }
      try {
        source.disconnect()
        gain.disconnect()
        limiter.disconnect()
      } catch {
        /* ignore */
      }
      // Do NOT close the shared context — other elements still use it.
      attachedSources.delete(el)
    },
  }
}

/**
 * Upgrade one pending lazy element to a full Web Audio chain, swapping its lazy
 * handle's internal impl in place (so MediaManager's reference stays valid).
 * Called from `ensureContextAndUpgrade()` for every pending entry. If the
 * element can't be taken over (page/DRM already claimed it) the handle stays on
 * volume control.
 *
 * The lazy handle's callback set is passed through so the worklet writes into
 * the SAME set the content script subscribed to — existing subscribers (and
 * their unsubscribe functions) keep working with zero re-subscription.
 */
function upgradeTakeover(el: HTMLMediaElement): void {
  const entry = pending.find((p) => p.el === el) as
    | (PendingTakeover & {
        upgrade?: (full: AudioGraphHandle) => void
        lufsCbs?: Set<(u: LufsUpdate) => void>
      })
    | undefined
  // Build against the lazy handle's subscriber set when present.
  const full = buildWebAudioHandle(el, entry?.lufsCbs)
  if (full && entry?.upgrade) {
    entry.upgrade(full)
  } else if (full) {
    // No lazy handle to swap (shouldn't happen in practice) — release the chain.
    full.dispose()
  }
  const idx = pending.findIndex((p) => p.el === el)
  if (idx >= 0) pending.splice(idx, 1)
}

// ---------------------------------------------------------------------------
// Limiter helpers — map user-facing limiter settings onto a DynamicsCompressor.
// ---------------------------------------------------------------------------

const DEFAULT_LIMITER_OFF: LimiterSettings = {
  enabled: false,
  thresholdDb: 0,
  kneeDb: 40,
  ratio: 1,
  attackMs: 0,
  releaseMs: 250,
}

// Clamp a limiter param into a [lo, hi] range. DynamicsCompressorNode would
// otherwise clamp silently AND log a console warning when fed an out-of-range
// value (e.g. "value 30 outside nominal range [1, 20]"); clamping here also
// neutralises stale persisted settings from an older extension version
// (ratio=30) so they can't re-trigger the warning on every SET_LIMITER.
export const clampLimiter = (v: number, [lo, hi]: readonly [number, number]): number =>
  v < lo ? lo : v > hi ? hi : v

function applyLimiter(node: DynamicsCompressorNode, time: number, settings: LimiterSettings): void {
  if (settings.enabled) {
    node.threshold.setValueAtTime(clampLimiter(settings.thresholdDb, [-100, 0]), time)
    node.knee.setValueAtTime(clampLimiter(settings.kneeDb, [0, 40]), time)
    node.ratio.setValueAtTime(clampLimiter(settings.ratio, [1, 20]), time)
    node.attack.setValueAtTime(clampLimiter(settings.attackMs, [0, 1000]) / 1000, time)
    node.release.setValueAtTime(clampLimiter(settings.releaseMs, [0, 1000]) / 1000, time)
  } else {
    // Bypass: threshold at 0 dB with 1:1 ratio = no compression.
    node.threshold.setValueAtTime(0, time)
    node.knee.setValueAtTime(40, time)
    node.ratio.setValueAtTime(1, time)
    node.attack.setValueAtTime(0, time)
    node.release.setValueAtTime(0.25, time)
  }
}

// ---------------------------------------------------------------------------
// Volume-only fallback (PRD §10.5)
// ---------------------------------------------------------------------------

function makeVolumeFallback(el: HTMLMediaElement): AudioGraphHandle {
  return {
    // volume is 0..1, so negative dB attenuates; positive dB is ignored.
    setGain(gainDb: number) {
      const linear = dbToGain(gainDb)
      el.volume = Math.max(0, Math.min(1, linear))
    },
    setLimiter() {
      /* no-op: volume fallback cannot limit */
    },
    onLufs() {
      /* no measurement in fallback mode */
      return () => {}
    },
    resetLufs() {
      /* no worklet to reset in fallback mode */
    },
    dispose() {
      /* nothing to release */
    },
  }
}
