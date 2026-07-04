# EqualLoud 2.0

## 🇬🇧 English

A major upgrade focused on **professional loudness measurement**. EqualLoud now
not only balances loudness — it shows you exactly what's happening to the audio.

### New

- **True Peak metering (dBTP)** — Measures inter-sample peaks via BS.1770 §5.2
  4× oversampling, the same standard broadcast engineers use. Sample-peak meters
  miss the peaks that happen *between* digital samples; true-peak catches them.
- **Integrated loudness** — The whole-programme gated LUFS (the figure EBU R128
  delivery specifies), now surfaced in the Pro panel. The worklet always
  computed it; 1.0 just never showed it.
- **Loudness Range (LRA)** — EBU Tech 3342's measure of dynamic range, shown as
  both a number and a thermometer bar. Tells you whether content is dynamic
  (classical, cinema) or compressed (ads, loudness-war pop).
- **Loudness presets** — One tap to set a correct, industry-standard target:
  Streaming (−14, Spotify/YouTube), Podcast (−16, Apple Podcasts/AES), or
  Broadcast (−23, EBU R128). Each preset shows its cited source on hover.
- **Pro mode** — Toggle a loudness-analysis panel (dBTP / integrated / LRA).
  Off by default for a clean, minimal interface.

### Changed

- **Boost ceiling raised 12 → 24 dB** — Quiet content (ASMR, low-volume
  podcasts, old recordings) can now actually reach the target loudness. The
  true-peak Protection limiter (−1 dBTP) is the safety net.
- **Output Protection: always on** — The old 5-knob Limiter is gone. Protection
  runs silently at −1 dBTP (EBU R128 spec) in the background — no toggle, no
  knobs, because clipping protection should never be something you can turn off.
- **Tooltip overflow fixed** — InfoTip bubbles are now teleported to the page
  body and positioned with `position: fixed`, structurally eliminating the
  recurring "tooltip clipped by the popup border" bug.
- **"Analyzing" indicator** — Moved inline into the tab row (no extra height).
- **Auto language detection** — Follows the browser/system language
  automatically on install and whenever the OS language changes. Manual toggle
  still available but no longer required.

### Removed

- **Limiter panel** (5 sliders → silent background protection)
- **"Loud" preset** (−10 LUFS had no standard basis)

### Verification

- 246 unit tests + 38 LUFS accuracy (golden-reference) tests pass
- True peak verified against pure tones (+1.6 dBTP overshoot at Nyquist) and
  the +1/−1 worst-case signal
- LRA algorithm verified against EBU Tech 3342 v2.0 specification

---

## 🇨🇳 中文

一次聚焦**专业响度测量**的大版本升级。EqualLoud 现在不仅平衡响度——
还能让你清楚地看到音频到底发生了什么。

### 新增

- **真峰值测量（dBTP）** — 基于 BS.1770 §5.2 的 4× 过采样算法，测量采样
  点之间的真实峰值。普通峰值表会漏掉数字采样点之间的失真峰值，真峰值能
  抓住它们——这正是广播工程师使用的标准。
- **整体响度（Integrated LUFS）** — 整段节目的 gated LUFS（EBU R128 交付
  标准规定的那个数值），现在在专业面板中展示。worklet 一直在算，1.0 只是
  没显示出来。
- **动态范围（LRA）** — EBU Tech 3342 定义的动态范围指标，同时以数字和
  温度计条展示。告诉你内容是动态丰富（古典、电影）还是被压缩过（广告、
  响度战争后的流行乐）。
- **响度预设** — 一键设置正确的行业标准目标：流媒体（−14，Spotify/
  YouTube）、播客（−16，Apple Podcasts/AES）、广播（−23，EBU R128）。
  每个预设 hover 时显示依据来源。
- **专业模式** — 切换响度分析面板（真峰值 / 整体响度 / 动态范围）。默认
  关闭，保持界面简洁。

### 改进

- **提升上限从 12 提高到 24 dB** — 安静的内容（ASMR、低音量播客、老录音）
  现在能真正达到目标响度。真峰值保护限幅器（−1 dBTP）是安全网。
- **输出保护：永远开启** — 旧的 5 旋钮限幅器已移除。保护以 −1 dBTP
  （EBU R128 标准）在后台静默运行——没有开关、没有旋钮，因为削波保护
  不应该是你能关掉的东西。
- **修复提示气泡遮挡** — InfoTip 气泡现在 teleport 到页面 body 层并用
  `position: fixed` 定位，从结构上彻底解决了反复出现的"问号提示被弹窗
  边框裁切"的问题。
- **"分析中"标识** — 内联进标签行，不再额外占用纵向空间。
- **自动语言检测** — 安装时以及系统语言变更时，自动跟随浏览器/系统
  语言。手动切换仍可用，但不再必须。

### 移除

- **限幅器面板**（5 个滑块 → 后台静默保护）
- **"响亮"预设**（−10 LUFS 没有标准依据）

### 验证

- 246 个单元测试 + 38 个 LUFS 精度（黄金参考）测试全部通过
- 真峰值算法经纯音验证（Nyquist 频率处 +1.6 dBTP 过冲）和 +1/−1
  最坏情况信号验证
- LRA 算法经 EBU Tech 3342 v2.0 规范核对
