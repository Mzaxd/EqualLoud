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
 */

import { GAIN_ATTACK_TC, GAIN_SMOOTH_TC } from '@/audio/config'
import { dbToGain } from '@/audio/lufs'
import type { LimiterSettings } from '@/messages/protocol'
import lufsProcessorUrl from '@/worklets/lufs-processor?worker&url'

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
  /** Tear everything down and release the element. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Shared AudioContext (per page). Chrome caps concurrent AudioContexts at ~6;
// creating one per media element broke multi-video sites (Twitter, Reddit,
// infinite-scroll YouTube) within seconds. One context serves N element
// chains — source nodes are independent.
// ---------------------------------------------------------------------------

let sharedCtx: AudioContext | null = null
let workletReady: Promise<void> | null = null
const attachedSources = new WeakSet<HTMLMediaElement>()

function getSharedContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext()
    // Load the LUFS worklet module once for the whole context. Subsequent
    // AudioWorkletNode creations on this ctx reuse it without re-fetching.
    const workletUrl = chrome.runtime.getURL(lufsProcessorUrl)
    workletReady = sharedCtx.audioWorklet.addModule(workletUrl).catch((err) => {
      console.warn('[EqualLoud] LUFS worklet failed to load', err)
      workletReady = null // allow retry on next attach
    })
    // Best-effort resume; autoplay policy may suspend until a user gesture.
    // The content script also wires gesture listeners that call resumeAll().
    void sharedCtx.resume().catch(() => {
      /* retried on user gesture */
    })
  }
  return sharedCtx
}

/** Resume the shared context (called on user gesture / play event). */
export function resumeSharedContext(): void {
  if (sharedCtx && sharedCtx.state !== 'closed') {
    void sharedCtx.resume().catch(() => {
      /* ignore */
    })
  }
}

/**
 * Attach an audio graph to a media element.
 *
 * @returns A handle, or `null` if attachment failed and we degraded to
 *          `element.volume` control (which is *not* returned because volume
 *          cannot boost — only attenuate). Callers should treat `null` as
 *          "skip this element for balancing".
 */
export function attachAudioGraph(el: HTMLMediaElement): AudioGraphHandle | null {
  // Guard against double-attach of the same element: createMediaElementSource
  // throws InvalidStateError if already called on this element.
  if (attachedSources.has(el)) return null

  const ctx = getSharedContext()
  let source: MediaElementAudioSourceNode
  try {
    // This can throw: InvalidStateError if the page already took the element,
    // or silent DRM-mute on protected content.
    source = ctx.createMediaElementSource(el)
    attachedSources.add(el)
  } catch (err) {
    console.warn('[EqualLoud] createMediaElementSource failed; degrading to volume', err)
    // Degrade: tweak element.volume directly. Can't boost, but can attenuate.
    return makeVolumeFallback(el)
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
  const lufsCbs = new Set<(u: LufsUpdate) => void>()
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
      console.warn('[EqualLoud] LUFS worklet node creation failed', err)
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

// ---------------------------------------------------------------------------
// Limiter helpers (migrated from loudness_dd offscreen.ts)
// ---------------------------------------------------------------------------

const DEFAULT_LIMITER_OFF: LimiterSettings = {
  enabled: false,
  thresholdDb: 0,
  kneeDb: 40,
  ratio: 1,
  attackMs: 0,
  releaseMs: 250,
}

function applyLimiter(node: DynamicsCompressorNode, time: number, settings: LimiterSettings): void {
  if (settings.enabled) {
    node.threshold.setValueAtTime(settings.thresholdDb, time)
    node.knee.setValueAtTime(settings.kneeDb, time)
    node.ratio.setValueAtTime(settings.ratio, time)
    node.attack.setValueAtTime(settings.attackMs / 1000, time)
    node.release.setValueAtTime(settings.releaseMs / 1000, time)
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
    dispose() {
      /* nothing to release */
    },
  }
}
