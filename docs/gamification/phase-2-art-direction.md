# A9mini 第二阶段：现有项目核查与奇幻科技美术风格规范（V2.0）

- **分支：** `feat/gamification-v1`
- **基线：** `05842abf261aa9938bbc1b9f4445fa4e8190be4a`（第一阶段第三轮验收通过基线）
- **当前进度：** 第一步（项目核查）完成；第五节（TonCenter 严格结构验证小修复）完成；第二步（首批美术风格样板）已完成 3/5 核心样板图，**因图像模型配额限制如实暂缓剩余 2 项生图，等待负责人画风确认及生图配额恢复后再进入扩展素材与前端大规模集成。**

---

## 一、第一步：现有项目检查结论（保留 vs 视觉改造）

### 1. 原样保留与复用的稳定业务模块（严禁重写）
- **后端与安全基线（第一阶段已验收）：** `worker/src/auth.mjs`、`api.mjs`、`presale-hotwallet.mjs`、`presale-runner.mjs`、`d1-growth-store.mjs`、`d1-promo-store.mjs`、`promo-hotwallet.mjs`、`growth-engine.mjs`、`money.mjs`、`ton-address.mjs`、`ton-cell.mjs`、`social-store.mjs`、`cf-worker.mjs`、`server.mjs`，以及 `worker/migrations/0001`–`0004`、`v15/` 智能合约（只读不可改）。本阶段仅对 `worker/src/toncenter.mjs` 做了任务书第五节规定的严格结构验证小修复。
- **前端稳定业务与隔离模块：**
  - `a9-mini-app/js/config.js`（演示/真实模式隔离，`liveFundsEnabled = false`）
  - `a9-mini-app/js/store.js`（前端状态与 `a9_ui_prefs_v1` 安全持久化白名单）
  - `a9-mini-app/js/data.js`（唯一 API 读取层、模式守卫）
  - `a9-mini-app/js/demo-data.js`（独立演示数据层）
  - `a9-mini-app/js/tma.js`、`tonconnect.js`、`v15-tx.js`（Telegram 环境、TON Connect 钱包证明与历史绑定态区分）
  - `a9-mini-app/js/router.js` 全部 26 条既有路由与深链（兼容 `/challenge`、`/round`、`/internal/market`、`/team`、`/profile`、`/gallery`、`/rewards`、`/observation/records`、`/rules` 等）。

### 2. 需要统一视觉改造的现状痛点
- **旧美术素材画风严重割裂：** `a9-mini-app/assets/wealthverse/game/` 现有图片混杂日落粉紫童话城堡（`city.webp`）、白日大教堂（`tower.webp`）、中世纪木屋 Q 版酒馆（`guild.webp`）、传统地牢金币箱（`vault.webp`）与卡通国王（`a9.webp`），缺乏统一的“奇幻科技世界”美学语言，且无法独立透明分层。
- **主城不是真正的 2.5D 交互建筑场景：** 当前 `wealthverse.js` 的 `city()` 仅用静态背景图 + 底部 4 个方形小图标按钮（`shield`/`chest`/`flag`/`cup`），缺乏建筑热区、空间纵深与探索感。
- **主导航未对齐新架构：** 当前 `app.js` 的 `TABS` 为「主城 / 商行 / 商会 / 资产库」，需在集成阶段统一升级为任务书规定的 **「主城 / 挑战 / 商会 / 背包」**，同时保持 `/internal/market`（商行/兑换入口）及所有旧路由完全可达。
- **三层 CSS 相互覆写：** `tokens.css`（石墨黑+活力橙）、`wealthverse.css`（紫调覆盖）、`game.css`（`body[data-game-route]` 硬覆盖）存在重复与打架，需在画风确认后整理收敛到统一视觉令牌，避免新建冲突样式系统。

---

## 二、第二步：A9 奇幻科技世界美术风格规范（Astral-Tech Realm）

### 1. 世界观与统一视觉锚点
- **风格定位：** 2.5D 高精度奇幻科技游戏美术（Astral-Tech），融合精密黑曜石机械倒角、深紫雕花星纹石材、鎏金星仪镶边、半透明全息能量环与刻面发光魔导晶体。杜绝廉价网页模板感、童话酒馆风与粗粝赛博废土风。
- **统一透视与光源：**
  - 视角：统一 2.5D 三分之四俯视角（约 30° 准等轴微仰），确保所有独立分层建筑可精准落座在主城浮空石台基座上。
  - 光源：左上高空冷月星穹环境光 + 建筑/晶体核心青蓝与暖金自发光，底部自带柔和投影以增强浮空纵深。
- **无文字原则：** 所有正式美术素材均**不含任何文字、数字或标签**，所有名称、倒计时、金额与提示统一由前端中英双语代码渲染。

### 2. 核心色彩系统（对齐 `AGENTS.md` 业主书面授权）
| 语义层级 | 名称 | 色值（Hex） | 用途规范 |
|---|---|---|---|
| 主世界深空底色 | 午夜星蓝（Midnight Sapphire） | `#070B1A` / `#0B122C` / `#13224D` | 宇宙底色、弹窗遮罩、导航 Dock 与主城前景暗部 |
| 主世界建筑基调 | 皇家深紫（Royal Astral Purple） | `#1B113B` / `#2A1854` / `#3D2475` | 建筑主体石材、半透明星纹卡片面板、次级层级表面 |
| 常规交互与能量态 | 魔导青蓝（Arcane Cyan） | `#2CE6F5` / `#00B4D8` / `#7DF3FF` | 能量桥、法阵、次级按钮描边、常规交互高亮、状态提示、初阶水晶 |
| 高阶收藏与重要奖励 | 星辉鎏金（Celestial Gold） | `#F5C76B` / `#D99B2E` / `#FFE8A6` | 主行动 CTA 按钮、建筑星仪镶边、高阶徽章、传说水晶、重要奖励 |
| 状态辅助色 | 翡翠达标 / 绯红警示 | `#1EE3A2` / `#F25C78` | 24H 达标/未达标时段、错误与风控提示（仅语义用途） |

### 3. 四大功能入口建筑与主城分层规划
- **主城竖屏分层结构：**
  - Layer 0（远景星穹 + 巨型半透明鎏金星环 + 四座空置发光法阵浮空石台背景）：`city-backdrop-portrait`
  - Layer 1（四座独立透明分层建筑热区，精准叠放在四座发光石台上，含呼吸微动、触摸/点击高亮光晕与波纹反馈）：
    1. **主城圣殿（中上主台）** → 主城核心总览 / 身份与协议规则入口
    2. **挑战星塔（右中石台）** → 挑战入口（`/round`、24H 观察塔 `/observation/records`）
    3. **商会星港（左中石台）** → 商会入口（`/team`、邀请与榜单）
    4. **背包晶库（中下石台）** → 背包与资产入口（`/profile`、凭证 `/proof`、奖励宝库 `/rewards`、商行 `/internal/market`）
  - Layer 2（轻量化 CSS 环境星尘与能量光效，支持 `prefers-reduced-motion` 自动降级）
  - Layer 3（悬浮顶部 HUD 与底部 4 项主导航 Dock：`主城 / 挑战 / 商会 / 背包`）

### 4. 三档水晶概念设定（仅供概念美术与非链上游戏收藏规划，不发币/不发 NFT）
- **初阶水晶（Novice Crystal）：** 剔透青蓝刻面晶体 + 简约午夜蓝暗银科技托环，柔和青色内光。
- **星辉水晶（Starlight Crystal）：** 深紫与电光青蓝双色折射多面晶簇 + 精密鎏金星轨环 + 星尘微粒。
- **传说水晶（Legendary Crystal）：** 鎏金与星云紫核心神圣棱晶 + 双层交错金色星仪陀螺环 + 青金双色光羽能量场。

### 5. 游戏 UI 组件视觉规范（集成阶段统一落地到 `tokens.css` / `components.css` / `game.css`）
- **主要按钮（Gold CTA）：** 鎏金金属斜切边框 + 钻石切角 + 顶缘高光 + 按下微沉与光晕脉冲；真实资金未开放按钮保持明确置灰只读态。
- **次级按钮（Arcane Cyan）：** 深紫午夜蓝磨砂黑曜石玻璃底 + 1px 青蓝能量细框 + 微型金色角钉。
- **卡片面板：** 普通信息卡采用深紫黑曜石玻璃 + 青蓝角标；高阶收藏/重要奖励卡采用深紫内发光 + 鎏金细框与角饰。
- **徽章与进度条：** 六边形/圆形金属晶石徽章框；青蓝向鎏金渐变的晶体能量进度条；中央带菱形晶体的细光分隔线。

---

## 三、首批美术样板产出清单与当前客观限制

素材存放目录：`a9-mini-app/assets/game-v2/style-samples/`

| 序号 | 样板项 | 状态 | 文件路径 | 分辨率与体积 |
|---|---|---|---|---|
| 1 | A9 游戏世界整体美术风格样板 | **已生成（真实图像模型）** | `01-style-board-world.png` / `.webp` | `1376×768`（PNG 1636KB / WebP 205KB） |
| 2 | 手机竖屏奇幻科技主城分层背景 | **已生成（真实图像模型）** | `02-city-backdrop-portrait.png` / `.webp` | `768×1376`（PNG 1535KB / WebP 167KB） |
| 3 | 四大功能入口建筑概念样板（2×2） | **已生成（真实图像模型）** | `03-buildings-concept-sheet.png` / `.webp` | `1024×1024`（PNG 1191KB / WebP 137KB） |
| 4 | 初阶 / 星辉 / 传说三档水晶概念美术 | **暂缺（待配额恢复）** | 待生成 `04-crystals-tiers-sheet.png` / `.webp` | 受生图配额限制，未用代码/SVG 伪造 |
| 5 | 游戏 UI 组件视觉规范图 | **暂缺（待配额恢复）** | 待生成 `05-ui-kit-visual-spec.png` / `.webp` | 受生图配额限制，未用代码/SVG 伪造 |

### 如实说明当前图像生成配额限制
- 本环境内置图像生成能力（`image-generator` / `gemini-3.1-flash-image`）在成功生成上述 3 张高分辨率核心样板图后，触发了服务端配额上限：`429 Too Many Requests (RESOURCE_EXHAUSTED)`，API 返回配额重置时间为约 **4 小时 57 分钟后**（约 UTC `2026-11-22T11:52:25Z` / 北京时间 `19:52`）。
- 严格遵循任务书红线：**绝不使用 CSS 渐变、SVG 或纯色矩形冒充游戏美术图片**。已生成的 3 张核心图（世界观全景 + 竖屏 4 平台主城背景 + 四大等轴建筑概念图）已完整确立画风、配色、光源、材质与透视语言，可供负责人先行审定画风；待配额重置后（或接入其他授权生图通道后）将第一时间补齐第 4、5 项样板图及全部透明分层正式素材，再进入前端集成。

---

## 四、同步完成：第一阶段遗留小修复（任务书第五节）

- **修改文件：** `worker/src/toncenter.mjs`、`worker/tests/p0-security.test.mjs`
- **修复内容：**
  1. `runGetMethod()` 严格校验 `Array.isArray(body.result.stack)`，拒绝缺失或非数组 `stack`；
  2. 新增 `TonCenterClient.parseStrictNum(item, { allowNegative })`，拒绝空栈、缺失字段、非 `['num', string]` 类型、非法数值字符串及负余额；
  3. `fetchWalletAccountState()` 严格校验 `body.result.state` 必须属于 `'active' | 'uninitialized' | 'frozen'`，缺失或非法时显式抛错，彻底堵死“缺少 `state` 字段默认变 `uninitialized` 进而误判余额 0”的隐患；
  4. `fetchUserJettonWallet()` 与 `fetchUserTicket()` 全量切换至严格校验，结果栈不完整或字段损坏一律返回 `a9BalanceRaw: null, balanceAvailable: false` / `ticketsAvailable: false`。
- **回归结果：** `worker.test.mjs` **19/19**、`p0-security.test.mjs` **51/51**（无 Miniflare）与 **64/64**（真实 Miniflare v3 Cloudflare D1）全通过。
