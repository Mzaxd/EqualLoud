<script setup lang="ts">
/**
 * A small "?" affordance that reveals an explanatory tooltip on hover/focus.
 *
 * Pure CSS show/hide (no JS positioning lib) — the bubble is absolutely
 * positioned relative to this inline element and capped in width so it never
 * overflows the 320px popup. Used to explain audio jargon (LUFS, threshold,
 * ratio, …) inline next to the label it qualifies.
 */
defineOptions({ name: 'InfoTip' })

defineProps<{
  /** The explanation text (already i18n-resolved by the caller). */
  tip: string
}>()
</script>

<template>
  <span class="info-tip" tabindex="0" role="button" :aria-label="tip">
    <span class="info-tip-icon">?</span>
    <span class="info-tip-bubble">{{ tip }}</span>
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
  border-radius: 50%;
  border: 1px solid #c0c4cc;
  color: #909399;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  background: #fafafa;
  transition: all 0.15s ease;
}

.info-tip:hover .info-tip-icon,
.info-tip:focus .info-tip-icon {
  border-color: #48bb78;
  color: #48bb78;
  background: #f0fdf4;
}

.info-tip-bubble {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 240px;
  padding: 7px 9px;
  background: #1a1a2e;
  color: #f7f8fa;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.45;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
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

/* Arrow pointing down at the "?" */
.info-tip-bubble::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: #1a1a2e;
}

.info-tip:hover .info-tip-bubble,
.info-tip:focus .info-tip-bubble {
  opacity: 1;
  visibility: visible;
}
</style>
