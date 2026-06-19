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
      coverage: {
        provider: 'v8',
        // The algorithm core must stay near-exhaustively covered — a regression
        // here is a correctness bug, not a styling miss. The rest of the codebase
        // (UI, SW orchestration) has softer thresholds because much of it is
        // glue that's exercised by e2e rather than unit tests.
        thresholds: {
          lines: 70,
          perFile: false,
        },
        include: ['src/audio/**/*.ts', 'src/storage/**/*.ts', 'src/content/media-manager.ts'],
        exclude: ['src/**/*.d.ts', 'src/worklets/**'],
      },
    },
  }),
)
