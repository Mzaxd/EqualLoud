import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { TabState } from '@/messages/protocol'
import { clearLogs } from '@/utils/logger'

// Holds the onConnect callback background.ts registered at module load. Lives
// at module scope (not inside createChromeMock) because beforeEach rebuilds the
// chrome mock every test, yet background.ts is a cached module that only runs
// its top-level onConnect.addListener once — so a per-mock capture would be
// empty for every test after the first. Keeping it here gives every test a
// stable handle to simulate a popup Port connecting.
let onConnectHandler: ((port: unknown) => void) | undefined

function createChromeMock() {
  return {
    runtime: {
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      // The popup Port listener; background.ts registers onConnect on load.
      // addListener stashes the handler in the module-scope `onConnectHandler`
      // so any test can simulate a popup connecting regardless of mock state.
      onConnect: {
        addListener: vi.fn((cb: (port: unknown) => void) => {
          onConnectHandler = cb
        }),
      },
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
      // session mirrors the logger ring buffer across SW sleep. Defaults to an
      // empty object so loadLogs() reads nothing and the buffer starts clean.
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
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
    // The logger buffer is a module singleton shared across tests; reset it so
    // one test's entries don't leak into another's GET_LOGS assertions.
    clearLogs()
    background = await import('@/background')
    background.resetState()
    // Drain the loadSettings()/loadLogs() promise chain triggered by resetState.
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

  // --- SW recovery: don't blip a tab back to 0 dB after sleep ----------------
  //
  // When the SW wakes from sleep its in-memory `tabs` Map is empty. The content
  // script's PING reply carries the gain it currently has applied so the SW can
  // seed `appliedGainDb` and echo it back instead of forcing a unity (0 dB)
  // decision on a cold tab — which would briefly restore full volume.

  it("echoes the content script's last gain on recovery instead of 0 dB", async () => {
    // Empty Map ⇒ simulate SW just woke. Tab 9 reports it was held at -8 dB.
    ;(chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    await background.handleMessage(
      {
        type: 'MEDIA_ATTACHED',
        tabId: -1,
        title: 'Loud',
        url: 'https://yt.com',
        appliedGainDb: -8,
      },
      { tab: { id: 9 } } as chrome.runtime.MessageSender,
    )

    // The recovered gain (-8 dB) must be echoed immediately so the GainNode
    // stays put. Crucially, no 0 dB decision should be emitted.
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 9, gainDb: -8 }),
    )
    const sent = (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as { type: string; gainDb?: number },
    )
    const setGains = sent.filter((m) => m.type === 'SET_GAIN')
    expect(setGains.every((m) => m.gainDb !== 0)).toBe(true)

    // And the tab's persisted state should carry the seeded gain.
    const state = (await background.handleMessage({ type: 'GET_STATE' })) as {
      tabs: TabState[]
    }
    expect(state.tabs.find((t) => t.tabId === 9)?.appliedGainDb).toBe(-8)
  })

  it('still rebalances a known tab on MEDIA_ATTACHED (no cold-recovery path)', async () => {
    // Tab 10 already exists (primary switch on a live SW). MEDIA_ATTACHED here
    // is NOT a recovery, so the SW should run maybeBalance() as before rather
    // than blindly echoing whatever gain the CS reports.
    seedTab({ tabId: 10, shortTerm: -20, blockCount: 50, appliedGainDb: -8, maxGainDb: 24 })
    ;(chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    await background.handleMessage(
      { type: 'MEDIA_ATTACHED', tabId: 10, title: 'YT', url: 'https://yt.com', appliedGainDb: -8 },
      { tab: { id: 10 } } as chrome.runtime.MessageSender,
    )

    // -14 (default target) - (-20) = +6 dB — the recomputed decision, not the
    // echoed -8 dB. Confirms the recovery shortcut only fires for missing tabs.
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ type: 'SET_GAIN', tabId: 10, gainDb: 6 }),
    )
  })

  it('falls back to the 0 dB path for an older content script (no appliedGainDb)', async () => {
    // Legacy CS that doesn't send appliedGainDb. The SW must not break; it
    // creates the tab and runs maybeBalance() (which yields 0 dB for a cold
    // tab) — i.e. the original pre-fix behaviour, preserving compatibility.
    ;(chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    await background.handleMessage(
      { type: 'MEDIA_ATTACHED', tabId: -1, title: 'Old', url: 'https://yt.com' },
      { tab: { id: 11 } } as chrome.runtime.MessageSender,
    )

    // Tab exists with default appliedGainDb: 0.
    const state = (await background.handleMessage({ type: 'GET_STATE' })) as {
      tabs: TabState[]
    }
    expect(state.tabs.find((t) => t.tabId === 11)?.appliedGainDb).toBe(0)
  })

  // --- Diagnostic logs (logger ring buffer) ----------------------------------

  it('GET_LOGS returns the buffered entries', async () => {
    // Produce a warning by forcing the SW to log one. scanTabs failure path
    // calls log.error('initial scan failed'); we instead drive a direct path:
    // an error inside handleNotification's MEDIA_ATTACHED with a missing sender
    // is a no-op, so seed a log via the unhandled-rejection-free route — just
    // send a MEDIA_ATTACHED then a TOGGLE_BALANCE which logs nothing. Instead,
    // assert the empty-buffer contract here and the round-trip in the next test.
    const empty = (await background.handleMessage({ type: 'GET_LOGS' })) as {
      entries: unknown[]
    }
    expect(Array.isArray(empty.entries)).toBe(true)
    // A freshly-reset SW (clearLogs in beforeEach) reports nothing yet.
    expect(empty.entries).toHaveLength(0)
  })

  it('CLEAR_LOGS empties the buffer and removes the session mirror', async () => {
    // Seed the buffer indirectly: a LUFS_REPORT on an unknown tab triggers the
    // recovery branch (ensureTab) but no error. Instead, we verify the clear
    // contract directly — CLEAR_LOGS must (a) return { cleared: true } and
    // (b) call storage.session.remove('elogs') so the sleep-mirror is wiped too.
    const resp = (await background.handleMessage({ type: 'CLEAR_LOGS' })) as {
      cleared?: boolean
    }
    expect(resp).toEqual({ cleared: true })
    expect(chrome.storage.session.remove).toHaveBeenCalledWith('elogs')

    // And a subsequent GET_LOGS confirms the buffer is empty.
    const after = (await background.handleMessage({ type: 'GET_LOGS' })) as {
      entries: unknown[]
    }
    expect(after.entries).toHaveLength(0)
  })

  it('restores the log buffer from storage.session after resetState (SW wake)', async () => {
    // Simulate a pre-sleep buffer persisted to session. The next resetState
    // (mirroring a SW wake) must reload it so the popup can still export the
    // history that preceded the sleep.
    const stored = [{ ts: 1, level: 'warn', scope: 'sw', msg: 'pre-sleep-warn' }]
    chrome.storage.session.get.mockResolvedValue({ elogs: stored })

    background.resetState()
    await vi.runOnlyPendingTimersAsync() // drain loadLogs()

    const resp = (await background.handleMessage({ type: 'GET_LOGS' })) as {
      entries: { msg: string }[]
    }
    expect(resp.entries.map((e) => e.msg)).toContain('pre-sleep-warn')
  })

  // --- Popup push: LUFS_REPORT must always stream to the popup ----------------
  //
  // Regression guard for the "live meter stays empty" bug. The popup's loudness
  // meter binds to `tab.shortTerm`, whose ONLY continuous source is the ~10 Hz
  // LUFS_REPORT heartbeat. pushStateToPopups() used to fire only at the tail of
  // balanceOnce(), which maybeBalance() short-circuits whenever the
  // BALANCE_THROTTLE_MS window (100 ms) hasn't elapsed — the SAME period as the
  // heartbeat. So most reports updated shortTerm in memory but never reached the
  // popup, freezing the meter (showed empty/black) until an untimed push (a
  // setting change, MEDIA_ATTACHED) happened to arrive.

  /** Build a fake popup Port and register it with the SW as if it just opened. */
  function connectPopup(): {
    port: { name: string; postMessage: ReturnType<typeof vi.fn> }
    sent: () => { type: string }[]
  } {
    const port = {
      name: 'equalloud-popup',
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    }
    // Use the module-scope handler captured at background.ts load time.
    onConnectHandler!(port)
    const sent = () => (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    return { port, sent }
  }

  it('pushes state to the popup on every LUFS_REPORT even when balance is throttled', async () => {
    seedTab({ tabId: 12, shortTerm: -30, blockCount: 50, maxGainDb: 24 })
    const { sent } = connectPopup()
    // Drain the cold-start snapshot pushed on connect.
    ;(chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()
    const initialPushCount = sent().length

    // First report runs balance (not throttled) and pushes. balanceOnce() is
    // fire-and-forget inside maybeBalance(), so await a microtask flush for its
    // trailing pushStateToPopups() to land.
    await background.handleMessage(
      { type: 'LUFS_REPORT', tabId: 12, shortTerm: -25, blockCount: 51 },
      { tab: { id: 12 } } as chrome.runtime.MessageSender,
    )
    await vi.runAllTimersAsync()
    expect(sent().length).toBeGreaterThan(initialPushCount)

    // Second report arrives within the 100 ms throttle window. balance is
    // skipped, but the popup's meter must STILL see the fresh shortTerm —
    // otherwise the live meter freezes (the reported bug).
    const beforeSecond = sent().length
    await background.handleMessage(
      { type: 'LUFS_REPORT', tabId: 12, shortTerm: -18, blockCount: 52 },
      { tab: { id: 12 } } as chrome.runtime.MessageSender,
    )
    await vi.runAllTimersAsync()
    expect(sent().length).toBeGreaterThan(beforeSecond)
    const lastPush = sent()[sent().length - 1] as unknown as { tabs: TabState[] }
    expect(lastPush.tabs.find((t) => t.tabId === 12)?.shortTerm).toBe(-18)
  })
})
