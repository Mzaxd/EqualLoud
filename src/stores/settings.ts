import { defineStore } from 'pinia'
import { ref } from 'vue'

function normalizeLocaleCode(input: string | null | undefined): 'en' | 'zh_CN' {
  const code = (input || '').toLowerCase()
  if (code.startsWith('zh')) return 'zh_CN'
  return 'en'
}

export const useSettingsStore = defineStore(
  'settings',
  () => {
    const locale = ref<string>(
      normalizeLocaleCode(typeof navigator !== 'undefined' ? navigator.language : 'en'),
    )

    /**
     * The app version for which the "please refresh your tabs" update notice
     * was last dismissed. `null` = never shown (fresh install — we don't bug
     * first-time users). When `__APP_VERSION__` differs, the banner shows again.
     */
    const lastNoticeVersion = ref<string | null>(null)

    function setLocale(newLocale: string): void {
      locale.value = normalizeLocaleCode(newLocale)
    }

    return {
      locale,
      lastNoticeVersion,
      setLocale,
    }
  },
  {
    persist: {
      // MUST differ from the SW's storage key ('settings' in background.ts).
      // Sharing that key made popup locale writes overwrite the SW's
      // {enabled,targetLufs} and vice versa.
      key: 'popupSettings',
      pick: ['locale', 'lastNoticeVersion'],
      // The popup-local schema (locale + lastNoticeVersion) is structurally
      // stable. The SW's settings/limiter are versioned via @/storage/migrate
      // (see background.ts); if this store ever grows complex fields, apply the
      // same pattern here.
    },
  },
)
