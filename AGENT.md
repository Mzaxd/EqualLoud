# AGENT.md — EqualLoud

Audience: coding agents (Cursor/Copilot) and maintainers. A high-signal,
task-oriented guide to modify, test, and ship EqualLoud safely. Read the
[PRD](./PRD.md) for the full design rationale; this file is the working manual.

## TL;DR commands

- Install: `pnpm install`
- Dev (HMR for popup): `pnpm dev`
- Build (type-check + bundle): `pnpm build`
- Unit tests: `pnpm test:unit`
- Lint / format / type-check: `pnpm lint`, `pnpm format`, `pnpm type-check`

Node engines: `^20.19.0 || >=22.12.0`.

## What this project does

EqualLoud is a Chrome MV3 extension that **automatically balances the loudness
of every video/audio tab toward one target LUFS (default −14)**, with no user
interaction. It injects content scripts that take over each page's
`<video>`/`<audio>` via `createMediaElementSource` + `GainNode` — no
`tabCapture`, no `activeTab`, no offscreen document.

## Key architecture

```
Popup (Vue 3 + Pinia)
    │ chrome.runtime.sendMessage (GET_STATE, SET_*, TOGGLE_*)
    ▼
Service Worker (coordinator)
    │  - aggregates per-tab LUFS heartbeats
    │  - runs computeBalanceGains (pure, in @/audio/balance)
    │  - pushes SET_GAIN via chrome.tabs.sendMessage
    │  - persists settings to chrome.storage.local
    ▼
Content Scripts (one per page)
    │  - MutationObserver finds <video>/<audio>
    │  - buildMediaElementSource + GainNode + limiter + LUFS worklet
    │  - reports LUFS_REPORT ~10 Hz
    ▲ chrome.tabs.sendMessage (SET_GAIN, SET_LIMITER, PING)
```

Key files:

- [src/background.ts](src/background.ts) — the SW coordinator. Single
  `handleMessage` router, exported for tests. `resetState()` / `seedTab()` are
  test helpers.
- [src/content/index.ts](src/content/index.ts) — content-script entry.
  Early-exits if no media; otherwise wires `MediaManager` + LUFS reporting +
  SW-directive handling + SPA navigation + autoplay resume.
- [src/content/media-manager.ts](src/content/media-manager.ts) — DOM watching.
  Exports the **pure** `pickPrimaryMedia()` and `shouldAttach()` for unit tests.
- [src/content/audio-graph.ts](src/content/audio-graph.ts) — per-element audio
  graph (source → gain → limiter → destination, parallel LUFS worklet). Falls
  back to `element.volume` if `createMediaElementSource` throws.
- [src/content/messenger.ts](src/content/messenger.ts) — thin wrappers around
  `chrome.runtime.sendMessage` / `onMessage`.
- [src/messages/protocol.ts](src/messages/protocol.ts) — **the contract**. Every
  message type and payload lives here; both sides import it.
- [src/audio/config.ts](src/audio/config.ts) — every tunable knob
  (defaults, limits, smoothing, report rate). PRD §9.
- [src/audio/lufs.ts](src/audio/lufs.ts), [src/worklets/lufs-processor.ts](src/worklets/lufs-processor.ts),
  [src/audio/balance.ts](src/audio/balance.ts) — the ITU-R BS.1770-4 loudness
  measurement + balance-decision core (pure functions, no DOM/Chrome deps).
- [src/stores/tabs.ts](src/stores/tabs.ts), [src/stores/settings.ts](src/stores/settings.ts) —
  popup Pinia stores. `tabs` polls the SW via `GET_STATE`.
- [src/components/](src/components/) — `AutoBalance.vue`, `TabList.vue`
  (per-tab balance toggle), `Limiter.vue`.
- [manifest.config.ts](manifest.config.ts) — MV3: `storage`, `tabs`,
  `scripting`, `alarms`, `host_permissions: <all_urls>`, `content_scripts`
  on `<all_urls>` at `document_idle`. **No** `tabCapture`/`activeTab`/`offscreen`.

## Message contract (PRD §6.4)

Content → SW (notifications):

- `MEDIA_ATTACHED` { tabId, title, url } — *tabId is -1 from the content
  script; the SW overwrites it with `sender.tab.id`.*
- `LUFS_REPORT` { tabId, shortTerm, blockCount } — ~10 Hz heartbeat.
- `TAB_UNLOAD` { tabId }

SW → Content (via `chrome.tabs.sendMessage`):

- `SET_GAIN` { tabId, gainDb } — *also drives per-tab bypass: the SW sends 0 dB
  for bypassed tabs, so the content layer never needs to know about bypass.*
- `SET_CONFIG` { target, enabled }
- `SET_LIMITER` { settings }
- `PING` (liveness probe / state rebuild)

Popup → SW (request/response):

- `GET_STATE` → { tabs, settings, limiter }
- `SET_TARGET_LUFS` { targetLufs } → { settings }
- `SET_ENABLED` { enabled } → { settings }
- `TOGGLE_BALANCE` { tabId } → { tabs } — *flips a tab's `balanceEnabled`;
  bypassed tabs get unity gain (0 dB) but keep reporting LUFS so re-enabling is
  instant.*
- `SET_LIMITER_SETTINGS` { settings } → { limiter }

## Build, run, and release

- `pnpm dev` — Vite dev server for the popup (HMR); content scripts + SW reload
  via CRXJS.
- `pnpm build` — `vue-tsc --build` then Vite. Unpacked extension in `dist/`;
  `release/release.zip` produced automatically.
- Load in Chrome: `chrome://extensions/` → Developer mode → Load unpacked →
  `dist/`.

## Coding conventions

- TypeScript-first, strict. No `any`; all message payloads typed in
  [src/messages/protocol.ts](src/messages/protocol.ts).
- Pure, side-effect-free logic (balance, LUFS, `pickPrimaryMedia`,
  `shouldAttach`) is extracted so it can be unit-tested without Chrome/DOM.
  Keep it that way.
- Vue 3 Composition API + Pinia. Light theme: `#f7f8fa` bg, white cards,
  `#48bb78` accent.
- Run `pnpm type-check`, `pnpm lint`, `pnpm test:unit` before shipping.

## Safe-edit checklist

1. **Adding/rename a message type:** update
   [src/messages/protocol.ts](src/messages/protocol.ts) **first**, then the SW
   router and every sender/receiver. A drift here is the most common bug.
2. **Tab id:** content scripts can't read their own tab id — always key on
   `sender.tab.id` in the SW, never trust the payload's `tabId`.
3. **Manifest:** do not add permissions without documented rationale. The whole
   point is "no `tabCapture`/`activeTab`".
4. **Audio:** keep limiter defaults conservative; clamp user ranges; benchmark
   CPU if you add per-element nodes.
5. **Lifecycle:** preserve `TAB_UNLOAD`, `onRemoved`, and the alarm scan so
   stale tabs are pruned; keep `updateBadge()` in sync — it shows `OFF` only
   when balancing is disabled (clean icon otherwise).
6. **Storage:** persist only `settings` + `limiter`. Never persist per-tab
   runtime state — it's rebuilt from content-script heartbeats.
7. **SW wake-up:** every handler awaits `settingsLoaded` so a freshly-woken SW
   answers with the user's real settings, not defaults. Don't bypass it.

## Tests

- Unit (`vitest` + `@vue/test-utils`, jsdom): `pnpm test:unit`, in
  [src/__tests__/](src/__tests__).
  - `balance.spec.ts`, `lufs-calculator.spec.ts`, `lufs-processor.spec.ts` —
    cover the pure algorithm core (K-weighting, gating, clamp/skip/solo).
  - `media-manager.spec.ts` — `pickPrimaryMedia` / `shouldAttach`.
  - `background.spec.ts` — the SW router end-to-end (LUFS_REPORT → SET_GAIN,
    persistence, per-tab balance bypass, disable, unload).
  - `stores/tabs.spec.ts`, `i18n.spec.ts`, component specs.

Merge gates: green type-check + lint + unit tests. For message-contract changes
add/adjust a handler test.

## Troubleshooting

- **A tab isn't balanced:** check the SW console for `MEDIA_ATTACHED`; if the
  page already called `createMediaElementSource`, EqualLoud degrades to
  `element.volume` (attenuate only) — expected for some visualizer sites and
  DRM content.
- **DRM content (Netflix HD):** Chrome silences `createMediaElementSource`
  output on EME media. This is a browser limitation; document it, don't try to
  bypass it.
- **No LUFS readings:** the AudioWorklet may have failed to load (CSP). Check
  the page console; playback still works, balancing is just skipped.
- **Popup shows stale state:** the popup polls `GET_STATE` every 100 ms; make
  sure `startPolling()` is called on mount (it is, in `App.vue`).

## Definition of Done (agent)

- `pnpm type-check` → `pnpm lint` → `pnpm test:unit` → `pnpm build` all green.
- Message contracts consistent (types + handlers + callers).
- No permission creep; manifest unchanged unless justified.
- `release/release.zip` builds; `dist/` loads in Chrome.
