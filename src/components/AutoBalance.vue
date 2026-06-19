<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
 * sits visually where the target sits relative to live loudness. A scale row
 * beneath (-60 / -40 / -20 / 0 majors, plus minor ticks) lets you read both
 * off the same axis.
 *
 * "Loudest balanced tab" is a popup-side heuristic (the SW has no notion of a
 * primary tab). It is exactly what a listener perceives as the dominant source,
 * and it updates every poll (≈100 ms) so the glow feels live.
 *
 * ── Optimistic knob (drag smoothness) ──────────────────────────────────────
 * The knob position and the target readout are bound to a *local* `dragValue`,
 * not to the store. The store only updates after the debounce + a SW round-trip
 * (~150 ms + message latency), so binding the visible knob to it made the knob
 * freeze mid-drag and snap into place on release — felt janky. Instead `@input`
 * writes `dragValue` synchronously (knob + number follow the finger live) and
 * the debounced setter carries the value to the SW in the background. When the
 * SW round-trip resolves and the store updates, we re-sync `dragValue` to it —
 * but only while not actively dragging, so a returning value can't fight the
 * user's hand mid-gesture.
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
const knobPct = computed(() => pct(dragValue.value))

// Local, synchronous mirror of the target for the knob + readout (see header).
// Seeded from the store so the initial paint matches before any drag.
const dragValue = ref(targetLufs.value)
let dragging = false
// Re-sync from the store whenever it changes externally (SW round-trip after a
// drag, or another surface editing the target) — but never overwrite a value
// the user is actively dragging to, which would make the knob fight the finger.
watch(targetLufs, (v) => {
  if (!dragging) dragValue.value = v
})

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
  if (isNaN(value)) return
  // Optimistic: move the knob + readout now; the SW update trails behind.
  dragValue.value = value
  debouncedSetTarget(value)
}

function handleThumbGrab(): void {
  dragging = true
}
function handleThumbRelease(): void {
  dragging = false
  // Snap the local mirror back to the authoritative store value once the
  // gesture ends, so a rejected/rounded SW response can't leave us drifting.
  dragValue.value = targetLufs.value
}

// Static scale ticks for the [-60, 0] LUFS axis. Majors carry a numeric label;
// minors are unlabelled short ticks. Percentages are precomputed (the axis is
// fixed-width) so there is zero per-frame work.
const SCALE_MINORS = [-50, -30, -10]
const SCALE_MAJORS = [-60, -40, -20, 0]
const scaleMinors = SCALE_MINORS.map((l) => ({ lufs: l, pct: pct(l) }))
const scaleMajors = SCALE_MAJORS.map((l) => ({ lufs: l, pct: pct(l) }))
</script>

<template>
  <div class="target" :class="{ 'is-off': !isAutoBalancing }">
    <div class="target-row">
      <span class="lab">{{ t('autobalance.title') }}</span>
      <span class="v">{{ dragValue }} LUFS</span>
    </div>

    <!-- Combined meter: fill (live loudness) + knob (target) in one groove,
         with an invisible range input laid over the whole thing to capture
         drags anywhere along the track. -->
    <div class="combined">
      <div class="c-track">
        <div
          class="c-fill"
          :class="{ active: isAutoBalancing }"
          :style="{ width: fillPct + '%' }"
        ></div>
        <div class="c-knob" :style="{ left: knobPct + '%' }"></div>
      </div>
      <input
        class="c-input target-slider"
        type="range"
        min="-60"
        max="0"
        step="1"
        :value="dragValue"
        :disabled="!isAutoBalancing"
        :aria-label="t('autobalance.title')"
        :aria-valuetext="`${dragValue} LUFS`"
        @input="handleTargetChange"
        @pointerdown="handleThumbGrab"
        @pointerup="handleThumbRelease"
        @pointercancel="handleThumbRelease"
      />
    </div>

    <!-- LUFS scale: majors labelled, minors bare. Shares the [-60,0] axis with
         the fill + knob above, so "how loud is it now vs. target" is readable. -->
    <div class="c-scale">
      <div
        v-for="tk in scaleMinors"
        :key="'m' + tk.lufs"
        class="tk"
        :style="{ left: tk.pct + '%' }"
      >
        <i></i>
      </div>
      <div
        v-for="tk in scaleMajors"
        :key="'M' + tk.lufs"
        class="tk major"
        :style="{ left: tk.pct + '%' }"
      >
        <i></i>
        <span>{{ tk.lufs }}</span>
      </div>
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

/* container-type anchors the fill gradient to the TRACK width (100cqw), so each
 * colour sits at a fixed LUFS position regardless of how far the fill extends —
 * the "temperature" at the leading edge reads true. */
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
  container-type: inline-size;
}

/* Five-stop gradient: dim amber → honey → warm red, sized to the whole track so
 * the hue maps to a fixed LUFS (left = quiet/cool, right = loud/hot). Track
 * stays square-cornered to match the rectangular popup frame. */
.c-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 50%;
  border-radius: 0;
  background: linear-gradient(
    90deg,
    oklch(42% 0.06 60) 0%,
    oklch(55% 0.09 65) 38%,
    var(--honey) 77%,
    oklch(70% 0.16 50) 90%,
    oklch(62% 0.21 25) 100%
  );
  background-size: 100cqw 100%;
  background-repeat: no-repeat;
  box-shadow: 0 0 10px var(--honey-soft);
  /* The fill width updates every poll tick (~250ms). Promote it to its own
   * compositor layer ONLY while balancing is on, so width changes don't
   * trigger a paint of the surrounding layout. When off the fill is static, so
   * holding a compositor layer forever would waste GPU memory. */
  transition: width 0.2s ease-out;
}

.c-fill.active {
  will-change: width;
}

/* Circular knob: honey ring on a pale disc, with a soft honey halo. Bound to
 * the local dragValue so it tracks the finger with zero latency (no SW
 * round-trip in the visible path). */
.c-knob {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: oklch(96% 0.01 72);
  border: 3px solid var(--honey);
  box-shadow:
    0 2px 6px oklch(8% 0.02 50 / 0.5),
    0 0 0 5px oklch(83% 0.118 76 / 0.08);
  pointer-events: none;
}

/* The real input is invisible and covers the whole track so dragging anywhere
   moves the target. Native thumb styling is hidden (opacity:0) — the visible
   knob is .c-knob above, kept in sync via :value + the left calc. */
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

/* The range input is invisible (opacity:0) but still keyboard-focusable.
 * Without a focus ring keyboard users cannot tell where the knob is. */
.c-input:focus-visible {
  outline: 2px solid var(--honey);
  outline-offset: 4px;
}

/* LUFS scale row beneath the track. */
.c-scale {
  position: relative;
  height: 15px;
  margin-top: 7px;
}

.c-scale .tk {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}

.c-scale .tk i {
  width: 1px;
  height: 4px;
  background: var(--faint);
}

.c-scale .tk.major i {
  height: 6px;
  background: var(--muted);
}

.c-scale .tk span {
  font: 500 8.5px / 1 var(--font-mono);
  color: var(--faint);
  margin-top: 3px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Off state: dim the fill so the meter reads as inactive without hiding the
   last target position (the knob stays put as a reminder of the setting). */
.target.is-off .c-fill {
  opacity: 0.25;
}
</style>
