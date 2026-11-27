# A9 性能基础修复与验收记录

2026-11-27。分支 release/a9-rc1，HEAD 500b154；本轮未提交、推送、合并或发布。

## 结论

本轮基础修复与测量工具验收通过。首屏速度没有显示出可信的整体改善，不能宣称“提速 20%–30%”。实盘冷启动中位数约 2.8 秒、同一浏览器上下文再次打开约 1.5 秒。尚未进行首屏 JS/CSS 拆分。

## 已修复

- 恢复被此前 stash 一并收走的 app.js 与 data.js。恢复前逐文件确认工作区与 stash 父版本一致；保留原 stash 和仓库外备份，没有执行 stash pop。原有顶栏快捷菜单与测试网标识已恢复。
- 请求去重使用完整身份，修复只比较认证前 32 个字符可能串用结果的问题；同时隔离模式、网络、API 地址、方法、头与超时。只合并在途 GET/HEAD，不缓存业务结果，不合并写请求。
- 成功、网络失败、超时、服务端拒绝均清理在途记录；真实模块测试验证失败后可重试，无未处理 rejection。
- 数据与页面就绪分别发事件；页面就绪检查路由序号、容器仍在文档中且没有骨架屏，避免旧页面误报。
- 测量器使用实际被测页 CDP 限速、PerformanceObserver、真实 DOM/样式及双帧等待。切页等待新路由容器，不能只检查 hash。
- 冒烟测试改成本地受控页面，调用同一个正式测量函数；验证延迟、超时、页面错误、样本不足和不同条件的对比拒绝。旧 v1/quick 入口统一转到同一实现。

## 浏览器对照

前后各 6 场景 × 5 次有效采样，共 60 次。条件：390×844、中文亮色、4× CPU、下载 1,250,000 B/s、上传 625,000 B/s、100ms 延迟。相同端口 8118 顺序托管仓库外固定快照；只读 API 代理至独立 Testnet 候选 Worker。

基线是保留已验收 UI、去掉本轮去重与测量标记的固定副本，**不是纯 HEAD 500b154**。完整源码清单与 SHA-256 写在原始 JSON 中。

首屏可见时间（ms，中位数，括号为最小–最大）：

| 场景 | 修复前 | 修复后 |
| --- | ---: | ---: |
| Live 冷启动（无钱包） | 2797（2652–5331） | 2820（2766–4148） |
| Live 同一上下文再次打开 | 1471（1451–1507） | 1459（1436–3792） |
| Demo 冷启动 | 2759（2654–2786） | 2711（2635–2824） |
| Tab 首进场景的首屏 | 2560（2539–2698） | 2643（2584–2724） |
| Tab 缓存场景的首屏 | 2793（2611–2857） | 2724（2623–2727） |
| 合成 Telegram fragment 启动 | 2826（2736–3601） | 2575（2537–2710） |

四 Tab 切页时间（ms，中位数）：

| 场景 / 路由 | 修复前 | 修复后 |
| --- | ---: | ---: |
| tab-first · #/round | 572 | 576 |
| tab-first · #/team | 565 | 564 |
| tab-first · #/profile | 364 | 366 |
| tab-first · #/challenge | 51 | 51 |
| tab-cached · #/round | 66 | 67 |
| tab-cached · #/team | 64 | 65 |
| tab-cached · #/profile | 49 | 47 |
| tab-cached · #/challenge | 49 | 50 |

Live 首屏 JS 解码体积 283,721 → 286,076 B（增加 2,355 B）；CSS 均为 194,195 B。新增去重与可观测代码有体积成本，本轮并未减少启动资源。Live 的 10 次样本中均未加载 demo-data.js。资源解码量不是压缩传输量，跨域 transferSize=0 也不能当成零流量。

公网读取、进程预热与机器调度仍有波动；合成 fragment 的中位数差异不能单独归因于此次改动。Live 再开不代表真实钱包恢复，LCP/CLS 仅统计至测量检查点。这里没有声称完成 iOS/Android 真机、真实钱包会话、额外慢网档位或整段交互性能验收。

## 验证

- Node 必跑基线、请求层回归与相关 Ops 专项合并执行：99/99 通过，0 失败、0 跳过。
- Python Bot：4/4；v17 与 v16 合约哈希：8/8 OK。
- 浏览器回归：54 项通过，覆盖中英文、亮暗、窄屏、跳转、断网重试、只读禁签与待激活入口。
- 性能冒烟测试通过；真实应用检查数据就绪先于页面就绪，页面就绪时已有内容且无骨架屏。
- 本轮变更空白检查通过。其他窗口已有文件完整保留。

## 原始证据

- [优化前样本及源码指纹](/Users/yu1/.local/share/a9-perf-recovery/results/baseline-before-foundation.json)
- [优化后样本及源码指纹](/Users/yu1/.local/share/a9-perf-recovery/results/baseline-after-foundation.json)
- [对照结果](/Users/yu1/.local/share/a9-perf-recovery/results/comparison.json)
- [浏览器验收截图目录](/Users/yu1/.local/share/a9-perf-recovery/browser)

后续按性能计划分阶段拆分非首屏资源，每阶段重新测量与验收。四道资金总闸、钱包签名守卫、合约和生产配置本轮均未修改；没有候选或生产发布。

## 本轮收尾状态

- 本轮「基础修复、测量工具校正、同条件采样与回归验收」已完成并收尾。
- 收尾复核：分支仍为 release/a9-rc1，HEAD 500b154；全工作区 git diff --check 无告警；本轮临时 8118 服务已关闭。
- 未提交、未推送、未发布。工作区保留本轮及其他窗口的改动，不能称为干净工作区。
- 原 stash 与仓库外恢复备份继续保留，未经逐项确认不删除、不 pop。
- 性能结果是有效基线，不是明显提速验收通过；启动资源拆分作为下一项独立任务。

下一项建议顺序：先定位首屏非必需模块及各页面样式覆盖率 → 优先拆分音频与复杂组件 → 按覆盖率拆页面 CSS → 每步同条件复测与全栈回归 → 验收后再安排独立候选发布与真机复测。钱包模块进一步拆分、内容指纹缓存及主网上线均不纳入本轮收尾。

---

## 小程序首屏资源优化（阶段 A / B / C 及复核修正）

2026-11-27。分支 `release/a9-rc1`，HEAD `500b154170c92007ad45bb4d9a61f1c4abb0be6b`；本轮未提交、未推送、未合并、未发布；工作区其他窗口改动及 `stash@{0}` 完整保留。

### 盘点与结论

- **静态依赖与覆盖率**：`audio.js`（14,877 B）与 `components.js`（40,335 B）原均进入广场首屏启动链；`chest-theater.js`（54,807 B）已在商城路由按需加载，无需重复改造。CDP 全站 CSS 覆盖率（16 路由 × 亮暗主题 × 390×844 & 320×568）表明，`game.css`（48,700 B）、`wealthverse.css`（39,103 B）、`animations.css`（33,652 B）合计 121,455 B 在广场冷启动时仅命中 672 B（0.3%–1.0%）。
- **资源体积与请求收益（Live 冷启动，最终快照 `final-v2`）**：首屏 JS 解码量 `286,076 B → 259,196 B`（净减 `26,880 B` / `-9.4%`），首屏 CSS 解码量 `194,195 B → 75,711 B`（净减 `118,484 B` / `-61.0%`），首屏 JS+CSS 合计净减 `145,364 B`（`-30.3%`），首屏请求数 `30 → 28`，CLS 保持 `0.0000`。
- **首屏耗时结论**：`live-warm`（同一上下文再次打开）中位数 `1,458 ms → 1,404 ms`（FCP `1,040 ms → 984 ms`）；冷启动各场景变化位于 `-5.4% ~ +0.8%` 波动区间，**冷启动整体未证明显著提速**。关于 `index.html` 中同步外链脚本 `https://telegram.org/js/telegram-web-app.js` 是否为冷启动 FCP 主要瓶颈，现有数据不足以确定其独立影响，标为**待控制实验验证的判断**（本次未改动其加载方式）。
- **首次使用功能转移成本（最终快照 `final-v2`）**：
  - 首次开启音效按需加载 `audio-engine.js`（15,354 B）：中位数 `131.9 ms`（`130.8–365.0 ms`，默认静音 0 加载）。
  - 首次切入 `#/round`（并发加载 `components-heavy.js` + 全部 3 份页面样式）：`558 ms → 709 ms`（`+151 ms`）。
  - 首次切入 `#/team`（样式已在 `#/round` 就绪）：`550 ms → 583 ms`（`+33 ms`）。
  - 首次切入 `#/profile`：`365 ms → 366 ms`（`+1 ms`）。
  - 缓存切回 4 主 Tab：`64 / 66 / 48 / 49 ms`（与优化前 `67 / 65 / 49 / 50 ms` 持平，零骨架屏闪烁）。

### 阶段实现与独立证据目录

- **阶段 A**：`a9-mini-app/js/audio.js` 精简为外观层（4,938 B），Web Audio 合成器与 3D 典藏卡反光拆至 `a9-mini-app/js/audio-engine.js`（15,354 B）；默认静音零加载、并发去重、失败可重试、手势同步预解锁 `AudioContext`。
- **阶段 B**：`a9-mini-app/js/components.js` 精简至 18,138 B（保留全部公共工具与弹层焦点/键盘/滚动锁），11 个非首屏复杂组件（滑块、12H 印章雷达、粒子、金币抛物线、滚轮数字、sparkline 等）迁至 `a9-mini-app/js/components-heavy.js`（24,396 B）。
- **阶段 C（含复核补齐）**：新增 `a9-mini-app/js/css-loader.js`（3,347 B，并发去重、失败移除残留 `<link>` 可重试、同步就绪判定），`index.html` 首屏仅保留 `tokens.css` 与 `components.css`（末尾补齐首屏刚需的基础动效、概览条与全局减弱动态规则），`router.js` 所有非广场路由统一并行加载 `game.css` + `wealthverse.css` + `animations.css`（修复 `#/round` 冷开漏载 `.alert-red-mode` 等跨文件样式问题），`app.js` 保留 `routeRenderSeq` 防快切覆盖与缓存切回纯同步零闪烁路径。
- **独立快照与证据目录**：`/Users/yu1/.local/share/a9-perf-first-screen-20261127/`（未触碰原 `/Users/yu1/.local/share/a9-perf-recovery/`）
  - 优化前快照清单：`before.sha256`（`1636141a83dcbd755eed9eb412242ceb02c9bfb9f418a869be1d82ccd8ce4e85`）
  - 阶段 A 快照清单：`stage-a.sha256`（`11506dcaef06e60c2a535cd8c13fc34a6a3c848e6d40221ed342d78c9e9abcfa`）
  - 阶段 B 快照清单：`stage-b.sha256`（`752acf8aab75713421df3a523ad0fdd91e6a2e0a452a43e619e7a2b6b0ddc8b2`）
  - 最终快照清单：`final-v2.sha256`（`bbe9aebe5ad5951f63e9dacb540bcbcd91208e96a498eae155b012f2fb68eebf`）
  - 原始样本：`results/baseline-before-1636141a.json`、`baseline-stage-a-11506dca.json`、`baseline-stage-b-752acf8a.json`、`baseline-final-v2-bbe9aebe.json`、`final-v2-audio-first-use.json`、`coverage-audit-before.json`
  - 浏览器截图：`browser/wealthverse-v2/`（54 项回归）与 `browser/e2e-v2/`（12 项严格专项验收）

### 回归验收结果（最终快照 `final-v2`）

- Node 全栈必跑基线 + `data.test.mjs` + `lazy-loaders.test.mjs`：83/83 通过，0 失败、0 跳过。
- Python Bot：4/4 通过；v17/v16 合约哈希：8/8 OK；性能冒烟测试通过；`git diff --check` 无告警。
- 浏览器回归：`wealthverse-browser.mjs` 54/54 通过；严格版专项浏览器验收 `browser-e2e-verify.mjs` 12/12 通过（零静默跳过：覆盖 `#/challenge` 111 节点 / `#/round` 257 节点 / `#/gallery` 35 节点 / `#/rewards` 54 节点“直接冷开 vs 跨页返回”计算样式 0 差异及 `.alert-red-mode` 规则存在、真实 `#btn-header-more` 弹层打开/焦点陷阱/`Escape` 焦点归还、`reduced-motion` `animationDuration=1e-06s` 与 `transitionDuration=1e-06s` 显式断言、真实 `#btn-buy-chest` 启动 `#ct-shell` 开箱剧场可见断言、快速切页、缓存切回零骨架屏闪烁、3G 慢网与样式失败重试）。
- 未覆盖项：真实钱包会话恢复、Telegram iOS/Android 真机复测均需在独立 Testnet 候选发布后单独验收。
