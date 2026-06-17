<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDebouncedCallback } from '@/composables/useDebouncedRef'
import { useTabsStore } from '@/stores/tabs'

/**
 * Target-volume control + the combined loudness meter.
 *
 * The meter is a single groove that overlays two things: a fill bar whose
 * width tracks the *loudest currently-balanced tab's* short-term LUFS (the
 * "ambient glow" — the most prominent sound right now), and a draggable knob
 * that sets the target LUFS. Both share the [-60, 0] LUFS range so the knob
 * sits visually where the target sits relative to live loudness.
 *
 * "Loudest balanced tab" is a popup-side heuristic (the SW has no notion of a
 * primary tab). It is exactly what a listener perceives as the dominant source,
 * and it updates every poll (≈100 ms) so the glow feels live.
 */
defineOptions({ name: 'AutoBalance' })

const tabsStore = useTabsStore()
const { t } = useI18n()

const targetLufs = computed(() => tabsStore.targetLufs)
const isAutoBalancing = computed(() => tabsStore.isAutoBalancing)

/**
 * The short-term LUFS of the loudest tab that is both capturing and being
 * balanced right now. Falls back to -Infinity (→ fill at 0%) when nothing is
 * playing, so the glow simply fades out rather than freezing on a stale value.
 */
const primaryShortTerm = computed(() => {
  let loudest = -Infinity
  for (const tab of tabsStore.tabs) {
    if (!tab.isCapturing || !tab.balanceEnabled) continue
    if (tab.shortTerm > loudest) loudest = tab.shortTerm
  }
  return loudest
})

/** Map a LUFS value in [-60, 0] to a [0, 100] percentage for the meter. */
function pct(lufs: number): number {
  if (!Number.isFinite(lufs)) return 0
  return Math.max(0, Math.min(100, ((lufs + 60) / 60) * 100))
}

const fillPct = computed(() => (isAutoBalancing.value ? pct(primaryShortTerm.value) : 0))
const knobPct = computed(() => pct(targetLufs.value))

// Debounce: a slider drag fires @input on every pixel; without this each tick
// sends SET_TARGET_LUFS (which force-resets the SW's balance throttle and
// triggers a full rebalance + storage write). 150 ms trailing coalesces a drag
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
</script>

<template>
  <div class="target" :class="{ 'is-off': !isAutoBalancing }">
    <div class="target-row">
      <span class="lab">{{ t('autobalance.title') }}</span>
      <span class="v">{{ targetLufs }} LUFS</span>
    </div>

    <!-- Combined meter: fill (live loudness) + knob (target) in one groove,
         with an invisible range input laid over the whole thing to capture
         drags anywhere along the track. -->
    <div class="combined">
      <div class="c-track">
        <div class="c-fill" :style="{ width: fillPct + '%' }"></div>
        <div class="c-knob" :style="{ left: knobPct + '%' }"></div>
      </div>
      <input
        class="c-input target-slider"
        type="range"
        min="-60"
        max="0"
        step="1"
        :value="targetLufs"
        :disabled="!isAutoBalancing"
        :aria-label="t('autobalance.title')"
        @input="handleTargetChange"
      />
    </div>
  </div>
</template>

<style scoped>
.target {
  margin: 14px 0 0;
}

.target-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}

.target-row .lab {
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 500;
}

.target-row .v {
  font-family: var(--font-serif);
  font-size: 17px;
  color: var(--honey);
  font-variant-numeric: tabular-nums;
}

/* Combined meter */
.combined {
  position: relative;
  height: 30px;
  margin-top: 14px;
}

.c-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 10px;
  border-radius: 0;
  background: oklch(16% 0.014 50);
  overflow: visible;
}

.c-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 50%;
  border-radius: 0;
  background: linear-gradient(90deg, oklch(55% 0.09 70), var(--honey));
  box-shadow: 0 0 10px var(--honey-soft);
  /* The fill width updates every poll tick (~250ms). Promote it to its own
   * compositor layer so width changes don't trigger a paint of the surrounding
   * layout; ease-out + a slightly longer duration keeps the motion smooth even
   * when a new value arrives mid-transition. */
  will-change: width;
  transition: width 0.2s ease-out;
}

.c-knob {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 6px;
  height: 22px;
  border-radius: 0;
  background: oklch(96% 0.01 72);
  border: none;
  border-top: 2px solid var(--honey);
  border-bottom: 2px solid var(--honey);
  box-shadow: 0 2px 6px oklch(8% 0.02 50 / 0.5);
  pointer-events: none;
}

/* The real input is invisible and covers the whole track so dragging anywhere
   moves the target. Native thumb styling is hidden (opacity:0) — the visible
   knob is .c-knob above, kept in sync via :value + the width calc. */
.c-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.c-input:disabled {
  cursor: not-allowed;
}

/* Off state: dim the fill so the meter reads as inactive without hiding the
   last target position (the knob stays put as a reminder of the setting). */
.target.is-off .c-fill {
  opacity: 0.25;
}
</style>
