# 启动增益过冲修复（GainSlew + 暖机上限）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除视频冷启动 / 换片瞬间增益冲顶导致的"糊+炸"失真——应用端上行斜坡限速 + SW 决策端暖机上限双层修复。

**Architecture:** 新增纯类 `GainSlew` 挂在 content script 的 `setGain` 入口（下降瞬时、上升限速）；`computeBalanceGains()` 在 `blockCount` 不足时给正增益加临时上限。两者均可在离线仿真器中建模并调参。

**Tech Stack:** TypeScript / Vitest / Chrome Extension MV3；离线评估体系在 `eval/`（simulate、cost、metrics、scenarios、tune）。

**Spec:** `docs/superpowers/specs/2026-08-27-startup-gain-overshoot-design.md`

## Global Constraints

- 项目测试规则：**只测纯函数**（见 `src/__tests__/audio-graph.spec.ts` 头注释）。Web Audio 绑定代码不加 jsdom mock 单测，靠 eval + 人工验收。
- 不撤销既有取舍：`MIN_BLOCKS_FOR_RELIABLE_LUFS = 1`、200 ms 早块、"不可信样本回 0 dB" 全部保持。
- 协议/UI 零改动：不改 `messages/protocol.ts`，不改任何 chrome message。
- 常量初值：`GAIN_RISE_RATE_DB_PER_S = 20`、`WARMUP_BOOST_CAP_DB = 10`、`WARMUP_FULL_TRUST_BLOCKS = 4`；最终值以 Task 6 调参报告为准采纳（采纳规则见该任务）。
- 依赖约束：`balance.ts` **不得** import `@/audio/config`（config 已 re-export balance 的符号，反向 import 会构成模块环并有 TDZ 风险）→ 暖机常量放 `balance.ts` 内（对 spec §2.2 的有意偏离，理由即此）。
- 每个任务结束跑相关测试并提交；全程 TDD。

---

### Task 1: GainSlew 纯模块

**Files:**
- Create: `src/audio/gain-slew.ts`
- Test: `src/__tests__/gain-slew.spec.ts`

**Interfaces:**
- Consumes: 无（零依赖纯类）
- Produces: `class GainSlew { constructor(opts: GainSlewOptions); next(targetDb: number, nowMs: number): number }`；`interface GainSlewOptions { maxRiseDbPerSec: number; maxStepMs?: number }`。Task 2 在 `audio-graph.ts` 里消费。

- [ ] **Step 1: 写失败测试**

```ts
// src/__tests__/gain-slew.spec.ts
import { describe, it, expect } from 'vitest'

import { GainSlew } from '@/audio/gain-slew'

describe('GainSlew', () => {
  it('holds at the current level on the first call (no dt yet)', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    expect(slew.next(24, 1000)).toBe(0)
  })

  it('limits rise to maxRiseDbPerSec across consecutive calls', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    slew.next(24, 0) // 第一拍 dt=0 → 保持 0
    expect(slew.next(24, 100)).toBeCloseTo(2) // 20 dB/s × 0.1 s
    expect(slew.next(24, 350)).toBeCloseTo(7) // +5 dB over 0.25 s
    expect(slew.next(24, 600)).toBeCloseTo(12)
  })

  it('stops exactly at target once reached', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    slew.next(8, 0)
    slew.next(8, 500) // 20×0.5=10 > 8 → 封顶到目标
    expect(slew.next(8, 600)).toBe(8)
  })

  it('lets decreases through instantly', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    slew.next(10, 0)
    slew.next(10, 400) // 爬到 +8
    expect(slew.next(-3, 401)).toBe(-3)
  })

  it('caps a huge wall-clock gap to maxStepMs worth of rise', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 }) // 默认 maxStepMs=500
    slew.next(24, 0)
    slew.next(24, 100)
    // 挂后台 60 s 后回来：只按 500 ms 记账 → 2 + 20×0.5 = 12
    expect(slew.next(24, 61_100)).toBeCloseTo(12)
  })

  it('keeps instances independent', () => {
    const a = new GainSlew({ maxRiseDbPerSec: 20 })
    const b = new GainSlew({ maxRiseDbPerSec: 20 })
    a.next(20, 0)
    a.next(20, 100)
    expect(a.next(20, 200)).toBeCloseTo(4)
    expect(b.next(-60, 200)).toBe(-60) // b 未被 a 影响
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/__tests__/gain-slew.spec.ts`
Expected: FAIL —— "Failed to resolve import '@/audio/gain-slew'"（模块不存在）。

- [ ] **Step 3: 最小实现**

```ts
// src/audio/gain-slew.ts
/**
 * Decision-domain slew limiter for gain *increases*.
 *
 * Wrap every incoming SET_GAIN decision through next() before handing it to
 * the GainNode. Rises are capped to maxRiseDbPerSec so a single wrong decision
 * (e.g. an early low LUFS reading during a video's quiet intro requesting the
 * full boost ceiling) can never slam in within one heartbeat; falls are always
 * instantaneous — attenuating is never harmful and must stay fast (spec §1).
 *
 * The clock is the main-thread performance.now() domain supplied by the
 * caller; this class never reads clocks itself so it stays pure/testable.
 */

export interface GainSlewOptions {
  /** Maximum upward gain movement, dB per second. Downward is unlimited. */
  maxRiseDbPerSec: number
  /**
   * Wall-clock gap (ms) credited to a single step. Guards against charging a
   * backgrounded tab one giant step when it wakes up after minutes idle.
   * Default 500 — matches five balance heartbeats' worth of rise.
   */
  maxStepMs?: number
}

const DEFAULT_MAX_STEP_MS = 500

export class GainSlew {
  private currentDb = 0
  private lastMs: number | null = null
  private readonly maxRiseDbPerSec: number
  private readonly maxStepMs: number

  constructor(opts: GainSlewOptions) {
    this.maxRiseDbPerSec = opts.maxRiseDbPerSec
    this.maxStepMs = opts.maxStepMs ?? DEFAULT_MAX_STEP_MS
  }

  /** Consume one decision at time `nowMs`; returns the level to actually apply. */
  next(targetDb: number, nowMs: number): number {
    const rawDtMs = this.lastMs === null ? 0 : nowMs - this.lastMs
    const dtSec = Math.max(0, Math.min(rawDtMs, this.maxStepMs)) / 1000
    if (targetDb <= this.currentDb) {
      this.currentDb = targetDb
    } else {
      this.currentDb = Math.min(targetDb, this.currentDb + this.maxRiseDbPerSec * dtSec)
    }
    this.lastMs = nowMs
    return this.currentDb
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/__tests__/gain-slew.spec.ts`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/audio/gain-slew.ts src/__tests__/gain-slew.spec.ts
git commit -m "feat(audio): add GainSlew decision-domain rise-rate limiter"
```

---

### Task 2: 配置常量 + 接入 audio-graph

**Files:**
- Modify: `src/audio/config.ts`（Content script tuning 区块，`GAIN_ATTACK_TC` 之后）
- Modify: `src/content/audio-graph.ts:43`（import 行）、`src/content/audio-graph.ts:401-483`（buildWebAudioHandle 内）

**Interfaces:**
- Consumes: Task 1 的 `GainSlew`
- Produces: `GAIN_RISE_RATE_DB_PER_S: number`（config 导出，Task 6 调参引用）。`buildWebAudioHandle.setGain` 行为变更但签名不变。

- [ ] **Step 1: config.ts 加常量**（放在 `GAIN_ATTACK_TC` 定义之后）

```ts
/**
 * Upward gain slew rate cap applied by GainSlew at the setGain entry point.
 * +6 dB arrives in ~0.3 s as a smooth swell; a wrong (too-high) decision can
 * only climb rate × time-before-correction before the corrected decision
 * lands, so startup blasts are bounded instead of instantaneous (spec §1.3).
 */
export const GAIN_RISE_RATE_DB_PER_S = 20
```

- [ ] **Step 2: audio-graph.ts 接入**

Import 行改为：

```ts
import { GAIN_ATTACK_TC, GAIN_RISE_RATE_DB_PER_S, GAIN_SMOOTH_TC } from '@/audio/config'
import { dbToGain } from '@/audio/lufs'
import { GainSlew } from '@/audio/gain-slew'
```

`buildWebAudioHandle` 中 `let currentGainDb = 0` 附近加：

```ts
  // Slew limiter on the DECISION path: rises capped, drops instant. Starts at
  // 0 dB, matching GainNode.gain.value's factory default on a fresh chain.
  const slew = new GainSlew({ maxRiseDbPerSec: GAIN_RISE_RATE_DB_PER_S })
```

`setGain` 整体替换为：

```ts
    setGain(gainDb: number) {
      if (ctx.state === 'closed') return
      // Direction-aware smoothing unchanged (see below), but the setpoint first
      // passes the slew limiter: rises may only climb GAIN_RISE_DB_PER_S, drops
      // land instantly. The volume-fallback path needs no slewing (it cannot
      // boost). Verified offline via eval/ scenarios + manual listening; no
      // unit test per the project's pure-functions-only rule.
      const slewed = slew.next(gainDb, performance.now())
      const tc = slewed < currentGainDb ? GAIN_ATTACK_TC : GAIN_SMOOTH_TC
      gain.gain.setTargetAtTime(dbToGain(slewed), ctx.currentTime, tc)
      currentGainDb = slewed
    },
```

原有的方向说明长注释保留不动即可（或原样留在 tc 选择上方）。

- [ ] **Step 3: 类型检查 + 既有单测回归**

Run: `pnpm type-check && pnpm vitest run`
Expected: 类型检查通过；全部既有单测通过（无行为级断言涉及 Web Audio 实例）。

- [ ] **Step 4: 提交**

```bash
git add src/audio/config.ts src/content/audio-graph.ts
git commit -m "feat(content): slew-limit gain increases via GainSlew"
```

---

### Task 3: 决策端暖机上限（balance.ts）

**Files:**
- Modify: `src/audio/balance.ts`
- Test: `src/__tests__/balance.spec.ts`（增补 describe）

**Interfaces:**
- Consumes: 无新增
- Produces: `BalanceParams` 扩展字段 `warmupBoostCapDb?: number`、`warmupFullTrustBlocks?: number`（undefined = 关闭，行为与现状逐位一致）；导出常量 `WARMUP_BOOST_CAP_DB = 10`、`WARMUP_FULL_TRUST_BLOCKS = 4`；`DEFAULT_BALANCE_PARAMS` 包含两者。仿真器经 `BalanceSimParams = BalanceParams & …` 自动继承，Task 4/6 直接使用。

- [ ] **Step 1: 追加失败测试**（文件末尾新 describe）

```ts
describe('computeBalanceGains warm-up boost cap', () => {
  it('caps positive gain while blockCount < trust threshold', () => {
    // 早窗口读数偏低：raw = -14 - (-38) = +24，暖机期压到 +10
    const tabs = [makeTab({ shortTerm: -38, blockCount: 1, maxGainDb: 24 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 10 }])
  })

  it('never caps above the tab ceiling', () => {
    const tabs = [makeTab({ shortTerm: -30, blockCount: 1, maxGainDb: 8 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 8 }])
  })

  it('lifts the cap once blockCount reaches the trust threshold', () => {
    const tabs = [makeTab({ shortTerm: -38, blockCount: 4, maxGainDb: 24 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 24 }])
  })

  it('does not affect negative gains', () => {
    const tabs = [makeTab({ shortTerm: -5, blockCount: 1 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: -9 }])
  })

  it('stays bit-compatible with legacy behaviour when warm-up params are omitted', () => {
    // 显式传旧形状的 params → cap 关闭
    const tabs = [makeTab({ shortTerm: -38, blockCount: 1, maxGainDb: 24 })]
    expect(
      computeBalanceGains(tabs, -14, { minBlocks: 1, minGainDb: -60 }),
    ).toEqual([{ tabId: 1, gainDb: 18 }])
  })

  it('respects raw values below the cap untouched', () => {
    // raw = +6 < cap 10：正常通过（现有用例语义不变）
    const tabs = [makeTab({ shortTerm: -20, maxGainDb: 24, blockCount: 1 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 6 }])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/__tests__/balance.spec.ts`
Expected: FAIL —— 首个用例得 `{gainDb: 24}`（cap 未实现），TS 报 `warmupBoostCapDb` 不是已知字段。

- [ ] **Step 3: 实现**

`balance.ts` 顶部常量区（`MIN_BLOCKS_FOR_RELIABLE_LUFS` 之后）：

```ts
/**
 * Warm-up boost cap: while a tab has fewer than WARMUP_FULL_TRUST_BLOCKS
 * samples, positive gains are additionally clamped to this value. The first
 * early-block readings routinely sit 10+ LU below program loudness (fade-ins,
 * musical intros), so uncapped decisions overshoot toward the boost ceiling
 * for the first few hundred ms — the audible "startup blast". 10 covers the
 * common early-read error band; negative gains are exempt (attenuation is
 * always safe). Disabled when warmupBoostCapDb is undefined (legacy shape).
 * Values finalised by eval/warmup-tune.spec.ts (plan Task 6).
 */
export const WARMUP_BOOST_CAP_DB = 10

/** Blocks after which the warm-up cap lifts (~0.6 s: first block ~0.2 s + 4 hops ×0.1 s). */
export const WARMUP_FULL_TRUST_BLOCKS = 4
```

`BalanceParams` 增加：

```ts
export interface BalanceParams {
  minBlocks: number
  minGainDb: number
  /** While blockCount < warmupFullTrustBlocks, clamp positive gains to this. Omit to disable. */
  warmupBoostCapDb?: number
  /** Trust threshold for the warm-up cap. Required when warmupBoostCapDb is set. */
  warmupFullTrustBlocks?: number
}
```

`DEFAULT_BALANCE_PARAMS` 改为：

```ts
export const DEFAULT_BALANCE_PARAMS: BalanceParams = {
  minBlocks: MIN_BLOCKS_FOR_RELIABLE_LUFS,
  minGainDb: DEFAULT_MIN_GAIN,
  warmupBoostCapDb: WARMUP_BOOST_CAP_DB,
  warmupFullTrustBlocks: WARMUP_FULL_TRUST_BLOCKS,
}
```

`computeBalanceGains` 的 clamp 分支替换为：

```ts
    const raw = targetLufs - tab.shortTerm
    let clamped = Math.max(params.minGainDb, Math.min(tab.maxGainDb, raw))
    if (
      clamped > 0 &&
      params.warmupBoostCapDb !== undefined &&
      tab.blockCount < (params.warmupFullTrustBlocks ?? Infinity)
    ) {
      clamped = Math.min(clamped, params.warmupBoostCapDb, tab.maxGainDb)
    }
    decisions.push({ tabId: tab.tabId, gainDb: clamped })
```

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `pnpm vitest run src/__tests__/balance.spec.ts && pnpm vitest run`
Expected: balance 全绿；其余套件绿（多数既有用例 blockCount ≥ 4 或 raw ≤ cap，不受影响；若有用例因新默认值变红，逐个核对其语义是否恰恰是本任务要改变的行为，再更新期望值并在提交信息里注明）。

- [ ] **Step 5: 提交**

```bash
git add src/audio/balance.ts src/__tests__/balance.spec.ts
git commit -m "feat(balance): warm-up boost cap for unreliable early measurements"
```

---

### Task 4: D5"软开头"场景（预期失败的基线）

**Files:**
- Modify: `eval/scenarios.spec.ts`（末尾追加）

**Interfaces:**
- Consumes: `runSingleScenario`（eval-helpers）、`pinkNoiseScenario`、`pinkAmpDbFor`（signals）
- Produces: 场景 `"D5 soft-intro"` —— Task 5 完成前的失败基线（记录当前 blast 幅度），完成后作为回归守卫。

- [ ] **Step 1: 追加场景测试**（复用文件顶部已有 imports 与常量 SR/TARGET/pinkAmpDbFor）

```ts
describe('Group D — D5 soft intro', () => {
  // 开头 0.6 s 低 10 LU 的淡入内容（读数≈-32 LUFS），随后进入正文（≈-22 LUFS，
  // 正确稳态增益 ≈ +8 dB）。修复目标：开头过冲（输出越过 target 的峰值）< 3 LU。
  it('bounds the startup blast from a quiet fade-in', () => {
    const signal = pinkNoiseScenario(SR, [
      { amplitudeDb: pinkAmpDbFor(-32), durationSec: 0.6 },
      { amplitudeDb: pinkAmpDbFor(-22), durationSec: 9.4 },
    ], 41)
    const tab = runSingleScenario(
      { id: 1, label: 'soft-intro fade-in', signal },
      { scenario: 'D5 soft-intro', targetLufs: TARGET, durationSec: 10 },
      { steadyWindowSec: 3 },
    )
    expect(tab.metrics.converged).toBe(true)
    expect(tab.metrics.overshoot).toBeLessThan(3)
  })
})
```

- [ ] **Step 2: 运行记录基线（预期 FAIL）**

Run: `pnpm vitest run --config vitest.eval.config.ts eval/scenarios.spec.ts`
Expected: converged 通过；overshoot 断言 FAIL，报出的数值即当前修复前基线（预计 ~8–10 LU）。把这个数字记进 commit message。

- [ ] **Step 3: 以测试状态提交基线场景**

注：先临时跳过断言提交会破坏"绿色主干"约定；正确做法是把本步与 Task 5 合并为一次提交序列——保留工作区未提交状态直接进入 Task 5 Step 1–3，最后一起跑绿再提交（两个任务的文件互不冲突）。若执行者必须单独收口 Task 4，可 `git stash` 或加 `.todo.skip` 后缀暂存，勿把红灯推进 main。

---

### Task 5: 仿真器建模 GainSlew（使 D5 转绿）

**Files:**
- Modify: `eval/simulate.ts`（`GainSmootherParams` 约 L113、`TabState` 约 L386、主循环 Step 3 约 L509）

**Interfaces:**
- Consumes: Task 3 已让 `DEFAULT_BALANCE_PARAMS` 自带暖机上限（决策路径自动生效）；Task 2 的 `GAIN_RISE_RATE_DB_PER_S`（sim 侧同值默认）
- Produces: `GainSmootherParams.maxRiseDbPerSec?: number`（undefined = 不建模）；`DEFAULT_GAIN_SMOOTHER` 含生产同值。Task 6 经 `splitParams` 透传。

- [ ] **Step 1: 扩展 GainSmootherParams 与默认值**

```ts
export interface GainSmootherParams {
  attackTc: number
  releaseTc: number
  /**
   * Production mirrors audio-graph's GainSlew: the DECIDED setpoint itself is
   * slew-limited (rises ≤ this many dB/s at TICK_SEC granularity, drops
   * instant). Omit to disable (legacy sim behaviour). Note: the production
   * implementation also caps single-step credit via maxStepMs=500ms; sim ticks
   * are uniform so the cap never binds here and is not modelled.
   */
  maxRiseDbPerSec?: number
}

export const DEFAULT_GAIN_SMOOTHER: GainSmootherParams = {
  attackTc: 0.02,
  releaseTc: 0.05,
  maxRiseDbPerSec: GAIN_RISE_RATE_DB_PER_S,
}
```

`DEFAULT_LIMITER_SETTINGS` 已从 `../src/audio/config` import；在同一 import 中加入 `GAIN_RISE_RATE_DB_PER_S`（sim ↔ config 无环风险）。

- [ ] **Step 2: TabState 加状态**

```ts
  /** Last output of the decision-path slew limiter (spec §1). Starts at 0 dB. */
  slewGainDb: number
```

初始化处（`decidedGainDb: 0` 旁）：`slewGainDb: 0,`

- [ ] **Step 3: 主循环 Step 3 替换 setpoint 更新**

把

```ts
      if (newDecided !== undefined) s.decidedGainDb = newDecided
```

替换为

```ts
      if (newDecided !== undefined) {
        // Decision-path slew (production: GainSlew inside setGain). Falls pass
        // through instantly; rises advance at most maxRiseDbPerSec·TICK_SEC.
        const prev = s.slewGainDb
        s.slewGainDb =
          smoother.maxRiseDbPerSec === undefined || newDecided <= prev
            ? newDecided
            : Math.min(newDecided, prev + smoother.maxRiseDbPerSec * TICK_SEC)
        s.decidedGainDb = s.slewGainDb
      }
```

- [ ] **Step 4: 跑 D5 与全套 eval**

Run: `pnpm vitest run --config vitest.eval.config.ts`
Expected: D5 PASS（overshoot < 3）；convergence/stability/scenarios 其余用例全绿——修复只会降低过冲与 ripple，若某条边界阈值意外转红，先读 trace 判断是不是改善越过了旧的宽松界，逐个核对后再改阈值并在 commit 注明。

- [ ] **Step 5: 一起提交 Task 4+5**

```bash
git add eval/scenarios.spec.ts eval/simulate.ts
git commit -m "feat(eval): model decision-path slew; add D5 soft-intro scenario (baseline X.X LU -> green)"
```

---

### Task 6: 调参标定（riseRate × warmCap × trustBlocks）

**Files:**
- Create: `eval/warmup-tune.spec.ts`
- Modify（仅当选出值 ≠ 初值）: `src/audio/balance.ts`、`src/audio/config.ts`

**Interfaces:**
- Consumes: `buildTuneSuite()` / `evaluateCandidate()` / `PRODUCTION_DEFAULTS`（均已是 tune.ts 公开导出）；Task 3/5 的可选参数与 `splitParams` 透传
- Produces: 定稿常量与一份可复核的成本对比报告

- [ ] **Step 1: splitParams 透传新字段**（tune.ts）

```ts
function splitParams(p: BalanceSimParams) {
  return {
    balance: {
      minBlocks: p.minBlocks,
      minGainDb: p.minGainDb,
      ...(p.warmupBoostCapDb !== undefined ? { warmupBoostCapDb: p.warmupBoostCapDb } : {}),
      ...(p.warmupFullTrustBlocks !== undefined
        ? { warmupFullTrustBlocks: p.warmupFullTrustBlocks }
        : {}),
    },
    smoother: {
      attackTc: p.attackTc,
      releaseTc: p.releaseTc,
      ...(p.maxRiseDbPerSec !== undefined ? { maxRiseDbPerSec: p.maxRiseDbPerSec } : {}),
    },
    limiter: { thresholdDb: p.thresholdDb, ratio: p.ratio, attackMs: p.attackMs, releaseMs: p.releaseMs, kneeDb: p.kneeDb },
  }
}
```

- [ ] **Step 2: 写标定报告 spec**

```ts
// eval/warmup-tune.spec.ts
import { describe, it } from 'vitest'

import {
  buildTuneSuite,
  evaluateCandidate,
  PRODUCTION_DEFAULTS,
  type BalanceSimParams,
} from './tune'

const RISE_GRID = [10, 15, 20, 30]
const CAP_GRID = [6, 8, 10, 12, 15]
const TRUST_GRID = [2, 3, 4, 6]

type Row = { label: string; rise?: number; cap?: number; trust?: number; cost: number }

function costOf(p: BalanceSimParams): number {
  return evaluateCandidate(p, buildTuneSuite()).totalCost
}

describe('warm-up calibration report', () => {
  it('prints baseline vs default-enabled vs grid winners', () => {
    const rows: Row[] = []

    rows.push({
      label: 'baseline (both mechanisms off)',
      cost: costOf({ ...PRODUCTION_DEFAULTS }),
    })
    rows.push({
      label: 'enabled defaults (rate=20 cap=10 trust=4)',
      rise: 20, cap: 10, trust: 4,
      cost: costOf({ ...PRODUCTION_DEFAULTS, maxRiseDbPerSec: 20, warmupBoostCapDb: 10, warmupFullTrustBlocks: 4 }),
    })

    let best: Row | null = null
    for (const rise of RISE_GRID) {
      for (const cap of CAP_GRID) {
        for (const trust of TRUST_GRID) {
          const cost = costOf({
            ...PRODUCTION_DEFAULTS,
            maxRiseDbPerSec: rise,
            warmupBoostCapDb: cap,
            warmupFullTrustBlocks: trust,
          })
          const row: Row = { label: `grid`, rise, cap, trust, cost }
          if (!best || cost < best.cost) best = row
        }
      }
    }
    rows.push(best!)

    console.table(rows)
    // 启用机制后总成本不得劣于关闭时的基线（速度项的微小损失应被过冲项的
    // 收益覆盖；若违背说明权重需要复核，而不是静默接受回退）。
    expect(best!.cost).toBeLessThanOrEqual(rows[0]!.cost)
  })
})
```

顶部补 `import { expect } from 'vitest'`（合并进首行 import）。

- [ ] **Step 3: 跑标定，按规则定稿常量**

Run: `pnpm vitest run --config vitest.eval.config.ts eval/warmup-tune.spec.ts`
Expected: 打印三行报告表，断言通过。

采纳规则：grid winner 相比 enabled defaults 总成本改善 ≥ 10% 且全场景收敛 → 把胜出的三个值写回 `WARMUP_BOOST_CAP_DB` / `WARMUP_FULL_TRUST_BLOCKS`（balance.ts）与 `GAIN_RISE_RATE_DB_PER_S`（config.ts）、`DEFAULT_GAIN_SMOOTHER.maxRiseDbPerSec`（simulate.ts）；否则保持初值并在 PR 描述附上报告结论（"初值已在最优点邻域"亦是合法结论）。

- [ ] **Step 4: 全量回归 + 提交**

Run: `pnpm test:unit && pnpm test:eval && pnpm build`
Expected: 全绿。

```bash
git add eval/tune.ts eval/warmup-tune.spec.ts
# 若常量有改动，一并加入 balance.ts / config.ts
git commit -m "feat(eval): warm-up calibration report; finalise slew/cap constants"
```

---

### Task 7: 文档与手工验收清单

**Files:**
- Modify: `CHANGELOG.md`（`## [Unreleased]` 下）
- Modify: `AGENT.md` 仅当其中存在与新机制冲突的描述（先 grep `setGain|balance` 核对，多半无需改）

- [ ] **Step 1: CHANGELOG 增补**

```markdown
## [Unreleased]

### Fixed
- **Startup blast eliminated.** On quiet videos the balancer could apply its
  full +24 dB boost ceiling for the first few hundred ms because the earliest
  measurement window under-reads a quiet intro by 10–20 LU. Two safeguards:
  gain *increases* are now slew-limited (+6 dB ≈ 0.3 s smooth swell, drops
  still instant), and decisions made on fewer than four measurement blocks cap
  boosts at +10 dB until the reading stabilises.
```

- [ ] **Step 2: 手工验收（需真实浏览器，交由用户执行并列结果）**

1. YouTube 冷启动一个安静视频：开局应为 ~0.3 s 平滑渐强，无爆音。
2. Instagram Reels/Douyin 连续滑片 10 次：无每次换片的"炸一下"。
3. 一个真正需要 +15~24 dB 的 ASMR 内容：增强仍在，只是渐强柔和；popup 徽标不再闪 "+24"。
4. 拉高再压低场景：某tab突然变大声 → 快速压下不受影响（快攻路径未动）。

- [ ] **Step 3: 最终提交**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): startup blast fix entry"
```

---

## Self-Review 结论（已内联修正）

- **Spec 覆盖**：spec §1→Task 1/2；§2→Task 3；§3→Task 4/5/6；§4 测试矩阵分散于各任务（依项目"只测纯函数"规则，audio-graph 层不写 jsdom 单测，改由 Task 4/5 的 eval 场景与 Task 7 手工验收覆盖——有意取舍，非缺口）；§5 风险→各任务注意事项。spec §3.2 提议的"LU·s 过冲面积"代价项**不再新增**：`computeMetrics.overshoot`（metrics.ts:115，越靶最大偏移）已完整度量本故障模式，D5 场景足以驱动调参，面积项属冗余（YAGNI）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`GainSlewOptions/GainSlew.next` 在 Task 1 定义、Task 2 同名消费；`maxRiseDbPerSec/warmupBoostCapDb/warmupFullTrustBlocks` 在 Task 3/5 定义、Task 6 经 `splitParams` 同名透传；`evaluateCandidate/buildTuneSuite/PRODUCTION_DEFAULTS` 为 tune.ts 既有导出（已核实）。
- **两处对 spec 的有意偏离**（均已注明理由）：① 暖机常量放 `balance.ts` 而非 `config.ts`，避免 config↔balance 模块环；② 不新增面积型 overshoot 代价项。
