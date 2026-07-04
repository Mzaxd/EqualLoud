// Design tokens + bundled fonts must load before any component renders, so the
// 暖夜灯 oklch variables and @font-face families are available on first paint.
import './styles/tokens.css'
import './styles/fonts.css'

import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createApp } from 'vue'

import App from './App.vue'
// import router from './router'
import { i18n } from './i18n'
import { resolveLocale, useSettingsStore } from './stores/settings'

const app = createApp(App)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
// app.use(router)
app.use(i18n)

// Resolve locale: follow system language unless the user has manually picked.
const settings = useSettingsStore(pinia)
i18n.global.locale.value = resolveLocale(settings.locale, settings.localeManuallySet)

app.mount('#app')
