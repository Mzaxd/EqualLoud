import { defineStore } from 'pinia'
import { ref } from 'vue'

export function normalizeLocaleCode(input: string | null | undefined): 'en' | 'zh_CN' {
  const code = (input || '').toLowerCase()
  if (code.startsWith('zh')) return 'zh_CN'
  return 'en'
}

/**
 * Resolve the locale that should be active right now, given the persisted
 * settings. When the user has NOT manually chosen a language, re-detect from
 * the browser/system language on every call — so the extension follows an OS
 * language change without the user touching anything. Once the user taps the
 * language toggle, their choice is pinned and the system language is ignored.
 */
export function resolveLocale(storedLocale: string, manuallySet: boolean): 'en' | 'zh_CN' {
  if (manuallySet) return normalizeLocaleCode(storedLocale)
  return normalizeLocaleCode(typeof navigator !== 'undefined' ? navigator.language : 'en')
}

export const useSettingsStore = defineStore(
  'settings',
  () => {
    const locale = ref<string>(
      normalizeLocaleCode(typeof navigator !== 'undefined' ? navigator.language : 'en'),
    )

    /**
     * Whether the user has manually chosen a language. While false (the default,
     * and the state of every fresh install), the locale follows the browser/
     * system language on every popup open — so a user who switches their OS
     * language sees the extension follow automatically. The moment the user
     * taps the language toggle, this flips to true and the chosen locale is
     * pinned permanently (we stop overriding it with the system language).
     */
    const localeManuallySet = ref(false)

    /**
     * The app version for which the "please refresh your tabs" update notice
     * was last dismissed. `null` = never shown (fresh install — we don't bug
     * first-time users). When `__APP_VERSION__` differs, the banner shows again.
     */
    const lastNoticeVersion = ref<string | null>(null)

    /**
     * Pro mode (2.0): when true, the popup shows the loudness-analysis panel
     * (true-peak / integrated / LRA) and per-tab micro-readings. Simple mode
     * (the default) hides them. Pure UI toggle — does not change any audio
     * processing. Persisted so the user's preference survives popup reopens.
     */
    const professionalMode = ref(false)

    /**
     * Set the locale *manually* (user tapped the language toggle). Pins the
     * choice so the extension stops following the system language.
     */
    function setLocale(newLocale: string): void {
      locale.value = normalizeLocaleCode(newLocale)
      localeManuallySet.value = true
    }

    // ── Cross-context sync ─────────────────────────────────────────────────
    // The popup and the standalone options page are two documents writing the
    // SAME localStorage key ('popupSettings'). pinia-plugin-persistedstate
    // serialises the whole picked object on every mutation and does NOT listen
    // for writes from elsewhere — so with both surfaces open, the next write
    // from one clobbered the other's change with its own stale snapshot (a
    // lost-update race). The 'storage' event fires in every OTHER same-origin
    // document, which is exactly the missing reconciliation channel: re-hydrate
    // this instance's refs from whatever the other surface just persisted.
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key !== 'popupSettings' || !e.newValue) return
        let snap: Partial<{
          locale: string
          localeManuallySet: boolean
          lastNoticeVersion: string | null
          professionalMode: boolean
        }>
        try {
          snap = JSON.parse(e.newValue) as typeof snap
        } catch {
          return // malformed payload — keep current state
        }
        if (typeof snap.locale === 'string') locale.value = normalizeLocaleCode(snap.locale)
        if (typeof snap.localeManuallySet === 'boolean')
          localeManuallySet.value = snap.localeManuallySet
        if (snap.lastNoticeVersion === null || typeof snap.lastNoticeVersion === 'string')
          lastNoticeVersion.value = snap.lastNoticeVersion
        if (typeof snap.professionalMode === 'boolean')
          professionalMode.value = snap.professionalMode
      })
    }

    return {
      locale,
      localeManuallySet,
      lastNoticeVersion,
      professionalMode,
      setLocale,
    }
  },
  {
    persist: {
      // MUST differ from the SW's storage key ('settings' in background.ts).
      // Sharing that key made popup locale writes overwrite the SW's
      // {enabled,targetLufs} and vice versa.
      key: 'popupSettings',
      pick: ['locale', 'localeManuallySet', 'lastNoticeVersion', 'professionalMode'],
      // The popup-local schema (locale + lastNoticeVersion) is structurally
      // stable. The SW's settings/limiter are versioned via @/storage/migrate
      // (see background.ts); if this store ever grows complex fields, apply the
      // same pattern here.
    },
  },
)
