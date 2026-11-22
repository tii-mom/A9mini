# A9mini 阶段三完整验收报告：立体书手账集章成长循环 & 0 GRAM 达标竞猜联动

- **仓库：** `https://github.com/tii-mom/A9mini`
- **分支：** `feat/gamification-v1`
- **前置基线：** `cc37fb0`（完成全局 6 类旧术语/单位/商标/配色残留清理后的纯暖棉纸立体书基线）
- **当前状态：** 阶段三（手账集章成长循环、服务端持久化防重领、成长数据与真实资产严格物理隔离）开发与全量回归测试已完成。

---

## 一、阶段三核心交付成果

### 1. 服务端手账集章与非金融成长引擎（Memory + Cloudflare D1 1:1 对齐）
- **增量数据库迁移**：[worker/migrations/0005_phase3_progression_stamps.sql](file:///Users/yu1/Desktop/A9mini/worker/migrations/0005_phase3_progression_stamps.sql)（并同步写入 [worker/schema.sql](file:///Users/yu1/Desktop/A9mini/worker/schema.sql)）：
  - `user_progression`：按已验签 Telegram 用户 `user_id` 持久化手账经验 `exp`、等级 `level`、连续打卡天数 `checkin_streak`、最后打卡 UTC 日期 `last_checkin_day`、累计盖章数 `total_stamps`。
  - `user_task_claims`：以 `PRIMARY KEY (user_id, task_key, period_key)` 唯一主键严格保证同一用户在同周期（日常任务为 UTC `'YYYY-MM-DD'`，成就印章为 `'ONCE'`）绝不可重复领取或并发刷取 EXP。
- **核心引擎与 D1 适配器**：
  - [worker/src/growth-engine.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/growth-engine.mjs)（`ProgressionEngine`、`PROGRESSION_TASKS`、UTC 日切与断签重置计算）
  - [worker/src/d1-growth-store.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/d1-growth-store.mjs)（`D1ProgressionEngine`，采用 `INSERT OR IGNORE` + `changes === 1` 原子守卫防止并发双发）
  - [worker/src/api.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/api.mjs) / [worker/src/cf-worker.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/cf-worker.mjs) / [worker/src/server.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/server.mjs)：
    - `GET /api/progression/me`（及 `/api/progression/user/:id`）：强校验 `auth.telegram()` 签名，禁止跨用户读取（`403 FORBIDDEN`）。
    - `POST /api/progression/claim`：强校验 `auth.telegram()` 签名与前置条件（如 `daily_prediction` 必须核实该用户已在 `PredictionEngine` 完成当轮 0 GRAM 竞猜；`daily_full_bonus` 必须当日集齐 4 章；`ach_streak_3` 必须连签满 3 天）。

### 2. 严格区分成长数据与真实链上资产（不可违反边界）
- 所有手账进度接口显式返回 `assetNature: 'NON_FINANCIAL_GAME_PROGRESSION', tradable: false, convertibleToA9: false`。
- 手账 EXP、等级（`Lv.1 折纸旅人` 至 `Lv.5 金箔典藏家`）、每日印章与成就印章 **100% 属于不可交易、不可变现的游戏内成长数据**，不产生任何 A9 或 GRAM 代币发放。
- 0 GRAM 24H 达标竞猜赢取的待激活 A9 补贴券（`POST /api/prediction/activate`）**继续严格保持原有的真实资本核验门槛（`hasCompletedPresale || hasStakeTicket`）**，不会因完成免费集章任务而自动获得激活资格。

### 3. 前端主城「主城集章手账卡」（`#/challenge`）
- **文件**：[a9-mini-app/js/pages/wealthverse.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/pages/wealthverse.js)、[a9-mini-app/css/wealthverse.css](file:///Users/yu1/Desktop/A9mini/a9-mini-app/css/wealthverse.css)、[a9-mini-app/js/data.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/data.js)、[a9-mini-app/js/demo-data.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/demo-data.js)、[a9-mini-app/js/store.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/store.js)。
- 4 格单行紧凑橡皮章槽（主城打卡 `+30 EXP` / 达标竞猜 `+50 EXP` / 24H 巡视 `+30 EXP` / 纸艺分享 `+40 EXP`），点击触发橡皮章砸落动效（`anim-slot-confirmed`）与纸艺盖章轻音效（`A9Audio.stamp()`）；未参与当轮 0 GRAM 竞猜时点击「达标竞猜」自动引导跳转至 24H 达标竞猜面板。
- 底部展示 4 枚集章成就印章（`初入手账` / `三日连签` / `竞猜观星` / `十章典藏`）及今日 4 章集齐后的 `+80 EXP` 满章加赠按钮。

---

## 二、阶段三验收测试结果

1. **后端与真实 Cloudflare D1（Miniflare）测试（65/65 全通过 + 19/19 Worker 测试全通过）**：
   - `Phase 3: Handbook Stamp progression loop (new user, consecutive check-ins, UTC boundary, idempotency, cross-user auth & strict asset isolation)` 在 **`memory`、`d1-sqlite`（含 `0001`→`0005` 增量迁移）、`d1-miniflare`（真实 Cloudflare D1）** 三种存储后端上全部通过：
     - 验证新用户初始状态（`exp=0, level=1, checkinStreak=0`）；
     - 验证跨用户越权读取与伪造 `body.userId` 均返回 `403 FORBIDDEN`；
     - 验证未满足前置条件时拒绝盖章（`TASK_PREREQUISITE_UNMET`）；
     - 验证同日重复盖章与成就重复领取均幂等拒绝（`ALREADY_CLAIMED`），EXP 绝不双发；
     - 验证跨 UTC 午夜（`23:59:50 UTC` → `00:00:05 UTC`）日常印章重置、连续 3 天打卡解锁 `ach_streak_3`（`+120 EXP`）、断签后连签归零重置为 `1`；
     - 验证拥有高等级/满章的用户在未完成真实商行购买或链上质押时调用 `POST /api/prediction/activate` 依然被 `ACTIVATION_REQUIREMENT_UNMET` 拦截。
2. **前端与 Playwright 浏览器自动化测试（7/7 + 6/6 单元测试 & 52 项双视口路由测试全通过）**：
   - 覆盖 `390×844` 白昼暖棉纸与 `360×780` 暗夜暖炭纸本下的主城集章手账渲染与点击盖章状态切换，0 水平溢出、0 控制台错误。
3. **合约基线校验**：
   - `v15/ci/artifacts.sha256` 4 项合约产物全部 `OK`。
