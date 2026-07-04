<script setup lang="ts">
/**
 * Loudness Analysis panel (Pro mode) — surfaces the measurements the worklet
 * has always computed but 1.0 never showed: true-peak (dBTP), integrated
 * loudness, and loudness range (LRA).
 *
 * These are the three figures a mixing/mastering engineer reads off a
 * professional loudness meter. Showing them in the popup turns EqualLoud from
 * "a balancer" into "a balancer that also tells you what's happening" — the
 * difference between a consumer tool and one a content creator reaches for.
 *
 * The values come from the loudest currently-balanced tab (the "primary"),
 * the same source the main meter binds to, so every reading on screen refers
 * to the same audio the user is hearing dominate the mix.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useTabsStore } from '@/stores/tabs'

defineOptions({ name: 'LoudnessAnalysis' })

const tabsStore = useTabsStore()
const { t } = useI18n()

/**
 * The primary tab: the loudest balanced+capturing tab, same definition as the
 * main meter's fill. All three readings refer to this tab so the panel tells a
 * coherent story about one source.
 */
const primary = computed(() => {
  let best: (typeof tabsStore.tabs)[number] | null = null
  for (const tab of tabsStore.tabs) {
    if (!tab.isCapturing || !tab.balanceEnabled) continue
    if (!best || tab.shortTerm > best.shortTerm) best = tab
  }
  return best
})

const truePeakDb = computed(() => primary.value?.truePeakDb ?? -Infinity)
const integrated = computed(() => primary.value?.integrated ?? -Infinity)
const lra = computed(() => primary.value?.lra ?? -Infinity)

/** Format a LUFS/LU/dBTP value, showing — for unmeasured (-Infinity). */
function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—'
}

/**
 * True-peak safety indicator: green when below −1 dBTP (the R128 ceiling),
 * red when at/above it (inter-sample clipping risk). This is the visual the
 * loudness video's "采样峰值会漏失真" point lands on — the user can finally
 * *see* whether their audio is clipping between samples.
 */
const tpStatus = computed<{ cls: string; icon: string }>(() => {
  const v = truePeakDb.value
  if (!Number.isFinite(v)) return { cls: 'idle', icon: '·' }
  if (v >= -1) return { cls: 'warn', icon: '!' }
  return { cls: 'ok', icon: '✓' }
})

/**
 * LRA "thermometer" width: maps 0–30 LU to 0–100%. Wider bar = more dynamic
 * range. Coloured cool (compressed) → warm (dynamic) via the same gradient
 * idea as the main meter, inverted (more range = warmer).
 */
const lraPct = computed(() => {
  const v = lra.value
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, (v / 30) * 100))
})
</script>

<template>
  <div class="analysis">
    <!-- True peak -->
    <div class="row">
      <span class="lab">{{ t('analysis.truePeak') }}</span>
      <span class="val-group">
        <span class="val">{{ fmt(truePeakDb) }}</span>
        <span class="unit">dBTP</span>
        <span class="status" :class="tpStatus.cls">{{ tpStatus.icon }}</span>
      </span>
    </div>

    <!-- Integrated loudness -->
    <div class="row">
      <span class="lab">{{ t('analysis.integrated') }}</span>
      <span class="val-group">
        <span class="val">{{ fmt(integrated) }}</span>
        <span class="unit">LUFS</span>
      </span>
    </div>

    <!-- Loudness range with thermometer bar -->
    <div class="row lra-row">
      <div class="lra-head">
        <span class="lab">{{ t('analysis.lra') }}</span>
        <span class="val-group">
          <span class="val">{{ fmt(lra) }}</span>
          <span class="unit">LU</span>
        </span>
      </div>
      <div class="lra-bar">
        <div class="lra-fill" :style="{ width: lraPct + '%' }"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.analysis {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.lab {
  font-size: 12px;
  color: var(--muted);
}

.val-group {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}

.val {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.unit {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
}

/* True-peak status dot */
.status {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: 700;
  margin-left: 4px;
}

.status.ok {
  background: oklch(30% 0.06 150);
  color: var(--ok);
}

.status.warn {
  background: oklch(35% 0.1 25);
  color: oklch(78% 0.18 30);
}

.status.idle {
  background: var(--surface-2);
  color: var(--faint);
}

/* LRA row — stacked: header, bar, hint */
.lra-row {
  flex-direction: column;
  gap: 5px;
}

.lra-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.lra-bar {
  height: 4px;
  background: oklch(26% 0.012 52);
  overflow: hidden;
}

.lra-fill {
  height: 100%;
  background: linear-gradient(90deg, oklch(60% 0.09 250), var(--honey), oklch(68% 0.15 50));
  transition: width 0.4s ease;
}
</style>
