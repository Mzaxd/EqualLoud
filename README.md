# EqualLoud

<p align="center">
  <strong>🔊 Automatically balance loudness across every video/audio tab</strong>
</p>

<p align="center">
  Install and forget — no icon clicks, no setup. Open as many videos and podcasts
  as you like; EqualLoud keeps their loudness consistent.
</p>

<p align="center">
  For contributors and coding agents, see <a href="./AGENT.md"><strong>AGENT.md</strong></a>.
</p>

---

## ✨ Features

- **100% automatic** — content scripts inject into every page and take over
  `<video>`/`<audio>` the moment it appears. No clicking the extension icon,
  no user gesture, no `activeTab` needed.
- **Cross-tab balancing** — every playing tab converges to one target loudness
  (ITU-R BS.1770 LUFS, default −14 LUFS), so loud ads and quiet podcasts meet
  in the middle.
- **Boost *and* cut** — gain can go positive, so quiet content is lifted toward
  the target, not just loud content attenuated.
- **Survives restarts** — settings persist in `chrome.storage`; the service
  worker wakes up and re-balances from content-script heartbeats.
- **Smooth** — gain changes glide via `setTargetAtTime` (50 ms), no clicks.
- **Per-tab balance toggle** — A/B any tab against its unprocessed audio with one click; measurement keeps running so re-enabling snaps to the right gain.
- **Output limiter** — default-on at −1 dB so a loud boost never clips.

## 🎯 Usage

1. **Install** the extension (load unpacked — see below).
2. **Open tabs** with audio (YouTube, podcasts, music, anything with a
   `<video>`/`<audio>` element). They're taken over automatically.
3. That's it. Loudness evens out across tabs within a few seconds.

Click the extension icon to:

- Toggle balancing on/off.
- Drag the target-LUFS slider (left = quieter overall, right = louder).
- See the live gain applied to each tab (`+5.2 dB`, `−3.0 dB`, …).
- Toggle per-tab balance on/off to A/B the effect.
- Open Settings for the output limiter.

The toolbar badge shows how many tabs are being balanced.

## 📐 How it works (and why it's different from tabCapture balancers)

The audio you hear from a video site is a `<video>` DOM element. A content
script can intercept that element's audio route directly with the Web Audio API
and a `GainNode`:

```js
const ctx = new AudioContext()
const src = ctx.createMediaElementSource(video) // take over the element
const gain = ctx.createGain()
src.connect(gain).connect(ctx.destination)       // to the speakers
gain.gain.value = 0.7                            // any value, even > 1
```

This needs **no `tabCapture`, no `activeTab`, no offscreen document, no user
click** — `host_permissions` + auto-injected `content_scripts` are enough, so
EqualLoud is truly automatic. (Chrome's `tabCapture.getMediaStreamId` only works
on the *current* tab *after* a user gesture, which is a dead end for
"auto-balance everything.")

Per media element the content script builds:

```
mediaElement
   │ createMediaElementSource
   ▼
MediaElementSource ──► GainNode ──► DynamicsCompressor ──► destination
   │                   (balance)    (limiter)              (speaker)
   └──► AudioWorklet("lufs-processor") ──► destination (silence, measure only)
```

The worklet measures short-term LUFS at ~10 Hz and reports it to the service
worker. The service worker runs `computeBalanceGains(tabs, target)` and pushes
one gain decision per tab back via `chrome.tabs.sendMessage`. Tabs with balance
disabled receive unity gain (0 dB) — passthrough — while still reporting LUFS.

### LUFS measurement

ITU-R BS.1770-4: K-weighting (high-shelf + high-pass), 400 ms blocks with 75 %
overlap, absolute (−70 LUFS) and relative (−10 LU) gating. Short-term (3 s
window) is used for real-time balancing because it converges fast.

## ⚠️ Known limitations

- **DRM content** (Netflix HD, Disney+, etc.): Chrome forces
  `createMediaElementSource` output silent on EME-protected media — this is a
  browser-level anti-piracy measure and cannot be bypassed. EqualLoud detects
  the failure and degrades to plain `element.volume` control (attenuate only).
- **`<all_urls>` permission warning**: required so the content script can inject
  into every site. EqualLoud reads media audio levels locally and **uploads no
  data anywhere**.
- **Pages that synthesise audio** without a `<video>`/`<audio>` element (rare)
  are not covered.

## 🛠️ Tech stack

- **Vue 3** (Composition API) + **Pinia** for the popup
- **TypeScript** (strict)
- **Vite** + **@crxjs/vite-plugin** for MV3 packaging
- **Web Audio API** + **AudioWorklet** for measurement and gain
- **Vitest** + **@vue/test-utils** + jsdom for tests
- **vue-i18n** (English / 简体中文)

## 📦 Installation

### From source

```bash
git clone https://github.com/dsh0416/EqualLoud.git
cd EqualLoud
pnpm install
pnpm build
```

Then load in Chrome/Edge: `chrome://extensions/` → enable **Developer mode** →
**Load unpacked** → select the `dist/` folder.

### Development

```bash
pnpm dev          # Vite dev server with HMR for the popup
pnpm test:unit    # unit tests (Vitest)
pnpm lint         # ESLint --fix
pnpm type-check   # vue-tsc
pnpm build        # type-check + production build (dist/ + release/release.zip)
```

## 🔧 Permissions

| Permission | Purpose |
|---|---|
| `storage` | Persist target LUFS, enabled, limiter settings |
| `tabs` | Read tab titles/URLs; send messages to content scripts (`chrome.tabs.sendMessage`) |
| `scripting` | Reserved for dynamic injection edge cases |
| `alarms` | 1-minute fallback scan to rebuild state after the SW sleeps |
| `host_permissions: <all_urls>` | Auto-inject the content script into every site |

**Removed** vs. the old loudness_dd: `tabCapture`, `activeTab`, `offscreen` —
the content-script architecture does not need them.

## 🔬 Manual testing

Open `tools/loudness-test.html` (a deterministic pink-noise source with a gain
slider) in two tabs, set different gains, and watch the popup converge both to
the target LUFS. Full scenarios in PRD §11.3.

## 📄 License

MIT

## 👤 Author

[@dsh0416](https://github.com/dsh0416)

---

<p align="center">
  <em>Browse without reaching for the volume knob 🎧</em>
</p>
