import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { useTabsStore, hasEnoughSamples, type TabLufs } from '@/stores/tabs'

function mockChromeRuntime(response: Record<string, unknown> = {}): void {
  // A minimal Port mock: collects listeners so tests can fire messages at it.
  const portHandlers: ((msg: unknown) => void)[] = []
  const disconnectHandlers: (() => void)[] = []
  const fakePort = {
    name: 'equalloud-popup',
    onMessage: { addListener: vi.fn((cb: (msg: unknown) => void) => portHandlers.push(cb)) },
    onDisconnect: { addListener: vi.fn((cb: () => void) => disconnectHandlers.push(cb)) },
    postMessage: vi.fn(),
    disconnect: vi.fn(() => {
      // Simulate Chrome firing onDisconnect on explicit disconnect.
      for (const cb of disconnectHandlers) cb()
    }),
    // Test-only: deliver a STATE_PUSH to all registered handlers.
    __deliver(msg: unknown): void {
      for (const cb of portHandlers) cb(msg)
    },
    __disconnect(): void {
      for (const cb of disconnectHandlers) cb()
    },
  }
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(response),
      connect: vi.fn().mockReturnValue(fakePort),
    },
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    // Expose for tests that need to drive the Port.
    __port: fakePort,
  })
}

function mockWindowTimers(): void {
  vi.stubGlobal('setInterval', vi.fn().mockReturnValue(1))
  vi.stubGlobal('clearInterval', vi.fn())
  vi.stubGlobal('setTimeout', vi.fn().mockReturnValue(1))
  vi.stubGlobal('clearTimeout', vi.fn())
}

describe('hasEnoughSamples', () => {
  it('returns false when blockCount < MIN_BLOCKS (1)', () => {
    const lufs: TabLufs = { shortTerm: -20, blockCount: 0 }
    expect(hasEnoughSamples(lufs)).toBe(false)
  })

  it('returns true when blockCount >= 1', () => {
    const lufs: TabLufs = { shortTerm: -20, blockCount: 1 }
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
    mockWindowTimers()
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

  describe('startConnection / stopConnection (Port-based push)', () => {
    it('opens a Port with the popup name on start', () => {
      const store = useTabsStore()
      store.startConnection()
      expect(chrome.runtime.connect).toHaveBeenCalledWith({ name: 'equalloud-popup' })
      store.stopConnection()
    })

    it('applies STATE_PUSH messages to the reactive refs', () => {
      const store = useTabsStore()
      store.startConnection()
      const port = (chrome as unknown as { __port: { __deliver: (m: unknown) => void } }).__port
      port.__deliver({
        type: 'STATE_PUSH',
        tabs: [
          {
            tabId: 99,
            title: 'Pushed',
            url: 'https://x.io',
            isCapturing: true,
            shortTerm: -10,
            blockCount: 5,
            appliedGainDb: 2,
            maxGainDb: 12,
            balanceEnabled: true,
          },
        ],
        settings: { enabled: true, targetLufs: -16 },
        limiter: {
          enabled: false,
          thresholdDb: -3,
          kneeDb: 0,
          ratio: 12,
          attackMs: 5,
          releaseMs: 200,
        },
      })
      expect(store.tabs).toHaveLength(1)
      expect(store.tabs[0]!.tabId).toBe(99)
      expect(store.targetLufs).toBe(-16)
      expect(store.isLimiterEnabled).toBe(false)
      store.stopConnection()
    })

    it('ignores non-STATE_PUSH messages on the Port', () => {
      const store = useTabsStore()
      store.startConnection()
      const before = store.tabs.length
      const port = (chrome as unknown as { __port: { __deliver: (m: unknown) => void } }).__port
      port.__deliver({ type: 'SOMETHING_ELSE' })
      expect(store.tabs.length).toBe(before)
      store.stopConnection()
    })

    it('disconnects the Port on stopConnection', () => {
      const store = useTabsStore()
      store.startConnection()
      const port = (chrome as unknown as { __port: { disconnect: ReturnType<typeof vi.fn> } })
        .__port
      store.stopConnection()
      expect(port.disconnect).toHaveBeenCalled()
    })
  })
})
