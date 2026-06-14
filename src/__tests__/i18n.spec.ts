import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, it, expect } from 'vitest'

import { i18n } from '@/i18n'

// Read raw JSON to avoid Vite/i18n plugin transforms
const enRaw = JSON.parse(readFileSync(resolve(__dirname, '../locales/en.json'), 'utf-8'))
const zhCNRaw = JSON.parse(readFileSync(resolve(__dirname, '../locales/zh_CN.json'), 'utf-8'))

describe('i18n configuration', () => {
  it('has en messages available', () => {
    expect(enRaw).toBeDefined()
    expect(enRaw.popup.title).toBe('EqualLoud')
  })

  it('has zh_CN messages available', () => {
    expect(zhCNRaw).toBeDefined()
    expect(zhCNRaw.popup.title).toBe('EqualLoud')
  })

  it('en and zh_CN have same structure for popup', () => {
    const enKeys = Object.keys(enRaw.popup).sort()
    const zhKeys = Object.keys(zhCNRaw.popup).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('en and zh_CN have same structure for tabs', () => {
    const enKeys = Object.keys(enRaw.tabs).sort()
    const zhKeys = Object.keys(zhCNRaw.tabs).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('en and zh_CN have same structure for limiter', () => {
    const enKeys = Object.keys(enRaw.limiter).sort()
    const zhKeys = Object.keys(zhCNRaw.limiter).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('en and zh_CN have same structure for autobalance', () => {
    const enKeys = Object.keys(enRaw.autobalance).sort()
    const zhKeys = Object.keys(zhCNRaw.autobalance).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('en and zh_CN have same structure for settings', () => {
    const enKeys = Object.keys(enRaw.settings).sort()
    const zhKeys = Object.keys(zhCNRaw.settings).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('fallback locale is en', () => {
    expect(i18n.global.fallbackLocale.value).toBe('en')
  })

  it('can translate key in English', () => {
    expect(i18n.global.t('popup.title')).toBe('EqualLoud')
  })

  it('can translate footer in English', () => {
    expect(i18n.global.t('footer.brand')).toBe('EqualLoud')
    expect(i18n.global.t('footer.author')).toBe('github.com/dsh0416/EqualLoud')
  })

  it('translates all status messages in English', () => {
    expect(i18n.global.t('popup.status.disabled')).toBe('Volume balancing is off')
    expect(i18n.global.t('popup.status.waiting')).toBe('Waiting for audio...')
  })

  it('can translate key in Chinese via locale swap', () => {
    const prevLocale = i18n.global.locale.value
    i18n.global.locale.value = 'zh_CN'
    expect(i18n.global.t('popup.status.disabled')).toBe('音量平衡已关闭')
    // Restore
    i18n.global.locale.value = prevLocale
  })

  it('translates all autobalance presets in English', () => {
    expect(i18n.global.t('autobalance.presets.broadcast')).toBe('Broadcast')
    expect(i18n.global.t('autobalance.presets.streaming')).toBe('Streaming')
    expect(i18n.global.t('autobalance.presets.podcast')).toBe('Podcast')
    expect(i18n.global.t('autobalance.presets.loud')).toBe('Loud')
  })

  it('translates all autobalance presets in Chinese', () => {
    const prevLocale = i18n.global.locale.value
    i18n.global.locale.value = 'zh_CN'
    expect(i18n.global.t('autobalance.presets.broadcast')).toBe('广播')
    expect(i18n.global.t('autobalance.presets.streaming')).toBe('流媒体')
    expect(i18n.global.t('autobalance.presets.podcast')).toBe('播客')
    expect(i18n.global.t('autobalance.presets.loud')).toBe('响亮')
    i18n.global.locale.value = prevLocale
  })
})
