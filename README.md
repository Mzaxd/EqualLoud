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
- **Boost *and* cut** — quiet content is lifted up toward the target, not just
  loud content pushed down. No more "I can't hear this podcast at all."
- **Survives restarts** — your settings are remembered; balancing resumes
  automatically after a browser restart.
- **Per-tab A/B toggle** — one click to hear any tab with vs. without balancing.
- **Output limiter** — on by default, so a loud boost never distorts or clips.

### 🎯 Usage

1. **Install** the extension (load unpacked — see [Installation](#-installation)).
2. **Open tabs** with audio — YouTube, podcasts, music, anything with a video or
   audio player. They're balanced automatically.
3. That's it. Loudness evens out across tabs within a few seconds.

Click the extension icon to:

- Toggle balancing on/off.
- Drag the target-loudness slider (left = quieter overall, right = louder).
- See the live gain applied to each tab (`+5.2 dB`, `−3.0 dB`, …).
- Toggle per-tab balance on/off to A/B the effect.
- Open Settings for the output limiter.

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
pnpm test         # unit tests + algorithm evaluation suite
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
- **既能放大也能衰减** —— 安静的内容被提升到目标响度,而不只是把吵的压低。再也不用"这个播客根本听不清"。
- **重启不丢设置** —— 设置会被记住;重启浏览器后自动恢复均衡。
- **单标签 A/B 开关** —— 一键对比某个标签处理前后的效果。
- **输出限幅器** —— 默认开启,防止提升后削波失真。

### 🎯 用法

1. **安装** 扩展(load unpacked,见[安装](#-安装))。
2. **打开** 有音频的标签 —— YouTube、播客、音乐,任何带视频或音频播放器的页面,自动均衡。
3. 没了。几秒内各标签响度自动拉平。

点扩展图标可以:

- 开启/关闭均衡。
- 拖动目标响度滑块(左=整体更轻,右=更响)。
- 看每个标签实时应用的增益(`+5.2 dB`、`−3.0 dB` …)。
- 单标签开关,A/B 对比效果。
- 打开设置调整输出限幅器。

工具栏图标在开启状态下保持干净;只有你手动关闭均衡时,才会出现一个灰色 `OFF` 标记,提醒你当前没有在均衡。

### ⚠️ 已知限制

- **DRM 内容**(Netflix HD、Disney+ 等):Chrome 会对受保护的媒体强制静音,阻止扩展接管音频。EqualLoud 会检测到这一点,降级为简单的音量控制(只能衰减,不能放大)。
- **`<all_urls>` 权限**:必须的,这样均衡才能在每个网站自动生效。EqualLoud 只在本地处理音频,**不上传任何数据**。
- **自己合成音频**(没有媒体元素)的页面(罕见)不支持。

### 📦 安装

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
pnpm test         # 单元测试 + 算法评估套件
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
