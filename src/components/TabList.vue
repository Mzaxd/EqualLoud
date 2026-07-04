<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { BIG_GAIN_BADGE_DB } from '@/audio/config'
import { useTabsStore, hasEnoughSamples } from '@/stores/tabs'

/**
 * The "Now playing" list. Each row is a single button — clicking the whole row
 * toggles that tab's balance (A/B) — no separate ⚖️ affordance. Layout: favicon
 * → title (ellipsis) → live gain readout. A row dims when bypassed; the gain
 * badge swaps to a 「BYPASS」 word, or 「—」 when balancing is globally off.
 */
defineOptions({ name: 'TabList' })

/** Pro mode shows per-tab integrated LUFS + LRA micro-readings (2.0). */
withDefaults(defineProps<{ professional?: boolean }>(), { professional: false })

const tabsStore = useTabsStore()
const { t } = useI18n()

function formatGain(gainDb: number): string {
  const prefix = gainDb >= 0 ? '+' : ''
  return `${prefix}${gainDb.toFixed(1)} dB`
}

/**
 * Format the per-tab Pro micro-reading: "−8 LUFS · 5 LU" (integrated + LRA).
 * Returns empty string when either value is unmeasured (no point cluttering
 * the row with "—"). Shown only in professional mode, at low contrast so it
 * doesn't compete with the primary gain readout.
 */
function formatMicro(tab: { integrated?: number; lra?: number }): string {
  const i = tab.integrated
  const l = tab.lra
  if (!Number.isFinite(i ?? -Infinity) || !Number.isFinite(l ?? -Infinity)) return ''
  return `${i!.toFixed(0)} LUFS · ${l!.toFixed(0)} LU`
}

/** Tailwind-style class for the gain badge: big boost → bright honey, normal
 *  boost → honey, cut (attenuation) → cool blue. The "big" threshold lives in
 *  config (BIG_GAIN_BADGE_DB) so it tracks the boost ceiling, not a magic 10. */
function gainClass(gainDb: number): string {
  if (gainDb >= 0) return Math.abs(gainDb) >= BIG_GAIN_BADGE_DB ? 'gain big' : 'gain'
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

/**
 * Whether a tab is still gathering LUFS samples (the "analyzing" state).
 * Inlined so we can show the pulsing indicator in the gain-readout slot
 * instead of a separate sub-row, avoiding extra vertical space.
 */
function isAnalyzing(tab: {
  isCapturing: boolean
  blockCount: number
  shortTerm: number
}): boolean {
  return (
    tab.isCapturing && !hasEnoughSamples({ blockCount: tab.blockCount, shortTerm: tab.shortTerm })
  )
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
            v-if="globalEnabled && tab.balanceEnabled && !isAnalyzing(tab)"
            :class="gainClass(tab.appliedGainDb)"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ formatGain(tab.appliedGainDb) }}
          </span>
          <!-- "Analyzing" indicator: takes over the gain-readout slot while the
               worklet gathers LUFS samples. No extra row, zero added height. -->
          <span
            v-else-if="globalEnabled && tab.balanceEnabled && isAnalyzing(tab)"
            class="analyzing"
          >
            <span class="status-dot"></span>
            <span class="analyzing-text">{{ t('tabs.status.collecting') }}</span>
          </span>
          <span v-else-if="globalEnabled && !tab.balanceEnabled" class="gain muted">{{
            t('tabs.balance.bypass')
          }}</span>
          <span v-else class="gain muted">{{ t('tabs.balance.dash') }}</span>

          <!-- Pro-mode micro-reading: this tab's integrated loudness + LRA.
               Low-contrast mono so it sits behind the primary gain readout. -->
          <span v-if="professional && formatMicro(tab)" class="micro">{{ formatMicro(tab) }}</span>
        </button>
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

/* Pro-mode micro-reading (integrated · LRA). Sits at the far right, dimmed. */
.micro {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  margin-left: 4px;
  white-space: nowrap;
}

/* "Analyzing" indicator — inline in the gain slot, no extra row. A pulsing
 * dot + short text, low-contrast so it sits in the layout without demanding
 * attention. Replaces the old .tab-status sub-row that added ~20px height. */
.analyzing {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-family: var(--font-ui);
  font-size: 10px;
  color: var(--honey-2);
}

.analyzing-text {
  white-space: nowrap;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
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
