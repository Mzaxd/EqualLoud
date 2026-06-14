import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import App from '../App.vue'
import { i18n } from '../i18n'

vi.mock('@/stores/tabs', () => {
  return {
    useTabsStore: () => ({
      tabs: [],
      startPolling: vi.fn(() => {}),
      stopPolling: vi.fn(() => {}),
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

  it('mounts and renders the EqualLoud title', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [i18n],
      },
    })
    expect(wrapper.text()).toContain('EqualLoud')
  })

  it('renders settings toggle button', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [i18n],
      },
    })
    expect(wrapper.text()).toContain('Settings')
  })
})
