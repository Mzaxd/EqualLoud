<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDebouncedCallback } from '@/composables/useDebouncedRef'
import { useTabsStore } from '@/stores/tabs'

const tabsStore = useTabsStore()
const { t } = useI18n()

const targetLufs = computed(() => tabsStore.targetLufs)
const isAutoBalancing = computed(() => tabsStore.isAutoBalancing)
const tabCount = computed(() => tabsStore.tabs.length)

const statusText = computed(() => {
  if (!isAutoBalancing.value) return t('popup.status.disabled')
  if (tabCount.value === 0) return t('popup.status.waiting')
  return t('popup.status.balancing', { count: tabCount.value })
})

// Debounce: a slider drag fires @input on every pixel; without this each tick
// sends SET_TARGET_LUFS (which force-resets the SW's balance throttle and
// triggers a full rebalance + storage write). 150ms trailing coalesces a drag
// into one round-trip once the user pauses.
const debouncedSetTarget = useDebouncedCallback((value: number) => {
  void tabsStore.setTargetLufs(value)
}, 150)

function handleTargetChange(event: Event): void {
  const target = event.target as HTMLInputElement
  const value = parseFloat(target.value)
  if (!isNaN(value)) {
    debouncedSetTarget(value)
  }
}

async function handleToggleAutoBalance(): Promise<void> {
  await tabsStore.toggleAutoBalance()
}
</script>

<template>
  <div class="auto-balance">
    <!-- Toggle Row -->
    <div class="toggle-row">
      <div class="toggle-info">
        <span class="toggle-label">{{ t('autobalance.title') }}</span>
        <span class="status-text">{{ statusText }}</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ active: isAutoBalancing }"
        @click="handleToggleAutoBalance"
      >
        <span class="toggle-track">
          <span class="toggle-thumb"></span>
        </span>
      </button>
    </div>

    <!-- Target LUFS Slider (shown when enabled) -->
    <Transition name="fade">
      <div v-if="isAutoBalancing" class="target-section">
        <div class="slider-row">
          <span class="slider-label">-60</span>
          <input
            type="range"
            class="target-slider"
            min="-60"
            max="0"
            step="1"
            :value="targetLufs"
            @input="handleTargetChange"
          />
          <span class="slider-label">0</span>
        </div>
        <div class="target-value">{{ targetLufs }} LUFS</div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.auto-balance {
  background: #fff;
  border-radius: 12px;
  padding: 14px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.toggle-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toggle-label {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a2e;
}

.status-text {
  font-size: 11px;
  color: #888;
}

/* Toggle Switch */
.toggle-switch {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}

.toggle-track {
  display: block;
  width: 44px;
  height: 26px;
  background: #d0d5dd;
  border-radius: 13px;
  position: relative;
  transition: background 0.2s ease;
}

.toggle-switch.active .toggle-track {
  background: #48bb78;
}

.toggle-thumb {
  position: absolute;
  width: 22px;
  height: 22px;
  background: #fff;
  border-radius: 50%;
  top: 2px;
  left: 2px;
  transition: transform 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.toggle-switch.active .toggle-thumb {
  transform: translateX(18px);
}

/* Target Slider */
.target-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slider-label {
  font-size: 10px;
  color: #aaa;
  font-family: 'SF Mono', 'Fira Code', monospace;
  width: 18px;
}

.slider-label:last-child {
  text-align: right;
}

.target-slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #e0e0e0;
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.target-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: #fff;
  border: 2px solid #48bb78;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  transition: transform 0.1s ease;
}

.target-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.target-value {
  text-align: center;
  margin-top: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #48bb78;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

/* Fade transition */
.fade-enter-active,
.fade-leave-active {
  transition: all 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
