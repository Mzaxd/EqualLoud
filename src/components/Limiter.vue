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
  if (v <= 12) return t('limiter.hints.ratio.standard')
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
  <div class="limiter">
    <!-- Header row: title + master on/off toggle. -->
    <div class="prot-row">
      <div class="l">
        <span class="h">
          {{ t('limiter.title') }}
          <InfoTip :tip="t('limiter.tooltips.title')" />
        </span>
        <span class="s">{{ t('limiter.subtitle') }}</span>
      </div>
      <div class="r">
        <span class="state" :class="{ off: !isEnabled }">{{ isEnabled ? t('limiter.on') : t('limiter.off') }}</span>
        <button
          class="mt limiter-toggle"
          :class="{ on: isEnabled }"
          type="button"
          role="switch"
          :aria-checked="isEnabled"
          :title="isEnabled ? t('limiter.tooltip.disable') : t('limiter.tooltip.enable')"
          @click="toggleLimiter"
        >
          <span class="mt-thumb"></span>
        </button>
      </div>
    </div>

    <!-- All five parameters are flattened to one level: no nested fold keeps
         the surface honest — every knob the limiter exposes is visible at once.
         Sensible defaults mean casual users never need to touch them. -->
    <div class="limiter-controls" :class="{ disabled: !isEnabled }">
      <!-- Threshold (Ceiling) -->
      <div class="ctrl">
        <div class="cr">
          <span class="cl"
            >{{ t('limiter.ceiling') }}
            <InfoTip :tip="t('limiter.tooltips.threshold')" />
          </span>
          <span class="cv">{{ formatThreshold(threshold) }}</span>
        </div>
        <input
          type="range"
          class="fader threshold-slider"
          min="-6"
          max="-0.1"
          step="0.1"
          :value="threshold"
          :disabled="!isEnabled"
          @input="handleThresholdChange"
        />
        <div class="cr"><span></span><span class="hint">{{ thresholdHint }}</span></div>
      </div>

      <!-- Ratio -->
      <div class="ctrl">
        <div class="cr">
          <span class="cl"
            >{{ t('limiter.ratio') }}
            <InfoTip :tip="t('limiter.tooltips.ratio')" />
          </span>
          <span class="cv">{{ formatRatio(ratio) }}</span>
        </div>
        <input
          type="range"
          class="fader ratio-slider"
          min="1"
          max="20"
          step="1"
          :value="ratio"
          :disabled="!isEnabled"
          @input="handleRatioChange"
        />
        <div class="cr"><span></span><span class="hint">{{ ratioHint }}</span></div>
      </div>

      <!-- Attack -->
      <div class="ctrl">
        <div class="cr">
          <span class="cl"
            >{{ t('limiter.attack') }}
            <InfoTip :tip="t('limiter.tooltips.attack')" />
          </span>
          <span class="cv cool">{{ formatAttack(attack) }}</span>
        </div>
        <input
          type="range"
          class="fader attack-slider"
          min="0.1"
          max="50"
          step="0.1"
          :value="attack"
          :disabled="!isEnabled"
          @input="handleAttackChange"
        />
        <div class="cr">
          <span></span>
          <span class="hint">
            <span v-if="attack <= 1">{{ t('limiter.hints.attack.fast') }}</span>
            <span v-else-if="attack <= 10">{{ t('limiter.hints.attack.balanced') }}</span>
            <span v-else>{{ t('limiter.hints.attack.slow') }}</span>
          </span>
        </div>
      </div>

      <!-- Release -->
      <div class="ctrl">
        <div class="cr">
          <span class="cl"
            >{{ t('limiter.release') }}
            <InfoTip :tip="t('limiter.tooltips.release')" />
          </span>
          <span class="cv cool">{{ formatRelease(release) }}</span>
        </div>
        <input
          type="range"
          class="fader release-slider"
          min="10"
          max="500"
          step="5"
          :value="release"
          :disabled="!isEnabled"
          @input="handleReleaseChange"
        />
        <div class="cr">
          <span></span>
          <span class="hint">
            <span v-if="release <= 50">{{ t('limiter.hints.release.fast') }}</span>
            <span v-else-if="release <= 150">{{ t('limiter.hints.release.balanced') }}</span>
            <span v-else>{{ t('limiter.hints.release.slow') }}</span>
          </span>
        </div>
      </div>

      <!-- Knee -->
      <div class="ctrl">
        <div class="cr">
          <span class="cl"
            >{{ t('limiter.knee') }}
            <InfoTip :tip="t('limiter.tooltips.knee')" />
          </span>
          <span class="cv cool">{{ formatKnee(knee) }}</span>
        </div>
        <input
          type="range"
          class="fader knee-slider"
          min="0"
          max="40"
          step="1"
          :value="knee"
          :disabled="!isEnabled"
          @input="handleKneeChange"
        />
        <div class="cr">
          <span></span>
          <span class="hint">
            <span v-if="knee <= 1">{{ t('limiter.hints.knee.hard') }}</span>
            <span v-else-if="knee <= 10">{{ t('limiter.hints.knee.soft') }}</span>
            <span v-else>{{ t('limiter.hints.knee.verySoft') }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.limiter {
  display: flex;
  flex-direction: column;
}

/* Header row */
.prot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.prot-row .l {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.prot-row .l .h {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 500;
}

.prot-row .l .s {
  font-size: 11.5px;
  color: var(--muted);
}

.prot-row .r {
  display: flex;
  align-items: center;
  gap: 10px;
}

.prot-row .state {
  font-size: 11.5px;
  color: var(--ok);
  font-weight: 500;
}

.prot-row .state.off {
  color: var(--faint);
}

/* Mini toggle */
.mt {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 0;
  background: var(--bg-deep);
  border: 1px solid var(--hair);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}

.mt .mt-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 0;
  background: var(--faint);
  transition:
    transform 0.2s,
    background 0.2s;
}

.mt.on {
  background: oklch(30% 0.04 60);
  border-color: var(--honey-2);
}

.mt.on .mt-thumb {
  transform: translateX(14px);
  background: var(--honey);
}

/* Controls */
.limiter-controls {
  display: flex;
  flex-direction: column;
  gap: 15px;
  margin-top: 15px;
  transition: opacity 0.2s ease;
}

.limiter-controls.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.ctrl {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cr {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.cl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

.cv {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--honey);
  font-variant-numeric: tabular-nums;
}

.cv.cool {
  color: var(--cut);
}

.hint {
  font-size: 10.5px;
  color: var(--faint);
  text-align: right;
}

/* Slim fader */
.fader {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  border-radius: 0;
  outline: none;
  background: oklch(30% 0.012 52);
  cursor: pointer;
}

.fader::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 6px;
  height: 18px;
  border-radius: 0;
  background: oklch(96% 0.01 72);
  border: none;
  border-top: 2px solid var(--honey);
  border-bottom: 2px solid var(--honey);
  box-shadow: 0 2px 6px oklch(8% 0.02 50 / 0.5);
  cursor: pointer;
  transition: transform 0.12s;
}

.fader::-webkit-slider-thumb:hover {
  transform: scaleY(1.1);
}

.fader::-moz-range-thumb {
  width: 6px;
  height: 18px;
  border-radius: 0;
  background: oklch(96% 0.01 72);
  border: none;
  border-top: 2px solid var(--honey);
  border-bottom: 2px solid var(--honey);
  cursor: pointer;
}

.fader:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
