import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settings'

describe('useSettingsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    // Default navigator.language in jsdom is 'en-US'
  })

  it('initializes with default locale from navigator.language', () => {
    const store = useSettingsStore()
    // jsdom's navigator.language is 'en-US' → normalized to 'en'
    expect(store.locale).toBe('en')
  })

  describe('setLocale', () => {
    it('normalizes zh locale to zh_CN', () => {
      const store = useSettingsStore()
      store.setLocale('zh')
      expect(store.locale).toBe('zh_CN')
    })

    it('normalizes zh-CN locale to zh_CN', () => {
      const store = useSettingsStore()
      store.setLocale('zh-CN')
      expect(store.locale).toBe('zh_CN')
    })

    it('normalizes zh_TW to zh_CN', () => {
      const store = useSettingsStore()
      store.setLocale('zh_TW')
      expect(store.locale).toBe('zh_CN')
    })

    it('keeps en locale as en', () => {
      const store = useSettingsStore()
      store.setLocale('en')
      expect(store.locale).toBe('en')
    })

    it('normalizes unknown locale to en', () => {
      const store = useSettingsStore()
      store.setLocale('fr')
      expect(store.locale).toBe('en')
    })

    it('normalizes empty string to en', () => {
      const store = useSettingsStore()
      store.setLocale('')
      expect(store.locale).toBe('en')
    })

    it('is case-insensitive', () => {
      const store = useSettingsStore()
      store.setLocale('ZH')
      expect(store.locale).toBe('zh_CN')
    })
  })
})
