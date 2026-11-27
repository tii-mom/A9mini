# A9 小程序用户体验优化 — 阶段 0 基线与核查报告（只读）

- **日期**：2026-11-27
- **分支 / 基线提交**：`release/a9-rc1`（`26b8eeb`）
- **核查对象**：
  - 源码仓库：`/Users/yu1/Desktop/A9mini`（只读核查，本阶段未修改任何业务代码、合约、迁移或配置）
  - 候选线上前端：`https://a9-v17-testnet-candidate.pages.dev`
  - 候选线上 Worker：`https://a9-v17-testnet-candidate.348421501.workers.dev`
  - 测试 Bot：`@A9_TestnetBot`

> [!IMPORTANT]
> **候选环境现状前置报告（严格遵循不覆盖红线）**
> 只读探测确认候选线上环境当前存在临时配置：
> - 候选 Pages `runtime-config.js`：`liveFundsEnabled: true`、`network: "testnet"`、`botHandle: "A9_TestnetBot"`；
> - 候选 Worker `/api/config`：`presaleHotWallet.open: true`、`chestMall.openEnabled: false`、`poolState.currentRoundId: 6`（`SUCCEEDED`）；
> - 仓库 `worker/wrangler.toml` 与 `a9-mini-app/js/runtime-config.js` 中四道生产总闸均保持关闭，本阶段及后续阶段均不触碰、不覆盖候选环境配置。

---

## 0.1 首屏与钱包性能基线 + Network 瀑布图

### 测量说明与真机限制
- **已完成自动化移动视口基线**：在本机使用 Chrome Headless（`390×844` 移动端视口、`zh-CN`、亮色主题）直连候选线上 `https://a9-v17-testnet-candidate.pages.dev/`，只读加载（不触发任何交易或写操作），分两档网络各执行 **冷开 3 次（全新浏览器上下文）** 与 **重开 3 次（同上下文复用 HTTP 缓存）**：
  - **Wi-Fi 档**：当前真实网络，无额外节流；
  - **慢网档**：CDP `Fast 3G`（下行 `1.6 Mbps` / 上行 `750 Kbps` / RTT `150 ms` + `4× CPU` 降速）。
- **物理真机 `@A9_TestnetBot` 实测说明**：当前 macOS 开发环境无可用物理手机设备，无法直接操控真机上的 Telegram 客户端测时。下文已预留真机实测登记表，待业主在真机补测后填入对照（或在真机验证阶段补齐）。

### 口径定义
- **FCP**：浏览器 `first-contentful-paint`（首帧有内容绘制）。
- **T1（页面框架出现）**：`#app-header`（顶栏）与 `#app-tabbar`（底部导航）首次渲染出 DOM 子节点。
- **T2（当前轮数据可见）**：`#app-main` 渲染出当前轮次真实数据卡片（`.plaza-overview`），且不再显示 `.nt-boot-skeleton` 或「正在读取当前轮次…」。
- **T3（钱包可连接）**：拆为两项观测，真实反映用户体感：
  - `T3-按钮`：顶栏「连接钱包」按钮可点击时间（此时打开弹层会看到 `SDK NOT READY`，尚未下载 SDK）；
  - `SDK 下载耗时`：打开弹层后点击连接按钮触发 `tonconnect-ui.min.js`（96 KB gzip / 324 KB decoded）下载并实例化 `TonConnectUI` 的增量耗时；
  - `T3-含 SDK 就绪` = `T3-按钮 + SDK 下载耗时`。

### 浏览器移动视口基线汇总（中位数 + 3 次原始值，单位：ms）

| 网络档位 | 打开方式 | 轮次 | FCP | T1 页面框架 | T2 当前轮数据可见 | T3 钱包按钮可点 | 钱包 SDK 下载增量 | T3 含 SDK 就绪估算 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **Wi-Fi** | **冷开** | #1 | 2,832 | 2,776 | 6,317 | 2,776 | 303 | 3,079 |
| Wi-Fi | 冷开 | #2 | 2,556 | 2,528 | 4,622 | 2,528 | 316 | 2,844 |
| Wi-Fi | 冷开 | #3 | 2,432 | 2,410 | 4,367 | 2,410 | 263 | 2,673 |
| **Wi-Fi** | **冷开中位数** | **Median** | **2,556** | **2,528** | **4,622** | **2,528** | **303** | **2,844** |
| **Wi-Fi** | **重开** | #1 | 812 | 778 | 1,211 | 778 | 432 | 1,210 |
| Wi-Fi | 重开 | #2 | 472 | 446 | 894 | 446 | 185 | 631 |
| Wi-Fi | 重开 | #3 | 680 | 657 | 1,022 | 657 | 143 | 800 |
| **Wi-Fi** | **重开中位数** | **Median** | **680** | **657** | **1,022** | **657** | **185** | **800** |
| **慢网 (Fast 3G)** | **冷开** | #1 | 3,420 | 3,339 | 5,524 | 3,339 | 716 | 4,055 |
| 慢网 (Fast 3G) | 冷开 | #2 | 3,172 | 3,064 | 5,304 | 3,064 | 765 | 3,829 |
| 慢网 (Fast 3G) | 冷开 | #3 | 3,868 | 3,793 | 7,590 | 3,793 | 778 | 4,571 |
| **慢网 (Fast 3G)** | **冷开中位数** | **Median** | **3,420** | **3,339** | **5,524** | **3,339** | **765** | **4,055** |
| **慢网 (Fast 3G)** | **重开** | #1 | 920 | 845 | 1,424 | 845 | 258 | 1,103 |
| 慢网 (Fast 3G) | 重开 | #2 | 908 | 832 | 1,413 | 832 | 258 | 1,090 |
| 慢网 (Fast 3G) | 重开 | #3 | 884 | 802 | 1,469 | 802 | 299 | 1,101 |
| **慢网 (Fast 3G)** | **重开中位数** | **Median** | **908** | **832** | **1,424** | **832** | **258** | **1,101** |

> 附注：全部冷开/重开样本点击顶栏「连接钱包」打开弹层时，页面均出现 `SDK NOT READY` 与 `DISCONNECTED` 工程状态字。

### 核心 API 耗时核查（实际路由为复数 `/api/rounds/:id`，单数 `/api/round/:id` 为 404）

| 场景 | `telegram-web-app.js` 中位数 | `GET /api/config` 中位数 | `GET /api/rounds` 中位数 | `GET /api/rounds/6` 中位数 |
|---|---:|---:|---:|---:|
| Wi-Fi 冷开 | 1,611 ms | 1,759 ms | 1,726 ms | 164 ms |
| Wi-Fi 重开 | 1 ms（缓存） | 144 ms | 139 ms | 153 ms |
| 慢网冷开 | 1,796 ms | 1,751 ms | 1,744 ms | 162 ms |
| 慢网重开 | 1 ms（缓存） | 175 ms | 164 ms | 153 ms |

> 补充单次 `curl` 冷连接探测：`GET /api/warmup/current` 耗时 `3,934 ms`、`GET /api/rounds/6` 冷连接 `3,409 ms`、`GET /api/rounds` `1,410 ms`。在浏览器中，`/api/config` 与 `/api/rounds` 承担了到 `workers.dev` 的首次 DNS + TLS + Worker 冷启动开销（1.1s–3.3s），随后的 `/api/rounds/6` 复用长连接仅需 `146–169 ms`。

### Network 瀑布图（典型样本：Wi-Fi Cold #2 与 Slow Cold #2）

#### Wi-Fi Cold #2 关键请求瀑布（总计 T2 = 4,622 ms）
| 序号 | 资源路径 | 来源主机 | Start (ms) | Duration (ms) | End (ms) | Transfer / Decoded (B) | 关键瓶颈说明 |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | `/css/tokens.css?v=17.1-rc1` | pages.dev | 562 | 113 | 674 | 2,627 / 6,035 | 早早完成 |
| 2 | `/js/runtime-config.js` | pages.dev | 562 | 120 | 682 | 608 / 416 | 早早完成 |
| 3 | `/css/components.css?v=17.1-rc1` | pages.dev | 562 | 152 | 714 | 14,571 / 69,676 | 早早完成 |
| 4 | `/js/app.js` | pages.dev | 562 | 215 | 777 | 17,612 / 54,401 | 777ms 已下载完毕，但**被 L23 同步脚本卡死无法解析模块依赖** |
| 5 | `/js/telegram-web-app.js` | telegram.org | 562 | **1,616** | **2,177** | cross-origin | **同步阻塞 `<head>` 1.62 秒**，造成整屏白屏并拖延 `data.js` 拉取 |
| 6 | `/js/data.js` | pages.dev | **2,193** | 198 | 2,391 | 12,749 / 37,685 | 等 `telegram-web-app.js` 执行完才发出请求 |
| 7 | `/api/config` | workers.dev | 2,527 | **1,759** | 4,287 | cross-origin | 此时页面整屏仅显示「正在读取当前轮次…」进度条 |
| 8 | `/api/rounds` | workers.dev | 2,528 | **1,726** | 4,254 | cross-origin | 与 `/api/config` 并发，其实已含当前轮核心字段 |
| 9 | `/api/rounds/6` | workers.dev | 4,287 | 169 | 4,456 | cross-origin | 串行第二跳，阻挡了 `config + rounds` 先渲染 |
| 10 | `/js/pages/plaza.js` | pages.dev | **4,458** | 139 | 4,597 | 5,648 / 14,929 | **直到 `dataReady=true` 才开始动态 import**，白白串行在所有 API 之后 |
| 11 | `/js/vendor/tonconnect-ui.min.js` | pages.dev | 4,783 | 254 | 5,037 | 96,058 / 324,640 | 打开弹层时尚未加载，点击连接才下载 |

#### 慢网 (Fast 3G) Cold #2 关键请求瀑布（总计 T2 = 5,304 ms）
| 序号 | 资源路径 | 来源主机 | Start (ms) | Duration (ms) | End (ms) | Transfer / Decoded (B) |
|---:|---|---|---:|---:|---:|---:|
| 1 | `/css/tokens.css?v=17.1-rc1` | pages.dev | 619 | 204 | 823 | 2,627 / 6,035 |
| 2 | `/js/runtime-config.js` | pages.dev | 620 | 212 | 832 | 608 / 416 |
| 3 | `/css/components.css?v=17.1-rc1` | pages.dev | 620 | 347 | 966 | 14,506 / 69,676 |
| 4 | `/js/app.js` | pages.dev | 620 | 375 | 995 | 17,711 / 54,401 |
| 5 | `/js/telegram-web-app.js` | telegram.org | 619 | **1,562** | **2,182** | cross-origin |
| 6 | `/js/data.js` | pages.dev | 2,256 | 620 | 2,876 | 12,749 / 37,685 |
| 7 | `/api/config` | workers.dev | 3,060 | 1,117 | 4,177 | cross-origin |
| 8 | `/api/rounds` | workers.dev | 3,063 | 1,744 | 4,807 | cross-origin |
| 9 | `/api/rounds/6` | workers.dev | 4,810 | 162 | 4,972 | cross-origin |
| 10 | `/js/pages/plaza.js` | pages.dev | 4,977 | 244 | 5,222 | 5,648 / 14,929 |
| 11 | `/js/vendor/tonconnect-ui.min.js` | pages.dev | 5,513 | **675** | 6,188 | 96,098 / 324,640 |

### 真机 `@A9_TestnetBot` 基线预留登记表（待真机补测填入）
> 同一台手机、同一网络下，冷开（杀 Telegram 后台或清缓存后首次点菜单）与重开各测 3 次：

| 网络档位 | 打开方式 | T1 页面框架出现 (s) [3次 / 中位数] | T2 当前轮数据可见 (s) [3次 / 中位数] | T3 钱包可连接 (s) [3次 / 中位数] | 设备型号与系统 |
|---|---|---|---|---|---|
| Wi-Fi | 冷开 | 待真机补测 | 待真机补测 | 待真机补测 | 待填 |
| Wi-Fi | 重开 | 待真机补测 | 待真机补测 | 待真机补测 | 待填 |
| 慢网 (4G弱网/3G) | 冷开 | 待真机补测 | 待真机补测 | 待真机补测 | 待填 |
| 慢网 (4G弱网/3G) | 重开 | 待真机补测 | 待真机补测 | 待真机补测 | 待填 |

---

## 0.2 预热阶梯三方核对与根因定位（待业主确认后再改）

### 事实核查：三方对照表

| 核查维度 | 来源位置 | 实际参数 / 逻辑 | 对应各人数奖励（A9） | 是否一致 |
|---|---|---|---|---|
| **源码默认配置** | `worker/src/social-store.mjs:15-23`（`DEFAULT_WARMUP_ROUND_CONFIG`） | `chestMinInvites=2`、`chestMaxInvites=5`、`chestBaseA9Raw=300000000000` (300)、`chestStepA9Raw=200000000000` (200) | `1人=未解锁`、`2人=300`、`3人=500`、`4人=700`、`5人=900` | 基准默认 |
| **(a) 候选环境 `/api/warmup/current` 实际返回** | 实时探测 `GET https://a9-v17-testnet-candidate.348421501.workers.dev/api/warmup/current`（第 7 轮） | `roundId=7`、`targetUsers=100`、**`chestMinInvites=1`**、`chestMaxInvites=5`、`chestBaseA9Raw="300000000000"` (300)、**`chestStepA9Raw="100000000000"` (100)** | 按服务端参数线性公式：`1人=300`、`2人=400`、`3人=500`、`4人=600`、`5人=700` | 与源码默认不同（候选第 7 轮 D1 `warmup_rounds` 写入了自定义低门槛配置） |
| **(b) 前端阶梯渲染逻辑** | `a9-mini-app/js/pages/warmup_market.js:138-145, 216, 222, 227-232` | 1. **头尾动态计算**：`baseReq=1`、`baseUnlockA9=300`、`maxChestA9 = 300 + (5-1)*100 = 700`，于是标题/进度条渲染「满 1 人解锁 300 A9」「最高解锁 700 A9」「5 人 = 700 A9」；<br>2. **中间三档硬编码写死**（L228-230）：写死了 `<span>2 人 = 300 A9</span>`、`<span>3 人 = 500 A9</span>`、`<span>4 人 = 700 A9</span>`！ | 页面实际混合拼接出：**「满 1 人解锁 300 A9」 + 「2 人 = 300 / 3 人 = 500 / 4 人 = 700 / 5 人 = 700」** | **根因在此！前端把“动态头尾”和“写死默认中间档”拼在了一起，导致自相矛盾！** |
| **(c) Worker 实际发奖计算** | `worker/src/chest-engine.mjs:378-391` (`computeWarmupChestReward`) + `worker/src/d1-chest-store.mjs:148, 204-209, 501-507` | `cur < minInv` → 不可开箱（`ASSISTS_UNMET`）；`cur === minInv` → `base`；`minInv < cur <= maxInv` → `base + (cur - minInv) * step`；`cur > maxInv` → 封顶 `base + (maxInv - minInv) * step`。开箱实发 `baseA9Raw + boostA9Raw` 入 `PENDING_VAULT`（`warmup` 预算桶）。 | - 对候选第 7 轮（`min=1, step=100`）：**`1/2/3/4/5 人 = 300/400/500/600/700 A9`**<br>- 对默认轮次（`min=2, step=200`）：**`2/3/4/5 人 = 300/500/700/900 A9`** | 与服务端配置 `(a)` 完全自洽 |

> 附注（只读发现，不主动改后端）：`worker/src/d1-chest-store.mjs:184-224` 的 `syncWarmupChestProgress` 在某轮**开预热之后**如果中途修改了 `warmup_rounds` 表的 `chest_min_invites` 或 `chest_base_a9_raw`，已生成 `user_chests` 记录的 `required_assists` 与 `base_a9_raw` 不会同步更新，仅更新 `boost_a9_raw`。只要每轮预热配置在开启前确定且不中途修改即无影响。

### 明确修改建议（请业主确认）
1. **必改前端（`a9-mini-app/js/pages/warmup_market.js`）**：
   - 删除第 228–230 行的硬编码阶梯文案，改为**唯一基于 `/api/warmup/current` 返回的 `config`（`chestMinInvites`、`chestMaxInvites`、`chestBaseA9Raw`、`chestStepA9Raw`）动态生成所有阶梯节点**；
   - 增加单调递增校验（`min >= 1`、`max >= min`、`base > 0`，当 `max > min` 时 `step > 0`，且每一档金额严格大于前一档），任何非法或缺失配置均不猜测默认值，直接展示「配置待确认」。
2. **请业主确认运营口径（不改 Worker 源码，仅确认候选环境预期）**：
   - 候选环境第 7 轮 `min=1, step=100, max=5`（`1/2/3/4/5 人 = 300/400/500/600/700 A9`）是否为测试网有意降低体验门槛的临时配置？
   - **若是**：保持候选 D1 和 Worker 源码不动，阶段 4 仅修改前端动态渲染即可 100% 与后端发奖一致；
   - **若否**（希望候选第 7 轮也按默认 `2/3/4/5 人 = 300/500/700/900 A9`）：由于本任务红线不操作候选环境，需由业主另行通过候选管理接口更新第 7 轮 `warmup_rounds` 配置；前端采用动态渲染后两边均能自动正确展示。

---

## 0.3 `index.html:23` Telegram 脚本改 `defer` 验证结论（只读实验，未改源码）

### 源码依赖核查
- `index.html:21` `js/theme-init.js`（同步）：仅读 `localStorage.a9_ui_prefs_v1`，**不访问 `window.Telegram`**。
- `index.html:49` `js/runtime-config.js`（同步）：仅注入 `window.__A9_CONFIG__`，**不访问 `window.Telegram`**。
- `index.html:50` `js/app.js`（`<script type="module">`）：所有 `A9TMA.init()`、`A9TMA.parseStartParam()`、`A9TMA.getRawInitData()`、`A9TMA.getRealTelegramUser()`、`initAutoLanguage()` 均在此模块内执行。
- **HTML 规范执行顺序**：`<script defer>` 与 `<script type="module">` 共用同一个"文档解析完成后执行"队列，严格按 HTML 出现顺序执行。由于 `telegram-web-app.js`（L23）在 `app.js`（L50）之前，浏览器保证先执行完 `telegram-web-app.js` 再执行 `app.js`。

### 5 组本地浏览器对照实验结果（不修改磁盘源码，内存代理改写响应）
测试注入标准 Telegram 启动片段：`#tgWebAppData=...user={id:987654321,username:"qa_tester"}&start_param=warmup_7_ref888...&tgWebAppVersion=9.6&tgWebAppPlatform=ios`

| 实验组 | `tgSdk` 执行时间 | `tg.ready()` 调用 | 拿到 `initData` | 拿到 `user` 身份 | 拿到 `start_param` 与归因 `ref` | 最终路由 Hash | 结论 |
|---|---:|---|---|---|---|---|---|
| 1. `sync` + 800ms 延迟（现状） | 821 ms | 是 | 是 | `@qa_tester` (`987654321`) | `warmup_7_ref888` / `ref888` | `#/warmup?round=7` | 正常，但阻塞 `<head>` 解析与模块下载 |
| **2. `defer` + 800ms 延迟（方案）** | **814 ms** | **是** | **是** | **`@qa_tester` (`987654321`)** | **`warmup_7_ref888` / `ref888`** | **`#/warmup?round=7`** | **100% 正常拿到全部身份与深链！** |
| **3. `defer` + 0ms（热缓存）** | **35 ms** | **是** | **是** | **`@qa_tester` (`987654321`)** | **`warmup_7_ref888` / `ref888`** | **`#/warmup?round=7`** | **100% 正常，FCP = 84 ms** |
| 4. `async` + 800ms 延迟（反面验证） | 814 ms | **否** | 启动时缺失 | 启动时缺失 | `referrerIdInStore = null`（丢失） | 未跳转（滞留 `#tgWebAppData=...`） | **严禁使用 `async`！** 会导致 `app.js` 抢跑、丢归因与安全区 |
| 5. `defer` + CDN 503 失败降级 | N/A | 否 | 否（降级为非 TG 浏览器） | `null` | `null` | 进入广场（未白屏崩溃） | 安全降级 |

### 最终结论
1. **可以安全将 `index.html:23` 改为 `<script defer src="https://telegram.org/js/telegram-web-app.js"></script>`**（**严禁改为 `async`**）。
2. 改为 `defer` 后，`tma.js` 与 `app.js` **无需改动即可稳定拿到 `initData`、`start_param`、用户身份、安全区并触发 `tg.ready()`**，且不会破坏 `router.js:78-83` 对 `#tgWebAppData=` 的保护。
3. **收益与边界**：
   - **收益**：解除 `<head>` 解析阻塞，浏览器可立即解析 `<body>` 骨架与样式，并**提前 ~1.5 秒并行下载 `app.js` 的 ES Module 依赖树（`data.js`、`store.js`、`tma.js` 等）**（参见 0.1 瀑布图第 5–6 行）。
   - **边界**：若处于外网完全无法访问 `telegram.org` 的独立浏览器环境，`defer` 不会跳过等待 `telegram-web-app.js` 失败/超时才执行 `app.js`；但在目标环境（真实 Telegram 客户端内），`telegram.org` 必可达且通常命中 WebView 缓存，风险极低、收益明确。

---

## 阶段 0 全栈基线测试与现状截图留档

### 必跑基线测试结果（零原有失败）
- `node --test a9-mini-app/js/batch-a-live-guard.test.mjs a9-mini-app/js/v15-tx.test.mjs worker/tests/*.test.mjs ops/scripts/selftest.mjs`：**89/89 全部通过**（`fail 0`）
- `python3 -m unittest a9-mini-app/bot/test_a9_bot.py`：**4/4 全部通过**
- `(cd v17 && shasum -a 256 -c ci/artifacts.sha256) && (cd v16 && shasum -a 256 -c ci/artifacts.sha256)`：**v17 4/4 OK，v16 4/4 OK**

### 阶段 0 现状参考截图（`docs/ux-screens/phase0/`）
- `390×844` 中文亮色：`plaza-390-zh-light.png`、`wallet-390-zh-light.png`、`warmup-390-zh-light.png`、`claim-390-zh-light.png`
- `360×800` 英文暗色：`plaza-360-en-dark.png`、`wallet-360-en-dark.png`、`warmup-360-en-dark.png`、`claim-360-en-dark.png`
- 慢网加载与断网重试现状：`slow-loading-390-zh-light.png`、`offline-retry-390-zh-light.png`
