<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useTabsStore, hasEnoughSamples } from '@/stores/tabs'

const tabsStore = useTabsStore()
const { t } = useI18n()

function formatGain(gainDb: number): string {
  const prefix = gainDb >= 0 ? '+' : ''
  return `${prefix}${gainDb.toFixed(1)} dB`
}

function getGainColor(gainDb: number): string {
  const abs = Math.abs(gainDb)
  if (abs < 3) return '#48bb78'
  if (abs < 10) return '#ed8936'
  return '#f56565'
}

function getFaviconUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`
  } catch {
    return ''
  }
}

function truncateTitle(title: string, maxLength = 28): string {
  if (title.length <= maxLength) return title
  return title.substring(0, maxLength - 3) + '...'
}

async function handleToggleBalance(tabId: number): Promise<void> {
  await tabsStore.toggleBalance(tabId)
}

const tabs = computed(() => tabsStore.tabs)
// Per-tab balance toggle is meaningless when the global switch is off, so we
// disable + dim the buttons in that state.
const globalEnabled = computed(() => tabsStore.isAutoBalancing)
</script>

<template>
  <div class="tab-list">
    <div v-if="tabs.length === 0" class="empty-state">
      <div class="empty-icon">🎵</div>
      <p class="empty-title">{{ t('tabs.empty.title') }}</p>
      <p class="empty-hint">{{ t('tabs.empty.hint') }}</p>
    </div>

    <TransitionGroup name="tab-item" tag="div" class="tabs-container">
      <div
        v-for="tab in tabs"
        :key="tab.tabId"
        class="tab-item"
        :class="{ 'is-bypass': !tab.balanceEnabled }"
      >
        <div class="tab-row">
          <img
            v-if="tab.url"
            :src="getFaviconUrl(tab.url)"
            alt=""
            class="tab-favicon"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
          <span class="tab-title" :title="tab.title">{{ truncateTitle(tab.title) }}</span>
          <span
            v-if="globalEnabled && tab.balanceEnabled"
            class="tab-gain"
            :style="{ color: getGainColor(tab.appliedGainDb) }"
          >
            {{ formatGain(tab.appliedGainDb) }}
          </span>
          <span v-else-if="globalEnabled && !tab.balanceEnabled" class="tab-gain bypass">
            {{ t('tabs.balance.bypass') }}
          </span>
          <button
            class="icon-btn balance-btn"
            :class="{ active: tab.balanceEnabled, disabled: !globalEnabled }"
            :disabled="!globalEnabled"
            :title="tab.balanceEnabled ? t('tabs.balance.onHint') : t('tabs.balance.offHint')"
            @click="handleToggleBalance(tab.tabId)"
          >
            ⚖️
          </button>
        </div>
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
  gap: 8px;
}

/* Empty State */
.empty-state {
  text-align: center;
  padding: 32px 16px;
}

.empty-icon {
  font-size: 32px;
  margin-bottom: 10px;
  opacity: 0.4;
  animation: float 3s ease-in-out infinite;
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
}

.empty-title {
  font-size: 14px;
  font-weight: 500;
  color: #555;
  margin-bottom: 4px;
}

.empty-hint {
  font-size: 12px;
  color: #aaa;
}

/* Tab Items */
.tabs-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tab-item {
  background: #fff;
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  border: 2px solid transparent;
}

.tab-item.is-bypass {
  opacity: 0.7;
}

.tab-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tab-favicon {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  flex-shrink: 0;
}

.tab-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-gain {
  font-size: 12px;
  font-weight: 600;
  font-family: 'SF Mono', 'Fira Code', monospace;
  white-space: nowrap;
  flex-shrink: 0;
}

.tab-gain.bypass {
  color: #999;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s ease;
}

.icon-btn:hover {
  background: #f0f0f0;
}

/* Balance toggle: active = balancing applied (green highlight); inactive =
   bypassed (greyed). Disabled when the global switch is off. */
.balance-btn:not(.active) {
  filter: grayscale(1);
  opacity: 0.35;
}

.balance-btn.active {
  background: #ebf4ff;
}

.balance-btn.disabled,
.balance-btn:disabled {
  cursor: not-allowed;
  opacity: 0.3;
  filter: grayscale(1);
}

.balance-btn.disabled:hover {
  background: transparent;
}

/* Tab Status */
.tab-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 10px;
  color: #aaa;
}

.tab-status.collecting {
  color: #ed8936;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ddd;
}

.tab-status.collecting .status-dot {
  background: #ed8936;
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

/* Transitions */
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
</style>
