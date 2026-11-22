# A9mini 第二阶段完整验收报告

- **仓库：** `https://github.com/tii-mom/A9mini`
- **分支：** `feat/gamification-v1`
- **第一阶段第三轮验收基线：** `05842abf261aa9938bbc1b9f4445fa4e8190be4a`
- **第二阶段 TonCenter 严格结构验证修复提交：** `9c334d7`
- **第二阶段小程序视觉重构与收口提交：** `548b7d07b5fbef63d36667d1d37e3d2319a51b5c`
- **当前状态：** 第二阶段开发、自检与全量回归测试已完成，现提交独立验收。**严格停留在第二阶段，未提前进入第三阶段，未合并 `main`，未改动 `v15/` 智能合约产物，未改动 `/Users/yu1/Desktop/BAM`，未开启任何真实资金操作。**

---

## 一、美术风格规范（暖棉纸立体书 × 实体厚卡纸贴纸版）

本阶段将 A9mini 统一重构为高辨识度、高交互感、移动端 60fps 流畅运行的 **「暖棉纸立体书 × 实体厚卡纸贴纸（Paper-Craft & Sticker Diorama）」** 游戏世界：

1. **色彩与材质体系（`a9-mini-app/css/tokens.css`）：**
   - **白昼暖棉纸（`data-theme="light"`，默认）：** 90% 温和暖棉纸底色（`#EFE8DC` / `#F5F0E6` / `#FFFFFF` 厚卡纸）+ 实体卡纸厚度投影（`#D9CFC0`）+ 手工虚线压痕缝线（`#D0C3B0`）。
   - **暖炭暗夜纸本（`data-theme="dark"`）：** 暖炭黑卡纸（`#171413` / `#1D1917` / `#26211E`）+ 暗金铜压纹缝线，支持圆弧径向主题过渡。
   - **焦点与语义色：** 8% 纸艺朱红行动焦点（`#E8453C`，底部厚键帽 `#B82D25`），2% 森林翠绿达标色（`#1F9D6A`）、琥珀金高阶收藏色（`#D98A1C`）、天空蓝辅助色（`#2E7CC6`）、珊瑚红警示色（`#D84352`）。
2. **立体折纸与贴纸工艺（`a9-mini-app/css/components.css` & `wealthverse.css` & `game.css`）：**
   - 统一冲压白边贴纸阴影（`--paper-cut-shadow`）、右上角微翘折纸标签（`.peel-badge`）、实体厚卡纸立牌插槽底座（`.standee-slot`）、24H 橡皮圆章盘与微型打孔战况轨、厚纸立体按压键帽、锯齿边缘兑换小票、3D 翻转纸质 SBT 质押凭证。
3. **动态文字与双语支持：**
   - 所有美术素材内部均不含业务动态文字或数字；所有标题、金额、倒计时、阶段状态均由前端 `i18n.js`（`zh-CN` / `en-US`）动态渲染。
   - 对外原生币名称与代码统一规范为 **`GRAM`**（`TON` 仅保留为 `TON Connect`、`TON 钱包` 等区块链与技术协议名）。

---

## 二、正式美术素材清单、用途、格式及资源目录

### 1. 折纸贴纸与棉纸肌理目录：`a9-mini-app/assets/paper-craft/`
| 文件名 | 格式 | 尺寸/体积 | 用途 |
|---|---|---|---|
| `cotton-paper-tile.png` | PNG | 无缝平铺纹理 (1.7 KB) | 全站暖棉纸微肌理背景叠加层 |
| `tower.svg` | SVG | 矢量冲压白边贴纸 | 主城态势沙盘核心徽标、轮次挑战眉标、24H 星轨观测盘核心 |
| `market.svg` | SVG | 矢量冲压白边贴纸 | 主城四宫格入口「主城商行」与商行页眉标 |
| `vault.svg` | SVG | 矢量冲压白边贴纸 | 主城四宫格入口「奖励宝库」、背包与领奖页眉标 |
| `trophy.svg` | SVG | 矢量冲压白边贴纸 | 主城四宫格入口「荣誉排行」与榜单眉标 |
| `rules.svg` | SVG | 矢量冲压白边贴纸 | 主城四宫格入口「玩法规则」与系统设置/规则页眉标 |
| `guild.svg` | SVG | 矢量冲压白边贴纸 | 商会大厅、群绑定与邀请工坊眉标 |
| `ticket.svg` | SVG | 矢量冲压白边贴纸 | 质押凭证收藏册、兑换回执小票、时段记录读数卡 |
| `crystal-basic.svg` | SVG | 矢量冲压白边贴纸 | **初阶水晶**概念美术预览（宝库页展示） |
| `crystal-starlight.svg` | SVG | 矢量冲压白边贴纸 | **星辉水晶**概念美术预览（宝库页展示） |
| `crystal-legendary.svg` | SVG | 矢量冲压白边贴纸 | **传说水晶**概念美术预览（宝库页展示） |

### 2. 九阶角色厚卡纸立牌目录：`a9-mini-app/assets/wealthverse/game/`
| 文件名 | 格式 | 体积范围 | 用途 |
|---|---|---|---|
| `a1.webp` ~ `a9.webp`（共 9 张） | 透明 WebP | 66 KB ~ 79 KB / 张 | A1（链上萌新）至 A9（加密传说）实体厚卡纸白边角色立牌，用于背包顶部身份立体舞台、九阶身份图鉴、商会主力名册、商行柜台与典藏卡 Canvas 导出 |

### 3. 内联三层景深立体布景：`a9-mini-app/js/paper-art.js`
- `DIORAMA_BACKDROP`：三层景深立体书剧场（远景山峦云朵、中景城堡旗帜与彩旗挂绳、近景波浪舞台折痕），用于背包个人身份舞台与身份图鉴。
- `CITY_SANDTABLE_BACKDROP`：主城态势沙盘专属折纸起伏丘陵与虚线航道布景。
- `SHOP_SCALLOP_AWNING`：主城商行红白相间立体扇贝波浪纸檐。

---

## 三、主城与全站视觉改版成果

1. **主导航统一为「主城 / 挑战 / 商会 / 背包」：**
   - **主城（`#/challenge`）：**
     - 核心立体态势沙盘：实时轮次阶段胶囊、倒计时徽章、本轮用户奖励池、早鸟最高 `2.0×` / 单轮上限 `15×` 标识、目标底价与当前判定均价（含实时迷你走势折线）、24H 微型打孔战况轨（第 16 格达标门槛分界线，点击直达 24H 时段记录）、唯一朱红主行动按钮（随轮次阶段智能切换文案）。
     - 四宫格厚卡纸生态入口：主城商行（`#/internal/market`）/ 奖励宝库（`#/rewards`）/ 荣誉排行（`#/leaderboard`）/ 玩法规则（`#/rules`）。
     - 0 GRAM 24H 生死预言局速览卡（点击直达挑战页预言星盘）+ 全网累计达标 / 推广返佣体系（`12% + 18%`）双格卡。
   - **挑战（`#/round`）：** 紧凑纸签眉标、全阶段挑战中枢（预热 / 参与 / 24H 橡皮圆章观察盘 / 达标结算 / 销毁纪念碑 / 技术中止）、0 GRAM 24H 生死预言星盘与双轨星轨观测盘（`#/observation/records`）。
   - **商会（`#/team`）：** 队长分红中枢（GRAM 实时跳字）、成员视图、团队大厅、团队主力立牌名册、邀请海报工坊（`#/team/invite`，3 套暖棉纸 Canvas 海报导出）与荣誉排行（`#/leaderboard`）。
   - **背包（`#/profile`）：**
     - 顶部个人身份立体书展示台：厚卡纸立牌插槽、微翘贴纸「身份图鉴 ›」入口；演示模式支持轻点立牌 **360° 纸片翻身切换 A1–A9 试穿**并触发纸屑粒子与折纸音效；**真实模式（`?mode=live`）显式呈现“示意立牌 · 阶位待核验”印章与降饱和待核验态**。
     - 一体化可领取 / 待解锁奖励卡（带拉链滑块）与 SBT 凭证收藏册（支持全部/观察中/已结算筛选及 `#/proof/:id` 3D 翻面核验）。
   - **三档水晶概念美术预览（`#/rewards`）：** 在奖励宝库页展示初阶、星辉、传说三档水晶概念美术（严格遵守非链上资产、不发新币/NFT 的边界）。
2. **手工纸艺轻音效引擎（`a9-mini-app/js/audio.js`）：**
   - 纯 Web Audio API 合成折纸轻敲、360° 翻牌刷声、橡皮章闷响、拉链确认和弦与阻尼提示音；顶栏支持一键静音/开启切换（默认静音，零外部音频加载负担）。

---

## 四、修改文件清单与原有模块复用说明

### 1. 原样保留与复用的稳定业务与安全模块
- **后端全套第一阶段安全与账本系统（100% 保留）：** `worker/src/auth.mjs`、`api.mjs`、`presale-hotwallet.mjs`、`presale-runner.mjs`、`d1-growth-store.mjs`、`d1-promo-store.mjs`、`promo-hotwallet.mjs`、`growth-engine.mjs`、`money.mjs`、`ton-address.mjs`、`ton-cell.mjs`、`social-store.mjs`、`v15-indexer.mjs`、`cf-worker.mjs`、`server.mjs` 及 `worker/migrations/0001`–`0004`。
- **智能合约与编译产物（100% 未改动）：** `v15/` 下 4 个合约产物通过 `shasum -a 256 -c ci/artifacts.sha256` 校验（4/4 `OK`）。
- **前端核心业务与隔离层（原样复用）：**
  - `a9-mini-app/js/config.js`（演示/真实模式判定，`liveFundsEnabled = false`）
  - `a9-mini-app/js/store.js`（状态管理与 `a9_ui_prefs_v1` 安全持久化白名单）
  - `a9-mini-app/js/data.js`（唯一 API 读取层、真实模式资金动作拦截）
  - `a9-mini-app/js/demo-data.js`（唯一演示数据源）
  - `a9-mini-app/js/tonconnect.js`、`v15-tx.js`（TON Connect 钱包连接、`ton_proof` 验签与历史绑定态区分）

### 2. 第一阶段遗留小修复（任务书第五节：TonCenter 严格结构验证）
- `worker/src/toncenter.mjs`（提交 `9c334d7`）：
  - `runGetMethod()` 严格验证 `Array.isArray(body.result.stack)`；
  - 新增 `TonCenterClient.parseStrictNum()`，拒绝空栈、缺失余额字段、非 `['num', string]` 类型、非法数值字符串与负余额；
  - `fetchWalletAccountState()` 严格验证 `body.result.state` 必须属于 `'active' | 'uninitialized' | 'frozen'`，缺失或非法时显式抛错，防止误当 `uninitialized` 返回虚假 `'0'` 余额；
  - `fetchUserJettonWallet()` 与 `fetchUserTicket()` 对结构不完整或类型错误统一返回 `a9BalanceRaw: null, balanceAvailable: false` / `ticketsAvailable: false`。
- `worker/tests/p0-security.test.mjs`：新增 `TonCenter strict schema validation` 反例测试（总计 **51 项默认 / 64 项含真实 Cloudflare D1**）。

### 3. 第二阶段前端视觉与交互修改文件
- **样式系统（复用既有 5 个 CSS 文件，未新建冲突样式系统）：** `a9-mini-app/css/tokens.css`、`components.css`、`animations.css`、`wealthverse.css`、`game.css`
- **入口、路由与公共模块：** `a9-mini-app/index.html`、`js/app.js`、`js/router.js`、`js/i18n.js`、`js/icons.js`、`js/audio.js`、`js/components.js`、`js/game-scenes.js`、`js/paper-art.js`（新增内联矢量立体布景）、`js/poster.js`、`js/share.js`、`js/tma.js`
- **页面模块：** `a9-mini-app/js/pages/wealthverse.js`、`profile.js`、`round_hub.js`、`round_stages.js`、`team.js`、`warmup_market.js`、`system.js`
- **自动化浏览器测试与文档：** `a9-mini-app/tests/wealthverse-browser.mjs`、`README.md`、`a9-mini-app/README.md`

---

## 五、关键页面截图与测试验证结果

### 1. 交付证据目录：`docs/gamification/phase-2-evidence/`
- `after-challenge.png`：390×844 白昼暖棉纸 · 主城（`#/challenge`）
- `narrow-challenge.png`：360×780 暗夜炭纸 · 英文主城（`#/challenge`）
- `after-round.png`：390×844 · 挑战中枢与 24H 橡皮圆章观察盘（`#/round`）
- `after-team.png`：390×844 · 商会大厅与主力立牌名册（`#/team`）
- `after-profile.png`：390×844 · 背包个人身份立体舞台与凭证收藏册（`#/profile`）
- `after-rewards.png`：390×844 · 奖励宝库与三档水晶美术预览（`#/rewards`）
- `live-long-balance-safe-area.png`：390×844 真实只读模式 · 阶位待核验印章、超长精确余额与 Telegram 34px 底部安全区避让
- `browser-results.json`：52 项路由/视口检查完整结构化记录
- `node.txt` / `browser.txt`：测试命令完整原始输出

### 2. 测试命令与实际执行结果
| 测试命令 | 覆盖范围 | 结果 |
|---|---|---|
| `node worker/tests/worker.test.mjs` | Worker v15 核心单元与 D1 闭环测试 | **19/19 通过** |
| `node worker/tests/p0-security.test.mjs` | 第一阶段 P0 安全 + 第五节 TonCenter 严格结构验证（Memory + SQLite） | **51/51 通过** |
| `MINIFLARE_MODULE=... node worker/tests/p0-security.test.mjs` | 第一阶段 P0 安全 + 第五节 TonCenter 严格结构验证（含**真实 Cloudflare D1 / workerd**） | **64/64 通过** |
| `node --test a9-mini-app/js/batch-a-live-guard.test.mjs a9-mini-app/js/v15-tx.test.mjs` | 前端模式隔离守卫（6 项）+ v15 交易 BOC 编码测试（6 项） | **12/12 通过** |
| `node a9-mini-app/tests/wealthverse-browser.mjs` | Playwright + Chromium：390×844 (`zh-CN`/light) & 360×780 (`en-US`/dark) 全 26 路由溢出检测、4 主导航切换、主城商行入口、三档水晶预览、图鉴 PNG 导出、立牌缺图回退、`?mode=live` 离线重试、超长余额、Telegram 安全区、live 零写请求 | **52 项路由/视口 + 专项全通过（0 错误 / 0 溢出 / 0 live 写请求）** |
| `cd v15 && shasum -a 256 -c ci/artifacts.sha256` | v15 智能合约编译产物完整性 | **4/4 `OK`** |

---

## 六、已知问题、未验证事项与生产上线阻断项

1. **未验证事项（需真实部署环境）：**
   - 真实 Telegram 客户端（iOS / Android / Desktop）WebView 内的真机触感、安全区与 `initData` 联调；
   - 真实 TON 钱包客户端（Tonkeeper / WalletTg 等）在正式 HTTPS 域名下的 `ton_proof` 端到端连接验证。
2. **第一阶段已识别的 5 项生产真实资金上线阻断项（仍然有效，本阶段保持真实资金关闭）：**
   - 缺少可信链上发币最终确认器（`payoutVerifier`）；
   - Worker（D1）与 Node 发币程序（内存）存储链路未打通；
   - TonCenter v2 无法可靠识别主链终局性、`aborted`、`bounced` 且缺少持久化分页游标；
   - 线上 Cloudflare 账号目标 D1 预发环境尚未执行实际迁移与压测（本地 Miniflare v3 已通过 13/13）；
   - 正式 HTTPS 域名与真实钱包 `ton_proof` 端到端未联调。
3. **阶段边界遵守情况：**
   - 三档水晶仅作概念美术预览，未创建任何代币、NFT 或水晶经济逻辑；
   - 未开发 Telegram Stars 支付或 GRAM 数字商品收款；
   - 真实模式资金操作保持关闭（`liveFundsEnabled = false`、`A9_PRESALE_OPEN = 0`）。
