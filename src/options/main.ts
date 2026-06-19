// Options page entry. The CWS "Extension options" link opens this in a tab.
// Reuses the same Pinia stores + i18n as the popup so settings stay in sync
// across both surfaces (they both talk to the SW over the same message
// contract).
import '../styles/tokens.css'
import '../styles/fonts.css'

import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createApp } from 'vue'

import { i18n } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'

import Options from './Options.vue'

const app = createApp(Options)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
app.use(i18n)

const settings = useSettingsStore(pinia)
i18n.global.locale.value = settings.locale as 'en' | 'zh_CN'

app.mount('#app')
