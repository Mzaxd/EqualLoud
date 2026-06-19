<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AutoBalance from '@/components/AutoBalance.vue'
import Diagnostics from '@/components/Diagnostics.vue'
import Limiter from '@/components/Limiter.vue'
import PowerToggle from '@/components/PowerToggle.vue'
import TabList from '@/components/TabList.vue'
import UpdateNotice from '@/components/UpdateNotice.vue'
import { useSettingsStore } from '@/stores/settings'
import { useTabsStore } from '@/stores/tabs'

const version = __APP_VERSION__

const tabsStore = useTabsStore()
const { t, locale } = useI18n()
const settings = useSettingsStore()

// The footer 「中 / EN」 button is a single two-state toggle (the prototype's
// behaviour), not a dropdown: each click flips between the two supported
// locales. The bilingual label reads naturally in either active locale.
const showSettings = ref(false)
const showDiagnostics = ref(false)
// Ref to the Diagnostics component so we can refresh its entry count whenever
// the panel is expanded (avoids polling the SW while it's collapsed).
const diagnosticsRef = ref<InstanceType<typeof Diagnostics> | null>(null)

function toggleSettings(): void {
  showSettings.value = !showSettings.value
}

function toggleDiagnostics(): void {
  showDiagnostics.value = !showDiagnostics.value
  // On expand, ask the panel to pull a fresh entry count from the SW. Done on
  // next tick so the v-show/transition has committed the mount before refresh.
  if (showDiagnostics.value) {
    void nextTick(() => diagnosticsRef.value?.refreshCount())
  }
}

/**
 * Label shown on the language button: the locale you'll switch *to* on click.
 * Computed from the current locale so it always names the OTHER language — a
 * user reading English sees "中" (click for Chinese) and vice versa. Single
 * glyph, not the old "中 / EN" pair which was ambiguous in both locales.
 */
const langLabel = computed(() => (locale.value === 'zh_CN' ? 'EN' : '中'))

/**
 * Pluralised "N tab(s)" label for the popup header. Resolves the count here
 * rather than relying on vue-i18n's plural overload (whose composition-API
 * signature is awkward and version-sensitive). The English message carries a
 * `|` plural separator ("{count} tab | {count} tabs"); Chinese has no plural
 * distinction so its message has no separator and is returned verbatim.
 */
const tabCountLabel = computed(() => {
  const n = tabsStore.tabs.length
  const raw = t('popup.tabCount', { count: n }) as string
  const sep = raw.indexOf('|')
  if (sep < 0) return raw // no plural distinction (e.g. Chinese)
  return (n === 1 ? raw.slice(0, sep) : raw.slice(sep + 1)).trim()
})

function toggleLocale(): void {
  locale.value = locale.value === 'zh_CN' ? 'en' : 'zh_CN'
}

onMounted(() => {
  tabsStore.startConnection()

  // Hydrate from the persisted popup locale (set by the user on a previous open).
  if (settings.locale) {
    locale.value = settings.locale
  }
  // langLabel is computed from locale, so no manual refresh is needed when
  // locale changes — Vue re-derives it.
})

watch(
  locale,
  (val) => {
    settings.locale = String(val)
  },
  { flush: 'post' },
)

onUnmounted(() => {
  tabsStore.stopConnection()
})
</script>

<template>
  <div class="popup">
    <!-- Header: wordmark + circular standby power button (the master on/off). -->
    <header class="top">
      <span class="name">Equal<b>Loud</b></span>
      <PowerToggle />
    </header>

    <div class="body">
      <!-- Update recovery notice — sits above the target meter, only shows when
           the extension version changed since the last dismissal. -->
      <UpdateNotice />

      <!-- Target volume + the combined loudness meter. -->
      <AutoBalance />

      <!-- Now-playing tab list (whole-row click = A/B). -->
      <div class="tabs-head">
        <span class="lab">{{ t('popup.playing') }}</span>
        <span class="n">{{ tabCountLabel }}</span>
      </div>
      <TabList />

      <!-- Collapsible settings panel (limiter), default hidden. Opens via the
           footer gear. Animates via grid-template-rows 0fr→1fr, which the
           compositor interpolates WITHOUT a layout reflow per frame (unlike
           max-height, which re-layouts the whole body every frame and was the
           source of the jank on open/close). The .settings-inner wrapper is
           overflow:hidden + min-height:0 so the 0fr track collapses to truly
           zero; the divider/spacing sit on the .panel-pad child so they don't
           fight the collapsed track height. -->
      <div class="settings" :class="{ open: showSettings }">
        <div class="settings-inner">
          <div class="panel-pad">
            <Limiter />
          </div>
        </div>
      </div>

      <!-- Collapsible diagnostics panel (log export), default hidden. Opens via
           the footer 「Diagnostics」 text button. Shares the same grid-rows
           collapse animation as the settings panel above for visual parity. -->
      <div class="settings" :class="{ open: showDiagnostics }">
        <div class="settings-inner">
          <div class="panel-pad">
            <Diagnostics ref="diagnosticsRef" />
          </div>
        </div>
      </div>
    </div>

    <!-- Footer: privacy/version/GitHub on the left, language + gear on the right. -->
    <footer class="foot">
      <span class="pri"
        >EqualLoud · v{{ version }} ·
        <a
          class="gh"
          href="https://github.com/mzaxd/EqualLoud"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="t('footer.source')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path
              d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 4.6 18 4.9 18 4.9c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"
            />
          </svg>
        </a>
      </span>
      <div class="actions">
        <button class="ghost" type="button" @click="toggleLocale">{{ langLabel }}</button>
        <button
          class="ghost"
          :class="{ active: showDiagnostics }"
          type="button"
          :aria-label="t('diagnostics.expand')"
          :title="t('diagnostics.expand')"
          @click="toggleDiagnostics"
        >
          {{ t('diagnostics.expand') }}
        </button>
        <button
          class="icon-btn"
          :class="{ active: showSettings }"
          type="button"
          :aria-label="t('settings.expand')"
          :title="showSettings ? t('settings.collapse') : t('settings.expand')"
          @click="toggleSettings"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3"></circle>
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            ></path>
          </svg>
        </button>
      </div>
    </footer>
  </div>
</template>

<style>
/* ── Global ──────────────────────────────────────────────────────────────
 * Chrome renders the popup as a plain rectangle sized to <body>. There is no
 * way to round the *window* itself, so the outermost surface must fill that
 * rectangle edge-to-edge — no margin, no flex-centering, no card with rounded
 * corners floating on a darker backdrop (that produced the "rectangle around a
 * rounded card" mismatch the user flagged). The whole popup is square-cornered;
 * internal elements are square-cornered too, for a consistent hard-edged look.
 */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#app {
  width: 348px;
}

body {
  font-family: var(--font-ui);
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>

<style scoped>
.popup {
  width: 348px;
  background: linear-gradient(180deg, oklch(23% 0.015 52), var(--bg));
  overflow: hidden;
}

/* Header */
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 22px 16px;
}

.name {
  font-family: var(--font-serif);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1;
}

.name b {
  color: var(--honey);
  font-weight: 600;
  font-style: italic;
}

/* Body */
.body {
  padding: 6px 22px 18px;
  /* overflow-x: clip is the GLOBAL guard against horizontal scrollbars: any
     descendant that spills past the popup's right edge (e.g. an absolutely-
     positioned tooltip bubble) is clipped invisibly instead of inflating
     scrollWidth and surfacing a horizontal scrollbar. Carried over from the
     pre-theme .app-content block so the InfoTip overflow fix still holds under
     the new structure. */
  overflow-x: clip;
}

.tabs-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 28px 0 4px;
}

.tabs-head .lab {
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 500;
}

.tabs-head .n {
  font-size: 12.5px;
  color: var(--muted);
}

/* Collapsible settings — animates grid-template-rows 0fr→1fr. The grid track
 * height is interpolated by the compositor (no per-frame layout reflow, unlike
 * max-height), and 1fr sizes to the content automatically so there's no
 * overshoot guess. For 0fr to actually collapse to zero the grid item needs
 * min-height:0 + overflow:hidden, and its own margins/borders must NOT sit on
 * the item itself (they'd push past the 0fr track) — spacing lives on an inner
 * wrapper instead. */
.settings {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.26s ease;
}

.settings.open {
  grid-template-rows: 1fr;
}

.settings-inner {
  min-height: 0;
  overflow: hidden;
}

/* Divider + top spacing between the panel and the tab list above. On a child
 * of the clipped grid item so it's hidden at 0fr and revealed at 1fr, never
 * fighting the track height. */
.panel-pad {
  padding-top: 18px;
  margin-top: 20px;
  border-top: 1px solid var(--hair);
}

/* Footer */
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 18px;
  border-top: 1px solid var(--hair);
  gap: 8px;
}

.pri {
  font-size: 10.5px;
  color: var(--faint);
}

.pri a {
  color: var(--muted);
  text-decoration: none;
  transition: color 0.15s;
}

.pri a:hover {
  color: var(--honey);
}

.pri a.gh {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}

.actions {
  display: flex;
  gap: 7px;
}

.ghost {
  font: 500 11.5px / 1 var(--font-ui);
  color: var(--muted);
  background: none;
  border: 1px solid var(--hair);
  padding: 7px 12px;
  border-radius: 0;
  cursor: pointer;
  transition:
    color 0.18s,
    border-color 0.18s,
    background 0.18s;
  white-space: nowrap;
}

.ghost:hover {
  color: var(--fg);
  border-color: var(--honey-2);
}

.icon-btn {
  width: 34px;
  height: 34px;
  border-radius: 0;
  padding: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--muted);
  background: none;
  border: 1px solid var(--hair);
  transition:
    color 0.18s,
    border-color 0.18s,
    background 0.18s,
    transform 0.12s;
}

.icon-btn svg {
  width: 16px;
  height: 16px;
  display: block;
}

.icon-btn:hover {
  color: var(--fg);
  border-color: var(--honey-2);
}

.icon-btn:active {
  transform: scale(0.94);
}

.icon-btn.active {
  color: var(--honey);
  border-color: var(--honey-2);
  background: var(--honey-soft);
}

/* The diagnostics text-button's active state mirrors the icon-btn: honey text
 * on a faint honey fill, so the open panel is signalled the same way as the
 * open settings gear. */
.ghost.active {
  color: var(--honey);
  border-color: var(--honey-2);
  background: var(--honey-soft);
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
