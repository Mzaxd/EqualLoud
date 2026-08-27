# EqualLoud — 启动增益过冲（"开头炸一下"）修复设计

> 日期：2026-08-27
> 主题：消除视频冷启动 / 换片瞬间增益冲顶导致的失真（用户可感知的"糊+炸"）
> 状态：已确认方向（A+B 组合），作为 writing-plans 的输入
>
> 本 spec 不重复 PRD.md 与 content-script spec 已定的架构内容，只补充本次修复必需的精确细节。

---

## 0. 问题定义与决策结论

### 0.1 现象

安静视频需要提升音量时，开头零点几秒会以远超真实需求的增益播放（用户实例："应该加 8 dB 却直接冲到 20 多 dB"），声音发糊发炸，约 0.3–1 s 后回落到正确值。

### 0.2 成因链（已代码定位）

1. 新视频 / Reels 换片触发 `resetLufs()`（`media-manager.ts`），测量管线清零——这是防旧内容污染的正确行为，不动。
2. worklet 的早块机制只积累 ~200 ms 样本即发出第一个块（`lufs-processor.ts` 的 `earlyBlockThreshold` = 半个 400 ms 窗），且 `MIN_BLOCKS_FOR_RELIABLE_LUFS = 1` 使首个决策立即生效——这是离线调参器为缩短启动延迟做的**有意取舍，不撤销**。
3. 视频开头的淡入/前奏/开口前弱音比全片平均响度低 10–20 LU，首块 shortTerm 读数严重偏低。
4. SW 决策 `gain = target − shortTerm` 得到虚高值，撞上 `DEFAULT_MAX_GAIN_DB = 24` 上限。
5. 应用端时间常数仅 50 ms，错误值近瞬时生效；提满后的信号疯狂触发 −1 dBTP 保护限幅器 → 压缩抽吸感（糊）+ 声压突跳（炸）。
6. 数百 ms 后窗口填入真实内容，shortTerm 回升，增益快速回落。

结论：过冲是"快速起测"取舍的副作用，但可用决策端 + 应用端双重手段消除，无需放弃启动速度。

### 0.3 开放决策结论

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| 1 | 修复位置 | **应用端斜坡限速（A）+ 决策端暖机上限（B）双层组合** | A 是普适保险丝（覆盖冷启动、换片、广告、任何未来坏测量）；B 让决策值诚实，顺带修 popup 徽标闪 "+24" |
| 2 | B 的形式 | **单级上限**（一个 capDb + 一个解除块数），不做多级阶梯 | 单级足以覆盖常见 ~10 LU 早读偏差；多级复杂度无对应收益；数值交调参器定稿 |
| 3 | 下降方向 | **完全不限速**（维持现有 GAIN_ATTACK_TC 快攻） | 衰减永远安全，是产品最痛路径，不许变慢 |
| 4 | MIN_BLOCKS | 保持 1 | 启动延迟优势保留；慢上升由 A 兜底 |
| 5 | 协议/UI | 零改动 | 全部变化在 balance.ts 内部逻辑与新增 content-script 模块 |

---

## 1. 方案 A：增益上行斜坡限速（GainSlew）

### 1.1 新模块 `src/audio/gain-slew.ts`

```ts
export interface GainSlewOptions {
  maxRiseDbPerSec: number   // 上行速率上限
  maxStepMs?: number        // 单次调用允许的最大间隔（防后台挂起后大步进），默认 500
}

export class GainSlew {
  /** 当前实际生效的目标增益（dB）。初始 0，与 GainNode 出厂值一致。 */
  private currentDb = 0
  private lastMs: number | null = null

  next(targetDb: number, nowMs: number): number {
    const dtMs =
      this.lastMs === null ? 0 : Math.min(nowMs - this.lastMs, maxStepMs)
    if (targetDb <= this.currentDb) {
      this.currentDb = targetDb          // 下降：瞬时放行
    } else {
      this.currentDb = Math.min(targetDb, this.currentDb + maxRiseDbPerSec * (dtMs / 1000))
    }
    this.lastMs = nowMs
    return this.currentDb
  }
}
```

要点：

- 纯决策域运算，用主线程 `performance.now()` 时钟，与 AudioContext 时钟无关。
- 首次调用（`lastMs === null`）dt 按 0 处理：目标高于 0 时该拍先不出力，从下一拍起按速率爬升。
- 不持久化、不跨链共享：每条 Web Audio 链一个实例，dispose 即弃。upgrade 路径新建的链天然从 0 dB 开始，与 GainNode 实际初始值一致。

### 1.2 接入点 `audio-graph.ts` `buildWebAudioHandle().setGain`

```ts
const slewed = slew.next(gainDb, performance.now())
const tc = slewed < currentGainDb ? GAIN_ATTACK_TC : GAIN_SMOOTH_TC
gain.gain.setTargetAtTime(dbToGain(slewed), ctx.currentTime, tc)
currentGainDb = slewed
```

- 方向判断与 TC 选择逻辑不变，只是输入从原始 decision 变为 slew 后的值。
- volume fallback 路径不加（只能衰减，不存在上行风险）。
- 时钟失效场景（标签页长时间不可见）：SW 心停，恢复后 dt 被 `maxStepMs` 封顶，不会一步跨一大段。

### 1.3 新配置常量 `src/audio/config.ts`

```ts
/** 增益上行速率上限。+6 dB 约 0.3 s 渐强到位；错误决策在修正到来前实际峰值 ≈ 速率×时长。 */
export const GAIN_RISE_RATE_DB_PER_S = 20
```

初值 20 dB/s；最终值经 §3 调参流程确认后写回。

### 1.4 行为量化（验收参照）

- 正确需求 +8 dB：0 → +8 约 0.4 s 平滑渐强，感知为 swell 而非功能延迟。
- 错误决策 +24 → 300 ms 后修正为 +8：实际峰值 ≈ min(20×0.3, …) = +6 dB，永不触顶。

---

## 2. 方案 B：决策端暖机上限

### 2.1 改动点 `src/audio/balance.ts` `computeBalanceGains()`

`BalanceParams` 增加两个可选字段（供调参器注入；生产走 config 常量默认）：

```ts
interface BalanceParams {
  minBlocks: number
  minGainDb: number
  warmupBoostCapDb?: number      // blockCount 未达解除阈值时正增益的临时上限；undefined = 关闭
  warmupFullTrustBlocks?: number // 解除阈值；配合上一字段使用
}
```

判定逻辑（仅作用于正增益，负增益豁免）：

```ts
const clamped = Math.max(params.minGainDb, Math.min(tab.maxGainDb, raw))
if (clamped > 0 && params.warmupBoostCapDb !== undefined) {
  const warmCap = Math.min(params.warmupBoostCapDb, tab.maxGainDb)
  if (tab.blockCount < params.warmupFullTrustBlocks!) decisions.push({ tabId, gainDb: Math.min(clamped, warmCap) })
  else decisions.push({ tabId, gainDb: clamped })
}
```

### 2.2 生产常量 `src/audio/config.ts`

```ts
export const WARMUP_BOOST_CAP_DB = 10     // 常见早读偏低幅度 ~10 LU，卡住这一档即可
export const WARMUP_FULL_TRUST_BLOCKS = 4 // ~0.6 s（0.2 s 首块 + 4×0.1 s hop）后放开
```

两值为候选，最终由调参器在 [+6,+15] × [3,8] 网格选定。

### 2.3 附带收益

`appliedGainDb` 记录的是决策目标值；B 生效后虚高的过渡值不再写入，popup 徽标不会再短暂闪 "+24"。appliedGainDb 继续记录决策值而非 slew 瞬时值（slew 属瞬态过程，popup 语义应为稳态目标）。

---

## 3. 参数标定（复用 eval/tune.ts 体系）

1. `eval/simulate.ts` `BalanceSimParams` 增加 `riseRateDbPerSec`、`warmupBoostCapDb`、`warmupFullTrustBlocks` 三轴；仿真器实现与生产一致的 slew + cap 语义。
2. `eval/cost.ts` 增加 overshoot 分量：Σ max(appliedGain_t − finalCorrectGain, 0)·Δt（LU·s 过冲面积）加入 balance 代价项。
3. `eval/signals.ts` 新增 soft-intro 场景：前 600 ms 低 18 dB 淡入后进入正文（用现有构造件拼装）。
4. 跑 `pnpm run tune` 输出 before/after 报告（过冲面积 vs 收敛时长的权衡曲线），据此定稿三个常数。

---

## 4. 测试计划

| 层 | 文件 | 断言 |
|----|------|------|
| 单测 | 新增 `src/__tests__/gain-slew.spec.ts` | 上行限速单调性（每秒 ≤ rate）；下降瞬时放行；超过 maxStepMs 的大间隔被封顶；每拍连续调用收敛到 target；实例间状态隔离 |
| 单测 | `balance.spec.ts` 增补 | blockCount=1 且 shortTerm 很低 → 正增益被 cap 到 WARMUP_BOOST_CAP_DB；blockCount ≥ 解除阈值 → 回到 maxGainDb；负增益不受 cap；参数缺省（undefined）时行为与现状逐位一致 |
| 单测 | `audio-graph.spec.ts` 增补 | setGain 序列下实际调用 setTargetAtTime 的值为 slew 后序列（mock performance.now） |
| eval | scenarios/convergence/stability 相应回归 | soft-intro 场景 overshoot 指标相对基线下降 ≥ 一个数量级或降为 0 |
| 手工 | 三场景听感验收 | YouTube 冷启动安静视频；Reels 连续滑片；真需 +20 dB 的 ASMR 内容（确认增强变柔和而非消失） |

---

## 5. 风险与既知取舍

- **增强生效稍慢**：真正需要大幅提升的内容到达目标会晚零点几秒（+10 dB ≈ 半秒渐强）。这是有意的平滑化，验收标准是"听起来像自动渐强，而不是反应迟钝"。
- **SW 休眠恢复不受影响**：`appliedGainDb` seed 属于 SW 记忆；音频链重建后仍从 0 dB 起（现状即如此），A 只约束上升趋势的速度。
- **不撤销既有取舍**：MIN_BLOCKS=1、200 ms 早块、"不可信样本回 0 dB"全部保持原样，回 0 dB 的下行本就不受限速影响。
- **风险回退路径**：两个机制独立成层，任一常量可单独置为"关闭"（rate 设很大 / cap 设 undefined）作紧急回退。
