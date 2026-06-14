/**
 * Centralised, tunable configuration for EqualLoud.
 *
 * Every knob that might need tuning lives here so the rest of the codebase can
 * `import { ... } from '@/audio/config'` instead of scattering magic numbers.
 * See PRD §9 for the rationale behind each default.
 */

// ---------------------------------------------------------------------------
// User-facing settings (persisted via chrome.storage.local by the SW)
// ---------------------------------------------------------------------------

/** Default target loudness each tab converges toward (LUFS, EBU R128-ish). */
export const DEFAULT_TARGET_LUFS = -14

/**
 * Per-tab maximum positive gain. Boosting quiet content toward the target is
 * desirable, but an unbounded boost amplifies the noise floor unpleasantly.
 * +12 dB covers typical streaming content while keeping hiss in check.
 */
export const DEFAULT_MAX_GAIN_DB = 12

/** Per-tab minimum gain (slider floor). Effectively silence. */
export const DEFAULT_MIN_GAIN_DB = -60

// ---------------------------------------------------------------------------
// Auto-balance tuning (re-exported from balance.ts for single import site)
// ---------------------------------------------------------------------------

export {
  /** Minimum LUFS blocks before a tab's measurement is trusted. */
  MIN_BLOCKS_FOR_RELIABLE_LUFS,
  /** Minimum spacing between auto-balance runs (epoch ms). */
  BALANCE_THROTTLE_MS,
} from './balance'

// ---------------------------------------------------------------------------
// Content script tuning
// ---------------------------------------------------------------------------

/**
 * Time constant (seconds) used by GainNode.setTargetAtTime when applying a new
 * gain decision. 50 ms glides between the ~10 Hz balance updates without
 * zipper clicks. Used for gain *increases* (boosting quiet content toward the
 * target); gain decreases use the faster {@link GAIN_ATTACK_TC}.
 */
export const GAIN_SMOOTH_TC = 0.05

/**
 * Faster time constant for gain *decreases* (attenuating loud content). A gain
 * drop never causes a click (there is less energy, never a discontinuity that
 * exceeds the previous sample), so we can attack faster than the release —
 * this lets a too-loud tab be pulled down in ~60 ms (3τ) instead of ~150 ms,
 * which is exactly the case where fast response matters most (a blaring video
 * at start). Boosts still use {@link GAIN_SMOOTH_TC} to avoid zipper noise on
 * the way up.
 */
export const GAIN_ATTACK_TC = 0.02

/** How often the content script reports its measured LUFS to the SW (Hz). */
export const LUFS_REPORT_HZ = 10

/**
 * Boosted report rate used during the first ~1 s after a primary media element
 * attaches. Faster heartbeats during warm-up cut the message-alignment latency
 * from ~100 ms to ~40 ms, so the SW sees the first usable measurement within a
 * couple of quantum ticks instead of waiting up to one full 10 Hz period. After
 * {@link BOOST_REPORT_MS} elapses the rate drops back to {@link LUFS_REPORT_HZ}.
 */
export const BOOST_REPORT_HZ = 25

/** Wall-clock window after attach during which the boosted report rate applies. */
export const BOOST_REPORT_MS = 1000

// ---------------------------------------------------------------------------
// Limiter defaults (output protection against post-boost clipping)
// ---------------------------------------------------------------------------

export const DEFAULT_LIMITER_SETTINGS = {
  // PRD §17 Q1 recommends default-on limiter at -1 dB to prevent clipping
  // when gain > 1 boosts content above 0 dBFS.
  enabled: true,
  thresholdDb: -1,
  kneeDb: 0,
  ratio: 20,
  attackMs: 1,
  releaseMs: 100,
} as const

// ---------------------------------------------------------------------------
// Service-worker housekeeping
// ---------------------------------------------------------------------------

/** Fallback alarm period: ping content scripts in case a tab's heartbeat
 *  was lost (e.g. after the SW slept). */
export const ALARM_SCAN_PERIOD_MIN = 1

/** Sample rate assumed by the LUFS worklet when `globalThis.sampleRate` is
 *  unavailable (worklet scope). Real AudioContext overrides this. */
export const FALLBACK_SAMPLE_RATE = 48000
