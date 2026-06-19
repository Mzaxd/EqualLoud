// Onboarding entry — mirrors main.ts but mounts Onboarding.vue and skips the
// tabs store (no SW state needed on the welcome screen).
import '../styles/tokens.css'
import '../styles/fonts.css'

import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createApp } from 'vue'

import { i18n } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'

import Onboarding from './Onboarding.vue'

const app = createApp(Onboarding)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
app.use(i18n)

const settings = useSettingsStore(pinia)
i18n.global.locale.value = settings.locale as 'en' | 'zh_CN'

app.mount('#app')
