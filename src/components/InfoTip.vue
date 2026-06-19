<script setup lang="ts">
/**
 * A small "?" affordance that reveals an explanatory tooltip on hover/focus.
 *
 * Positioning solves TWO constraints, both measured from a single rect read on
 * open (no positioning lib — this is the only place popups exist in the app):
 *
 *  1. Horizontal: compute the bubble's viewport left so it is CLAMPED inside
 *     [0, vw - bw] — i.e. the bubble can NEVER overflow either edge, by
 *     construction. We then convert that to an offset relative to the icon
 *     (the bubble's absolute positioning context) and feed it as a CSS var.
 *     The previous logic only chose between three fixed anchors (center/start/
 *     end) and never verified the chosen anchor actually fit — when the icon
 *     sat mid-popup a "fix the left overflow" decision spilled the bubble out
 *     the right, inflating the scroll container's scrollWidth (the popup's
 *     horizontal scrollbar bug). Clamping makes that class of bug impossible.
 *
 *  2. Vertical: default opens ABOVE the icon, but if there's no room above
 *     within the nearest scroll ancestor (`.app-content`, which hard-clips
 *     overflow), the bubble flips to open BELOW — otherwise it renders above
 *     the viewport and is invisible (the "问号被遮挡" bug).
 *
 * The arrow tracks the icon's horizontal center (clamped to the bubble's own
 * edges) so it always points at the "?" regardless of how far the bubble had
 * to shift to stay on screen.
 *
 * Pure CSS show/hide; JS only computes two numbers + a placement flag.
 */
import { nextTick, ref } from 'vue'

defineOptions({ name: 'InfoTip' })

defineProps<{
  /** The explanation text (already i18n-resolved by the caller). */
  tip: string
}>()

/**
 * Horizontal offset of the bubble's left edge, relative to the icon's left
 * edge (the bubble's absolute positioning context is the 13px `.info-tip`).
 * Negative = bubble extends left of the icon. Set on open; 0 until then.
 */
const bubbleOffset = ref(0)
/**
 * Horizontal position of the arrow, as a fraction of the bubble width [0,1].
 * 0.5 = centered (icon under the middle of the bubble). Clamped so the arrow
 * never sits closer than ~6px to either bubble edge.
 */
const arrowRatio = ref(0.5)
/** Vertical placement: 'top' opens above the icon (default), 'bottom' below. */
const placement = ref<'top' | 'bottom'>('top')

const rootRef = ref<HTMLElement | null>(null)
const bubbleRef = ref<HTMLElement | null>(null)

/** Gap between the icon and the bubble edge, in px (keep in sync with CSS). */
const BUBBLE_GAP = 6
/** Keep the arrow this many px away from either edge of the bubble. */
const ARROW_MARGIN = 6

/**
 * Find the nearest ancestor that clips overflow (the scroll container whose
 * padding box hard-clips absolutely-positioned descendants). Used to decide
 * whether the bubble has room to open above the icon without being cut.
 */
function nearestScrollAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const o = getComputedStyle(node).overflow
    if (o !== 'visible') return node
    node = node.parentElement
  }
  return null
}

/**
 * Compute offset + arrow + placement before the bubble becomes visible. Runs
 * on nextTick so the bubble is laid out and its size is measurable.
 */
async function computeAlignment(): Promise<void> {
  // Reset so the natural (centered) width is measured fresh each open.
  bubbleOffset.value = 0
  arrowRatio.value = 0.5
  placement.value = 'top'
  await nextTick()

  const icon = rootRef.value
  const bubble = bubbleRef.value
  if (!icon || !bubble) return

  const iconRect = icon.getBoundingClientRect()
  const bubbleRect = bubble.getBoundingClientRect()
  const bw = bubbleRect.width
  const bh = bubbleRect.height
  const vw = window.innerWidth
  const iconLeft = iconRect.left
  const iconCenter = iconLeft + iconRect.width / 2

  // --- Horizontal: clamp the bubble's viewport left into [0, vw - bw]. ---
  // Ideal is centered on the icon; shift only as much as needed to stay inside.
  const idealLeft = iconCenter - bw / 2
  const maxLeft = Math.max(0, vw - bw)
  const bubbleViewLeft = Math.min(Math.max(idealLeft, 0), maxLeft)
  // Convert viewport-left → offset relative to the icon (positioning context).
  bubbleOffset.value = Math.round(bubbleViewLeft - iconLeft)
  // Arrow points at the icon center, clamped to [ARROW_MARGIN, bw - ARROW_MARGIN].
  const arrowX = Math.min(Math.max(iconCenter - bubbleViewLeft, ARROW_MARGIN), bw - ARROW_MARGIN)
  arrowRatio.value = bw > 0 ? arrowX / bw : 0.5

  // --- Vertical: flip below if opening above is clipped by the scroll box. ---
  const scrollParent = nearestScrollAncestor(icon)
  if (scrollParent) {
    const sp = scrollParent.getBoundingClientRect()
    const bubbleTopIfAbove = iconRect.top - BUBBLE_GAP - bh
    // 4px safety margin so we flip a touch early rather than exactly at the edge.
    if (bubbleTopIfAbove < sp.top + 4) {
      placement.value = 'bottom'
    }
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
    <span
      ref="bubbleRef"
      class="info-tip-bubble"
      :class="`placement-${placement}`"
      :style="{ left: `${bubbleOffset}px`, '--arrow-ratio': arrowRatio }"
    >
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

/*
 * CRITICAL layout guard: while hidden, collapse the bubble to ZERO width.
 *
 * A `position: absolute; width: max-content` bubble is still measured by its
 * scroll ancestor's scrollWidth even when invisible — so an un-hovered bubble
 * whose icon sits in the right half of the popup would extend 240px to the
 * right and inflate .app-content.scrollWidth, surfacing a horizontal scrollbar
 * even though nothing is visible. Forcing width/padding to 0 while hidden
 * removes it from the horizontal layout entirely; :hover/:focus restore the
 * natural width so computeAlignment() can measure it on open.
 */
.info-tip:not(:hover):not(:focus) .info-tip-bubble {
  width: 0;
  max-width: 0;
  padding: 0;
  overflow: hidden;
}

/* Default placement: opens ABOVE the icon. BUBBLE_GAP in the script must
   match this 6px. */
.info-tip-bubble.placement-top {
  bottom: calc(100% + 6px);
}

/* Flipped placement: opens BELOW when there's no room above (e.g. the icon is
   scrolled to the top of the popup's scroll container). */
.info-tip-bubble.placement-bottom {
  top: calc(100% + 6px);
}

/*
 * Horizontal position is set inline via `left: <bubbleOffset>px` (computed in
 * script to clamp the bubble inside the viewport). No align-* classes: the old
 * center/start/end anchors couldn't guarantee no-overflow, which is what
 * caused the popup's horizontal scrollbar. `left` + `width: max-content` means
 * the bubble's right edge is deterministic and, by construction, ≤ vw.
 */

/* Arrow. placement-top → arrow on the bubble's BOTTOM pointing down at the "?";
   placement-bottom → arrow on the TOP pointing up. Horizontal position tracks
   the icon via --arrow-ratio (fraction of bubble width), so the arrow always
   points at the "?" even when the bubble had to shift off-center to fit. */
.info-tip-bubble::after {
  content: '';
  position: absolute;
  /* Center the 10px-wide arrow (5px border × 2) on the icon's projected x. */
  left: calc(var(--arrow-ratio, 0.5) * 100% - 5px);
  border: 5px solid transparent;
  border-top-color: var(--bg-deep);
}

/* Arrow on the bottom edge, pointing down (default/above placement). */
.info-tip-bubble.placement-top::after {
  top: 100%;
  border-top-color: var(--bg-deep);
}

/* Arrow on the top edge, pointing up (flipped/below placement). */
.info-tip-bubble.placement-bottom::after {
  bottom: 100%;
  border-bottom-color: var(--bg-deep);
}

.info-tip:hover .info-tip-bubble,
.info-tip:focus .info-tip-bubble {
  opacity: 1;
  visibility: visible;
}
</style>
