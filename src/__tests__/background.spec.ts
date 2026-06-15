import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { TabState } from '@/messages/protocol'

function createChromeMock() {
  return {
    runtime: {
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onReplaced: { addListener: vi.fn() },
      get: vi.fn().mockResolvedValue({ id: 1, title: 'Tab', url: 'https://example.com' }),
      // scanTabs calls chrome.tabs.query on SW wake-up; must be mocked or the
      // startup self-heal path silently throws and is never exercised.
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
  }
}

describe('background service worker (EqualLoud coordinator)', () => {
  let background: typeof import('@/background')
  let chrome: ReturnType<typeof createChromeMock>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal('chrome', (chrome = createChromeMock()))
    vi.useFakeTimers()
    background = await import('@/background')
    background.resetState()
    // Drain the loadSettings() promise chain triggered by resetState.
    await vi.runOnlyPendingTimersAsync()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function seedTab(overrides: Partial<TabState> & { tabId: number }): TabState {
    return background.seedTab(overrides)
  }

  // --- balance decision drives SET_GAIN to the content script ----------------

  it('applies balanced gain to the content script when LUFS_REPORT arrives', async () => {
    seedTab({ tabId: 1, shortTerm: -20, blockCount: 50, maxGainDb: 24 })

    await background.handleMessage(
      { type: 'LUFS_REPORT', tabId: 1, shortTerm: -20, blockCount: 50 },
      { tab: { id: 1 } } as chrome.runtime.MessageSender,
    )

    // default target -14; -14 - (-20) = +6 dB
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 1, gainDb: 6 }),
    )
  })

  it('uses sender.tab.id as the authoritative tab id (content sends -1)', async () => {
    await background.handleMessage(
      { type: 'MEDIA_ATTACHED', tabId: -1, title: 'YT', url: 'https://youtube.com' },
      { tab: { id: 42 } } as chrome.runtime.MessageSender,
    )
    // GET_STATE after attach should list the tab under id 42.
    const state = (await background.handleMessage({ type: 'GET_STATE' })) as {
      tabs: TabState[]
    }
    expect(state.tabs.find((t) => t.tabId === 42)).toBeTruthy()
  })

  it('drives a too-few-samples tab to unity gain (no stale-gain freeze)', async () => {
    seedTab({ tabId: 2, shortTerm: -20, blockCount: 1, maxGainDb: 24 })
    ;(chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    await background.handleMessage(
      { type: 'LUFS_REPORT', tabId: 2, shortTerm: -20, blockCount: 0 },
      { tab: { id: 2 } } as chrome.runtime.MessageSender,
    )

    // computeBalanceGains now emits a unity decision for below-MIN_BLOCKS tabs
    // so a jittery primary (Reels/Douyin) can't freeze the GainNode at a stale
    // gain forever.
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 2, gainDb: 0 }),
    )
  })

  // --- settings persistence across SW restarts --------------------------------

  it('restores target LUFS from storage when the worker wakes', async () => {
    chrome.storage.local.get.mockResolvedValue({
      settings: { enabled: true, targetLufs: -20 },
    })
    background.resetState()
    await vi.runOnlyPendingTimersAsync()

    const state = (await background.handleMessage({ type: 'GET_STATE' })) as {
      settings: { targetLufs: number }
    }
    expect(state.settings.targetLufs).toBe(-20)
  })

  // --- SET_TARGET_LUFS applies immediately ------------------------------------

  it('rebalances immediately when SET_TARGET_LUFS changes', async () => {
    seedTab({ tabId: 3, shortTerm: -14, blockCount: 50, maxGainDb: 24 })

    await background.handleMessage({ type: 'SET_TARGET_LUFS', targetLufs: -30 })

    // -30 - (-14) = -16 dB
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 3, gainDb: -16 }),
    )
  })

  // --- per-tab balance bypass (A/B toggle) ------------------------------------

  it('pushes unity gain (0 dB) to a tab whose balance is toggled off', async () => {
    seedTab({ tabId: 4, shortTerm: -20, blockCount: 50, maxGainDb: 24 })

    await background.handleMessage({ type: 'TOGGLE_BALANCE', tabId: 4 })

    // Bypass is expressed as unity gain via the standard SET_GAIN channel —
    // no separate SET_MUTED message. The SW drives the content graph to 0 dB.
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 4, gainDb: 0 }),
    )
  })

  it('re-applies the computed gain when balance is toggled back on', async () => {
    const t = seedTab({ tabId: 7, shortTerm: -20, blockCount: 50, maxGainDb: 24 })
    t.balanceEnabled = false

    await background.handleMessage({ type: 'TOGGLE_BALANCE', tabId: 7 })

    // -14 - (-20) = +6 dB — back to balancing.
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 7, gainDb: 6 }),
    )
  })

  // --- disable restores unity gain --------------------------------------------

  it('restores unity gain on every tab when disabled', async () => {
    seedTab({ tabId: 5, shortTerm: -30, blockCount: 50, appliedGainDb: 12, maxGainDb: 24 })

    await background.handleMessage({ type: 'SET_ENABLED', enabled: false })

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 5, gainDb: 0 }),
    )
  })

  // --- TAB_UNLOAD drops the tab -----------------------------------------------

  it('drops a tab on TAB_UNLOAD', async () => {
    seedTab({ tabId: 6 })
    await background.handleMessage({ type: 'TAB_UNLOAD', tabId: 6 }, {
      tab: { id: 6 },
    } as chrome.runtime.MessageSender)
    const state = (await background.handleMessage({ type: 'GET_STATE' })) as {
      tabs: TabState[]
    }
    expect(state.tabs.find((t) => t.tabId === 6)).toBeUndefined()
  })
})
