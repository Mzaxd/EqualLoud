import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

import UpdateNotice from '@/components/UpdateNotice.vue'
import { i18n } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'

// `__APP_VERSION__` is injected by Vite's `define` (from npm_package_version).
// We don't know what value that resolves to in CI, so stub a known one.
const STUB_VERSION = '9.9.9-test'

describe('UpdateNotice', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', STUB_VERSION)
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mountComponent() {
    return mount(UpdateNotice, { global: { plugins: [i18n] } })
  }

  it('is hidden on first install (lastNoticeVersion is null)', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.update-notice').exists()).toBe(false)
  })

  it('is hidden after the notice was dismissed for the current version', () => {
    useSettingsStore().lastNoticeVersion = STUB_VERSION
    const wrapper = mountComponent()
    expect(wrapper.find('.update-notice').exists()).toBe(false)
  })

  it('is visible when the stored version differs from the current one', () => {
    useSettingsStore().lastNoticeVersion = '0.0.1-old'
    const wrapper = mountComponent()
    expect(wrapper.find('.update-notice').exists()).toBe(true)
  })

  it('writes back the current version and disappears on dismiss', async () => {
    const settings = useSettingsStore()
    settings.lastNoticeVersion = '0.0.1-old'
    const wrapper = mountComponent()

    await wrapper.find('.notice-dismiss').trigger('click')

    expect(settings.lastNoticeVersion).toBe(STUB_VERSION)
    expect(wrapper.find('.update-notice').exists()).toBe(false)
  })

  it('renders the i18n text and dismiss label', () => {
    useSettingsStore().lastNoticeVersion = '0.0.1-old'
    const wrapper = mountComponent()
    expect(wrapper.find('.notice-text').text()).toBe(i18n.global.t('updateNotice.text') as string)
    const btn = wrapper.find('.notice-dismiss')
    expect(btn.attributes('aria-label')).toBe(i18n.global.t('updateNotice.dismiss') as string)
  })
})
