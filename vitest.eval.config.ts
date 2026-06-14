import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

import viteConfig from './vite.config'

/**
 * Separate Vitest config for the balance-evaluation suite (eval/).
 *
 * Why it exists separately from vitest.config.ts:
 *   • The eval suite runs multi-second signal-synthesis simulations — heavier
 *     than the unit tests. Keeping it in its own config lets `pnpm test:unit`
 *     stay sub-second and `pnpm test:eval` run on demand.
 *   • It needs no jsdom/DOM (pure TS + node), so environment is 'node'.
 *   • Longer test timeouts for the larger signal-processing loops.
 *
 * Path alias '@/...' is inherited from vite.config so eval files import the
 * real algorithm modules identically to production code.
 */
export default defineConfig({
  ...viteConfig,
  test: {
    environment: 'node',
    include: ['eval/**/*.spec.ts'],
    // configDefaults.exclude would otherwise drop node_modules etc.; we keep
    // the defaults but explicitly limit include to eval/.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**', 'src/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    root: fileURLToPath(new URL('./', import.meta.url)),
  },
})
