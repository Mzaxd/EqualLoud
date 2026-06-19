import { describe, it, expect } from 'vitest'

import { DEFAULT_LIMITER_SETTINGS, DEFAULT_TARGET_LUFS } from '@/audio/config'
import type { LimiterSettings, Settings } from '@/messages/protocol'
import { CURRENT_SCHEMA_VERSION, hydratePayload, migratePayload } from '@/storage/migrate'

const DEFAULT_SETTINGS: Settings = { enabled: true, targetLufs: DEFAULT_TARGET_LUFS }

describe('migratePayload', () => {
  it('returns CURRENT_SCHEMA_VERSION for empty/undefined input', () => {
    const out = migratePayload({})
    expect(out.__v).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('treats a missing __v as v0 and runs the v0→v1 step', () => {
    // Pre-versioning data: no __v, but valid settings/limiter fields.
    const out = migratePayload({
      settings: { enabled: false, targetLufs: -20 },
      limiter: { enabled: true, thresholdDb: -2, kneeDb: 0, ratio: 4, attackMs: 1, releaseMs: 100 },
    })
    expect(out.__v).toBe(1)
    expect(out.settings?.enabled).toBe(false)
    expect(out.settings?.targetLufs).toBe(-20)
    expect(out.limiter?.ratio).toBe(4) // in range, unchanged
  })

  it('clamps stale ratio=30 (the bug that motivated the v0→v1 clamp)', () => {
    const out = migratePayload({
      limiter: {
        enabled: true,
        thresholdDb: -2,
        kneeDb: 0,
        ratio: 30,
        attackMs: 1,
        releaseMs: 100,
      },
    })
    expect(out.limiter?.ratio).toBe(20) // clamped into [1, 20]
  })

  it('clamps ratio below 1 up to 1', () => {
    const out = migratePayload({ limiter: { ratio: 0 } })
    expect(out.limiter?.ratio).toBe(1)
  })

  it('drops settings fields of the wrong type (corrupt storage)', () => {
    const out = migratePayload({
      settings: { enabled: 'yes' as unknown as boolean, targetLufs: 'loud' as unknown as number },
    })
    // Both invalid fields are dropped; nothing is kept.
    expect(out.settings?.enabled).toBeUndefined()
    expect(out.settings?.targetLufs).toBeUndefined()
  })

  it('keeps NaN targetLufs out (would mute tabs via NaN gain)', () => {
    const out = migratePayload({ settings: { targetLufs: NaN } })
    expect(out.settings?.targetLufs).toBeUndefined()
  })

  it('is idempotent: running it twice yields the same result', () => {
    const input = { settings: { targetLufs: -14 }, limiter: { ratio: 30 } }
    const once = migratePayload(input)
    const twice = migratePayload(once)
    expect(twice).toEqual(once)
  })

  it('is a no-op on already-current data', () => {
    const current = {
      __v: CURRENT_SCHEMA_VERSION,
      settings: { enabled: true, targetLufs: -14 },
      limiter: { ...DEFAULT_LIMITER_SETTINGS },
    }
    const out = migratePayload(current)
    expect(out).toEqual(current)
  })
})

describe('hydratePayload', () => {
  it('fills defaults for missing settings/limiter on a fresh install', () => {
    const out = hydratePayload(undefined, DEFAULT_SETTINGS)
    expect(out.__v).toBe(CURRENT_SCHEMA_VERSION)
    expect(out.settings).toEqual(DEFAULT_SETTINGS)
    expect(out.limiter).toEqual(DEFAULT_LIMITER_SETTINGS)
  })

  it('preserves valid stored values, only defaults the missing ones', () => {
    const out = hydratePayload({ settings: { targetLufs: -18 } }, DEFAULT_SETTINGS)
    expect(out.settings.targetLufs).toBe(-18)
    expect(out.settings.enabled).toBe(true) // default filled in
    expect(out.limiter).toEqual(DEFAULT_LIMITER_SETTINGS)
  })

  it('returns the full limiter shape even when storage had a partial limiter', () => {
    const partial: Partial<LimiterSettings> = { enabled: false }
    const out = hydratePayload({ limiter: partial }, DEFAULT_SETTINGS)
    expect(out.limiter.enabled).toBe(false)
    // The rest come from DEFAULT_LIMITER_SETTINGS.
    expect(out.limiter.ratio).toBe(DEFAULT_LIMITER_SETTINGS.ratio)
    expect(out.limiter.thresholdDb).toBe(DEFAULT_LIMITER_SETTINGS.thresholdDb)
  })

  it('runs the v0→v1 ratio clamp before hydrating', () => {
    const out = hydratePayload(
      { limiter: { ratio: 30 } as Partial<LimiterSettings> },
      DEFAULT_SETTINGS,
    )
    expect(out.limiter.ratio).toBe(20)
  })
})
