<script setup lang="ts">
/**
 * A small "?" affordance that reveals an explanatory tooltip on hover/focus.
 *
 * The bubble auto-aligns within the viewport: on show it measures the icon's
 * position and picks one of three anchors so the bubble never overflows the
 * 320px popup. Previously it was always centered on the icon, which clipped
 * the left half whenever the icon sat near the popup's left edge — exactly
 * the case in the Limiter control rows where every "?" is left-aligned.
 *
 * Pure CSS show/hide (no positioning lib); only a tiny rect read on open to
 * pick the alignment mode. Used to explain audio jargon (LUFS, threshold,
 * ratio, …) inline next to the label it qualifies.
 */
import { nextTick, ref } from 'vue'

defineOptions({ name: 'InfoTip' })

defineProps<{
  /** The explanation text (already i18n-resolved by the caller). */
  tip: string
}>()

// Alignment picked at open time so the bubble stays inside the popup.
//   center: bubble centered on the icon (default, when there is room)
//   start : bubble's left edge aligns to the icon (icon near the left edge)
//   end   : bubble's right edge aligns to the icon (icon near the right edge)
const align = ref<'center' | 'start' | 'end'>('center')

const rootRef = ref<HTMLElement | null>(null)
const bubbleRef = ref<HTMLElement | null>(null)

/**
 * Decide alignment before the bubble becomes visible. Runs on nextTick so the
 * bubble element is laid out and its width is measurable (it is always
 * rendered center-aligned first, which gives the natural width).
 */
async function computeAlignment(): Promise<void> {
  align.value = 'center'
  await nextTick()

  const icon = rootRef.value
  const bubble = bubbleRef.value
  if (!icon || !bubble) return

  const iconRect = icon.getBoundingClientRect()
  const bubbleWidth = bubble.getBoundingClientRect().width
  const vw = window.innerWidth
  const iconCenter = iconRect.left + iconRect.width / 2

  // Would a centered bubble overflow either edge of the viewport?
  const half = bubbleWidth / 2
  if (half - iconCenter > 0) {
    align.value = 'start'
  } else if (iconCenter + half - vw > 0) {
    align.value = 'end'
  }
}
</script>

<template>
  <span
    ref="rootRef"
    class="info-tip"
    tabindex="0"
    role="button"
    :aria-label="tip"
    @mouseenter="computeAlignment"
    @focus="computeAlignment"
  >
    <span class="info-tip-icon">?</span>
    <span ref="bubbleRef" class="info-tip-bubble" :class="`align-${align}`">
      {{ tip }}
    </span>
  </span>
</template>

<style scoped>
.info-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  cursor: help;
  outline: none;
}

.info-tip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border-radius: 0;
  border: 1px solid var(--hair);
  color: var(--faint);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  background: var(--surface);
  transition: all 0.15s ease;
}

.info-tip:hover .info-tip-icon,
.info-tip:focus .info-tip-icon {
  border-color: var(--honey);
  color: var(--honey);
  background: var(--honey-soft);
}

.info-tip-bubble {
  position: absolute;
  bottom: calc(100% + 6px);
  width: max-content;
  max-width: 240px;
  padding: 7px 9px;
  background: var(--bg-deep);
  color: var(--fg);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.45;
  border-radius: 0;
  border: 1px solid var(--hair);
  box-shadow: 0 4px 12px oklch(8% 0.02 50 / 0.4);
  /* Hidden state: invisible + non-interactive so it doesn't block sliders. */
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.15s ease,
    visibility 0.15s ease;
  z-index: 10;
  text-align: center;
}

/* Centered (default): bubble centered on the icon. */
.info-tip-bubble.align-center {
  left: 50%;
  transform: translateX(-50%);
}

/* Icon near the left edge: pin bubble's left edge to the icon. */
.info-tip-bubble.align-start {
  left: 0;
}

/* Icon near the right edge: pin bubble's right edge to the icon. */
.info-tip-bubble.align-end {
  right: 0;
}

/* Arrow pointing down at the "?". The icon always sits in the center of the
   13px container, so when the bubble is pinned to an edge the arrow just
   tracks the near side of the bubble. */
.info-tip-bubble::after {
  content: '';
  position: absolute;
  top: 100%;
  border: 5px solid transparent;
  border-top-color: var(--bg-deep);
}

.info-tip-bubble.align-center::after {
  left: 50%;
  transform: translateX(-50%);
}

.info-tip-bubble.align-start::after {
  left: 6px;
}

.info-tip-bubble.align-end::after {
  right: 6px;
}

.info-tip:hover .info-tip-bubble,
.info-tip:focus .info-tip-bubble {
  opacity: 1;
  visibility: visible;
}
</style>
