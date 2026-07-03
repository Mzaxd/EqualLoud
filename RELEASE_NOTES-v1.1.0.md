# EqualLoud v1.1.0

<p align="center">
  <img src="public/logo@128w.png" width="120" height="120" alt="EqualLoud">
</p>

**🔊 Automatically balance loudness across every video/audio tab — install and forget.**

Open as many YouTube videos, podcasts, and music tabs as you like; EqualLoud
keeps their loudness consistent. No clicking, no per-site setup — it just
works in the background.

---

## 📦 Download & Install

### Option A — Load the unpacked build (recommended)

1. Download **`release.zip`** from the assets below.
2. Unzip it — you get a `dist/` folder.
3. Open `chrome://extensions/` in Chrome or Edge.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** → select the `dist/` folder.
6. Done. Open any video/podcast tab and the loudness evens out within seconds.

> Requires **Chrome / Edge 120+**.

### Option B — Build from source

```bash
git clone https://github.com/mzaxd/EqualLoud.git
cd EqualLoud
pnpm install
pnpm build      # produces dist/ and release/release.zip
```

Then load `dist/` as an unpacked extension (same as step 3–5 above).

---

## ✨ What it does

- **100% automatic** — the moment audio starts playing in any tab, EqualLoud
  takes over. No icon clicks, no setup.
- **Cross-tab balancing** — every playing tab converges to one loudness target
  (default −14 LUFS). Loud ads, quiet podcasts, and normal videos all sit at
  the same level.
- **Boost *and* cut** — quiet content is lifted up toward the target, not just
  loud content pushed down. No more "I can't hear this podcast."
- **Accurate loudness measurement** — ITU-R BS.1770-4 K-weighted loudness via
  an AudioWorklet, with sample-rate-aware filter coefficients (correct on both
  44.1 kHz and 48 kHz contexts).
- **Survives restarts** — settings are remembered; balancing resumes after a
  browser restart.
- **Per-tab A/B toggle** — one click to hear any tab with vs. without
  balancing.
- **Output limiter** — on by default, so a loud boost never distorts or clips.
- **100% on-device** — audio is processed locally. No data is collected,
  uploaded, or tracked. See [`PRIVACY.md`](PRIVACY.md).

### Click the toolbar icon to

- Toggle balancing on/off.
- Drag the target-loudness slider (left = quieter overall, right = louder).
- See the live gain applied to each tab (`+5.2 dB`, `−3.0 dB`, …).
- Toggle per-tab balance to A/B the effect.
- Open **Settings** for the output limiter.

---

## 🔧 What's in this release (since 1.0.0)

- **Sample-rate-aware K-weighting** — the ITU-R BS.1770 filter coefficients are
  now designed for the runtime `AudioContext.sampleRate` via bilinear-transform
  pre-warping, instead of fixed 48 kHz constants. Corrects a 0.3–0.7 LU drift
  on 44.1 kHz contexts (the macOS default). At 48 kHz the output is numerically
  identical to before.
- **Popup long-lived Port** — the popup now streams state from the service
  worker over `chrome.runtime.connect` instead of polling, so the live gain
  readout is smoother and the SW isn't woken by poll traffic.
- **Storage schema versioning** — settings and limiter records now carry a
  `__v` tag and run through an idempotent migration chain on load.
- **AudioContext lifecycle backstop** — the shared context is closed when the
  extension is invalidated and all media elements have detached, preventing
  leaks across extension reloads.
- **Favicon privacy** — tab favicons are served from Chrome's local
  `_favicon/` cache. Zero network egress.
- **Mono-source fix** — mono audio is no longer duplicated into both channels
  before K-weighting, fixing a +3 dB bias on podcasts and single-channel clips.

See [`CHANGELOG.md`](CHANGELOG.md) for the full list.

---

## ⚠️ Known limitations

- **DRM content** (Netflix HD, Disney+, etc.): Chrome forces protected media
  silent when an extension takes over the audio. EqualLoud detects this and
  falls back to a simpler volume-only control (attenuate, no boost).
- **`<all_urls>` permission**: required so balancing works on every site
  automatically. EqualLoud processes audio locally and uploads no data.
- **Pages that synthesise audio** without a media element (rare) aren't covered.

---

## 📄 License

MIT — see [`LICENSE`](LICENSE).

---

## 🇨🇳 中文简介

**EqualLoud** 会自动把你打开的每一个音视频标签拉到同一个目标响度,全程后台运行,零操作。

**安装:** 下载下面的 `release.zip` → 解压 → 在 `chrome://extensions/` 开启开发者模式 → "加载已解压的扩展程序" → 选择解压出来的 `dist/` 文件夹。(需要 Chrome / Edge 120+)

功能亮点:跨标签自动均衡、既能放大也能衰减、基于 ITU-R BS.1770-4 的 K 加权响度测量(适配 44.1/48 kHz)、重启不丢设置、单标签 A/B 对比、输出限幅器、100% 本地处理不上传任何数据。
