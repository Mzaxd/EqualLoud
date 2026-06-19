import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FlatCompat } from '@eslint/eslintrc'
import {
  configureVueProject,
  defineConfigWithVueTs,
  vueTsConfigs,
} from '@vue/eslint-config-typescript'
import { globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'

const eslintrc = new FlatCompat()

configureVueProject({
  scriptLangs: ['ts', 'js', 'jsx', 'tsx'],
})

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

const config = defineConfigWithVueTs(
  prettier,
  ...pluginVue.configs['flat/recommended'],
  ...eslintrc.extends('plugin:import/recommended'),
  ...eslintrc.extends('plugin:prettier/recommended'),
  vueTsConfigs.recommended,
)

export default [
  globalIgnores([
    '.pnpm-store',
    '.vite',
    'node_modules',
    'dist',
    'release',
    // Standalone build scripts use CommonJS (sharp/fs in a .cjs context) — the
    // no-require-import rule does not apply to them and they are not shipped.
    'scripts/*.cjs',
    'tools/*.mjs',
    // Offline algorithm-tuning harness; dev-only, not shipped, has its own
    // vitest config (vitest.eval.config.ts).
    'eval/**',
  ]),
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: currentDirectory,
      },
    },
  },
  ...config,
  {
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
        node: {
          map: {
            '@': './src',
          },
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', ['internal', 'parent', 'sibling', 'index'], 'unknown'],
          pathGroups: [
            {
              pattern: '@/**',
              group: 'external',
              position: 'after',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
    },
  },
]
