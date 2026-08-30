# EqualLoud 2.1

## 🇬🇧 English

A refinement release focused on **making the loudness target trustworthy** —
a sane, enforced target range and a fix for mono content measurement.

### Changed

- **Target-LUFS slider narrowed to [−36, −6]** — The old [−60, 0] axis allowed
  nonsense targets: −60 demands a ~+54 dB boost the protection limiter would
  clamp into pumping mush, and 0 LUFS forces maximum compression. The popup
  meter and knob are retargeted to the practical axis, and the Options slider
  uses the same bounds.

### Added

- **Target range enforced end-to-end** — The bounds are a shared config
  constant checked in every layer: the service worker clamps incoming
  `SET_TARGET_LUFS` messages, and a settings migration clamps any stored
  target into range, dropping corrupt non-numeric values instead of passing
  them through. Existing stored targets migrate automatically.

### Fixed

- **Mono loudness over-read (2.0.1 regression)** — Mono media was up-mixed to
  identical stereo before measurement, biasing mono LUFS ~+3 dB high, so quiet
  mono podcasts/clips were under-boosted. Mono now stays native 1-channel;
  5.1 input still down-mixes to stereo correctly.
- **Re-attach on SPA pages** — Elements managed via the volume fallback
  (CORS-tainted or takeover-failed) stayed permanently claimed after teardown,
  so an SPA re-inserting the same node never got re-managed. Handles now
  un-claim on every dispose path.

### Verification

- Full release gate: type-check, lint, unit tests, and the LUFS accuracy
  (golden-reference) suite
- Target-range behavior covered by new unit tests across config, service
  worker, and storage migration

---

## 🇨🇳 中文

一次聚焦**让响度目标值得信赖**的打磨版本——收紧并全链路强制目标范围，
修复单声道内容的测量偏差。

### 改进

- **目标响度滑杆收窄到 [−36, −6]** — 旧的 [−60, 0] 轴允许明显不合理的
  目标：−60 需要约 +54 dB 的提升，会被保护限幅器压成忽大忽小的糊状声；
  0 LUFS 则意味着极限压缩。弹出面板的刻度盘和旋钮已重定向到实用区间，
  选项页滑杆同步使用相同边界。

### 新增

- **目标范围全链路强制** — 边界值是共享的配置常量，在每一层都被校验：
  Service Worker 对 `SET_TARGET_LUFS` 消息做钳制；设置迁移会把已存储的
  超范围目标值收敛进区间，并丢弃损坏的非数值而不是透传。现有已存储的
  目标会自动完成迁移。

### 修复

- **单声道响度偏高（2.0.1 回归）** — 单声道媒体在测量前被上混成相同的
  左右声道，导致单声道 LUFS 读数偏高约 +3 dB，安静的单声道播客/片段
  提升不足。现在单声道保持原生 1 声道；5.1 输入仍正确下混为立体声。
- **SPA 页面重新挂载** — 走音量回退路径管理的元素（CORS 污染或接管
  失败）在销毁后仍被永久占用，SPA 重新插入同一节点时再也无法被管理。
  现在每条销毁路径都会解除占用标记。

### 验证

- 完整发布门禁：类型检查、lint、单元测试、LUFS 精度（黄金参考）套件
- 目标范围行为在 config、Service Worker、存储迁移三层均有新增单元测试覆盖
