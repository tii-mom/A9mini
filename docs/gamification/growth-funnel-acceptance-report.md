# A9mini 转化漏斗重构、纯内盘回归与 TG 战队群播报验收报告

- **分支**：`feat/gamification-v1`（保留工作区最新任天堂暖棉纸 UI 改版、新版命名体系「广场 / 闯关 / 战队 / 我的」与 PNG 纸艺资产）
- **日期**：2026-11-22
- **安全与合规红线**：
  - `v15/` 智能合约与编译产物零改动（`v15/ci/artifacts.sha256` 4/4 `OK`）
  - `/Users/yu1/Desktop/BAM` 只读来源零改动
  - 真实模式保持只读保护（`A9_PRESALE_OPEN` 默认关闭、`A9_BROADCAST_ENABLED="0"`、Live 模式零写请求、不合并 `main`、不开启真实链上资金）

---

## 一、四步一体化改动摘要

### Step 0：前后端彻底移除商品道具售卖 A9，回归纯内盘固定汇率（选项 1A）
- **后端彻底移除**：
  - 删除 `worker/src/growth-engine.mjs` 中的 `STICKER_PACK_CATALOG`、`COSMETIC_ITEM_CATALOG` 与 `InventoryEngine`；
  - 删除 `worker/src/d1-growth-store.mjs` 中的 `D1InventoryEngine`；
  - 删除 `worker/src/api.mjs` 中的所有 `/api/inventory/*` 路由（`/api/inventory/me`、`/api/inventory/sandbox-open`、`/api/inventory/equip` 全部返回 `404`）及 `/api/config` 中的 `stickerPacks` / `cosmeticCatalog` 字段；
  - 清理 `worker/src/presale-hotwallet.mjs` 中的 `STICKER_PACK_NANO_TO_SKU` 与 `skuId` 分支，严格回归 **`1 GRAM = 2,002 A9`、`5–200 GRAM` 单笔边界**（1.99 GRAM 与纯 `skuId` 均拒绝）；
  - 新增增量迁移 [0007_tg_broadcast_events.sql](file:///Users/yu1/Desktop/A9mini/worker/migrations/0007_tg_broadcast_events.sql) 与同步更新 [schema.sql](file:///Users/yu1/Desktop/A9mini/worker/schema.sql)，安全清理旧 `inventory_items` / `inventory_deliveries` / `user_cosmetics_equipped` 表。
- **前端彻底移除**：
  - [warmup_market.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/pages/warmup_market.js)：移除 `1.99 / 5.99 / 13.99 GRAM` 三档贴纸礼盒货架与拆封动画弹窗，恢复纯净 **A9 兑换屋 · 固定汇率兑换柜台**（`20 / 50 / 100 / 200 GRAM` 快捷档）；
  - [profile.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/pages/profile.js)：移除「贴纸与纸艺装扮匣」及全部换装事件，只保留手账集章成长与 A1–A9 进化图鉴；
  - 同步清理 [demo-data.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/demo-data.js)、[store.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/store.js)、[data.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/data.js)、[wealthverse.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/pages/wealthverse.js) 与 [wealthverse.css](file:///Users/yu1/Desktop/A9mini/a9-mini-app/css/wealthverse.css) 残留引用。

### 第二刀：新人首轮 24H 竞猜必得 500 A9 保底体验金
- 在 [growth-engine.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/growth-engine.mjs) 与 [d1-growth-store.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/d1-growth-store.mjs) 同步实现 `settleRoundBets` 新人首败保底：
  - 仅针对终身首次结算（`totalSettled === 0`）且押错的新人发放待激活体验金（默认 `500 A9`，记为 `status = 'LOST_FIRST_BONUS'`），**不占用赢家主奖池**；
  - 严格走原防女巫激活门槛（需完成 1 笔已确认纯内盘兑换或链上质押）与 `48h` 过期作废机制；
  - 支持环境变量热控：`A9_PRED_FIRST_LOSS_BONUS_RAW`（默认 `500000000000`，设 `0` 可随时关闭）与单轮预算硬上限 `A9_PRED_FIRST_LOSS_CAP_RAW`（默认 `200000000000000` = 200,000 A9）；
  - D1 实现通过单次 `db.batch()` 原子写入整轮结算记录，防止半途中断产生脏状态。

### 第三刀：极简 Telegram 战队群实时战报 Bot（选项 2A + D1 去重表 `0007`）
- 新增 [tg-broadcaster.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/tg-broadcaster.mjs)，挂载至 [cf-worker.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/cf-worker.mjs)（新增 `scheduled()` Cron 入口）、[server.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/server.mjs) 与 [presale-hotwallet.mjs](file:///Users/yu1/Desktop/A9mini/worker/src/presale-hotwallet.mjs)，并在 [wrangler.toml](file:///Users/yu1/Desktop/A9mini/worker/wrangler.toml) 配置 `A9_BROADCAST_ENABLED = "0"`（默认关闭）、`A9_BROADCAST_WHALE_MIN_GRAM = "50"`。
- **核心设计保障**：
  - 仅面向已通过四重核验的战队群（`bind_status = 'bound'` 且有 `tg_chat_id`）播报；
  - 新增 D1 去重表 `tg_broadcast_events`（迁移 `0007`），以 `event_key + chat_id` 复合主键防止 Cloudflare Worker 多实例并发重复推群；
  - 群主归因深链采用短 ID `invite_<teamId>_<captainTgUserId>`（严格 `<= 64` 字节，符合 Telegram `startapp` 长度限制）；
  - 100ms 间隔频控、所有 Telegram API 异常完全吞吐记录、绝不阻塞成交确认与主链路；
  - 覆盖 4 大高潮事件：① 开轮 2.0× 早鸟窗口；② 纯内盘单笔 `>= 50 GRAM` 大额确认成交捷报（仅推买家所属已核验战队群）；③ 最后 4 小时冲刺/焦灼警报（兼容无 1H 蜡烛源）；④ 结算战报（通关 / 100% 销毁 BURN，附动态 OG PNG 战报图）。

### 第一刀：前端情绪与转化漏斗重塑（完全遵循最新版术语与任天堂暖棉纸视觉）
- [round_stages.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/pages/round_stages.js) & [wealthverse.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/pages/wealthverse.js) & [round_hub.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/pages/round_hub.js)：
  - **待提现奖金金库高亮条**（`#a9-pending-vault-banner`）：当存在待激活 A9 时置顶于「广场」与「闯关」首屏，采用**真实二步进度（`1/2 已到账金库 → 2/2 差 1 步激活提现`）** + 实时作废倒计时 + 「去兑换屋解锁」与「或链上质押解锁」双按钮；
  - **2.0× 早鸟黄金窗口倒计时条**（`#a9-early-bird-banner`）：入场前 1/3 窗口实时倒计时（由 [app.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/app.js) 每秒刷新）；
  - **跨轮锁仓护盾 · 本轮生死对赌双栏卡**：展示待解锁份额在达标（释放下一档）vs 未达标（销毁 BURN）的对称后果，真实模式缺值时严格隐藏不编造数字；
  - **24H 预言擂台红蓝对抗比分条 + 最后 4H 红警样式**（`.alert-red-mode`）及 `LOST_FIRST_BONUS` 保底到账提示；
  - **集章手账默认折叠降权**（`<details id="a9-handbook-collapse">`）：退居首屏次级区域，完整保留打卡与 EXP 接口；
  - 同步升级 [share.js](file:///Users/yu1/Desktop/A9mini/a9-mini-app/js/share.js) 三切角默认合规传播文案，禁用所有旧词，统一使用 `广场 / 闯关 / 战队 / 我的 / A9 兑换屋 / 奖金金库 / 销毁 BURN`；
  - 同步修复 `/challenge/success` 页面因 `.success-cert-stage` 的 `overflow: visible` 与流光伪元素动画导致的 245px 横向溢出缺陷（[animations.css](file:///Users/yu1/Desktop/A9mini/a9-mini-app/css/animations.css)、[game.css](file:///Users/yu1/Desktop/A9mini/a9-mini-app/css/game.css)）。

---

## 二、全量自动化与实机回归结果

| 验证层 | 执行命令 / 范围 | 结果 | 证据文件 |
|---|---|---|---|
| v15 合约基线锁定 | `(cd v15 && shasum -a 256 -c ci/artifacts.sha256)` | **4 / 4 OK** | [node.txt](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/node.txt) |
| 前端安全边界与交易构造 | `node --test a9-mini-app/js/batch-a-live-guard.test.mjs a9-mini-app/js/v15-tx.test.mjs` | **7/7 + 6/6 PASS** | [node.txt](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/node.txt) |
| 后端 Worker 单元测试 | `node worker/tests/worker.test.mjs` | **21 / 21 PASS** | [node.txt](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/node.txt) |
| 后端 P0 安全与三驱动 D1（含真实 Miniflare D1） | `MINIFLARE_MODULE=... node worker/tests/p0-security.test.mjs` | **68 / 68 PASS** | [node.txt](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/node.txt) |
| Playwright 双视口浏览器全量回归 | `390×844`（中文白昼）+ `360×780`（英文暗夜）× 26 路由 + Live 离线重试与长金额安全区 | **52 / 52 PASS（0 溢出 / 0 报错 / 0 Live 写请求）** | [browser.txt](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/browser.txt) |

### 关键实机截图核验
- 白昼 390×844：[after-challenge.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/after-challenge.png)、[after-round.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/after-round.png)、[after-internal-market.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/after-internal-market.png)、[after-profile.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/after-profile.png)、[after-challenge-success.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/after-challenge-success.png)
- 暗夜 360×780：[narrow-challenge.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/narrow-challenge.png)、[narrow-round.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/narrow-round.png)、[narrow-internal-market.png](file:///Users/yu1/Desktop/A9mini/docs/gamification/phase-2-evidence/narrow-internal-market.png)
