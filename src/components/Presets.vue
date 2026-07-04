<script setup lang="ts">
/**
 * Loudness preset selector — a row of segmented buttons.
 *
 * One tap sets the target LUFS (and stays in sync if the user later drags the
 * main slider — the active highlight only shows when the slider sits exactly
 * on a preset's value, otherwise all segments dim, signalling "custom".
 *
 * The presets map to real delivery standards (Spotify −14, EBU R128 −23, …)
 * so a non-expert gets a correct, industry-aligned loudness target without
 * needing to understand LUFS. This is the 2.0 answer to "how do I pick the
 * right number": you don't, you pick what kind of content you're listening to.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { LOUDNESS_PRESETS } from '@/audio/config'
import InfoTip from '@/components/InfoTip.vue'
import { useTabsStore } from '@/stores/tabs'

defineOptions({ name: 'Presets' })

const tabsStore = useTabsStore()
const { t } = useI18n()

const presets = LOUDNESS_PRESETS
/** The currently-active preset id, or null when the slider is between presets. */
const activeId = computed(() => {
  const target = tabsStore.targetLufs
  const match = presets.find((p) => p.targetLufs === target)
  return match ? match.id : null
})

async function apply(preset: (typeof presets)[number]): Promise<void> {
  await tabsStore.setTargetLufs(preset.targetLufs)
}
</script>

<template>
  <div class="presets-wrap">
    <div class="presets" role="group" :aria-label="t('preset.group')">
      <button
        v-for="p in presets"
        :key="p.id"
        type="button"
        class="seg"
        :class="{ active: activeId === p.id }"
        :aria-pressed="activeId === p.id"
        @click="apply(p)"
      >
        <span class="lab">{{ t(p.labelKey) }}</span>
        <span class="v">{{ p.targetLufs }}</span>
        <!-- Citation "?" inside the button, pinned top-right. The bubble
             teleports to <body> so it's never clipped, and @click.stop keeps
             it from triggering the preset select. -->
        <span class="seg-info" @click.stop @mousedown.stop @touchstart.stop>
          <InfoTip :tip="t(p.sourceKey)" />
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.presets-wrap {
  margin: 14px 0 0;
}

.presets {
  display: flex;
  gap: 4px;
}

/* Segmented control — square-cornered to match the popup's hard-edged frame.
 * position:relative anchors the citation "?" in the top-right corner. */
.seg {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border-radius: 0;
  border: 1px solid var(--hair);
  background: none;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background 0.15s;
}

.seg:hover {
  color: var(--fg);
  border-color: var(--honey-2);
}

.seg .lab {
  font-size: 11px;
  font-weight: 500;
  line-height: 1.1;
}

.seg .v {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--faint);
}

.seg.active {
  color: var(--honey);
  border-color: var(--honey-2);
  background: var(--honey-soft);
}

.seg.active .v {
  color: var(--honey-2);
}

.seg:focus-visible {
  outline: 2px solid var(--honey);
  outline-offset: 1px;
}

/* Citation "?" — pinned to the button's top-right corner, inside the frame.
 * @click.stop on the wrapper (template) keeps it from selecting the preset. */
.seg-info {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Slightly smaller than the other InfoTips so it sits neatly in the corner. */
  transform: scale(0.85);
  transform-origin: top right;
}
</style>
