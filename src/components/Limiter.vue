<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import InfoTip from '@/components/InfoTip.vue'
import { useDebouncedCallback } from '@/composables/useDebouncedRef'
import { useTabsStore } from '@/stores/tabs'

const tabsStore = useTabsStore()
defineOptions({ name: 'LimiterControl' })
const { t } = useI18n()

const isEnabled = computed(() => tabsStore.isLimiterEnabled)
const threshold = computed(() => tabsStore.limiterThreshold)
const attack = computed(() => tabsStore.limiterAttack)
const release = computed(() => tabsStore.limiterRelease)
const knee = computed(() => tabsStore.limiterKnee)
const ratio = computed(() => tabsStore.limiterRatio)

// Dynamic hint text for threshold & ratio — mirrors the attack/release/knee
// pattern so every control-row has the same vertical footprint.
const thresholdHint = computed(() => {
  const v = threshold.value
  if (v <= -3) return t('limiter.hints.threshold.conservative')
  if (v <= -1.5) return t('limiter.hints.threshold.balanced')
  return t('limiter.hints.threshold.aggressive')
})
const ratioHint = computed(() => {
  const v = ratio.value
  if (v <= 4) return t('limiter.hints.ratio.gentle')
  if (v <= 20) return t('limiter.hints.ratio.standard')
  return t('limiter.hints.ratio.brickwall')
})

async function toggleLimiter(): Promise<void> {
  await tabsStore.setLimiterEnabled(!isEnabled.value)
}

// Debounce each slider: a drag fires @input per pixel; without this each tick
// broadcasts SET_LIMITER to every content script (rebuilding a DynamicsCompressor
// config in every tab). 150ms trailing coalesces a drag into one broadcast.
const debouncedThreshold = useDebouncedCallback(
  (v: number) => void tabsStore.setLimiterThreshold(v),
  150,
)
const debouncedAttack = useDebouncedCallback((v: number) => void tabsStore.setLimiterAttack(v), 150)
const debouncedRelease = useDebouncedCallback(
  (v: number) => void tabsStore.setLimiterRelease(v),
  150,
)
const debouncedKnee = useDebouncedCallback((v: number) => void tabsStore.setLimiterKnee(v), 150)
const debouncedRatio = useDebouncedCallback((v: number) => void tabsStore.setLimiterRatio(v), 150)

function handleThresholdChange(event: Event): void {
  const value = parseFloat((event.target as HTMLInputElement).value)
  if (!isNaN(value)) debouncedThreshold(value)
}

function handleAttackChange(event: Event): void {
  const value = parseFloat((event.target as HTMLInputElement).value)
  if (!isNaN(value)) debouncedAttack(value)
}

function handleReleaseChange(event: Event): void {
  const value = parseFloat((event.target as HTMLInputElement).value)
  if (!isNaN(value)) debouncedRelease(value)
}

function handleKneeChange(event: Event): void {
  const value = parseFloat((event.target as HTMLInputElement).value)
  if (!isNaN(value)) debouncedKnee(value)
}

function handleRatioChange(event: Event): void {
  const value = parseFloat((event.target as HTMLInputElement).value)
  if (!isNaN(value)) debouncedRatio(value)
}

function formatThreshold(db: number): string {
  return `${db.toFixed(1)} dB`
}

function formatAttack(ms: number): string {
  return `${ms.toFixed(1)} ms`
}

function formatRelease(ms: number): string {
  return `${ms.toFixed(0)} ms`
}

function formatKnee(db: number): string {
  return `${db.toFixed(0)} dB`
}

function formatRatio(x: number): string {
  return `${x.toFixed(0)}:1`
}
</script>

<template>
  <div class="limiter-section">
    <div class="limiter-header">
      <div class="limiter-title">
        <span class="limiter-icon">🛡️</span>
        <span>{{ t('limiter.title') }}</span>
        <InfoTip :tip="t('limiter.tooltips.title')" />
      </div>
      <button
        class="limiter-toggle"
        :class="{ active: isEnabled }"
        :title="isEnabled ? t('limiter.tooltip.disable') : t('limiter.tooltip.enable')"
        @click="toggleLimiter"
      >
        <span class="toggle-track">
          <span class="toggle-thumb"></span>
        </span>
        <span class="toggle-label">{{ isEnabled ? t('limiter.on') : t('limiter.off') }}</span>
      </button>
    </div>

    <!-- All five parameters are flattened to one level: no nested fold keeps
         the surface honest — every knob the limiter exposes is visible at once.
         Sensible defaults mean casual users never need to touch them. -->
    <div class="limiter-controls" :class="{ disabled: !isEnabled }">
      <!-- Threshold (Ceiling) -->
      <div class="control-row">
        <label class="control-label">
          <span class="label-text">
            {{ t('limiter.ceiling') }}
            <InfoTip :tip="t('limiter.tooltips.threshold')" />
          </span>
          <span class="control-value">{{ formatThreshold(threshold) }}</span>
        </label>
        <div class="slider-container">
          <span class="slider-label">-6</span>
          <input
            type="range"
            class="param-slider threshold-slider"
            min="-6"
            max="-0.1"
            step="0.1"
            :value="threshold"
            :disabled="!isEnabled"
            @input="handleThresholdChange"
          />
          <span class="slider-label">-0.1</span>
        </div>
        <div class="param-hint">{{ thresholdHint }}</div>
      </div>

      <!-- Ratio -->
      <div class="control-row">
        <label class="control-label">
          <span class="label-text">
            {{ t('limiter.ratio') }}
            <InfoTip :tip="t('limiter.tooltips.ratio')" />
          </span>
          <span class="control-value ratio-value">{{ formatRatio(ratio) }}</span>
        </label>
        <div class="slider-container">
          <span class="slider-label">1</span>
          <input
            type="range"
            class="param-slider ratio-slider"
            min="1"
            max="60"
            step="1"
            :value="ratio"
            :disabled="!isEnabled"
            @input="handleRatioChange"
          />
          <span class="slider-label">60</span>
        </div>
        <div class="param-hint">{{ ratioHint }}</div>
      </div>

      <!-- Attack -->
      <div class="control-row">
        <label class="control-label">
          <span class="label-text">
            {{ t('limiter.attack') }}
            <InfoTip :tip="t('limiter.tooltips.attack')" />
          </span>
          <span class="control-value attack-value">{{ formatAttack(attack) }}</span>
        </label>
        <div class="slider-container">
          <span class="slider-label">0.1</span>
          <input
            type="range"
            class="param-slider attack-slider"
            min="0.1"
            max="50"
            step="0.1"
            :value="attack"
            :disabled="!isEnabled"
            @input="handleAttackChange"
          />
          <span class="slider-label">50</span>
        </div>
        <div class="param-hint">
          <span v-if="attack <= 1">{{ t('limiter.hints.attack.fast') }}</span>
          <span v-else-if="attack <= 10">{{ t('limiter.hints.attack.balanced') }}</span>
          <span v-else>{{ t('limiter.hints.attack.slow') }}</span>
        </div>
      </div>

      <!-- Release -->
      <div class="control-row">
        <label class="control-label">
          <span class="label-text">
            {{ t('limiter.release') }}
            <InfoTip :tip="t('limiter.tooltips.release')" />
          </span>
          <span class="control-value release-value">{{ formatRelease(release) }}</span>
        </label>
        <div class="slider-container">
          <span class="slider-label">10</span>
          <input
            type="range"
            class="param-slider release-slider"
            min="10"
            max="500"
            step="5"
            :value="release"
            :disabled="!isEnabled"
            @input="handleReleaseChange"
          />
          <span class="slider-label">500</span>
        </div>
        <div class="param-hint">
          <span v-if="release <= 50">{{ t('limiter.hints.release.fast') }}</span>
          <span v-else-if="release <= 150">{{ t('limiter.hints.release.balanced') }}</span>
          <span v-else>{{ t('limiter.hints.release.slow') }}</span>
        </div>
      </div>

      <!-- Knee -->
      <div class="control-row">
        <label class="control-label">
          <span class="label-text">
            {{ t('limiter.knee') }}
            <InfoTip :tip="t('limiter.tooltips.knee')" />
          </span>
          <span class="control-value knee-value">{{ formatKnee(knee) }}</span>
        </label>
        <div class="slider-container">
          <span class="slider-label">0</span>
          <input
            type="range"
            class="param-slider knee-slider"
            min="0"
            max="40"
            step="1"
            :value="knee"
            :disabled="!isEnabled"
            @input="handleKneeChange"
          />
          <span class="slider-label">40</span>
        </div>
        <div class="param-hint">
          <span v-if="knee <= 1">{{ t('limiter.hints.knee.hard') }}</span>
          <span v-else-if="knee <= 10">{{ t('limiter.hints.knee.soft') }}</span>
          <span v-else>{{ t('limiter.hints.knee.verySoft') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.limiter-section {
  background: #fff;
  border-radius: 12px;
  padding: 14px;
  border: 1px solid #e8eaed;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.limiter-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.limiter-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.limiter-icon {
  font-size: 16px;
}

.label-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.limiter-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px;
}

.toggle-track {
  width: 36px;
  height: 20px;
  background: #d0d5dd;
  border-radius: 10px;
  position: relative;
  transition: all 0.2s ease;
}

.limiter-toggle.active .toggle-track {
  background: #48bb78;
}

.toggle-thumb {
  position: absolute;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  top: 2px;
  left: 2px;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.limiter-toggle.active .toggle-thumb {
  background: #fff;
  left: 18px;
}

.toggle-label {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  min-width: 24px;
}

.limiter-toggle.active .toggle-label {
  color: #48bb78;
}

.limiter-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: opacity 0.2s ease;
}

.limiter-controls.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.control-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.control-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: #555;
}

.control-value {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-weight: 500;
  font-size: 11px;
  color: #48bb78;
}

.attack-value {
  color: #48bb78;
}

.release-value {
  color: #4299e1;
}

.knee-value {
  color: #9f7aea;
}

.slider-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slider-label {
  font-size: 9px;
  color: #aaa;
  font-family: 'SF Mono', 'Fira Code', monospace;
  width: 28px;
}

.slider-label:last-child {
  text-align: right;
}

.param-slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #e0e0e0;
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.param-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  background: #fff;
  border: 2px solid #48bb78;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  transition: transform 0.1s ease;
}

.param-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.param-slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.param-slider:disabled::-webkit-slider-thumb {
  cursor: not-allowed;
}

.param-hint {
  font-size: 9px;
  color: #bbb;
  text-align: center;
  font-style: italic;
}
</style>
