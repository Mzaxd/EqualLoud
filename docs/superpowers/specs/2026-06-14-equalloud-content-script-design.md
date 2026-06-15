# EqualLoud — Content-Script 架构实现设计

> 日期:2026-06-14
> 主题:EqualLoud(content script 接管音频路由方案)的实现设计
> 状态:已确认,作为 writing-plans 的输入
>
> **本 spec 不重复 PRD.md 已明确的内容**(三层架构、数据流、模块职责、权限模型、路线图、风险),只补充实现落地必需但 PRD 未写明的精确细节,并固化 §17 开放决策。实现时 PRD.md + 本 spec 共同为准。

---

## 0. 开放决策结论(对应 PRD §17)

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| 1 | Limiter 默认 | **开启**,threshold -1 dB / knee 0 / ratio 20 / attack 1 ms / release 100 ms | gain 可 >1(放大过轻内容),默认开限幅器防削波破音 |
| 2 | `maxGainDb` 暴露 | **不暴露**,固定 +12 dB | 保持极简 UI;+12 足够把 -26 LUFS 提到 -14 |
| 3 | 黑名单 UI | **不做用户 UI**;内置 DRM 站点跳过列表(M5) | 减少认知负担;DRM 站点接管必静音,跳过反而让原生播放正常 |
| 4 | `all_frames` | **false**(只注入顶层框架) | YouTube/B 站/播客站播放器在顶层;漏抓再开,性能优先 |
| 5 | 实现范围 | **完整 M0–M5** | 交付可加载的完整插件 + 单测全绿 |

---

## 1. content script 音频图拓扑(精确实现)

### 1.1 拓扑

```
<video>/<audio> element
   │  createMediaElementSource(el)   ← 每个 element 只调一次,WeakMap 防重
   ▼
MediaElementSourceNode
   │
   ├──→ [测量分支] AudioWorkletNode('lufs-processor')
   │        │  output 填 0(处理器内已 fill(0)),**不连 destination**
   │        │  processor.port.onmessage → 上报 { shortTerm, blockCount }
   │        ▼
   │      (静音,丢弃)
   │
   └──→ [播放分支] GainNode
            │  gain.gain.setTargetAtTime(dbToGain(gainDb), now, 0.05)
            ▼
        DynamicsCompressorNode (limiter, PRD 决策1:默认开)
            │
            ▼
        AudioContext.destination   ← 必须连接,否则页面静音
```

### 1.2 关键不变量(实现必须保证)

- `createMediaElementSource(el)` **每个 element 全局只能调一次**;用 `WeakMap<HTMLMediaElement, MediaState>` 记录已接管的。二次调用抛 `InvalidStateError`,try/catch 降级(见 §7.2)。
- **播放分支必须连到 `ctx.destination`**——接管后原 element 的默认输出被切断,不连 destination 会静音。
- 测量分支(worklet)**不连 destination**(worklet `process()` 内已把 output 填 0),只取其 `port` 上报的 LUFS。
- 一个页面 **一个 AudioContext**(缓存复用),多个 media element 共享。
- AudioContext 默认 `suspended`(autoplay policy),见 §5.3。

### 1.3 代码骨架(content/audio-graph.ts)

```ts
interface MediaState {
  el: HTMLMediaElement
  source: MediaElementAudioSourceNode
  gain: GainNode
  limiter: DynamicsCompressorNode
  worklet: AudioWorkletNode
}

class AudioGraph {
  private ctx: AudioContext | null = null
  private attached = new WeakMap<HTMLMediaElement, MediaState>()

  async ensureContext(): Promise<AudioContext> { /* 单例 + worklet 加载 */ }
  async attach(el: HTMLMediaElement): Promise<MediaState> { /* 建图,WeakMap 防重 */ }
  detach(el: HTMLMediaElement): void { /* 断开 + 释放 */ }
  setGain(state: MediaState, gainDb: number): void {
    state.gain.gain.setTargetAtTime(dbToGain(gainDb), this.ctx!.currentTime, GAIN_SMOOTH_TC)
  }
}
```

---

## 2. 消息协议契约(messages/protocol.ts)

所有消息类型**集中到 `src/messages/protocol.ts`**,SW/content/popup 三方共享,TS strict 强类型,避免散落在各文件里。

```ts
// ── 共享类型 ──
export interface LimiterSettings {
  enabled: boolean
  thresholdDb: number
  kneeDb: number
  ratio: number
  attackMs: number
  releaseMs: number
}

export interface Settings {
  enabled: boolean
  targetLufs: number        // 默认 -14
  soloTabId: number | null
}

export interface TabState {
  tabId: number
  title: string
  url: string
  shortTerm: number         // 最新 short-term LUFS,-Infinity 表示无数据
  blockCount: number
  appliedGainDb: number
  maxGainDb: number         // 固定 +12
  muted: boolean
}

// ── Content → SW(runtime.sendMessage,notification 或请求) ──
export type ContentToServiceWorker =
  | { type: 'GET_CONFIG' }                                              // 启动时拉配置
  | { type: 'MEDIA_ATTACHED'; tabId: number; title: string; url: string }
  | { type: 'LUFS_REPORT'; tabId: number; shortTerm: number; blockCount: number }
  | { type: 'TAB_UNLOAD'; tabId: number }

// ── SW → Content(chrome.tabs.sendMessage,定向) ──
export type ServiceWorkerToContent =
  | { type: 'SET_GAIN'; tabId: number; gainDb: number }
  | { type: 'SET_CONFIG'; target: number; enabled: boolean }
  | { type: 'SET_LIMITER'; settings: LimiterSettings }
  | { type: 'SET_MUTED'; tabId: number; muted: boolean }
  | { type: 'SET_SOLO'; soloTabId: number | null }

// ── Popup ↔ SW(chrome.runtime.sendMessage,请求/响应) ──
export type PopupToServiceWorker =
  | { type: 'GET_STATE' }
  | { type: 'SET_TARGET_LUFS'; targetLufs: number }
  | { type: 'SET_ENABLED'; enabled: boolean }
  | { type: 'TOGGLE_MUTE'; tabId: number }
  | { type: 'TOGGLE_SOLO'; tabId: number }
  | { type: 'SET_LIMITER'; settings: Partial<LimiterSettings> }

export interface PopupStateResponse {
  tabs: TabState[]
  settings: Settings
  limiter: LimiterSettings
}
```

> **通道分界**(PRD §6.4 已强调,这里固化):SW ↔ popup 用 `chrome.runtime.sendMessage`;SW → content **必须用 `chrome.tabs.sendMessage(tabId, msg)`**(content script 收不到 `runtime.sendMessage`)。

---

## 3. 状态与持久化(SW 侧)

### 3.1 内存状态(SW 运行时,不持久化)

```ts
const tabs = new Map<number, TabState>()        // content script 上报重建
let settings: Settings                           // 从 storage 加载
let limiter: LimiterSettings                     // 从 storage 加载
let lastBalanceRunMs = 0                         // 节流
```

### 3.2 持久化(chrome.storage.local)

只持久化**设置类**(`Settings` + `LimiterSettings`)。`TabState` 不持久化——SW 唤醒后由 content script 的 `LUFS_REPORT`/`MEDIA_ATTACHED` 自然重建(PRD §6.2.3)。

```ts
const STORAGE_KEYS = {
  settings: 'equalloud:settings',
  limiter: 'equalloud:limiter',
}
```

### 3.3 SW 生命周期

- **启动即加载**:`loadSettings()` 返回 Promise,SW 顶层立即调用并缓存。
- **入口守卫**:`handleMessage` 入口 `await initialSettingsLoaded`,保证任何应答前设置就绪。
- **休眠唤醒**:`onInstalled` / `onStartup` / 首条消息触发 `loadSettings()`(三重保险,不依赖单一入口)。
- `chrome.alarms`(1 min)兜底:SW 休眠前/唤醒后做轻量自检,可选。

---

## 4. content script 生命周期

### 4.1 启动(content/index.ts)

1. 自查 `document.querySelector('video, audio')`;**无媒体元素 → 立即退出**(零开销,PRD §8)。
2. 自查 URL 是否在 DRM 黑名单(§7.1);命中 → 退出,不接管。
3. 初始化 `MediaManager`(MutationObserver)+ `AudioGraph` + `Messenger`。
4. 向 SW 发 `GET_CONFIG` 拿初始 `Settings`/`LimiterSettings`;回 `MEDIA_ATTACHED`。

### 4.2 媒体发现(content/media-manager.ts)

- `MutationObserver`(childList + subtree)监听 DOM 增删。
- 扫描 `document.querySelectorAll('video, audio')`。
- 新增 element → `audioGraph.attach(el)`;移除 element → `audioGraph.detach(el)`。
- SPA 路由:监听 `popstate` + hook `history.pushState/replaceState`,触发重扫。

### 4.3 主元素选择(pickPrimaryMedia,纯函数,单测)

一页可能多 `<video>`(主视频+广告+预览)。**全部接管**(各自 gain),但 LUFS 上报**只取主元素**。启发式打分,取最高:

```ts
function pickPrimaryMedia(elements: HTMLMediaElement[]): HTMLMediaElement | null {
  // 得分项(取并集最优):
  //   + videoWidth 越大
  //   + duration 越长(有限值)
  //   + 可见(offsetParent !== null)
  //   + 非 muted 优先
  //   + 有 src/currentSrc 优先
}
```

### 4.4 LUFS 上报

- 主元素经 worklet 产出 `{ shortTerm, blockCount }`(10 Hz)。
- content script 节流后(`LUFS_REPORT_HZ`)发 `LUFS_REPORT` 给 SW。
- blockCount < `MIN_BLOCKS_FOR_RELIABLE_LUFS`(=3)时 SW 跳过该 tab(复用 `balance.ts`)。

### 4.5 接收 SW 指令

`chrome.runtime.onMessage` 收 `SET_GAIN`/`SET_CONFIG`/`SET_LIMITER`/`SET_MUTED`/`SET_SOLO` → 应用到主元素(及该 tab 所有已接管 element,保证一致)。

### 4.6 卸载

`pagehide`/`beforeunload` → 发 `TAB_UNLOAD`,SW 清理 `tabs.get(tabId)`。

---

## 5. AudioContext 激活(autoplay policy)

- 监听页面首次 `pointerdown`/`keydown`/`touchstart` → `ctx.resume()`。
- 监听 `<video>`/`<audio>` 的 `play` 事件(用户点播放 = 手势)→ `ctx.resume()`。
- `ctx.state === 'suspended'` 时:**不应用 gain**(避免无效写),但**不报错**;一旦 resume 立即补写当前 gain。
- resume 成功后才发 `MEDIA_ATTACHED`(确保 SW 不给一个还没出声的 tab 下发无效 gain)。

---

## 6. SW 协调决策(复用 balance.ts,原样)

1. 收到 `LUFS_REPORT` → 更新 `tabs.get(tabId)` 的 shortTerm/blockCount。
2. `shouldThrottleBalance(lastBalanceRunMs, now)` 节流(100 ms)。
3. `computeBalanceGains(tabs数组, settings.targetLufs, settings.soloTabId)`(原样复用)算出 `GainDecision[]`。
4. 对每个 decision:`chrome.tabs.sendMessage(tabId, { type:'SET_GAIN', tabId, gainDb })`,并更新 `appliedGainDb`。
5. muted tab:gain 走 -100(`SOLO_MUTE_GAIN`),但 `appliedGainDb` 仍记决策值(UI 区分)。

> **BalanceableTab 适配**:`computeBalanceGains` 需要 `{ tabId, isCapturing, shortTerm, blockCount, maxGainDb }`。EqualLoud 里 `isCapturing` ≡ 该 tab 在 `tabs` Map 中(已 `MEDIA_ATTACHED`)。

---

## 7. 降级与边界

### 7.1 DRM 站点(content script 启动自查)

内置跳过列表(host 后缀匹配),命中则**不接管**(让原生播放):
```
netflix.com, disneyplus.com, max.com(原 hbomax), hbomax.com,
primevideo.com, tv.apple.com, peacocktv.com, paramplus.com
```
存 `src/audio/config.ts` 常量。M5 后可扩成 storage 可配。

### 7.2 `createMediaElementSource` 冲突(InvalidStateError)

页面自带音频可视化时可能已对该 element 调过。try/catch 捕获 → **降级**:直接调 `el.volume`(范围 0~1,只能衰减不能放大,但至少能降过响内容),记录降级标记,popup 提示"该元素降级为音量控制"。

### 7.3 DRM 接管后静音(无法绕过)

不在黑名单的 DRM 站点即使接管也可能静音。检测:`AnalyserNode`(挂在测量分支)有数据 + worklet 上报有效 LUFS,但用户反馈听不到 → popup 提示。M5 实现检测启发式;首版以黑名单为主防线。

---

## 8. 模块清单

### 纯算法核心(无 DOM/Chrome 依赖)
- `src/audio/lufs.ts` — ITU-R BS.1770-4 K-weighting + gating + block loudness
- `src/audio/balance.ts` — `computeBalanceGains` 纯函数
- `src/worklets/lufs-processor.ts` — AudioWorklet 测量节点
- `src/stores/settings.ts`(locale 持久化)
- `src/i18n.ts` + `src/locales/{en,zh_CN}.json` + `plugins/i18n-locales.ts` + `public/_locales/`
- `tools/loudness-test.html`
- 配置模板:`vite.config.ts` / `vitest.config.ts` / `tsconfig*.json` / `eslint.config.ts` / `.prettierrc.json` / `env.d.ts`

### Popup 与 store
- `src/stores/tabs.ts`:Pinia store,popup↔SW 通信骨架走新协议(`GET_STATE`/`TOGGLE_MUTE`/`TOGGLE_SOLO`/`SET_LIMITER`),实时显示 appliedGainDb。
- `src/components/AutoBalance.vue`:适配新 settings store。
- `src/components/Limiter.vue`:默认值 enabled=true。
- `src/components/TabList.vue`:每行 appliedGainDb 显示(+5.2 dB / -3.0 dB);mute/solo 按钮接 TOGGLE_MUTE/TOGGLE_SOLO。
- `src/__tests__/`:balance/lufs-calculator/lufs-processor spec;components/stores spec 适配协议;`pickPrimaryMedia.spec.ts`、`protocol.spec.ts`。

### 原生架构(content-script 方案独有)
- `src/background.ts`(SW 协调器,§3/§6 —— 无 tabCapture、无 offscreen)
- `manifest.config.ts`(权限,§9)
- `src/content/{index,media-manager,audio-graph,messenger}.ts`、`src/messages/protocol.ts`(content-script 方案的核心)

---

## 9. manifest.config.ts(精确)

```ts
export default defineManifest({
  manifest_version: 3,
  name: 'EqualLoud',
  description: '自动平衡所有标签页响度——装上即忘',
  version: process.env.npm_package_version ?? '0.0.0',
  default_locale: 'en',
  icons: { '16': 'logo@16w.png', '32': 'logo@32w.png', '48': 'logo@48w.png', '128': 'logo@128w.png' },
  action: { default_popup: 'index.html', default_icon: { '16': 'logo@16w.png', '32': 'logo@32w.png' } },
  background: { service_worker: 'src/background.ts', type: 'module' },
  permissions: ['storage', 'tabs', 'alarms'],           // 去掉 tabCapture/activeTab/offscreen
  host_permissions: ['<all_urls>'],
  content_scripts: [{
    matches: ['<all_urls>'],
    js: ['src/content/index.ts'],
    run_at: 'document_idle',
    all_frames: false,
  }],
})
```

> `scripting` 权限 PRD 标"可选"。首版 content_scripts 静态注入足够覆盖;SPA 路由靠 MutationObserver 处理。**不加 scripting**,减少权限警告。

---

## 10. 配置参数(src/audio/config.ts)

| 参数 | 默认 | 说明 |
|---|---|---|
| `targetLufs` | -14 | 用户可调(滑块 -60~0) |
| `maxGainDb` | +12 | 固定,不暴露 |
| `DEFAULT_MIN_GAIN` | -60 | (balance.ts 已定义) |
| `MIN_BLOCKS_FOR_RELIABLE_LUFS` | 3 | (balance.ts 已定义) |
| `BALANCE_THROTTLE_MS` | 100 | (balance.ts 已定义) |
| `GAIN_SMOOTH_TC` | 0.05 | gain setTargetAtTime timeConstant(秒) |
| `LUFS_REPORT_HZ` | 10 | content 上报频率 |
| `SOLO_MUTE_GAIN` | -100 | (balance.ts 已定义) |
| `DRM_BLOCKLIST` | [见 §7.1] | host 后缀数组 |
| `LimiterSettings 默认` | enabled=true, -1dB, knee 0, ratio 20, 1/100ms | |

---

## 11. 测试策略

### 纯逻辑 TDD(Vitest + jsdom,先红后绿)
- `computeBalanceGains` / `shouldThrottleBalance` / `hasEnoughSamples` —— `balance.spec.ts`(12 用例)
- `LufsCalculator` —— 复用 `lufs-calculator.spec.ts`(24 用例)
- `lufs-processor` —— 复用 `lufs-processor.spec.ts`(7 用例)
- **新增** `pickPrimaryMedia` —— 多视频打分选择(可见/时长/尺寸/muted 组合)
- **新增** `protocol` 类型守卫 / 消息构造(可选)

### 集成测试(mock chrome.*)
- SW `handleMessage`:各消息类型(GET_STATE / LUFS_REPORT → SET_GAIN 链路 / TOGGLE_SOLO / SET_LIMITER)
- SW 持久化:storage 读写 + 唤醒恢复
- content ↔ SW 协议:模拟 LUFS_REPORT 触发 SET_GAIN

### 端到端(手动,复用 loudness-test.html)
- 双 tab 不同增益 → 平衡后响度趋近
- 重启浏览器 → 自动恢复
- SPA 导航(YouTube 切视频)→ 持续工作
- DRM 站点(Netflix)→ 跳过接管,原生播放正常

### Definition of Done(复用 PRD §11.4)
`pnpm type-check` / `pnpm lint` / `pnpm test:unit` 全绿,`pnpm build` 产出 unpacked 扩展 + zip,§11.3 手动验证通过。

---

## 12. 实现顺序(对齐 PRD §12 路线图)

M0 脚手架 → M1 content 单 tab 接管(音频图 + 手动 gain 验证)→ M2 LUFS 测量(worklet 接入)→ M3 SW 协调 + 多 tab 平衡 + 持久化 → M4 Popup UI(复用 + gain 显示)→ M5 打磨(DRM 黑名单 / SPA / 主元素选择 / 降级 / 文档)。

每个 M 可独立验证,纯逻辑先 TDD。
