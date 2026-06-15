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

    it('renders the balance toggle button', async () => {
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()] }))
      const btn = wrapper.find('.balance-btn')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toContain('⚖️')
      // balanceEnabled defaults true → active class + not disabled.
      expect(btn.classes()).toContain('active')
      expect(btn.attributes('disabled')).toBeUndefined()
    })

    it('calls toggleBalance when the balance button is clicked', async () => {
      const toggleBalance = vi.fn(async () => true)
      const wrapper = await remountWith(mockStore({ tabs: [createMockTab()], toggleBalance }))
      await wrapper.find('.balance-btn').trigger('click')
      expect(toggleBalance).toHaveBeenCalledWith(1)
    })

    it('marks the balance button inactive and shows BYPASS when balanceEnabled is false', async () => {
      const wrapper = await remountWith(
        mockStore({ tabs: [createMockTab({ balanceEnabled: false })] }),
      )
      const btn = wrapper.find('.balance-btn')
      expect(btn.classes()).not.toContain('active')
      // BYPASS badge replaces the dB value.
      expect(wrapper.text()).toContain('BYPASS')
    })

    it('disables the balance button when the global switch is off', async () => {
      const wrapper = await remountWith(
        mockStore({ tabs: [createMockTab()], isAutoBalancing: false }),
      )
      const btn = wrapper.find('.balance-btn')
      expect(btn.attributes('disabled')).toBeDefined()
      // No gain badge when globally disabled.
      expect(wrapper.text()).not.toContain('+0.0 dB')
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

    it('truncates long titles', async () => {
      const wrapper = await remountWith(
        mockStore({ tabs: [createMockTab({ title: 'A'.repeat(50) })] }),
      )
      const titleEl = wrapper.find('.tab-title')
      expect(titleEl.text().length).toBeLessThanOrEqual(28)
    })
  })
})
