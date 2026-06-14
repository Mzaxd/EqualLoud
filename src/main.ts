import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createApp } from 'vue'

import App from './App.vue'
// import router from './router'
import { i18n } from './i18n'
import { useSettingsStore } from './stores/settings'

const app = createApp(App)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
// app.use(router)
app.use(i18n)

// Hydrate i18n locale from persisted store before mount
const settings = useSettingsStore(pinia)
i18n.global.locale.value = settings.locale as 'en' | 'zh_CN'

app.mount('#app')
