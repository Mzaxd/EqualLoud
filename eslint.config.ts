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
  globalIgnores(['.pnpm-store', '.vite', 'node_modules', 'dist', 'release']),
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
