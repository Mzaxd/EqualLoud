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
 * zipper clicks.
 */
export const GAIN_SMOOTH_TC = 0.05

/** How often the content script reports its measured LUFS to the SW (Hz). */
export const LUFS_REPORT_HZ = 10

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
