import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import App from '../App.vue'
import { i18n } from '../i18n'

vi.mock('@/stores/tabs', () => {
  return {
    useTabsStore: () => ({
      tabs: [],
      isAutoBalancing: true,
      targetLufs: -14,
      // Limiter is rendered inside the (collapsed) settings panel, so its store
      // slice must exist even though the panel starts hidden — mounting Limiter
      // reads these on setup.
      isLimiterEnabled: true,
      limiterThreshold: -2,
      limiterAttack: 0.7,
      limiterRelease: 150,
      limiterKnee: 0,
      limiterRatio: 20,
      setLimiterEnabled: vi.fn(async () => true),
      setLimiterThreshold: vi.fn(async () => true),
      setLimiterAttack: vi.fn(async () => true),
      setLimiterRelease: vi.fn(async () => true),
      setLimiterKnee: vi.fn(async () => true),
      setLimiterRatio: vi.fn(async () => true),
      startPolling: vi.fn(() => {}),
      stopPolling: vi.fn(() => {}),
      toggleAutoBalance: vi.fn(async () => {}),
      setTargetLufs: vi.fn(async () => true),
    }),
  }
})

vi.mock('@/stores/settings', () => {
  return {
    useSettingsStore: () => ({
      locale: 'en',
      setLocale: vi.fn(),
    }),
  }
})

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('mounts and renders the EqualLoud wordmark', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [i18n],
      },
    })
    expect(wrapper.text()).toContain('EqualLoud')
  })

  it('renders the circular power toggle button in the header', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [i18n],
      },
    })
    // The master on/off is now a standby power button, not a text "Settings" link.
    expect(wrapper.find('.power').exists()).toBe(true)
  })

  it('renders the settings gear button in the footer', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [i18n],
      },
    })
    expect(wrapper.find('.icon-btn').exists()).toBe(true)
  })

  it('keeps the settings panel collapsed until the gear is clicked', async () => {
    const wrapper = mount(App, {
      global: {
        plugins: [i18n],
      },
    })
    expect(wrapper.find('.settings').classes()).not.toContain('open')
    await wrapper.find('.icon-btn').trigger('click')
    expect(wrapper.find('.settings').classes()).toContain('open')
  })

  it('renders the language toggle button', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [i18n],
      },
    })
    expect(wrapper.find('.ghost').exists()).toBe(true)
  })
})
