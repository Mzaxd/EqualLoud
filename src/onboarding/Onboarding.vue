<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSettingsStore } from '@/stores/settings'

/**
 * Three-step first-run welcome. Shown once on install (the SW opens this page
 * via `chrome.tabs.create` on `onInstalled` reason 'install').
 *
 * Step 1: what EqualLoud does.
 * Step 2: the `<all_urls>` permission — front-and-centre, because it's the one
 *         a privacy-conscious user will want explained before they trust it.
 * Step 3: it's already on; how to use it.
 *
 * Reuses the暖夜灯 tokens so the welcome feels like the popup, not a generic
 * Chrome page. Locale toggle in the corner so a non-English user can flip
 * before reading step 2 (the important one).
 */
defineOptions({ name: 'Onboarding' })

const { t, locale } = useI18n()
const settings = useSettingsStore()

const step = ref(0)
const steps = [0, 1, 2] as const

function next(): void {
  if (step.value < steps.length - 1) step.value++
  else finish()
}

function back(): void {
  if (step.value > 0) step.value--
}

function finish(): void {
  // Mark the locale choice, then close the tab. The "update notice" is
  // first-install-exempt, so no bookkeeping needed here.
  settings.locale = String(locale.value)
  // chrome.tabs may be undefined in non-extension contexts (dev preview);
  // guard so the component can be mounted standalone for styling work.
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id != null) void chrome.tabs.remove(tab.id)
    })
  }
}

function toggleLocale(): void {
  locale.value = locale.value === 'zh_CN' ? 'en' : 'zh_CN'
}

const langLabel = locale.value === 'zh_CN' ? 'EN' : '中'
</script>

<template>
  <div class="onb">
    <header class="onb-top">
      <span class="wordmark">Equal<b>Loud</b></span>
      <button class="lang" type="button" @click="toggleLocale">{{ langLabel }}</button>
    </header>

    <main class="onb-body">
      <div class="hero">
        <img src="/logo@128w.png" alt="" width="72" height="72" />
        <h1 class="tag">{{ t('onboarding.tagline') }}</h1>
      </div>

      <section :key="step" class="step">
        <h2 class="step-title">
          {{
            step === 0
              ? t('onboarding.step1Title')
              : step === 1
                ? t('onboarding.step2Title')
                : t('onboarding.step3Title')
          }}
        </h2>
        <p class="step-body">
          {{
            step === 0
              ? t('onboarding.step1Body')
              : step === 1
                ? t('onboarding.step2Body')
                : t('onboarding.step3Body')
          }}
        </p>
        <a
          v-if="step === 1"
          class="privacy"
          href="https://github.com/mzaxd/EqualLoud/blob/main/PRIVACY.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t('onboarding.privacyLink') }} →
        </a>
      </section>

      <div class="dots">
        <span
          v-for="s in steps"
          :key="s"
          class="dot"
          :class="{ on: s === step }"
          @click="step = s"
        ></span>
      </div>
    </main>

    <footer class="onb-foot">
      <button v-if="step > 0" class="btn ghost" type="button" @click="back">
        {{ t('onboarding.back') }}
      </button>
      <button class="btn primary" type="button" @click="next">
        {{ step === steps.length - 1 ? t('onboarding.getStarted') : t('onboarding.next') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.onb {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, oklch(23% 0.015 52), var(--bg));
  color: var(--fg);
}

.onb-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 28px;
}

.wordmark {
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.wordmark b {
  color: var(--honey);
  font-weight: 600;
  font-style: italic;
}

.lang {
  font: 500 12px / 1 var(--font-ui);
  color: var(--muted);
  background: none;
  border: 1px solid var(--hair);
  padding: 7px 12px;
  border-radius: 0;
  cursor: pointer;
  transition:
    color 0.18s,
    border-color 0.18s;
}

.lang:hover {
  color: var(--fg);
  border-color: var(--honey-2);
}

.onb-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 28px;
  text-align: center;
  max-width: 520px;
  margin: 0 auto;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  margin-bottom: 40px;
}

.hero img {
  border-radius: 16px;
}

.tag {
  font-family: var(--font-serif);
  font-size: 28px;
  font-weight: 500;
  line-height: 1.25;
  letter-spacing: -0.015em;
}

.step {
  min-height: 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.step-title {
  font-family: var(--font-serif);
  font-size: 19px;
  font-weight: 600;
  color: var(--honey);
}

.step-body {
  font-size: 15px;
  line-height: 1.6;
  color: var(--muted);
  max-width: 440px;
}

.privacy {
  font-size: 13px;
  color: var(--honey-2);
  text-decoration: none;
  transition: color 0.15s;
}

.privacy:hover {
  color: var(--honey);
}

/* Step enter animation — a gentle fade so the three screens flow rather than
 * snap. Respects prefers-reduced-motion (handled globally in tokens). */
.step {
  animation: step-in 0.28s ease-out;
}

@keyframes step-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.dots {
  display: flex;
  gap: 8px;
  margin-top: 32px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hair);
  cursor: pointer;
  transition:
    background 0.2s,
    transform 0.2s;
}

.dot.on {
  background: var(--honey);
  transform: scale(1.25);
}

.onb-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 22px 28px;
  border-top: 1px solid var(--hair);
}

.btn {
  font: 500 14px / 1 var(--font-ui);
  padding: 12px 22px;
  border-radius: 0;
  cursor: pointer;
  transition: all 0.18s;
}

.btn.primary {
  background: var(--honey);
  color: oklch(16% 0.02 50);
  border: 1px solid var(--honey);
}

.btn.primary:hover {
  background: var(--honey-2);
  border-color: var(--honey-2);
}

.btn.ghost {
  background: none;
  color: var(--muted);
  border: 1px solid var(--hair);
}

.btn.ghost:hover {
  color: var(--fg);
  border-color: var(--honey-2);
}

@media (prefers-reduced-motion: reduce) {
  .step {
    animation: none;
  }
  .dot {
    transition: none;
  }
}
</style>
