# EqualLoud — 产品需求文档 (PRD)

> 自动平衡所有视频/音频网站播放响度的 Chrome 扩展。
> 装上即忘,无需点图标,无需任何干预——只要开关开着。

---

## 0. 文档信息

| 项 | 值 |
|---|---|
| 项目名 | **EqualLoud** |
| 文档版本 | v1.0 |
| 日期 | 2026-06-14 |
| 状态 | Draft（待评审后进入实现） |
| 平台 | Chrome / Edge（Chromium 系,Manifest V3） |

---

## 1. 执行摘要 (TL;DR)

EqualLoud 是一个 Chrome MV3 扩展,目标:**让用户同时打开多个视频/音频网站时,所有标签页的响度自动趋近一致,无需手动调音量。**

核心技术决策:**放弃 `chrome.tabCapture` API,改用 content script + `AudioContext.createMediaElementSource` 直接接管页面 `<video>`/`<audio>` 元素的音频路由,通过 `GainNode` 调整增益。** 这一架构从根本绕开了 MV3 的 `activeTab` 限制(详见 §3),实现真正的"100% 自动"。

平衡算法采用广播标准 **ITU-R BS.1770 LUFS**,目标是让每个标签页的 short-term LUFS 收敛到用户设定值(默认 -14 LUFS)。

---

## 2. 目标与非目标

### 2.1 目标 (Goals)

- **G1 — 全自动**:用户安装后,任何视频/音频网站打开即自动接管,**不需要点击扩展图标、不需要任何用户手势**。
- **G2 — 跨标签平衡**:同时播放的多个标签页响度自动趋近一致(目标 LUFS)。
- **G3 — 双向调整**:既能把过响的内容降下来,也能把过轻的内容提上去(gain > 0)。
- **G4 — 持久稳定**:浏览器重启、标签页切换、service worker 休眠/唤醒后均自动恢复工作。
- **G5 — 平滑无突兀**:增益调整平滑过渡,无咔哒声、无突变。
- **G6 — 低开销**:CPU/内存占用可控,不拖慢页面。

### 2.2 非目标 (Non-Goals)

- **N1 — 不做屏幕录制 / 流捕获**(那是 tabCapture 的领域)。
- **N2 — 不处理 DRM 加密内容**(Netflix 高清流等,Chrome 会强制静音 Web Audio,无法绕过,见 §12.1)。
- **N3 — 不处理无 `<video>`/`<audio>` 元素的音频**(用 Web Audio API 直接合成的极少数页面)。
- **N4 — 不做宿主原生 app 的音量**(Spotify 桌面客户端等,不在浏览器范围内)。
- **N5 — 不做精细 EQ / 频段调整**(只做整体响度,不做频响)。

---

## 3. 背景与动机:为什么用 content script 而不是 tabCapture

### 3.1 为什么 tabCapture 行不通

直觉上"自动平衡所有标签"该用 `chrome.tabCapture.getMediaStreamId({ targetTabId })` 捕获标签页音频,在 offscreen document 里跑 LUFS + GainNode。但**这个方案在 MV3 下有一个无法绕过的根本限制。** Chrome 官方文档(`developer.chrome.com/docs/extensions/reference/api/tabCapture`)明确写道:

> **GetMediaStreamOptions.targetTabId**:"Only tabs for which the extension has been granted the `activeTab` permission can be used as the target tab."
>
> "It can only be called **after the user invokes an extension**, such as by clicking the extension's action button."

即:
1. `getMediaStreamId({ targetTabId })` 只能对**已被授予 `activeTab` 权限**的标签使用。
2. `activeTab` 是**临时权限**,只在用户**主动调用扩展**(点图标)时授予**当前那个 tab**。
3. **`host_permissions` 不能替代 `activeTab`**(文档只字未提;实测加了 `<all_urls>` 仍报 "Extension has not been invoked for the current page")。
4. `activeTab` 故意设计为"不可程序化授予"——防止扩展偷偷录音。

**结论**:tabCapture 方案无法实现"自动捕获任意标签"。任何基于 tabCapture 的"自动平衡"在 MV3 下都是死路。

### 3.2 破局点:不"捕获",直接"控制"

用户真正要的不是"录制音频",而是"调音量"。视频网站的音量本质上是一个 `<video>` DOM 元素。content script 能直接操作它,**完全不需要 tabCapture、不需要 activeTab、不需要用户点击**。

```js
const video = document.querySelector('video')
const ctx = new AudioContext()
const src = ctx.createMediaElementSource(video)  // 接管 video 的音频路由
const gain = ctx.createGain()
src.connect(gain).connect(ctx.destination)        // 经 gain 输出到扬声器
gain.gain.value = 0.7                              // 任意调,还能 >1 放大
```

`createMediaElementSource` 是标准 Web Audio API,运行在页面 content script 里,配合 `content_scripts` 自动注入 + `host_permissions`,即实现**真正 100% 自动**。这也是业界音量类扩展(Volume Master、Audio Equalizer 等)实际采用的方案。

---

## 4. 用户场景 (User Stories)

- **US1**:同时开 YouTube 两个视频 + 一个播客网站,音量忽大忽小。装了 EqualLoud 后,三者响度自动趋近一致,不再需要手够音量键。
- **US2**:深夜看视频,某广告突然炸响。EqualLoud 把它压到目标响度。
- **US3**:关浏览器、第二天重开,所有视频网站自动接管,无需重新启用。
- **US4**:把目标从 -14 拖到 -20(整体更安静),所有标签立即平滑收敛到新目标。
- **US5**:某个标签想单独静音,点 popup 里的 mute 按钮,立即静音;再点恢复。
- **US6**:想单独听某一个标签(solo),点 solo,其他自动静音。

---

## 5. 解决方案概述

### 5.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  Popup UI (Vue 3)                                        │
│  ─ 目标 LUFS 滑块 / 开关 / 标签列表 / mute / solo         │
└───────────────┬─────────────────────────────────────────┘
                │ chrome.runtime.sendMessage
                ▼
┌─────────────────────────────────────────────────────────┐
│  Service Worker (协调器)                                  │
│  ─ 收集各 tab 的 LUFS 报告                                │
│  ─ 计算各 tab 应有 gain (复用 computeBalanceGains)        │
│  ─ 下发 gain 指令                                         │
│  ─ 持久化设置 (chrome.storage)                            │
└───────────────┬─────────────────────────────────────────┘
                │ chrome.runtime.sendMessage
        ┌───────┴───────┬──────────┐
        ▼               ▼          ▼
   ┌─────────┐    ┌─────────┐  ┌─────────┐
   │ Tab A   │    │ Tab B   │  │ Tab C   │   Content Scripts
   │ content │    │ content │  │ content │   (注入到每个视频网站)
   │ script  │    │ script  │  │ script  │
   │         │    │         │  │         │
   │ <video> │    │ <video> │  │ <audio> │
   │   ↓     │    │   ↓     │  │   ↓     │
   │ src→gain│    │ src→gain│  │ src→gain│
   │   →dest │    │   →dest │  │   →dest │
   └─────────┘    └─────────┘  └─────────┘
```

### 5.2 数据流(单向 + 反馈)

1. **测量**:每个 content script 持续测量本页 `<video>` 的 short-term LUFS(~10 Hz)。
2. **上报**:content script → SW,消息 `LUFS_REPORT { tabId, shortTerm, blockCount }`。
3. **决策**:SW 收到报告后,用 `computeBalanceGains(allTabs, target, soloTab)` 算出每个 tab 应有 gain。
4. **下发**:SW → 各 content script,消息 `SET_GAIN { gainDb }`。
5. **应用**:content script 把 gain 平滑写到 `GainNode.gain`(`setTargetAtTime`,50ms)。

---

## 6. 详细设计

### 6.1 Content Script

**职责**:在单个标签页内发现媒体元素、接管音频路由、测量响度、应用增益。

#### 6.1.1 媒体元素发现(鲁棒性是关键)

视频网站多为 SPA,`<video>` 元素会动态创建/销毁(如 YouTube 切视频、插入广告)。必须用 `MutationObserver` 监听 DOM:

```
on DOM mutation:
  scan document for <video>, <audio>
  for each new media element:
    ensureAttached(mediaEl)  // 创建 AudioContext + source + gain,记录到 Map
  for each removed media element:
    detach(mediaEl)          // 断开、释放
```

要点:
- 一个媒体元素只能调一次 `createMediaElementSource`(再调会抛错),用 `WeakMap<Element, MediaState>` 记录已接管的。
- 同一页面可能有多个 `<video>`(主视频 + 预览 + 广告),**全部接管,各自 gain**,但响度上报只取**主要的那一个**(音量最大 / 可见 / 时长最长),避免广告干扰。
- AudioContext 创建后缓存,复用(避免多个 context)。

#### 6.1.2 音频图

```
mediaElement
   │ createMediaElementSource
   ▼
MediaStreamSource ──► (分支1:测量) ──► AnalyserNode / AudioWorklet (LUFS)
   │
   └──► (分支2:播放) ──► GainNode ──► AudioContext.destination
```

- **测量分支**:并联一个 `AudioWorkletNode`(`lufs-processor.ts`),输出静音,只为算 LUFS。
- **播放分支**:经 `GainNode`(实际增益)到 `destination`(用户听到)。
- 两条分支共享同一个 source,互不干扰。

#### 6.1.3 AudioContext 激活(autoplay policy)

浏览器 autoplay 策略:`AudioContext` 默认 `suspended`,需用户手势激活。处理:
- 监听页面首次用户交互(`pointerdown`/`keydown`/`play` 事件),调 `ctx.resume()`。
- 监听 `<video>` 的 `play` 事件(用户点播放 = 手势)→ resume。
- 如果 ctx 仍 suspended,不应用 gain(等激活),但不报错。

#### 6.1.4 与 SW 通信

- 启动时:`GET_CONFIG` 拿目标 LUFS / enabled / solo 状态。
- 周期(~10 Hz):`LUFS_REPORT { tabId, shortTerm, blockCount }`。
- 接收:`SET_GAIN { gainDb }`、`SET_CONFIG { target, enabled }`、`SET_MUTED { muted }`、`SET_SOLO { soloTabId }`。
- 页面卸载:`TAB_UNLOAD { tabId }`(SW 清理)。

### 6.2 Service Worker(协调器)

**职责**:汇总各 tab 状态、决策、持久化、给 popup 提供数据。

#### 6.2.1 状态

```ts
interface TabState {
  tabId: number
  title: string
  url: string
  shortTerm: number        // 最新 short-term LUFS
  blockCount: number       // 累计块数(判断是否可靠)
  appliedGainDb: number    // 最后下发的 gain
  maxGainDb: number        // per-tab 上限(默认 +12)
  muted: boolean
}
interface Settings {
  enabled: boolean
  targetLufs: number       // 默认 -14
  soloTabId: number | null
}
```

#### 6.2.2 平衡决策(纯函数)

直接复用 `computeBalanceGains(tabs, target, soloTabId)`(已单元测试,见 §17)。每次收到 `LUFS_REPORT` 触发一次决策(带 100ms 节流)。

#### 6.2.3 持久化与 SW 休眠

MV3 service worker 会休眠,内存状态丢失。设计原则:
- **设置类(`Settings`)必须持久化到 `chrome.storage.local`**,SW 唤醒时主动 `loadSettings()` 恢复(不能只依赖 `onInstalled`/`onStartup`)。
- **每标签运行时状态(`TabState`)不持久化**(content script 会重新上报),SW 唤醒后靠 content script 的 `LUFS_REPORT` 自然重建。
- `handleMessage` 入口 `await initialSettingsLoaded`,确保任何应答前设置已就绪。

### 6.3 Popup UI(Vue 3 + Pinia)

| 组件 | 功能 |
|---|---|
| `AutoBalance.vue` | 总开关 + 目标 LUFS 滑块(-60~0)+ 状态文案 |
| `TabList.vue` | 当前已接管的标签列表(只读)+ 每行 mute / solo 按钮 + 实时 gain 显示 |
| `Limiter.vue`(可选,折叠) | 输出限幅器(threshold/knee/ratio/attack/release) |

#### 6.3.1 关键 UX 改进

- **gain 实时显示**:TabList 每行显示当前 appliedGainDb(+5.2 dB / -3.0 dB),让用户"看到"平衡在工作(光靠耳朵不直观)。
- **目标滑块双向生效提示**:明确告知"往左拖=整体更安静,往右拖=整体更响"。
- **状态文案**:Balancing 3 tabs / Waiting / Disabled。

### 6.4 消息协议(契约)

所有消息 TypeScript 强类型,SW 和 content script 共享类型定义。

**Content → SW(notification,无需响应):**
```ts
{ type: 'LUFS_REPORT', tabId, shortTerm, blockCount }
{ type: 'TAB_UNLOAD', tabId }
{ type: 'MEDIA_ATTACHED', tabId, title, url }   // content script 接管成功
```

**SW → Content(广播或定向):**
```ts
{ type: 'SET_GAIN', tabId, gainDb }
{ type: 'SET_CONFIG', target, enabled }
{ type: 'SET_MUTED', tabId, muted }
{ type: 'SET_SOLO', soloTabId }
```

**Popup ↔ SW(请求/响应):**
```ts
// popup → SW
{ type: 'GET_STATE' }                              → { tabs, settings }
{ type: 'SET_TARGET_LUFS', targetLufs }            → { settings }
{ type: 'SET_ENABLED', enabled }                   → { settings }
{ type: 'TOGGLE_MUTE', tabId }                     → { tabs }
{ type: 'TOGGLE_SOLO', tabId }                     → { settings }
{ type: 'SET_LIMITER', settings }                  → { limiter }
```

> 注意:content script 不能直接收到 SW 的 `sendMessage`(除非用 `tabs.sendMessage`)。SW 给 content script 发指令要用 `chrome.tabs.sendMessage(tabId, msg)`。协议里要分清 `runtime.sendMessage`(同扩展 SW/popup)和 `tabs.sendMessage`(SW → content)。

### 6.5 响度测量(LUFS)

**测量核心**:
- `src/audio/lufs.ts`:`LufsCalculator` 类(BS.1770-4 K-weighting + gating,纯 TS)。
- `src/worklets/lufs-processor.ts`:AudioWorklet 实现(实时,低开销)。

**决策量**:用 **short-term LUFS**(3 秒滑动窗口),不用 integrated(太慢)。这是 EBU R128 实时表的量,适合实时平衡。`MIN_BLOCKS` 设 3(~300ms)即开始平衡,响应快。

### 6.6 平衡算法

**复用** `computeBalanceGains(tabs, target, soloTabId)`:
- 非 capturing 的 tab:跳过。
- solo 模式:非 solo tab → gain = -100(静音)。
- 样本不足(< `MIN_BLOCKS_FOR_RELIABLE_LUFS`):跳过。
- shortTerm 非有限值:跳过。
- 否则:`gain = clamp(target - shortTerm, MIN_GAIN=-60, maxGainDb=+12)`。

### 6.7 增益应用与平滑

content script:
```js
gainNode.gain.setTargetAtTime(dbToGain(gainDb), ctx.currentTime, 0.05)
```
- `setTargetAtTime` 平滑过渡(50ms time constant),避免咔哒声。
- mute 直接设 gain = 0(或 gain = -100 dB),也走平滑。
- 与 SW 的 ~10 Hz 决策频率匹配。

---

## 7. 权限模型

```jsonc
{
  "permissions": ["storage", "tabs", "scripting", "alarms"],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["src/content/index.ts"],
    "run_at": "document_idle",
    "all_frames": false
  }]
}
```

| 权限 | 用途 |
|---|---|
| `storage` | 持久化设置 |
| `tabs` | 读 tab 标题/url、给 content script 发消息 |
| `scripting` | （可选）动态注入,处理 content_scripts 未覆盖的 SPA 路由 |
| `alarms` | 兜底:每分钟检查 content script 是否存活 |
| `host_permissions: <all_urls>` | content script 注入所有网站 + 读 url |
| `content_scripts` | 自动注入(核心,实现"自动") |

**不用**:`tabCapture`、`activeTab`、`offscreen`——content script 方案完全不需要。

### 7.1 权限警告(用户安装/更新时)

`<all_urls>` + content script 会触发 Chrome 权限警告("读取和更改你访问的网站上的所有数据")。这是**功能必需**,无法绕过。在 README 和商店描述里**诚实说明**用途(只读媒体音量、不上传任何数据)。

---

## 8. 网站匹配与注入策略

- **默认 `<all_urls>`**:最大化"装了就忘"体验。任何有 `<video>`/`<audio>` 的页面自动接管。
- content script 启动时先 `document.querySelector('video, audio')`,**没有媒体元素就立刻退出**(几乎零开销,不浪费资源)。
- **未来可加用户黑名单**(某些网站用户不想被接管),存 storage,content script 启动时自查 url。

---

## 9. 配置参数(可调旋钮)

| 参数 | 默认 | 说明 |
|---|---|---|
| `targetLufs` | -14 | 目标响度(slider -60~0) |
| `maxGainDb` | +12 | 单 tab 增益上限(防爆底噪) |
| `minGainDb` | -60 | 单 tab 增益下限 |
| `MIN_BLOCKS_FOR_RELIABLE_LUFS` | 3 | 几个块后开始平衡(响应速度) |
| `BALANCE_THROTTLE_MS` | 100 | 决策节流 |
| `GAIN_SMOOTH_TC` | 0.05 | gain 平滑 timeConstant(秒) |
| `LUFS_REPORT_HZ` | 10 | content script 上报频率 |
| `soloMuteGain` | -100 | solo 模式下非 solo tab 的 gain |
| `alarms scan period` | 1 min | 兜底检查周期 |

这些应集中在一个 `src/config.ts`,便于调优。

---

## 10. 限制与边界情况

### 10.1 DRM 内容(已知不可解)

Netflix、Disney+ 等的高清流使用 EME/DRM。Chrome 出于防盗版,**会对 `createMediaElementSource` 接管后的音频强制静音**(输出 destination 听不到)。**这是浏览器层面的限制,无法绕过。**

缓解:
- 检测到静音(`AnalyserNode` 有数据但用户听不到)时,popup 提示"该网站受 DRM 保护,无法调整"。
- 维护已知 DRM 站点黑名单,这些站点 content script 主动跳过(不接管,让原生播放)。
- 文档明确说明。

### 10.2 Autoplay policy

`AudioContext` 需用户手势激活。处理见 §6.1.3。实际影响小(用户本就主动点播放)。

### 10.3 SPA 导航(YouTube 切视频等)

URL 变化但页面不刷新,`<video>` 元素可能被复用或替换。`MutationObserver` 处理元素替换;同时监听 `popstate`/`pushstate` 处理路由变化。

### 10.4 多媒体元素(主视频 + 广告 + 预览)

全接管但只上报主元素的 LUFS。判断"主元素"启发式:`videoWidth` 最大、`duration` 最长、可见(`offsetParent !== null`)、非 muted。取并集最优。

### 10.5 页面已用 `createMediaElementSource`

少数页面(自带音频可视化的)可能已对同一 `<video>` 调过 `createMediaElementSource`,再次调用会抛 `InvalidStateError`。处理:`try/catch`,失败则**降级到直接调 `mediaEl.volume`**(只能 0~1,不能放大,但至少能降)。

### 10.6 跨域 iframe

`all_frames: false` 默认只注入顶层框架。视频网站的播放器通常在顶层或同源 iframe。如发现遗漏,可针对性 `all_frames: true`(性能权衡)。

### 10.7 Service Worker 休眠

见 §6.2.3。设置持久化 + 唤醒加载 + content script 自动重建运行时状态。

---

## 11. 测试策略

遵循 **TDD**(Red-Green-Refactor),所有纯逻辑先写测试。

### 11.1 单元测试(Vitest + jsdom)

| 模块 | 测试 |
|---|---|
| `computeBalanceGains` | 12 个用例(各种 clamp/skip/solo) |
| `LufsCalculator` | 24 个用例(K-weighting、gating、block cap) |
| `lufs-processor` worklet | 复用 7 个用例 |
| content script 的媒体选择逻辑 | 抽成纯函数 `pickPrimaryMedia(elements)` 测试 |
| `shouldThrottleBalance` | 节流逻辑 |

### 11.2 集成测试

- SW 消息处理:mock `chrome.*`,`handleMessage` 各消息类型。
- content script ↔ SW 协议:模拟 `LUFS_REPORT` → `SET_GAIN` 链路。

### 11.3 端到端(手动 + 可选 Playwright)

真实浏览器验证(无法自动化 DRM 等):
- 准备测试音源(`tools/loudness-test.html`,粉噪 + 可控增益)。
- 多 tab 场景:两个标签不同增益 → 平衡后响度趋近。
- 重启浏览器 → 自动恢复。
- SPA 导航(YouTube 切视频)→ 持续工作。
- DRM 站点(Netflix)→ 优雅降级。

### 11.4 Definition of Done

- [ ] `pnpm type-check` 绿
- [ ] `pnpm lint` 绿
- [ ] `pnpm test:unit` 全绿
- [ ] `pnpm build` 成功,产出可加载的 unpacked 扩展 + zip
- [ ] 真实浏览器手动验证 §11.3 全部通过
- [ ] README + 商店描述诚实说明权限与 DRM 限制

---

## 12. 实现路线图

按里程碑交付,每个 M 可独立验证。

### M0 — 项目脚手架(0.5 天)
- Vite + CRXJS + Vue 3 + TS + Vitest 项目初始化
- manifest(content_scripts + host_permissions)
- 目录结构(见 §14)

### M1 — content script 单 tab 接管(1 天)
- media 元素发现 + MutationObserver
- createMediaElementSource + GainNode 音频图
- 手动设 gain 验证能改变音量
- autoplay/ctx.resume 处理

### M2 — 响度测量(1 天)
- 集成 `lufs-processor.ts`(复用)
- 测出 short-term LUFS,console 打印验证

### M3 — SW 协调 + 多 tab 平衡(1.5 天)
- 消息协议实现
- `computeBalanceGains` 集成
- 多 tab 平衡验证(测试页双标签)
- 设置持久化 + SW 休眠恢复

### M4 — Popup UI(1 天)
- Popup 组件(AutoBalance / Limiter / TabList)
- gain 实时显示
- mute / solo

### M5 — 打磨与边界(1.5 天)
- DRM 检测与降级
- SPA 导航鲁棒性
- 多媒体元素选择
- 性能 profiling
- 文档(README + 商店)

**预估总计:~6.5 人天**(熟悉代码库前提下)。

---

## 13. 技术栈

| 层 | 技术 |
|---|---|
| UI | Vue 3 (Composition API) + Pinia |
| 语言 | TypeScript (strict) |
| 构建 | Vite + @crxjs/vite-plugin |
| 测试 | Vitest + @vue/test-utils + jsdom |
| 音频 | Web Audio API + AudioWorklet |
| i18n | vue-i18n(中/英) |
| 代码质量 | ESLint + Prettier |

---

## 14. 目录结构(提议)

```
EqualLoud/
├── PRD.md                      # 本文档
├── AGENT.md                    # 给 coding agent 的开发指南
├── README.md
├── manifest.config.ts
├── vite.config.ts
├── vitest.config.ts
├── package.json
├── tsconfig*.json
├── src/
│   ├── background.ts           # service worker(协调器)
│   ├── content/
│   │   ├── index.ts            # content script 入口
│   │   ├── media-manager.ts    # 媒体发现 + MutationObserver
│   │   ├── audio-graph.ts      # createMediaElementSource + GainNode
│   │   └── messenger.ts        # 与 SW 通信
│   ├── audio/
│   │   ├── lufs.ts             # BS.1770 测量
│   │   ├── balance.ts          # 复用:computeBalanceGains 等
│   │   └── config.ts           # 可调参数
│   ├── worklets/
│   │   └── lufs-processor.ts   # 复用
│   ├── messages/
│   │   └── protocol.ts         # 共享消息类型(契约)
│   ├── stores/
│   │   ├── tabs.ts             # 复用(改造)
│   │   └── settings.ts
│   ├── components/
│   │   ├── AutoBalance.vue     # 复用
│   │   ├── TabList.vue         # 复用 + gain 显示
│   │   └── Limiter.vue         # 复用
│   ├── App.vue / main.ts / i18n.ts / locales/
│   └── __tests__/              # 测试
├── tools/
│   └── loudness-test.html      # 复用测试音源
└── release/                    # 打包产物
```

---

## 15. 模块清单

| 文件 | 职责 |
|---|---|
| `src/audio/lufs.ts` | BS.1770 算法(纯 TS,无 DOM/Chrome 依赖) |
| `src/worklets/lufs-processor.ts` | AudioWorklet 实时测量节点 |
| `src/audio/balance.ts` | `computeBalanceGains` 等纯函数 |
| `src/components/AutoBalance.vue` | 总开关 + 目标 LUFS 滑块 |
| `src/components/Limiter.vue` | 输出限幅器设置 |
| `src/components/TabList.vue` | 标签列表 + gain 实时显示 |
| `src/stores/settings.ts` | 设置 store(locale 持久化) |
| `src/stores/tabs.ts` | 标签 store(popup↔SW 通信) |
| `src/i18n.ts` + `locales/` | 国际化(中/英) |
| `src/__tests__/lufs-calculator.spec.ts` | 24 用例 |
| `src/__tests__/lufs-processor.spec.ts` | 7 用例 |
| `src/__tests__/balance.spec.ts` | 12 用例 |
| `src/__tests__/components/*.spec.ts` | 组件测试 |
| `tools/loudness-test.html` | 测试音源(粉噪 + 可控增益) |
| `vitest.config.ts` / `tsconfig` | 测试与类型配置 |

**content-script 方案独有**(无 tabCapture / offscreen 层):
- `src/background.ts`(SW 协调器)
- `src/content/`(content script:媒体接管、音频图、消息桥)
- `src/messages/protocol.ts`(共享消息契约)
- `manifest.config.ts`(content_scripts + host_permissions)

---

## 16. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| DRM 站点失效 | 高 | 中 | 黑名单 + 降级提示(§10.1) |
| 网站改版导致 `<video>` 选择器失效 | 中 | 高 | MutationObserver + 多选择器兜底 + 主元素启发式(§10.4) |
| `createMediaElementSource` 与页面冲突 | 低 | 中 | try/catch 降级到 `volume`(§10.5) |
| 性能(多 tab 各跑 LUFS worklet) | 中 | 中 | worklet 轻量(~5KB);如需要可降采样/降频率 |
| Chrome 未来改 autoplay 策略 | 低 | 中 | 持续跟进,文档记录 |
| 商店审核因 `<all_urls>` 被拒 | 低 | 高 | 商店描述明确用途 + 隐私政策(不上传数据) |

---

## 17. 开放问题(Open Questions)

1. **Limiter 是否保留?** content script 方案下,gain 可能 > 1 导致削波。建议**默认开启 limiter**(threshold -1 dB),防提升后削波。待评审。
2. **是否暴露 maxGainDb 给用户?** 当前默认 +12。是否加高级设置?建议先固定,后续按反馈加。
3. **黑名单 UI?** 是否在 popup 提供"此网站不接管"开关?建议 M5 后按需加。
4. **Edge / 其他 Chromium 兼容?** content script + Web Audio 是标准,理论兼容。需实测。

---

## 18. 参考资料

- Chrome `tabCapture` 文档(限制来源):https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- `createMediaElementSource` MDN:https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaElementSource
- ITU-R BS.1770-4(响度算法标准)
- EBU R128(响度归一化实践)
- Stack Overflow: Properly using chrome.tabCapture in a manifest v3 extension(MV3 限制讨论)

---

## 附录 A:术语表

| 术语 | 含义 |
|---|---|
| LUFS | Loudness Units Full Scale,感知响度单位 |
| short-term LUFS | 3 秒滑动窗口响度(实时用) |
| integrated LUFS | 全程累积响度(统计用,慢) |
| K-weighting | BS.1770 的频率加权(模拟人耳) |
| gain | 增益(dB),0=不变,正=放大,负=衰减 |
| content script | 扩展注入页面的 JS,可访问 DOM |
| service worker | 扩展后台脚本(MV3,会休眠) |
| offscreen document | MV3 用于跑 DOM API 的隐藏页(content 方案下不再需要) |

---

*文档结束。评审通过后,按 §12 路线图开始 M0 实现。*
