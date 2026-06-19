/**
 * Versioned storage schema + migration chain for EqualLoud.
 *
 * Problem this solves: `chrome.storage.local` persists across extension
 * upgrades, but the shape of `settings` / `limiter` evolves. The old code did a
 * defensive per-field type-check on every load — that handles "stale field of
 * the wrong type" but cannot handle renames, structural changes, or multi-step
 * upgrades (a user who skips v2 and goes v1→v3 directly).
 *
 * Pattern: each stored record carries a `__v`. On load we read the stored
 * version, then run it through a sequential chain of `migrate_vN_vNplus1`
 * functions until it reaches {@link CURRENT_SCHEMA_VERSION}. Each step is pure,
 * idempotent and defensive (assumes fields may be missing / corrupt). The SW
 * can be terminated mid-migration; a re-run converges because each step checks
 * the version it sees, not the global state.
 *
 * The existing field-type validation and the `ratio` clamp live on as the body
 * of `migrate_v0_v1` — the first migration, applied to any pre-versioning data.
 */

import { DEFAULT_LIMITER_SETTINGS } from '@/audio/config'
import type { LimiterSettings, Settings } from '@/messages/protocol'

/**
 * The current schema version. Bump this whenever you change the shape of the
 * stored `settings` or `limiter` objects, and append a new
 * `migrate_vN_vNplus1` step below.
 */
export const CURRENT_SCHEMA_VERSION = 1

/** What we expect to read back from storage (version-tagged payload). */
export interface VersionedPayload {
  /** Schema version; absent on pre-versioning data (treated as 0). */
  __v?: number
  settings?: Partial<Settings>
  limiter?: Partial<LimiterSettings>
}

export interface MigratedPayload {
  __v: number
  settings: Settings
  limiter: LimiterSettings
}

/**
 * v0 → v1: the original defensive validation, now formalised as a migration.
 *
 * - Drops any `settings` field whose type is wrong (a corrupt or future-version
 *   object could put a non-number into `targetLufs`, which would propagate as a
 *   NaN gain and silently mute tabs).
 * - Clamps `limiter.ratio` into the Web Audio `[1, 20]` range. Older versions
 *   defaulted to ratio=30; without this the stale value re-triggers the
 *   "value 30 outside nominal range [1, 20]" console warning on every load.
 * - Clamps every other limiter param into its nominal range too, so a corrupt
 *   value never reaches the DynamicsCompressorNode.
 *
 * Idempotent: running it on an already-v1 payload is a no-op (the clamps are
 * fixed points, the type checks pass through valid values unchanged).
 */
function migrate_v0_v1(payload: VersionedPayload): VersionedPayload {
  // NOTE: do NOT set __v here — the migratePayload() loop owns version
  // bookkeeping. Each step only transforms the data shape.
  const out: VersionedPayload = {}

  // --- settings ---
  const s = payload.settings
  if (s) {
    const picked: Partial<Settings> = {}
    if (typeof s.enabled === 'boolean') picked.enabled = s.enabled
    if (typeof s.targetLufs === 'number' && Number.isFinite(s.targetLufs)) {
      picked.targetLufs = s.targetLufs
    }
    if (Object.keys(picked).length > 0) out.settings = picked
  }

  // --- limiter ---
  const l = payload.limiter
  if (l) {
    const picked: Partial<LimiterSettings> = {}
    if (typeof l.enabled === 'boolean') picked.enabled = l.enabled
    for (const k of ['thresholdDb', 'kneeDb', 'attackMs', 'releaseMs'] as const) {
      const v = l[k]
      if (typeof v === 'number' && Number.isFinite(v)) picked[k] = v
    }
    if (typeof l.ratio === 'number' && Number.isFinite(l.ratio)) {
      // Clamp to the Web Audio DynamicsCompressorNode range [1, 20].
      picked.ratio = Math.min(20, Math.max(1, l.ratio))
    }
    if (Object.keys(picked).length > 0) out.limiter = picked
  }

  return out
}

/**
 * The ordered list of migrations. Index N migrates version N → N+1.
 * To add v1 → v2: append `{ from: 1, migrate: migrate_v1_v2 }` here.
 */
const MIGRATIONS: { from: number; migrate: (p: VersionedPayload) => VersionedPayload }[] = [
  { from: 0, migrate: migrate_v0_v1 },
]

/**
 * Run a stored payload through every migration step it needs to reach
 * {@link CURRENT_SCHEMA_VERSION}. Pure and idempotent: safe to call on every
 * load and on already-current data.
 */
export function migratePayload(input: VersionedPayload): VersionedPayload {
  let v = input.__v ?? 0
  let current = input
  while (v < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === v)
    if (!step) {
      // No migration registered for this version gap — stop rather than risk a
      // silent data-shape mismatch. The version stays where it is so the next
      // load re-attempts (in case a step was added in the meantime).
      break
    }
    current = step.migrate(current)
    v = (current.__v ?? step.from) + 1
    current = { ...current, __v: v }
  }
  return current
}

/**
 * Build a fully-populated {@link MigratedPayload} from a (possibly partial /
 * pre-versioning) stored record, falling back to defaults for any missing
 * field. This is what the SW uses to seed its in-memory state on load.
 */
export function hydratePayload(
  input: VersionedPayload | undefined,
  defaultSettings: Settings,
): MigratedPayload {
  const migrated = migratePayload(input ?? {})
  return {
    __v: migrated.__v ?? CURRENT_SCHEMA_VERSION,
    settings: { ...defaultSettings, ...(migrated.settings ?? {}) },
    limiter: { ...DEFAULT_LIMITER_SETTINGS, ...(migrated.limiter ?? {}) },
  }
}
