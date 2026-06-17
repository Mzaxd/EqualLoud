import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import InfoTip from '@/components/InfoTip.vue'
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

  it('shows OFF when disabled', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('OFF')
  })

  it('toggle does not have the on class when disabled', () => {
    const wrapper = mountComponent()
    const toggle = wrapper.find('.limiter-toggle')
    expect(toggle.exists()).toBe(true)
    expect(toggle.classes()).not.toContain('on')
  })

  describe('all five parameters are always visible (no fold)', () => {
    // The defining property of the flattened design: every limiter knob is
    // rendered at one level, regardless of enable state. No "Advanced" fold.
    it('renders threshold, ratio, attack, release, knee sliders', () => {
      const wrapper = mountComponent()
      expect(wrapper.find('.threshold-slider').exists()).toBe(true)
      expect(wrapper.find('.ratio-slider').exists()).toBe(true)
      expect(wrapper.find('.attack-slider').exists()).toBe(true)
      expect(wrapper.find('.release-slider').exists()).toBe(true)
      expect(wrapper.find('.knee-slider').exists()).toBe(true)
    })

    it('renders default formatted values', () => {
      const wrapper = mountComponent()
      expect(wrapper.text()).toContain('-1.0 dB')
      expect(wrapper.text()).toContain('20:1')
      expect(wrapper.text()).toContain('1.0 ms')
      expect(wrapper.text()).toContain('100 ms')
      expect(wrapper.text()).toContain('0 dB')
    })

    it('renders no "Advanced Settings" toggle', () => {
      const wrapper = mountComponent()
      expect(wrapper.find('.advanced-toggle').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Advanced Settings')
    })

    it('renders no advanced-controls container', () => {
      const wrapper = mountComponent()
      expect(wrapper.find('.advanced-controls').exists()).toBe(false)
    })

    it('renders contextual hints for all five parameters', () => {
      const wrapper = mountComponent()
      // Defaults: threshold=-1 (aggressive), ratio=20 (standard boundary→brickwall at >20),
      // attack=1 (fast), release=100 (balanced), knee=0 (hard)
      expect(wrapper.text()).toContain('Aggressive')
      expect(wrapper.text()).toContain('Brick wall')
      expect(wrapper.text()).toContain('Fast - catches transients')
      expect(wrapper.text()).toContain('Balanced')
      expect(wrapper.text()).toContain('Hard knee')
    })

    it('renders an InfoTip next to each label and the title', () => {
      const wrapper = mountComponent()
      // 5 parameter labels + 1 title = 6 tooltips
      const tips = wrapper.findAllComponents(InfoTip)
      expect(tips.length).toBe(6)
    })

    it('disables all sliders when limiter is off', () => {
      const wrapper = mountComponent()
      const sliders = wrapper.findAll('.fader')
      expect(sliders.length).toBe(5)
      for (const s of sliders) {
        expect(s.attributes('disabled')).toBeDefined()
      }
    })
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

    async function mountEnabled() {
      vi.resetModules()
      setActivePinia(createPinia())
      const { default: LimiterOn } = await import('@/components/Limiter.vue')
      return mount(LimiterOn, { global: { plugins: [i18n] } })
    }

    it('shows ON when enabled', async () => {
      const wrapper = await mountEnabled()
      expect(wrapper.text()).toContain('ON')
    })

    it('toggle has the on class when enabled', async () => {
      const wrapper = await mountEnabled()
      const toggle = wrapper.find('.limiter-toggle')
      expect(toggle.classes()).toContain('on')
    })

    it('shows the configured parameter values', async () => {
      const wrapper = await mountEnabled()
      expect(wrapper.text()).toContain('-2.0 dB')
      expect(wrapper.text()).toContain('10:1')
      expect(wrapper.text()).toContain('5.0 ms')
      expect(wrapper.text()).toContain('150 ms')
      expect(wrapper.text()).toContain('3 dB')
    })

    it('does not disable sliders when enabled', async () => {
      const wrapper = await mountEnabled()
      const sliders = wrapper.findAll('.fader')
      for (const s of sliders) {
        expect(s.attributes('disabled')).toBeUndefined()
      }
    })

    it('updates hint text to match new parameter values', async () => {
      // threshold=-2 (balanced), ratio=10 (standard), attack=5 (balanced),
      // release=150 (balanced boundary→slow at >150), knee=3 (soft)
      const wrapper = await mountEnabled()
      expect(wrapper.text()).toContain('Balanced')
      expect(wrapper.text()).toContain('Standard')
      expect(wrapper.text()).toContain('Soft knee - smoother')
    })
  })

  describe('toggle interaction', () => {
    it('calls setLimiterEnabled with inverted value on click', async () => {
      const wrapper = mountComponent()
      await wrapper.find('.limiter-toggle').trigger('click')
      expect(defaultStore.setLimiterEnabled).toHaveBeenCalledWith(true)
    })
  })
})
