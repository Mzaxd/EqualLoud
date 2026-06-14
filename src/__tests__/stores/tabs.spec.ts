import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { useTabsStore, hasEnoughSamples, type TabLufs } from '@/stores/tabs'

function mockChromeRuntime(response: Record<string, unknown> = {}): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(response),
    },
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  })
}

function mockWindowSetInterval(): void {
  vi.stubGlobal('setInterval', vi.fn().mockReturnValue(1))
  vi.stubGlobal('clearInterval', vi.fn())
}

describe('hasEnoughSamples', () => {
  it('returns false when blockCount < MIN_BLOCKS (3)', () => {
    const lufs: TabLufs = { shortTerm: -20, blockCount: 2 }
    expect(hasEnoughSamples(lufs)).toBe(false)
  })

  it('returns true when blockCount >= 3', () => {
    const lufs: TabLufs = { shortTerm: -20, blockCount: 3 }
    expect(hasEnoughSamples(lufs)).toBe(true)
  })
})

describe('useTabsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mockChromeRuntime({
      tabs: [],
      settings: { enabled: true, targetLufs: -14 },
      limiter: {
        enabled: true,
        thresholdDb: -1,
        kneeDb: 0,
        ratio: 20,
        attackMs: 1,
        releaseMs: 100,
      },
    })
    mockWindowSetInterval()
  })

  describe('initial state', () => {
    it('starts with empty tabs', () => {
      const store = useTabsStore()
      expect(store.tabs).toEqual([])
    })

    it('defaults to enabled with target -14', () => {
      const store = useTabsStore()
      // Before fetch, the store holds its own defaults.
      expect(store.isAutoBalancing).toBe(true)
      expect(store.targetLufs).toBe(-14)
    })

    it('starts with limiter enabled by default (DRM/clipping protection)', () => {
      const store = useTabsStore()
      expect(store.isLimiterEnabled).toBe(true)
    })
  })

  describe('fetchState', () => {
    it('populates tabs/settings/limiter from GET_STATE response', async () => {
      mockChromeRuntime({
        tabs: [
          {
            tabId: 7,
            title: 'x',
            url: 'https://x',
            isCapturing: true,
            shortTerm: -14,
            blockCount: 50,
            appliedGainDb: 0,
            maxGainDb: 12,
            balanceEnabled: true,
          },
        ],
        settings: { enabled: false, targetLufs: -20 },
        limiter: {
          enabled: false,
          thresholdDb: -2,
          kneeDb: 1,
          ratio: 10,
          attackMs: 5,
          releaseMs: 80,
        },
      })
      const store = useTabsStore()
      await store.fetchState()
      expect(store.tabs).toHaveLength(1)
      expect(store.isAutoBalancing).toBe(false)
      expect(store.targetLufs).toBe(-20)
      expect(store.tabs[0].balanceEnabled).toBe(true)
      expect(store.isLimiterEnabled).toBe(false)
    })
  })

  describe('toggleAutoBalance', () => {
    it('sends SET_ENABLED with the flipped value', async () => {
      const store = useTabsStore()
      await store.toggleAutoBalance()
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SET_ENABLED', enabled: false }),
      )
    })
  })

  describe('setTargetLufs', () => {
    it('sends SET_TARGET_LUFS', async () => {
      const store = useTabsStore()
      await store.setTargetLufs(-20)
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SET_TARGET_LUFS', targetLufs: -20 }),
      )
    })
  })

  describe('toggleBalance', () => {
    it('sends TOGGLE_BALANCE for the given tab', async () => {
      const store = useTabsStore()
      await store.toggleBalance(3)
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TOGGLE_BALANCE', tabId: 3 }),
      )
    })

    it('replaces tabs from the SW response', async () => {
      mockChromeRuntime({
        tabs: [{ tabId: 9, balanceEnabled: false } as never],
      })
      const store = useTabsStore()
      await store.toggleBalance(9)
      expect(store.tabs).toHaveLength(1)
      expect(store.tabs[0].balanceEnabled).toBe(false)
    })
  })

  describe('limiter patches', () => {
    it('sends SET_LIMITER_SETTINGS with the partial', async () => {
      const store = useTabsStore()
      await store.setLimiterThreshold(-3)
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SET_LIMITER_SETTINGS',
          settings: { thresholdDb: -3 },
        }),
      )
    })
  })

  describe('startPolling / stopPolling', () => {
    it('registers and unregisters the storage listener', () => {
      const store = useTabsStore()
      store.startPolling()
      expect(chrome.storage.onChanged.addListener).toHaveBeenCalled()
      store.stopPolling()
      expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled()
    })
  })
})
