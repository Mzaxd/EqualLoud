<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AutoBalance from '@/components/AutoBalance.vue'
import Limiter from '@/components/Limiter.vue'
import TabList from '@/components/TabList.vue'
import UpdateNotice from '@/components/UpdateNotice.vue'
import { useSettingsStore } from '@/stores/settings'
import { useTabsStore } from '@/stores/tabs'

const version = __APP_VERSION__

const tabsStore = useTabsStore()
const { t, locale } = useI18n()
const settings = useSettingsStore()
const languages = [
  { code: 'en', name: 'English' },
  { code: 'zh_CN', name: '简体中文' },
]

const showSettings = ref(false)

function toggleSettings(): void {
  showSettings.value = !showSettings.value
}

onMounted(() => {
  tabsStore.startPolling()

  const currentLocale = locale.value
  if (currentLocale) {
    const language = languages.find((l) => l.code === currentLocale)
    if (language) {
      locale.value = language.code
    } else {
      locale.value = 'en'
    }
  }

  if (settings.locale && settings.locale !== locale.value) {
    locale.value = settings.locale
  }
})

watch(
  locale,
  (val) => {
    settings.locale = String(val)
  },
  { flush: 'post' },
)

onUnmounted(() => {
  tabsStore.stopPolling()
})
</script>

<template>
  <div class="app">
    <!-- Header -->
    <header class="app-header">
      <h1 class="app-title">{{ t('popup.title') }}</h1>
      <div class="header-right">
        <select v-model="locale" class="lang-select">
          <option v-for="l in languages" :key="l.code" :value="l.code">{{ l.name }}</option>
        </select>
        <span class="version">v{{ version }}</span>
      </div>
    </header>

    <!-- Main Content -->
    <main class="app-content">
      <!-- Update recovery notice (auto-hides once dismissed for this version) -->
      <UpdateNotice />

      <!-- Auto Balance Toggle + Status -->
      <AutoBalance />

      <!-- Tab List -->
      <section class="tabs-section">
        <TabList />
      </section>

      <!-- Settings Toggle -->
      <button class="settings-toggle" @click="toggleSettings">
        <span>⚙️</span>
        <span>{{ showSettings ? t('settings.collapse') : t('settings.expand') }}</span>
      </button>

      <!-- Settings Panel (expandable) -->
      <Transition name="settings-panel">
        <div v-if="showSettings" class="settings-panel">
          <Limiter />
        </div>
      </Transition>
    </main>

    <!-- Footer -->
    <footer class="app-footer">
      <span>{{ t('footer.brand') }}</span>
      <span class="separator">•</span>
      <a href="https://github.com/mzaxd/EqualLoud" target="_blank" rel="noopener noreferrer">{{
        t('footer.author')
      }}</a>
    </footer>
  </div>
</template>

<style>
/* Global Styles */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #1a1a2e;
}

/* Popup dimensions */
html,
body,
#app {
  width: 320px;
  min-height: 400px;
  max-height: 600px;
}
</style>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 400px;
  max-height: 600px;
  background: #f7f8fa;
  overflow: hidden;
}

/* Header */
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #e8eaed;
}

.app-title {
  font-size: 16px;
  font-weight: 700;
  color: #1a1a2e;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lang-select {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  color: #555;
  font-size: 11px;
  padding: 3px 6px;
  cursor: pointer;
  outline: none;
}

.lang-select:focus {
  border-color: #4299e1;
}

.version {
  font-size: 10px;
  color: #999;
}

/* Main Content */
.app-content {
  flex: 1;
  /* overflow-x: clip is the GLOBAL guard against horizontal scrollbars: any
     descendant that spills past the popup's right edge (e.g. an absolutely-
     positioned tooltip bubble) is clipped invisibly instead of inflating
     scrollWidth and surfacing a horizontal scrollbar. overflow-y stays auto so
     the popup still scrolls vertically. Modern Chromium (the only target —
     this is an MV3 extension popup) computes this to hidden-on-x but the
     observable effect is identical: no horizontal scroll UI. */
  overflow-x: clip;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Tabs Section */
.tabs-section {
  flex: 1;
}

/* Settings Toggle */
.settings-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #888;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.settings-toggle:hover {
  background: #eef0f2;
  color: #555;
}

/* Settings Panel */
.settings-panel {
  padding-top: 4px;
}

.settings-panel-enter-active,
.settings-panel-leave-active {
  transition: all 0.25s ease;
  overflow: hidden;
}

.settings-panel-enter-from,
.settings-panel-leave-to {
  opacity: 0;
  max-height: 0;
}

.settings-panel-enter-to,
.settings-panel-leave-from {
  opacity: 1;
  max-height: 600px;
}

/* Footer */
.app-footer {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid #e8eaed;
  font-size: 10px;
  color: #bbb;
}

.separator {
  opacity: 0.5;
}

.app-footer a {
  color: #999;
  text-decoration: none;
}

.app-footer a:hover {
  color: #4299e1;
}

/* Scrollbar */
.app-content::-webkit-scrollbar {
  width: 4px;
}

.app-content::-webkit-scrollbar-track {
  background: transparent;
}

.app-content::-webkit-scrollbar-thumb {
  background: #d0d5dd;
  border-radius: 2px;
}
</style>
