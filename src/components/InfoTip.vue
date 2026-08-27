<script setup lang="ts">
/**
 * A small "?" affordance that reveals an explanatory tooltip on hover/focus.
 *
 * ── Why Teleport + position: fixed ─────────────────────────────────────────
 * The popup has several `overflow: hidden` layers (`.settings-inner`,
 * `.body`, `.popup`) that hard-clip any absolutely-positioned descendant.
 * A tooltip rendered inside the component tree is therefore always at risk
 * of being sliced by whichever ancestor happens to clip — a game of whack-
 * a-mole that broke every time the layout changed.
 *
 * The structural fix: render the bubble via `<Teleport to="body">` and
 * position it with `position: fixed` against the *viewport*. `document.body`
 * has no overflow clipping, so the bubble is immune to every nested container
 * inside the popup. This makes the "问号提示被遮挡" bug impossible by
 * construction, regardless of future layout changes.
 *
 * ── Positioning ─────────────────────────────────────────────────────────────
 * On hover/focus we read the icon's viewport rect (`getBoundingClientRect`,
 * which is the coordinate space `position: fixed` uses) and place the bubble
 * centered above it, then:
 *   - Horizontal: clamp the bubble's left into `[0, vw - bw]` so it never
 *     spills either edge (the popup is the whole viewport in a Chrome popup).
 *   - Vertical: open above by default; flip below if there isn't room above
 *     within the viewport (checked directly against `vh`, no ancestor walk).
 * The arrow tracks the icon's horizontal center so it always points at the "?".
 */
import { nextTick, ref, useId } from 'vue'

defineOptions({ name: 'InfoTip' })

defineProps<{
  /** The explanation text (already i18n-resolved by the caller). */
  tip: string
}>()

/** Whether the bubble is currently open (drives Teleport render + visibility). */
const open = ref(false)

/**
 * Stable id for the teleported bubble so the trigger can reference its content
 * via aria-describedby (the tooltip content is otherwise not announced as
 * being "about" this icon). v-show (not v-if) keeps that id resolvable at all
 * times while still removing the bubble from the visual layout when closed.
 */
const bubbleId = useId()

/**
 * Inline style applied to the fixed-positioned bubble. `top`/`left` are
 * viewport coordinates (px); `--arrow-x` is the px offset of the arrow from
 * the bubble's left edge so it lines up under the icon.
 */
const bubbleStyle = ref<Record<string, string>>({})
/** 'top' = bubble opens above the icon; 'bottom' = below (flipped). */
const placement = ref<'top' | 'bottom'>('top')

const rootRef = ref<HTMLElement | null>(null)
const bubbleRef = ref<HTMLElement | null>(null)

/** Gap between the icon and the bubble, in px (kept in sync with CSS). */
const GAP = 6
/** Keep the arrow this many px from either edge of the bubble. */
const ARROW_MARGIN = 6

/**
 * Compute the bubble's fixed position relative to the viewport. Called on
 * hover/focus; runs on nextTick so the just-mounted bubble is measurable.
 */
async function show(): Promise<void> {
  open.value = true
  await nextTick()

  const icon = rootRef.value
  const bubble = bubbleRef.value
  if (!icon || !bubble) return

  const ir = icon.getBoundingClientRect()
  const br = bubble.getBoundingClientRect()
  const bw = br.width
  const bh = br.height
  const vw = window.innerWidth
  const vh = window.innerHeight
  const iconCenter = ir.left + ir.width / 2

  // --- Horizontal: clamp the bubble's viewport left into [0, vw - bw]. ---
  const idealLeft = iconCenter - bw / 2
  const maxLeft = Math.max(0, vw - bw)
  const left = Math.min(Math.max(idealLeft, 0), maxLeft)

  // --- Vertical: open above by default; flip below if no room above. ---
  // 4px safety so we flip a touch early rather than exactly at the edge.
  let top: number
  if (ir.top - GAP - bh >= 4) {
    placement.value = 'top'
    top = ir.top - GAP - bh
  } else {
    placement.value = 'bottom'
    top = ir.bottom + GAP
  }
  // If flipping below also overflows (very short viewport / tall bubble), fall
  // back to opening above and let the viewport clip the top — opening below
  // would push the bubble entirely off-screen, which is worse.
  if (top + bh > vh - 4 && placement.value === 'bottom') {
    placement.value = 'top'
    top = Math.max(4, ir.top - GAP - bh)
  }

  // Arrow: point at the icon center, clamped within the bubble's own edges.
  const arrowX = Math.min(Math.max(iconCenter - left, ARROW_MARGIN), bw - ARROW_MARGIN)

  bubbleStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    '--arrow-x': `${Math.round(arrowX)}px`,
  }
}

function hide(): void {
  open.value = false
}
</script>

<template>
  <!-- Keyboard contract: Enter/Space toggle the bubble (role=button without a
       key handler is an a11y lie — either ship the handler or drop the role;
       we ship both here). Escape closes. aria-describedby ties this trigger to
       its bubble content for assistive tech. -->
  <span
    ref="rootRef"
    class="info-tip"
    tabindex="0"
    role="button"
    :aria-label="tip"
    :aria-describedby="bubbleId"
    :aria-expanded="open"
    @mouseenter="show"
    @focus="show"
    @mouseleave="hide"
    @blur="hide"
    @keydown.enter.prevent="open ? hide() : show()"
    @keydown.space.prevent="open ? hide() : show()"
    @keydown.escape.prevent="hide"
  >
    <span class="info-tip-icon">?</span>
  </span>

  <!-- Teleported to <body> so the bubble escapes every overflow:hidden ancestor
       inside the popup. position:fixed anchors it to the viewport directly.
       v-show (not v-if): the stable DOM node keeps `getBoundingClientRect`
       measurable on re-open and keeps the aria-describedby target alive. -->
  <Teleport to="body">
    <span
      v-show="open"
      :id="bubbleId"
      ref="bubbleRef"
      class="info-tip-bubble"
      :class="`placement-${placement}`"
      :style="bubbleStyle"
      role="tooltip"
    >
      {{ tip }}
    </span>
  </Teleport>
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
  transition:
    border-color 0.15s ease,
    color 0.15s ease,
    background-color 0.15s ease;
}

.info-tip:hover .info-tip-icon,
.info-tip:focus .info-tip-icon {
  border-color: var(--honey);
  color: var(--honey);
  background: var(--honey-soft);
}
</style>

<!--
  The bubble lives under <body> via Teleport, NOT inside the scoped component,
  so its styles must be NON-scoped (global) to apply. The `.info-tip-bubble`
  class is specific enough to avoid collisions — it is only ever emitted by
  this component.
-->
<style>
.info-tip-bubble {
  position: fixed;
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
  z-index: 9999;
  text-align: center;
  pointer-events: none;
}

/* Arrow: a CSS triangle on the bubble's edge nearest the icon. placement-top
   → arrow on the bottom edge (pointing down at the "?"); placement-bottom →
   arrow on the top edge (pointing up). `--arrow-x` positions it horizontally
   to track the icon even when the bubble had to shift off-center to fit. */
.info-tip-bubble::after {
  content: '';
  position: absolute;
  left: var(--arrow-x, 50%);
  transform: translateX(-50%);
  border: 5px solid transparent;
}

.info-tip-bubble.placement-top::after {
  top: 100%;
  border-top-color: var(--bg-deep);
}

.info-tip-bubble.placement-bottom::after {
  bottom: 100%;
  border-bottom-color: var(--bg-deep);
}
</style>
