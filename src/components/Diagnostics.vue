<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import InfoTip from '@/components/InfoTip.vue'
import { useTabsStore } from '@/stores/tabs'

defineOptions({ name: 'Diagnostics' })

const tabsStore = useTabsStore()
const { t } = useI18n()

// Entry count for the subtitle ("Last N entries · warnings and errors"). Fetched
// lazily on first expand + after each copy/clear so the badge stays accurate
// without polling the SW. Null = not yet loaded (empty-state placeholder).
const entryCount = ref<number | null>(null)
const busy = ref(false)
// Transient feedback line under the buttons. Empty = idle.
const toast = ref('')

let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string): void {
  toast.value = msg
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
    toastTimer = null
  }, 2500)
}

async function refreshCount(): Promise<void> {
  // Reuse the export path: it already returns a text blob whose line count is
  // the entry count. Cheaper than a dedicated COUNT request.
  const text = await tabsStore.exportLogs()
  if (text === null) {
    entryCount.value = 0
    return
  }
  entryCount.value = text === '' ? 0 : text.split('\n').length
}

async function onCopy(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const text = await tabsStore.exportLogs()
    if (text === null) {
      showToast(t('diagnostics.empty'))
      return
    }
    const count = text === '' ? 0 : text.split('\n').length
    if (count === 0) {
      showToast(t('diagnostics.empty'))
      return
    }
    await navigator.clipboard.writeText(text)
    showToast(t('diagnostics.copied', { count }))
    entryCount.value = count
  } catch {
    showToast(t('diagnostics.empty'))
  } finally {
    busy.value = false
  }
}

async function onClear(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const ok = await tabsStore.clearLogs()
    if (ok) {
      entryCount.value = 0
      showToast(t('diagnostics.empty'))
    }
  } finally {
    busy.value = false
  }
}

// Called by the parent when the panel is expanded, so the count is fresh each
// time the user looks. Kept as a defineExpose hook rather than auto-running in
// onMounted so we don't hit the SW when the panel is collapsed.
defineExpose({ refreshCount })
</script>

<template>
  <div class="diagnostics">
    <div class="prot-row">
      <div class="l">
        <span class="h">
          {{ t('diagnostics.title') }}
          <InfoTip :tip="t('diagnostics.tooltip.title')" />
        </span>
        <span class="s">{{
          entryCount === null
            ? t('diagnostics.empty')
            : t('diagnostics.subtitle', { count: entryCount })
        }}</span>
      </div>
    </div>

    <div class="diag-actions">
      <button
        class="ghost"
        type="button"
        :disabled="busy"
        :title="t('diagnostics.copy')"
        @click="onCopy"
      >
        {{ t('diagnostics.copy') }}
      </button>
      <button
        class="ghost"
        type="button"
        :disabled="busy"
        :title="t('diagnostics.clear')"
        @click="onClear"
      >
        {{ t('diagnostics.clear') }}
      </button>
    </div>

    <Transition name="diag-toast">
      <p v-if="toast" class="diag-toast">{{ toast }}</p>
    </Transition>
  </div>
</template>

<style scoped>
.diagnostics {
  font-family: var(--font-ui);
}

/* Header row mirrors the limiter's .prot-row layout so the two panels read as
 * siblings. */
.prot-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.prot-row .l {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.prot-row .h {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.prot-row .s {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
}

.diag-actions {
  display: flex;
  gap: 7px;
  margin-top: 14px;
}

/* Reuse the footer .ghost idiom but reskin locally: these are primary actions
 * inside a panel, so a faint honey tint reads as more "active" than the muted
 * footer toggle. */
.diag-actions .ghost {
  flex: 1;
  font: 500 11.5px / 1 var(--font-ui);
  color: var(--muted);
  background: none;
  border: 1px solid var(--hair);
  padding: 8px 12px;
  border-radius: 0;
  cursor: pointer;
  transition:
    color 0.18s,
    border-color 0.18s;
}

.diag-actions .ghost:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--honey-2);
}

.diag-actions .ghost:disabled {
  opacity: 0.5;
  cursor: default;
}

.diag-toast {
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--faint);
  line-height: 1.4;
}

.diag-toast-enter-active,
.diag-toast-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.diag-toast-enter-from,
.diag-toast-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
