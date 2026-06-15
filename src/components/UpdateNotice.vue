<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSettingsStore } from '@/stores/settings'

/**
 * A dismissible banner that surfaces after an extension update.
 *
 * On reload/update the content scripts in already-open tabs lose their
 * `chrome.runtime` context permanently, and `createMediaElementSource` can only
 * be called once per media element — so the only reliable recovery is a page
 * refresh. Rather than auto-reloading (destructive) or silently doing nothing,
 * we tell the user once, then remember the dismissal keyed by version.
 *
 * First install (`lastNoticeVersion === null`) is exempt: there are no
 * pre-existing tabs to recover, so nagging a brand-new user would be noise.
 */
defineOptions({ name: 'UpdateNotice' })

const { t } = useI18n()
const settings = useSettingsStore()

const currentVersion = __APP_VERSION__

const isVisible = computed(() => {
  const seen = settings.lastNoticeVersion
  return seen !== null && seen !== currentVersion
})

function dismiss(): void {
  settings.lastNoticeVersion = currentVersion
}
</script>

<template>
  <div v-if="isVisible" class="update-notice" role="status">
    <span class="notice-icon">🔄</span>
    <span class="notice-text">{{ t('updateNotice.text') }}</span>
    <button
      class="notice-dismiss"
      :aria-label="t('updateNotice.dismiss')"
      :title="t('updateNotice.dismiss')"
      @click="dismiss"
    >
      ✕
    </button>
  </div>
</template>

<style scoped>
.update-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  color: #92400e;
  font-size: 12px;
  line-height: 1.45;
}

.notice-icon {
  font-size: 13px;
  flex-shrink: 0;
  margin-top: 1px;
}

.notice-text {
  flex: 1;
}

.notice-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: #92400e;
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  opacity: 0.7;
  transition: all 0.15s ease;
}

.notice-dismiss:hover {
  opacity: 1;
  background: rgba(146, 64, 14, 0.1);
}
</style>
