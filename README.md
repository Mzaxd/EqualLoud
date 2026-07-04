# EqualLoud

<p align="center">
  <img src="public/logo@128w.png" width="128" height="128" alt="EqualLoud icon" title="EqualLoud">
</p>

<p align="center">
  <strong>🔊 Automatically balance loudness across every video/audio tab</strong>
</p>

<p align="center">
  Install and forget — no icon clicks, no setup. Open as many videos and podcasts
  as you like; EqualLoud keeps their loudness consistent.
</p>

<p align="center">
  <sub>
    <a href="#-english">English</a>
    &nbsp;·&nbsp;
    <a href="#-中文">中文</a>
  </sub>
</p>

---

## 🇬🇧 English

Ever switch between a YouTube video, a podcast, and a music tab, and find
yourself reaching for the volume knob on every single switch? A loud ad blows
your ears off, then the podcast is whisper-quiet, then the music is too loud
again.

**EqualLoud fixes that.** Every audio/video tab you open is automatically
brought to the same target loudness, in the background, with zero interaction.
Just install it and browse.

### ✨ Features

- **100% automatic** — works the moment audio starts playing. No clicking, no
  setup, no per-site enable.
- **Cross-tab balancing** — every playing tab converges to one loudness target,
  so loud ads, quiet podcasts, and normal videos all sit at the same level.
- **Loudness presets** *(2.0)* — one-tap targets aligned with real delivery
  standards: Streaming (−14 LUFS, Spotify/Apple), Podcast (−16), Broadcast
  (−23, EBU R128), Loud (−10).
- **True-Peak protection** *(2.0)* — a single ceiling slider (default −1 dBTP,
  the EBU R128 spec) replaces the old 5-knob limiter. Prevents inter-sample
  clipping the way broadcast engineers actually measure it.
- **Pro mode** *(2.0)* — toggle a loudness-analysis panel showing true-peak
  (dBTP), integrated loudness, and loudness range (LRA) — the three figures on
  a professional loudness meter, now in your browser.
- **Boost *and* cut** — quiet content is lifted up toward the target, not just
  loud content pushed down. No more "I can't hear this podcast at all."
- **Survives restarts** — your settings are remembered; balancing resumes
  automatically after a browser restart.
- **Per-tab A/B toggle** — one click to hear any tab with vs. without balancing.

### 🎯 Usage

1. **Install** the extension (load unpacked — see [Installation](#-installation)).
2. **Open tabs** with audio — YouTube, podcasts, music, anything with a video or
   audio player. They're balanced automatically.
3. That's it. Loudness evens out across tabs within a few seconds.

Click the extension icon to:

- Toggle balancing on/off.
- Pick a **loudness preset** (Streaming / Podcast / Broadcast / Loud) or drag
  the target slider for a custom value.
- See the live gain applied to each tab (`+5.2 dB`, `−3.0 dB`, …).
- Toggle per-tab balance on/off to A/B the effect.
- Turn on **Pro mode** to see true-peak, integrated loudness, and dynamic range.
- Adjust the **true-peak ceiling** under Output Protection.

The toolbar icon is clean while balancing is on. Turn it off and a gray `OFF`
badge appears so it's obvious nothing is being balanced.

### ⚠️ Known limitations

- **DRM content** (Netflix HD, Disney+, etc.): Chrome forces protected media
  silent when an extension takes over the audio. EqualLoud detects this and
  falls back to a simpler volume-only control (attenuate, no boost).
- **`<all_urls>` permission**: required so balancing works on every site
  automatically. EqualLoud processes audio locally and **uploads no data
  anywhere**.
- **Pages that synthesise audio** without a media element (rare) aren't covered.

### 📦 Installation

#### From a Release (easiest)

1. Go to the [Releases page](https://github.com/mzaxd/EqualLoud/releases).
2. Download **`release.zip`** from the latest release and unzip it.
3. Open `chrome://extensions/` → enable **Developer mode** →
   **Load unpacked** → select the unzipped `dist/` folder.

Requires Chrome / Edge 120+.

#### From source

```bash
git clone https://github.com/mzaxd/EqualLoud.git
cd EqualLoud
pnpm install
pnpm build
```

Then load in Chrome/Edge: `chrome://extensions/` → enable **Developer mode** →
**Load unpacked** → select the `dist/` folder.

#### Development

```bash
pnpm dev          # dev server with HMR for the popup
pnpm test:all     # unit tests + algorithm evaluation suite
pnpm test:e2e     # end-to-end tests (Playwright)
pnpm lint         # ESLint --fix
pnpm build        # type-check + production build (dist/ + release/release.zip)
```

---

## 🇨🇳 中文

在 YouTube、播客、音乐标签之间来回切,每次都要调音量?广告响得震耳朵,播客又轻得听不见,音乐又太吵。

**EqualLoud 解决这个问题。** 你打开的每一个音视频标签,都会自动被拉到同一个目标响度,全程后台,零操作。装上就行,正常浏览。

### ✨ 功能

- **全自动** —— 音频一播放就开始工作。不用点图标、不用设置、不用每个网站单独开启。
- **跨标签均衡** —— 每个正在播放的标签都收敛到同一个响度目标,吵的广告、轻的播客、正常音量的视频,都拉到同一水平。
- **响度预设** *(2.0)* —— 一键切换目标,对标真实交付标准:流媒体(−14 LUFS,Spotify/Apple)、播客(−16)、广播(−23,EBU R128)、响亮(−10)。
- **真峰值保护** *(2.0)* —— 用一个上限滑块(默认 −1 dBTP,EBU R128 标准)替代旧的 5 旋钮限幅器。按广播工程师真正的方式防止采样点之间的隐性削波。
- **专业模式** *(2.0)* —— 打开响度分析面板,显示真峰值(dBTP)、整体响度、动态范围(LRA)——专业响度表上的三个核心读数,现在就在浏览器里。
- **既能放大也能衰减** —— 安静的内容被提升到目标响度,而不只是把吵的压低。再也不用"这个播客根本听不清"。
- **重启不丢设置** —— 设置会被记住;重启浏览器后自动恢复均衡。
- **单标签 A/B 开关** —— 一键对比某个标签处理前后的效果。

### 🎯 用法

1. **安装** 扩展(load unpacked,见[安装](#-安装))。
2. **打开** 有音频的标签 —— YouTube、播客、音乐,任何带视频或音频播放器的页面,自动均衡。
3. 没了。几秒内各标签响度自动拉平。

点扩展图标可以:

- 开启/关闭均衡。
- 选一个**响度预设**(流媒体 / 播客 / 广播 / 响亮),或拖动滑块自定义。
- 看每个标签实时应用的增益(`+5.2 dB`、`−3.0 dB` …)。
- 单标签开关,A/B 对比效果。
- 打开**专业模式**,查看真峰值、整体响度、动态范围。
- 在「输出保护」里调整**真峰值上限**。
- 打开设置调整输出限幅器。

工具栏图标在开启状态下保持干净;只有你手动关闭均衡时,才会出现一个灰色 `OFF` 标记,提醒你当前没有在均衡。

### ⚠️ 已知限制

- **DRM 内容**(Netflix HD、Disney+ 等):Chrome 会对受保护的媒体强制静音,阻止扩展接管音频。EqualLoud 会检测到这一点,降级为简单的音量控制(只能衰减,不能放大)。
- **`<all_urls>` 权限**:必须的,这样均衡才能在每个网站自动生效。EqualLoud 只在本地处理音频,**不上传任何数据**。
- **自己合成音频**(没有媒体元素)的页面(罕见)不支持。

### 📦 安装

#### 从 Release 下载(最简单)

1. 打开 [Releases 页面](https://github.com/mzaxd/EqualLoud/releases)。
2. 下载最新 Release 里的 **`release.zip`**,解压。
3. 打开 `chrome://extensions/` → 开启**开发者模式** → **加载已解压的扩展程序** → 选解压出来的 `dist/` 文件夹。

需要 Chrome / Edge 120+。

#### 从源码

```bash
git clone https://github.com/mzaxd/EqualLoud.git
cd EqualLoud
pnpm install
pnpm build
```

然后在 Chrome/Edge 里:`chrome://extensions/` → 开启**开发者模式** → **加载已解压的扩展程序** → 选 `dist/` 文件夹。

#### 开发

```bash
pnpm dev          # 开发服务器(popup HMR)
pnpm test:all     # 单元测试 + 算法评估套件
pnpm test:e2e     # 端到端测试(Playwright)
pnpm lint         # ESLint --fix
pnpm build        # 类型检查 + 生产构建(dist/ + release/release.zip)
```

---

## 📄 License

MIT

## 👤 Author

[@mzaxd](https://github.com/mzaxd)

---

<p align="center">
  <em>Browse without reaching for the volume knob 🎧 / 不用再手忙脚乱调音量了 🎧</em>
</p>
