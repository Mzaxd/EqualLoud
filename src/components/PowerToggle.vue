<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useTabsStore } from '@/stores/tabs'

/**
 * The circular standby power button in the popup header — the master on/off
 * for auto-balancing (replaces the old green toggle switch). Same store action
 * under the hood; only the affordance changed.
 */
defineOptions({ name: 'PowerToggle' })

const tabsStore = useTabsStore()
const { t } = useI18n()

const isOn = computed(() => tabsStore.isAutoBalancing)

async function toggle(): Promise<void> {
  await tabsStore.toggleAutoBalance()
}
</script>

<template>
  <button
    class="power"
    :class="{ on: isOn }"
    type="button"
    :aria-label="t('popup.power')"
    :aria-pressed="isOn"
    @click="toggle"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg
    >
  </button>
</template>

<style scoped>
.power {
  width: 42px;
  height: 42px;
  border-radius: 0;
  padding: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
  border: 1px solid var(--hair);
  background: linear-gradient(180deg, oklch(27% 0.014 52), var(--bg-deep));
  box-shadow:
    inset 0 1px 0 oklch(40% 0.014 52),
    inset 0 -3px 6px oklch(10% 0.014 50);
  color: var(--faint);
  transition:
    color 0.28s,
    border-color 0.28s,
    background 0.28s,
    box-shadow 0.28s,
    transform 0.12s;
}

.power svg {
  width: 17px;
  height: 17px;
  display: block;
}

.power:hover {
  color: var(--muted);
}

.power:active {
  transform: scale(0.94);
}

.power.on {
  color: var(--honey);
  border-color: color-mix(in oklch, var(--honey) 42%, var(--hair));
  background: linear-gradient(180deg, oklch(37% 0.065 62), oklch(22% 0.03 55));
  box-shadow:
    0 0 0 1px oklch(83% 0.118 76 / 0.14),
    0 0 16px oklch(83% 0.118 76 / 0.32),
    inset 0 1px 0 oklch(54% 0.05 70),
    inset 0 -3px 6px oklch(12% 0.02 52);
}
</style>
