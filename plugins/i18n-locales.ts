import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'

import type { Plugin } from 'vite'

type LocaleObject = Record<string, unknown>

function flattenMessages(obj: LocaleObject, parentKey = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = parentKey ? `${parentKey}_${key}` : key
    if (value && typeof value === 'object') {
      Object.assign(result, flattenMessages(value as LocaleObject, fullKey))
    } else {
      result[fullKey] = String(value ?? '')
    }
  }
  return result
}

function readLocales(dir: string): Array<{ lang: string; messages: Record<string, string> }> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  return files.map((file) => {
    const lang = basename(file, '.json')
    const raw = JSON.parse(readFileSync(resolve(dir, file), 'utf-8')) as LocaleObject
    const flat = flattenMessages(raw)
    return { lang, messages: flat }
  })
}

function toChromeMessages(messages: Record<string, string>): Record<string, { message: string }> {
  const out: Record<string, { message: string }> = {}
  for (const [k, v] of Object.entries(messages)) {
    out[k] = { message: v }
  }
  return out
}

export default function i18nLocalesPlugin(): Plugin {
  let root = process.cwd()
  let localesDir = resolve(root, 'src/locales')
  let publicLocalesDir = resolve(root, 'public/_locales')

  function writeToPublic(): void {
    try {
      // Clean up the entire _locales directory first to remove stale files
      rmSync(publicLocalesDir, { recursive: true, force: true })
      const bundles = readLocales(localesDir)
      for (const { lang, messages } of bundles) {
        const chromeMessages = toChromeMessages(messages)
        const targetFile = resolve(publicLocalesDir, `${lang}/messages.json`)
        mkdirSync(dirname(targetFile), { recursive: true })
        writeFileSync(targetFile, JSON.stringify(chromeMessages, null, 2), 'utf-8')
      }
    } catch {
      // swallow to avoid dev-time noise; build will surface errors
    }
  }

  return {
    name: 'i18n-locales',
    configResolved(cfg) {
      root = cfg.root
      localesDir = resolve(root, 'src/locales')
      publicLocalesDir = resolve(root, 'public/_locales')
    },
    configureServer(server) {
      // Initial write so dev CRX has files available
      writeToPublic()
      // Watch for changes and update
      server.watcher.add(localesDir)
      const handler = () => writeToPublic()
      server.watcher.on('add', handler)
      server.watcher.on('change', handler)
      server.watcher.on('unlink', handler)
    },
    buildStart() {
      // Make sure we watch the directory for incremental builds
      this.addWatchFile(localesDir)
    },
    generateBundle() {
      // Emit as bundle assets for production build
      const bundles = readLocales(localesDir)
      for (const { lang, messages } of bundles) {
        const chromeMessages = toChromeMessages(messages)
        this.emitFile({
          type: 'asset',
          fileName: `_locales/${lang}/messages.json`,
          source: JSON.stringify(chromeMessages, null, 2),
        })
      }
    },
  }
}
