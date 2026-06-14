import { fileURLToPath } from 'node:url'

import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'

import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // Exclude e2e (Playwright) and eval (heavy balance-evaluation suite,
      // run via `pnpm test:eval` with its own config).
      exclude: [...configDefaults.exclude, 'e2e/**', 'eval/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
    },
  }),
)
