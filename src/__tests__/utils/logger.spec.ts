import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LogEntry } from '@/messages/protocol'
import { clearLogs, createLogger, getRecentLogs, loadLogs } from '@/utils/logger'

/**
 * The logger gates the minimum level on `import.meta.env.DEV` (dev → debug,
 * prod → warn). Vitest runs with `DEV` truthy by default, so tests see the
 * permissive dev filter unless they stub it. We stub explicitly per-case.
 */
function setDevMode(isDev: boolean): void {
  vi.stubEnv('DEV', isDev)
  // import.meta.env is read-only at the surface, but stubEnv is the supported
  // vitest escape hatch and is picked up by code that branches on DEV.
}

describe('logger', () => {
  beforeEach(() => {
    setDevMode(true)
    clearLogs()
    vi.clearAllMocks()
  })

  describe('level filtering', () => {
    it('records debug/info in dev mode', () => {
      const log = createLogger('ut')
      log.debug('d')
      log.info('i')
      expect(getRecentLogs().filter((e) => e.msg === 'd' || e.msg === 'i')).toHaveLength(2)
    })

    it('drops debug/info in prod mode, keeps warn/error', () => {
      setDevMode(false)
      const log = createLogger('ut')
      log.debug('d')
      log.info('i')
      log.warn('w')
      log.error('e')
      const msgs = getRecentLogs().map((e) => e.msg)
      expect(msgs).toEqual(['w', 'e'])
    })

    it('always logs error regardless of mode', () => {
      setDevMode(false)
      createLogger('ut').error('boom')
      expect(getRecentLogs().some((e) => e.msg === 'boom')).toBe(true)
    })
  })

  describe('ring buffer capacity', () => {
    it('evicts the oldest entries once capacity is exceeded', () => {
      const log = createLogger('ut')
      // Warn survives in both dev and prod, so the buffer fills deterministically.
      for (let i = 0; i < 1050; i++) log.warn(`entry-${i}`)
      const entries = getRecentLogs()
      expect(entries).toHaveLength(1000)
      // The first 50 should have been dropped; the buffer now starts at entry-50.
      expect(entries[0].msg).toBe('entry-50')
      expect(entries[entries.length - 1].msg).toBe('entry-1049')
    })
  })

  describe('getRecentLogs', () => {
    it('returns a defensive copy (mutating the result does not affect the buffer)', () => {
      const log = createLogger('ut')
      log.warn('a')
      const snapshot = getRecentLogs()
      snapshot.pop()
      expect(getRecentLogs()).toHaveLength(1)
    })

    it('preserves chronological order', () => {
      const log = createLogger('ut')
      log.warn('first')
      log.warn('second')
      const entries = getRecentLogs()
      expect(entries.map((e) => e.msg)).toEqual(['first', 'second'])
    })
  })

  describe('createLogger scope tagging', () => {
    it('tags every entry with the scope', () => {
      const a = createLogger('sw')
      const b = createLogger('audio')
      a.warn('x')
      b.warn('y')
      const entries = getRecentLogs()
      expect(entries.find((e) => e.msg === 'x')?.scope).toBe('sw')
      expect(entries.find((e) => e.msg === 'y')?.scope).toBe('audio')
    })

    it('serializes Error data into { message, stack }', () => {
      const log = createLogger('ut')
      const err = new Error('kaboom')
      log.error('failed', err)
      const entry = getRecentLogs().find((e) => e.msg === 'failed') as LogEntry
      expect(entry.data).toMatchObject({ message: 'kaboom' })
      expect(typeof (entry.data as { stack?: unknown }).stack).toBe('string')
    })
  })

  describe('clearLogs', () => {
    it('empties the in-memory buffer', () => {
      createLogger('ut').warn('x')
      expect(getRecentLogs()).toHaveLength(1)
      clearLogs()
      expect(getRecentLogs()).toHaveLength(0)
    })

    it('removes the session mirror when chrome.storage.session is available', () => {
      const remove = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('chrome', { storage: { session: { remove } } })
      clearLogs()
      expect(remove).toHaveBeenCalledWith('elogs')
    })
  })

  describe('loadLogs', () => {
    it('restores the buffer from storage.session', async () => {
      const stored: LogEntry[] = [
        { ts: 1, level: 'warn', scope: 'sw', msg: 'old-1' },
        { ts: 2, level: 'error', scope: 'sw', msg: 'old-2' },
      ]
      const get = vi.fn().mockResolvedValue({ elogs: stored })
      vi.stubGlobal('chrome', { storage: { session: { get } } })

      await loadLogs()

      const entries = getRecentLogs()
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.msg)).toEqual(['old-1', 'old-2'])
    })

    it('skips malformed entries rather than throwing', async () => {
      const get = vi
        .fn()
        .mockResolvedValue({ elogs: [{ level: 'warn' }, 'nope', null, { msg: 'ok' }] })
      vi.stubGlobal('chrome', { storage: { session: { get } } })

      await loadLogs()
      // Only entries with both `level` and `msg` survive validation.
      expect(getRecentLogs()).toHaveLength(0)
    })

    it('resolves without throwing when chrome.storage.session is absent', async () => {
      vi.stubGlobal('chrome', { storage: {} })
      await expect(loadLogs()).resolves.toBeUndefined()
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
})
