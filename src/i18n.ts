import { createI18n } from 'vue-i18n'

import en from './locales/en.json'
import zhCN from './locales/zh_CN.json'

function normalizeLocaleCode(input: string | null | undefined): 'en' | 'zh_CN' {
  const code = (input || '').toLowerCase()
  if (code.startsWith('zh')) return 'zh_CN'
  return 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: normalizeLocaleCode(typeof navigator !== 'undefined' ? navigator.language : 'en'),
  fallbackLocale: 'en',
  globalInjection: true,
  messages: {
    en,
    zh_CN: zhCN,
  },
})
