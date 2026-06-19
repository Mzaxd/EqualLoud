import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { crx } from '@crxjs/vite-plugin'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'
import zipPack from 'vite-plugin-zip-pack'

import manifest from './manifest.config'
import i18nLocalesPlugin from './plugins/i18n-locales'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    VueI18nPlugin({
      include: resolve(__dirname, 'src/locales/**'),
      strictMessage: false,
    }),
    i18nLocalesPlugin(),
    crx({ manifest }),
    zipPack({ outDir: 'release', outFileName: 'release.zip' }),
  ],
  build: {
    rollupOptions: {
      // onboarding.html is opened by the SW via chrome.runtime.getURL on first
      // install, but CRXJS only emits HTML files declared in the manifest
      // (popup/options). Register it as an explicit rollup input so it ships.
      input: {
        onboarding: resolve(__dirname, 'onboarding.html'),
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
    cors: {
      origin: '*',
    },
  },
})
