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

  it('renders the title', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('Target Volume')
  })

  it('shows disabled status when auto-balance is off', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('Volume balancing is off')
  })

  it('renders the toggle button', () => {
    const wrapper = mountComponent()
    const toggle = wrapper.find('.toggle-switch')
    expect(toggle.exists()).toBe(true)
  })

  it('toggle button does not have active class when disabled', () => {
    const wrapper = mountComponent()
    const toggle = wrapper.find('.toggle-switch')
    expect(toggle.classes()).not.toContain('active')
  })

  it('does not show target slider when disabled', () => {
    const wrapper = mountComponent()
    const slider = wrapper.find('.target-slider')
    expect(slider.exists()).toBe(false)
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
              shortTerm: -20,
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

    it('shows active toggle when enabled', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: AutoBalanceOn } = await import('@/components/AutoBalance.vue')
      const wrapper = mount(AutoBalanceOn, {
        global: { plugins: [i18n] },
      })
      const toggle = wrapper.find('.toggle-switch')
      expect(toggle.classes()).toContain('active')
    })

    it('shows balancing status with count when enabled', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: AutoBalanceOn } = await import('@/components/AutoBalance.vue')
      const wrapper = mount(AutoBalanceOn, {
        global: { plugins: [i18n] },
      })
      expect(wrapper.text()).toContain('Balancing 1 tab(s)')
    })

    it('shows target slider when enabled', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: AutoBalanceOn } = await import('@/components/AutoBalance.vue')
      const wrapper = mount(AutoBalanceOn, {
        global: { plugins: [i18n] },
      })
      const slider = wrapper.find('.target-slider')
      expect(slider.exists()).toBe(true)
    })

    it('shows target LUFS value', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: AutoBalanceOn } = await import('@/components/AutoBalance.vue')
      const wrapper = mount(AutoBalanceOn, {
        global: { plugins: [i18n] },
      })
      expect(wrapper.text()).toContain('-20 LUFS')
    })
  })
})
