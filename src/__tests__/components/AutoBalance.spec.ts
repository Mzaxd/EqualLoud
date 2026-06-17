import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import AutoBalance from '@/components/AutoBalance.vue'
import { i18n } from '@/i18n'

vi.mock('@/stores/tabs', () => ({
  useTabsStore: () => ({
    targetLufs: -14,
    isAutoBalancing: false,
    tabs: [],
    toggleAutoBalance: vi.fn(async () => {}),
    setTargetLufs: vi.fn(async () => true),
  }),
}))

describe('AutoBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  function mountComponent() {
    return mount(AutoBalance, {
      global: { plugins: [i18n] },
    })
  }

  it('renders the target label', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('Target Volume')
  })

  it('renders the target LUFS value', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('-14 LUFS')
  })

  it('renders the combined meter track and target slider', () => {
    const wrapper = mountComponent()
    // The combined meter: a groove (.c-track) + an invisible range input.
    expect(wrapper.find('.c-track').exists()).toBe(true)
    expect(wrapper.find('.target-slider').exists()).toBe(true)
  })

  it('marks the target as off (dimmed fill) when auto-balance is disabled', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.target').classes()).toContain('is-off')
  })

  it('disables the target slider when auto-balance is off', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.target-slider').attributes('disabled')).toBeDefined()
  })

  describe('with mocked auto-balance enabled', () => {
    beforeEach(() => {
      vi.doMock('@/stores/tabs', () => ({
        useTabsStore: () => ({
          targetLufs: -20,
          isAutoBalancing: true,
          tabs: [
            {
              tabId: 1,
              title: 'Tab',
              url: 'https://test.com',
              isCapturing: true,
              shortTerm: -18,
              blockCount: 50,
              appliedGainDb: 0,
              maxGainDb: 12,
              balanceEnabled: true,
            },
          ],
          toggleAutoBalance: vi.fn(async () => {}),
          setTargetLufs: vi.fn(async () => true),
        }),
      }))
    })

    async function mountEnabled() {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: AutoBalanceOn } = await import('@/components/AutoBalance.vue')
      return mount(AutoBalanceOn, { global: { plugins: [i18n] } })
    }

    it('drops the is-off class when enabled', async () => {
      const wrapper = await mountEnabled()
      expect(wrapper.find('.target').classes()).not.toContain('is-off')
    })

    it('enables the target slider when enabled', async () => {
      const wrapper = await mountEnabled()
      expect(wrapper.find('.target-slider').attributes('disabled')).toBeUndefined()
    })

    it('reflects the target LUFS value', async () => {
      const wrapper = await mountEnabled()
      expect(wrapper.text()).toContain('-20 LUFS')
    })

    it('drives the fill from the loudest balanced tab short-term', async () => {
      const wrapper = await mountEnabled()
      const fill = wrapper.find('.c-fill')
      // shortTerm -18 → ((-18+60)/60)*100 = 70%. A 0.5px tolerance covers the
      // CSS px rounding vs. the JS percentage string.
      expect(fill.attributes('style')).toContain('width: 70%')
    })
  })
})
