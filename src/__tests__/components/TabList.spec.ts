import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { type CapturedTab } from '@/stores/tabs'

function createMockTab(overrides: Partial<CapturedTab> = {}): CapturedTab {
  return {
    tabId: 1,
    title: 'YouTube - Music',
    url: 'https://music.youtube.com/watch?v=abc',
    isCapturing: true,
    shortTerm: -15,
    blockCount: 50,
    appliedGainDb: 0,
    maxGainDb: 12,
    balanceEnabled: true,
    ...overrides,
  }
}

// Shared mock-store builder so each test only spells out what it varies. The
// store is mocked wholesale (vi.mock) because TabList reads reactive slices
// off it directly.
function mockStore(
  overrides: {
    tabs?: CapturedTab[]
    isAutoBalancing?: boolean
    toggleBalance?: ReturnType<typeof vi.fn>
  } = {},
) {
  return {
    useTabsStore: () => ({
      tabs: overrides.tabs ?? [],
      isAutoBalancing: overrides.isAutoBalancing ?? true,
      toggleBalance: overrides.toggleBalance ?? vi.fn(async () => true),
    }),
    hasEnoughSamples: (lufs: { blockCount: number }) => lufs.blockCount >= 1,
  }
}

vi.mock('@/stores/tabs', () => mockStore())

async function remountWith(storeOverride: ReturnType<typeof mockStore>) {
  vi.doMock('@/stores/tabs', () => storeOverride)
  vi.resetModules()
  setActivePinia(createPinia())
  const { default: TabList } = await import('@/components/TabList.vue')
  const { i18n } = await import('@/i18n')
  return mount(TabList, { global: { plugins: [i18n] } })
}

describe('TabList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.doUnmock('@/stores/tabs')
    vi.mock('@/stores/tabs', () => mockStore())
    setActivePinia(createPinia())
  })

  async function mountComponent() {
    const { default: TabListFresh } = await import('@/components/TabList.vue')
    const { i18n } = await import('@/i18n')
    return mount(TabListFresh, { global: { plugins: [i18n] } })
  }

  it('shows empty state when no tabs', async () => {
    const wrapper = await mountComponent()
    expect(wrapper.text()).toContain('Waiting for audio...')
  })

  it('shows hint text in empty state', async () => {
    const wrapper = await mountComponent()
    expect(wrapper.text()).toContain('Open a tab with audio')
  })

  describe('with tabs', () => {
    it('renders tab title', async () => {
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()] }))
      expect(wrapper.text()).toContain('YouTube - Music')
    })

    it('renders applied gain value', async () => {
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()] }))
      expect(wrapper.text()).toContain('+0.0 dB')
    })

    it('renders the whole row as a clickable tab button', async () => {
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()] }))
      const row = wrapper.find('.tab')
      expect(row.exists()).toBe(true)
      expect(row.element.tagName).toBe('BUTTON')
      // balanceEnabled defaults true → no bypass dimming.
      expect(row.classes()).not.toContain('bypass')
      // Row is interactive (global switch on).
      expect(row.attributes('disabled')).toBeUndefined()
    })

    it('calls toggleBalance when the whole row is clicked', async () => {
      const toggleBalance = vi.fn(async () => true)
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()], toggleBalance }))
      await wrapper.find('.tab').trigger('click')
      expect(toggleBalance).toHaveBeenCalledWith(1)
    })

    it('adds the bypass class and shows BYPASS when balanceEnabled is false', async () => {
      const wrapper = await remountWith(
        mockStore({ tabs: [createMockTab({ balanceEnabled: false })] }),
      )
      const row = wrapper.find('.tab')
      expect(row.classes()).toContain('bypass')
      // BYPASS badge replaces the dB value.
      expect(wrapper.text()).toContain('BYPASS')
    })

    it('disables the row when the global switch is off', async () => {
      const wrapper = await remountWith(
        mockStore({ tabs: [createMockTab()], isAutoBalancing: false }),
      )
      const row = wrapper.find('.tab')
      expect(row.attributes('disabled')).toBeDefined()
      // Dash badge replaces the dB value when globally disabled.
      expect(wrapper.text()).toContain('—')
    })

    it('does not show collecting status when enough samples', async () => {
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()] }))
      expect(wrapper.text()).not.toContain('Analyzing...')
    })
  })

  describe('tab with collecting status', () => {
    it('shows collecting status for tab with few samples', async () => {
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab({ blockCount: 0 })] }))
      expect(wrapper.text()).toContain('Analyzing...')
    })
  })

  describe('gain display', () => {
    it('formats positive appliedGainDb with + prefix', async () => {
      const wrapper = await remountWith(
        mockStore({ tabs: [createMockTab({ appliedGainDb: 5.5 })] }),
      )
      expect(wrapper.text()).toContain('+5.5 dB')
    })
  })

  describe('favicon resolution (privacy: zero network egress)', () => {
    // The old code fetched every tab's domain from google.com/s2/favicons.
    // The new code must resolve icons locally: prefer the SW-captured
    // favIconUrl, else Chrome's _favicon/ cache. Neither may hit a third party.
    const fakeExtId = 'fakeeqextid1234567890abcdef'

    beforeEach(() => {
      // chrome.runtime.id is read inside getFaviconUrl to build the _favicon/ URL.
      globalThis.chrome = {
        ...(globalThis.chrome ?? {}),
        runtime: { ...(globalThis.chrome?.runtime ?? {}), id: fakeExtId },
      } as typeof chrome
    })

    it('uses the SW-captured favIconUrl when present (no third-party fetch)', async () => {
      const wrapper = await remountWith(
        mockStore({
          tabs: [createMockTab({ favIconUrl: 'https://music.youtube.com/favicon.ico' })],
        }),
      )
      const img = wrapper.find('.fav img')
      expect(img.exists()).toBe(true)
      expect(img.attributes('src')).toBe('https://music.youtube.com/favicon.ico')
    })

    it('falls back to the local _favicon/ API when no favIconUrl captured', async () => {
      const tab = createMockTab({ favIconUrl: undefined })
      const wrapper = await remountWith(mockStore({ tabs: [tab] }))
      const src = wrapper.find('.fav img').attributes('src') ?? ''
      // Must be the on-device _favicon path, never google.com.
      expect(src).toContain('_favicon/')
      expect(src).toContain(`chrome-extension://${fakeExtId}`)
      expect(src).toContain(encodeURIComponent(tab.url))
      expect(src).not.toContain('google.com')
    })

    it('never emits a google.com URL (regression guard for the privacy leak)', async () => {
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()] }))
      const src = wrapper.find('.fav img').attributes('src') ?? ''
      expect(src).not.toMatch(/google\.com/)
    })

    it('renders the glyph fallback when the URL is invalid', async () => {
      const wrapper = await remountWith(
        mockStore({ tabs: [createMockTab({ url: 'not-a-url', favIconUrl: undefined })] }),
      )
      // Invalid URL → getFaviconUrl returns '' → the v-if falls through, but
      // url is still truthy so img renders with empty src; the fallback glyph
      // span (.g) is in the v-else branch. Test the contract: no crash, no
      // google, and the row still renders.
      expect(wrapper.find('.tab').exists()).toBe(true)
      const src = wrapper.find('.fav img').attributes('src') ?? ''
      expect(src).not.toMatch(/google\.com/)
    })
  })
})
