import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

import Limiter from '@/components/Limiter.vue'
import { i18n } from '@/i18n'

const defaultStore = {
  isLimiterEnabled: false,
  limiterThreshold: -1,
  limiterAttack: 1,
  limiterRelease: 100,
  limiterKnee: 0,
  limiterRatio: 20,
  setLimiterEnabled: vi.fn(async () => true),
  setLimiterThreshold: vi.fn(async () => true),
  setLimiterAttack: vi.fn(async () => true),
  setLimiterRelease: vi.fn(async () => true),
  setLimiterKnee: vi.fn(async () => true),
  setLimiterRatio: vi.fn(async () => true),
}

vi.mock('@/stores/tabs', () => ({
  useTabsStore: () => ({ ...defaultStore }),
}))

describe('Limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  function mountComponent() {
    return mount(Limiter, {
      global: { plugins: [i18n] },
    })
  }

  it('renders the limiter title', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('Output Limiter')
  })

  it('renders the description', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('Prevents clipping')
  })

  it('shows OFF when disabled', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('OFF')
  })

  it('toggle does not have active class when disabled', () => {
    const wrapper = mountComponent()
    const toggle = wrapper.find('.limiter-toggle')
    expect(toggle.classes()).not.toContain('active')
  })

  it('renders threshold slider', () => {
    const wrapper = mountComponent()
    const slider = wrapper.find('.threshold-slider')
    expect(slider.exists()).toBe(true)
  })

  it('renders threshold value', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('-1.0 dB')
  })

  it('does not show limiter active status when disabled', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.limiter-status').exists()).toBe(false)
  })

  describe('when enabled', () => {
    beforeEach(() => {
      vi.doMock('@/stores/tabs', () => ({
        useTabsStore: () => ({
          ...defaultStore,
          isLimiterEnabled: true,
          limiterThreshold: -2,
          limiterAttack: 5,
          limiterRelease: 150,
          limiterKnee: 3,
          limiterRatio: 10,
        }),
      }))
    })

    it('shows ON when enabled', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: LimiterOn } = await import('@/components/Limiter.vue')
      const wrapper = mount(LimiterOn, {
        global: { plugins: [i18n] },
      })
      expect(wrapper.text()).toContain('ON')
    })

    it('toggle has active class when enabled', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: LimiterOn } = await import('@/components/Limiter.vue')
      const wrapper = mount(LimiterOn, {
        global: { plugins: [i18n] },
      })
      const toggle = wrapper.find('.limiter-toggle')
      expect(toggle.classes()).toContain('active')
    })

    it('shows active status indicator when enabled', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: LimiterOn } = await import('@/components/Limiter.vue')
      const wrapper = mount(LimiterOn, {
        global: { plugins: [i18n] },
      })
      const status = wrapper.find('.limiter-status')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('Limiter active')
    })

    it('shows correct threshold value', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: LimiterOn } = await import('@/components/Limiter.vue')
      const wrapper = mount(LimiterOn, {
        global: { plugins: [i18n] },
      })
      expect(wrapper.text()).toContain('-2.0 dB')
    })
  })

  describe('advanced settings', () => {
    it('hides advanced controls by default', () => {
      const wrapper = mountComponent()
      expect(wrapper.find('.advanced-controls').exists()).toBe(false)
    })

    it('shows advanced toggle button', () => {
      const wrapper = mountComponent()
      expect(wrapper.text()).toContain('Advanced Settings')
    })

    it('advanced toggle is disabled when limiter is off', () => {
      const wrapper = mountComponent()
      const advancedToggle = wrapper.find('.advanced-toggle')
      expect(advancedToggle.attributes('disabled')).toBeDefined()
    })
  })

  describe('advanced settings when enabled', () => {
    beforeEach(() => {
      vi.doMock('@/stores/tabs', () => ({
        useTabsStore: () => ({
          ...defaultStore,
          isLimiterEnabled: true,
        }),
      }))
    })

    it('toggles advanced controls on click', async () => {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: LimiterEnabled } = await import('@/components/Limiter.vue')
      const wrapper = mount(LimiterEnabled, {
        global: { plugins: [i18n] },
      })
      const advancedToggle = wrapper.find('.advanced-toggle')
      await advancedToggle.trigger('click')
      await nextTick()
      // After click, should show expanded icon
      expect(wrapper.text()).toContain('▼')
      expect(wrapper.find('.advanced-controls').exists()).toBe(true)
    })
  })
})
