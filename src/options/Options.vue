<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import Limiter from '@/components/Limiter.vue'
import { useDebouncedCallback } from '@/composables/useDebouncedRef'
import { useSettingsStore } from '@/stores/settings'
import { useTabsStore } from '@/stores/tabs'

/**
 * Standalone settings page — the CWS "Extension options" entry point.
 *
 * Layout: target-loudness slider, the full limiter panel (reused verbatim
 * from the popup), a locale picker, and a "reload all audio tabs" convenience
 * button. The popup and this page share the same SW message contract, so a
 * change here propagates instantly to every playing tab.
 *
 * Reuses the暖夜灯 tokens; lays out vertically because a full tab has room
 * the 348 px popup does not.
 */
defineOptions({ name: 'OptionsPage' })

const tabsStore = useTabsStore()
const settings = useSettingsStore()
const { t, locale } = useI18n()

// --- target loudness (debounced slider, same pattern as AutoBalance) --------
const targetLufs = computed(() => tabsStore.targetLufs)
const isAutoBalancing = computed(() => tabsStore.isAutoBalancing)
const dragValue = ref(targetLufs.value)
let dragging = false

watch(targetLufs, (v) => {
  if (!dragging) dragValue.value = v
})

const debouncedSetTarget = useDebouncedCallback((value: number) => {
  void tabsStore.setTargetLufs(value)
}, 150)

function handleTargetChange(event: Event): void {
  const value = parseFloat((event.target as HTMLInputElement).value)
  if (isNaN(value)) return
  dragValue.value = value
  debouncedSetTarget(value)
}

function handleThumbGrab(): void {
  dragging = true
}
function handleThumbRelease(): void {
  dragging = false
  dragValue.value = targetLufs.value
}

// --- locale -----------------------------------------------------------------
const localeOptions = [
  { value: 'en', label: computed(() => t('options.localeEn')) },
  { value: 'zh_CN', label: computed(() => t('options.localeZh')) },
] as const

function pickLocale(value: string): void {
  locale.value = value as 'en' | 'zh_CN'
  settings.locale = value
}

// --- reload-all convenience -------------------------------------------------
const reloadState = ref<'idle' | 'working' | 'done'>('idle')

async function reloadAllAudioTabs(): Promise<void> {
  if (reloadState.value === 'working') return
  reloadState.value = 'working'
  try {
    // Query every http(s) tab and reload it. chrome.tabs.reload on a tab that
    // has no audio is harmless (it just refreshes the page).
    const allTabs = await chrome.tabs.query({})
    await Promise.all(
      allTabs
        .filter((tab) => tab.id != null && /^https?:/i.test(tab.url ?? ''))
        .map((tab) => chrome.tabs.reload(tab.id!, { bypassCache: false }).catch(() => {})),
    )
    reloadState.value = 'done'
    setTimeout(() => {
      reloadState.value = 'idle'
    }, 2000)
  } catch {
    reloadState.value = 'idle'
  }
}

onMounted(() => {
  tabsStore.startConnection()
})
onUnmounted(() => {
  tabsStore.stopConnection()
})
</script>

<template>
  <div class="opts">
    <header class="opts-top">
      <span class="wordmark">Equal<b>Loud</b></span>
      <span class="opts-title">{{ t('options.title') }}</span>
    </header>

    <main class="opts-body">
      <!-- Target loudness -->
      <section class="card">
        <h2 class="card-title">{{ t('options.targetSection') }}</h2>
        <div class="target-row">
          <span class="target-val">{{ dragValue }} LUFS</span>
          <span class="target-state">{{ isAutoBalancing ? '●' : '○' }}</span>
        </div>
        <div class="slider-wrap">
          <input
            type="range"
            class="slider"
            min="-60"
            max="0"
            step="1"
            :value="dragValue"
            :disabled="!isAutoBalancing"
            :aria-label="t('options.targetSection')"
            @input="handleTargetChange"
            @pointerdown="handleThumbGrab"
            @pointerup="handleThumbRelease"
            @pointercancel="handleThumbRelease"
          />
        </div>
      </section>

      <!-- Limiter (reused popup component) -->
      <section class="card">
        <Limiter />
      </section>

      <!-- Locale -->
      <section class="card">
        <h2 class="card-title">{{ t('options.localeSection') }}</h2>
        <div class="locale-row">
          <button
            v-for="opt in localeOptions"
            :key="opt.value"
            type="button"
            class="locale-btn"
            :class="{ on: locale === opt.value }"
            @click="pickLocale(opt.value)"
          >
            {{ opt.label.value }}
          </button>
        </div>
      </section>

      <!-- Reload all -->
      <section class="card">
        <h2 class="card-title">{{ t('options.reloadAll') }}</h2>
        <p class="hint">{{ t('options.applyHint') }}</p>
        <button
          class="reload-btn"
          type="button"
          :disabled="reloadState === 'working'"
          @click="reloadAllAudioTabs"
        >
          {{ reloadState === 'done' ? t('options.reloaded') : t('options.reloadAll') }}
        </button>
      </section>
    </main>
  </div>
</template>

<style scoped>
.opts {
  min-height: 100vh;
  background: linear-gradient(180deg, oklch(23% 0.015 52), var(--bg));
  color: var(--fg);
}

.opts-top {
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 26px 32px 20px;
  border-bottom: 1px solid var(--hair);
}

.wordmark {
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 600;
}

.wordmark b {
  color: var(--honey);
  font-weight: 600;
  font-style: italic;
}

.opts-title {
  font-size: 13px;
  color: var(--muted);
}

.opts-body {
  max-width: 640px;
  margin: 0 auto;
  padding: 28px 24px 60px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--hair);
  padding: 22px 24px;
}

.card-title {
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
}

.target-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}

.target-val {
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 700;
  color: var(--honey);
  font-variant-numeric: tabular-nums;
}

.target-state {
  font-size: 12px;
  color: var(--muted);
}

.slider-wrap {
  padding: 4px 0;
}

.slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  background: oklch(30% 0.012 52);
  outline: none;
  cursor: pointer;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 6px;
  height: 18px;
  background: oklch(96% 0.01 72);
  border-top: 2px solid var(--honey);
  border-bottom: 2px solid var(--honey);
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 6px;
  height: 18px;
  background: oklch(96% 0.01 72);
  border: none;
  border-top: 2px solid var(--honey);
  border-bottom: 2px solid var(--honey);
  cursor: pointer;
}

.slider:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.locale-row {
  display: flex;
  gap: 10px;
}

.locale-btn {
  font: 500 13px / 1 var(--font-ui);
  color: var(--muted);
  background: none;
  border: 1px solid var(--hair);
  padding: 10px 18px;
  cursor: pointer;
  transition: all 0.18s;
}

.locale-btn:hover {
  color: var(--fg);
  border-color: var(--honey-2);
}

.locale-btn.on {
  color: var(--honey);
  border-color: var(--honey);
  background: var(--honey-soft);
}

.hint {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
  margin-bottom: 14px;
}

.reload-btn {
  font: 500 13px / 1 var(--font-ui);
  color: var(--fg);
  background: var(--surface-2);
  border: 1px solid var(--hair);
  padding: 11px 18px;
  cursor: pointer;
  transition: all 0.18s;
}

.reload-btn:hover:not(:disabled) {
  border-color: var(--honey-2);
  color: var(--honey);
}

.reload-btn:disabled {
  opacity: 0.5;
  cursor: wait;
}
</style>
