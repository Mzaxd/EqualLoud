import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import PowerToggle from '@/components/PowerToggle.vue'
import { i18n } from '@/i18n'

const toggleAutoBalance = vi.fn(async () => {})

vi.mock('@/stores/tabs', () => ({
  useTabsStore: () => ({
    isAutoBalancing: false,
    toggleAutoBalance,
  }),
}))

describe('PowerToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  function mountComponent() {
    return mount(PowerToggle, { global: { plugins: [i18n] } })
  }

  it('renders the circular power button', () => {
    const wrapper = mountComponent()
    const btn = wrapper.find('.power')
    expect(btn.exists()).toBe(true)
    expect(btn.element.tagName).toBe('BUTTON')
  })

  it('does not glow (no .on) when balancing is off', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.power').classes()).not.toContain('on')
  })

  it('reflects aria-pressed for the on/off state', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.power').attributes('aria-pressed')).toBe('false')
  })

  it('calls toggleAutoBalance on click', async () => {
    const wrapper = mountComponent()
    await wrapper.find('.power').trigger('click')
    expect(toggleAutoBalance).toHaveBeenCalled()
  })

  describe('when balancing is on', () => {
    beforeEach(() => {
      vi.doMock('@/stores/tabs', () => ({
        useTabsStore: () => ({
          isAutoBalancing: true,
          toggleAutoBalance,
        }),
      }))
    })

    it('adds the .on glow class and aria-pressed=true', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: PowerToggleOn } = await import('@/components/PowerToggle.vue')
      const wrapper = mount(PowerToggleOn, { global: { plugins: [i18n] } })
      const btn = wrapper.find('.power')
      expect(btn.classes()).toContain('on')
      expect(btn.attributes('aria-pressed')).toBe('true')
    })
  })
})
