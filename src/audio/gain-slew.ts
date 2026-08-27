// src/audio/gain-slew.ts
/**
 * Decision-domain slew limiter for gain *increases*.
 *
 * Wrap every incoming SET_GAIN decision through next() before handing it to
 * the GainNode. Rises are capped to maxRiseDbPerSec so a single wrong decision
 * (e.g. an early low LUFS reading during a video's quiet intro requesting the
 * full boost ceiling) can never slam in within one heartbeat; falls are always
 * instantaneous — attenuating is never harmful and must stay fast (spec §1).
 *
 * The clock is the main-thread performance.now() domain supplied by the
 * caller; this class never reads clocks itself so it stays pure/testable.
 */

export interface GainSlewOptions {
  /** Maximum upward gain movement, dB per second. Downward is unlimited. */
  maxRiseDbPerSec: number
  /**
   * Wall-clock gap (ms) credited to a single step. Guards against charging a
   * backgrounded tab one giant step when it wakes up after minutes idle.
   * Default 500 — matches five balance heartbeats' worth of rise.
   */
  maxStepMs?: number
}

const DEFAULT_MAX_STEP_MS = 500

export class GainSlew {
  private currentDb = 0
  private lastMs: number | null = null
  private readonly maxRiseDbPerSec: number
  private readonly maxStepMs: number

  constructor(opts: GainSlewOptions) {
    this.maxRiseDbPerSec = opts.maxRiseDbPerSec
    this.maxStepMs = opts.maxStepMs ?? DEFAULT_MAX_STEP_MS
  }

  /** Consume one decision at time `nowMs`; returns the level to actually apply. */
  next(targetDb: number, nowMs: number): number {
    const rawDtMs = this.lastMs === null ? 0 : nowMs - this.lastMs
    const dtSec = Math.max(0, Math.min(rawDtMs, this.maxStepMs)) / 1000
    if (targetDb <= this.currentDb) {
      this.currentDb = targetDb
    } else {
      this.currentDb = Math.min(targetDb, this.currentDb + this.maxRiseDbPerSec * dtSec)
    }
    this.lastMs = nowMs
    return this.currentDb
  }
}
