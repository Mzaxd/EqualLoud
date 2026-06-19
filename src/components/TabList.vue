<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useTabsStore, hasEnoughSamples } from '@/stores/tabs'

/**
 * The "Now playing" list. Each row is a single button — clicking the whole row
 * toggles that tab's balance (A/B) — no separate ⚖️ affordance. Layout: favicon
 * → title (ellipsis) → live gain readout. A row dims when bypassed; the gain
 * badge swaps to a 「BYPASS」 word, or 「—」 when balancing is globally off.
 */
defineOptions({ name: 'TabList' })

const tabsStore = useTabsStore()
const { t } = useI18n()

function formatGain(gainDb: number): string {
  const prefix = gainDb >= 0 ? '+' : ''
  return `${prefix}${gainDb.toFixed(1)} dB`
}

/** Tailwind-style class for the gain badge: big boost → bright honey, normal
 *  boost → honey, cut (attenuation) → cool blue. */
function gainClass(gainDb: number): string {
  if (gainDb >= 0) return Math.abs(gainDb) >= 10 ? 'gain big' : 'gain'
  return 'gain cut'
}

/**
 * Resolve a tab's favicon with zero network egress.
 *
 * Priority: the favIconUrl the SW captured from `chrome.tabs` (Chrome's own
 * cached URL for the site) → otherwise the local `_favicon/` virtual resource
 * (Chrome 118+, gated by the `favicon` permission), which serves from Chrome's
 * in-memory icon cache. Both paths keep the icon fetch on-device; the old
 * `google.com/s2/favicons` endpoint leaked every open domain to a third party
 * and is removed.
 *
 * `favIconUrl` can itself be a remote http(s) URL, but Chrome serves it via the
 * extension's own image loader subject to the popup CSP, and it points at the
 * site's own origin (not a tracker). The `_favicon/` fallback is fully local.
 */
function getFaviconUrl(tab: { url: string; favIconUrl?: string }): string {
  // Prefer the SW-captured favIconUrl when Chrome actually has one.
  if (tab.favIconUrl) return tab.favIconUrl
  // Otherwise ask Chrome's local favicon cache via the _favicon/ API.
  if (!tab.url) return ''
  try {
    // Validate the URL (also guards against injecting arbitrary pageUrl values).
    new URL(tab.url)
    const extId = chrome.runtime.id
    return `chrome-extension://${extId}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`
  } catch {
    return ''
  }
}

/** First character of the hostname, used as the favicon fallback glyph. */
function fallbackGlyph(url: string, title: string): string {
  try {
    const host = new URL(url).hostname
    const lead = host.replace(/^www\./, '')[0]
    return (lead || title[0] || '?').toUpperCase()
  } catch {
    return (title[0] || '?').toUpperCase()
  }
}

async function handleToggleBalance(tabId: number): Promise<void> {
  await tabsStore.toggleBalance(tabId)
}

const tabs = computed(() => tabsStore.tabs)
// Per-tab balance toggle is meaningless when the global switch is off, so the
// rows disable + dim in that state.
const globalEnabled = computed(() => tabsStore.isAutoBalancing)
</script>

<template>
  <div class="tab-list">
    <div v-if="tabs.length === 0" class="empty-state">
      <p class="empty-title">{{ t('tabs.empty.title') }}</p>
      <p class="empty-hint">{{ t('tabs.empty.hint') }}</p>
    </div>

    <TransitionGroup name="tab-item" tag="div" class="tab-list-rows">
      <div v-for="tab in tabs" :key="tab.tabId" class="tab-item">
        <button
          type="button"
          class="tab"
          :class="{ bypass: globalEnabled && !tab.balanceEnabled }"
          :disabled="!globalEnabled"
          :title="
            globalEnabled
              ? tab.balanceEnabled
                ? t('tabs.balance.onHint')
                : t('tabs.balance.offHint')
              : t('popup.status.disabled')
          "
          @click="handleToggleBalance(tab.tabId)"
        >
          <span class="fav">
            <img
              v-if="tab.url"
              :src="getFaviconUrl(tab)"
              alt=""
              @error="($event.target as HTMLImageElement).style.display = 'none'"
            />
            <span v-else class="g">{{ fallbackGlyph(tab.url, tab.title) }}</span>
          </span>
          <span class="ttitle">{{ tab.title }}</span>

          <span
            v-if="globalEnabled && tab.balanceEnabled"
            :class="gainClass(tab.appliedGainDb)"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ formatGain(tab.appliedGainDb) }}
          </span>
          <span v-else-if="globalEnabled && !tab.balanceEnabled" class="gain muted">{{
            t('tabs.balance.bypass')
          }}</span>
          <span v-else class="gain muted">{{ t('tabs.balance.dash') }}</span>
        </button>

        <!-- "Analyzing…" sub-row while the worklet gathers enough blocks for a
             reliable LUFS reading; hides once we have enough samples. -->
        <div
          v-if="
            tab.isCapturing &&
            !hasEnoughSamples({ blockCount: tab.blockCount, shortTerm: tab.shortTerm })
          "
          class="tab-status collecting"
        >
          <span class="status-dot"></span>
          <span>{{ t('tabs.status.collecting') }}</span>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.tab-list {
  display: flex;
  flex-direction: column;
}

/* Empty state — no icon, just calm serif text. */
.empty-state {
  text-align: center;
  padding: 28px 16px;
}

.empty-title {
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 4px;
}

.empty-hint {
  font-size: 12px;
  color: var(--faint);
}

.tab-list-rows {
  display: flex;
  flex-direction: column;
}

.tab-item {
  display: flex;
  flex-direction: column;
}

/* Whole-row button: clicking anywhere toggles this tab's balance. */
.tab {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 11px 6px;
  margin: 0 -6px;
  border-radius: 0;
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
  transition:
    background 0.16s,
    opacity 0.2s;
}

.tab:hover {
  background: oklch(26% 0.014 52);
}

.tab:disabled {
  cursor: not-allowed;
}

.tab.bypass {
  opacity: 0.42;
}

.fav {
  width: 20px;
  height: 20px;
  border-radius: 0;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--surface);
  display: grid;
  place-items: center;
}

.fav img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.fav .g {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font: 700 9px / 1 var(--font-mono);
  color: oklch(16% 0.02 52);
}

.ttitle {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.gain {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--honey);
  flex-shrink: 0;
}

.gain.cut {
  color: var(--cut);
}

.gain.big {
  color: var(--honey);
}

.gain.muted {
  color: var(--faint);
  font-weight: 500;
  font-size: 11.5px;
  font-family: var(--font-ui);
}

/* Collecting sub-row */
.tab-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px 8px;
  margin: 0 -6px;
  font-size: 10px;
  color: var(--muted);
}

.tab-status.collecting {
  color: var(--honey-2);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 0;
  background: var(--honey-2);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

/* Row transitions */
.tab-item-enter-active,
.tab-item-leave-active {
  transition: all 0.25s ease;
}

.tab-item-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

.tab-item-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

.tab-item-move {
  transition: transform 0.25s ease;
}

@media (prefers-reduced-motion: reduce) {
  .status-dot {
    animation: none;
  }
}
</style>
