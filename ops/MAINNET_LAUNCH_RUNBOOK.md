# A9 · 财富大冒险 主网分波次上线执行手册（波次 1 → 波次 2 → 波次 3）

> **安全总则**：本手册严格遵循 `AGENTS.md` 安全边界——所有写操作脚本默认 dry-run；任何密钥、助记词与 API Token 严禁入库或粘贴进聊天记录；未完成前置波次验收前，严禁提前打开下一波次开关。

---

## 0. 主网前置物料准备（业主提供 / 本机生成）

| 序号 | 配置项 | 说明 | 获取/生成方式 |
|---|---|---|---|
| 1 | 正式域名 | 前端域名（如 `https://app.<domain>`）与 API 域名（如 `https://api.<domain>`） | Cloudflare DNS 接入正式域名并开启 HTTPS 代理 |
| 2 | 正式 Telegram Bot | `A9_BOT_TOKEN`（Secret）、`A9_TG_WEBHOOK_SECRET`（Secret，>=16位）与 `A9_TG_BOT_HANDLE`（不含 `@`） | `@BotFather` 执行 `/newbot` 与 `/newapp` 绑定前端域名；`openssl rand -hex 24` 生成 Webhook Secret |
| 3 | 主网 TonCenter Key | `TONCENTER_API_KEY`（Worker Secret）与 `TONCENTER_MAINNET_API_KEY`（Acton 1.1.0 主网 Key，建议 >= 10 RPS） | `@tonapibot` 或 toncenter.com 申请 Mainnet Key（CLI 会自动从 `TONCENTER_API_KEY` 映射） |
| 4 | 主网钱包（7 个角色 / 当前锁定包 6 个独立 W5 地址） | 链上 5 角色（`deployer`、`treasury`、`keeper`、`roundOpener`、`teamWallet`）+ 波次 2 双独立热钱包（`presaleHotWallet`、`promoHotWallet`，严禁复用或混用）。当前锁定部署包 `ops/deploy-console/bundle-mainnet-v17.0.json` 中 `keeper` 与 `roundOpener` 合用同一地址（`UQA1vS1TvBUBEr0jTEBDbexKsDIL_74tOfleC08UmU32dLOI`），**角色合设仍需业主书面确认，不得自行更换地址或重新生成主网钱包** | 主网统一按 **W5 (`v5r1`, `chain = -239`)** 实际地址与 `signer-manifest.json`（含公开 `StateInit`）核验；波次 1B 支持外部手机/硬件 W5 扫码控制台（`ops/deploy-console/server.mjs`）或本机独立 `v5r1` 签名来源；不再以 `v4r2` 生成示例作为默认上线流程；助记词离线冷备 |
| 5 | 团队多签/硬件地址 | `A9_TEAM_WALLET_ADDRESS`（主网部署 `RoundController` 时永久固化） | 硬件钱包或 TON Multisig 主网地址 |
| 6 | 管理与 D1 Token | `A9_ADMIN_TOKEN`（Secret）与 `CLOUDFLARE_API_TOKEN`（仅 `Account: D1: Edit` 权限） | `openssl rand -hex 32` 与 Cloudflare Dashboard API Tokens |
| 7 | 代币元数据 JSON | `A9_METADATA_URI`（如 `https://app.a9.lat/a9.json`） | 上传符合 TEP-64 的 `a9.json`（精度 9、名称、Logo）至正式前端静态域 |

建议主网启动 GRAM 储备（余额仅通过只读查询核对，严禁自动充值或跨钱包调拨）：
- `deployer`：`>= 5 GRAM`（部署合约 Gas）
- `treasury`：`>= 3 GRAM`（`10,000,000,000 A9` 一次铸造弃权 + `8,200,000,000 A9` 注资 RoundController）
- `keeper` / `roundOpener`（当前合用地址）：`>= 3 GRAM`
- `presaleHotWallet`：`>= 5 GRAM`（A9 发币与被动退款 Gas 垫底）
- `promoHotWallet`：`>= 3 GRAM`（启动储备，用户每次 0.06 GRAM 找零持续净增）

---

## 1. 波次 1：分阶段独立授权执行（波次 1A 生产只读基础设施 → 波次 1B 不可逆合约部署、铸币弃权与注资 → 波次 1C 地址回填与只读 Worker）

**分阶段独立授权原则**：主网上线严格划分为 **波次 1A（生产只读基础设施）→ 波次 1B（不可逆合约部署、铸币弃权与注资）→ 波次 1C（地址回填与只读 Worker）→ 波次 2（商城与推广）→ 波次 3（闯关开轮）**，**每个阶段均须获得业主单独书面授权**，严禁将多阶段捆绑执行。先在**零主网铸币、零资金暴露**前提下完成前端静态站、域名、Bot 与 D1 只读链路验收（波次 1A），再经业主单独书面授权执行主网 4 合约部署、铸币弃权与 8,200,000,000 A9 注资（波次 1B，仍不开轮），随后单独授权回填合约地址并部署只读 Worker（波次 1C）。

### 1A. 前端静态站只读上线与生产基础设施预演（零链上铸币/注资）
> **生产写操作红线**：本步中的**远程生产 D1 迁移（`--remote`）**与**生产 Worker Secrets 注入（`wrangler secret put`）**均直接写入生产 Cloudflare 环境，**必须由业主单独书面授权后方可执行**；未获单独授权前仅可进行本地只读预演与静态资产核对。

1. **发布静态前端与元数据（含官网分域对齐）**：若独立官网（`a9-official-web/`）占根域 `https://a9.lat`，推荐 Mini App 部署至 `https://app.a9.lat` 并同步更新 `tonconnect-manifest.json` 的 `url`、`A9_PUBLIC_ORIGIN` 与 `A9_TON_PROOF_DOMAINS`，同时确保根域或静态域上的 `a9.json`、`tonconnect-manifest.json` 与 `assets/token/a9-token-2048.png` 返回 `HTTP 200` 且带 `Access-Control-Allow-Origin: *`（`a9-mini-app/_headers` 已内置）；确认 `window.__A9_CONFIG__.liveFundsEnabled = false`；
2. **生产 D1 迁移（波次 1A 基础库 `0001..0015` + 仓库完整迁移 `0001..0018`，写生产库 · 须单独授权）**：
   - **分波次迁移口径**：
     - **波次 1A 基础库（`0001..0015`）**：覆盖主网只读基础设施、宝箱商城与 v17.0/v17.1 核心账本；
     - **后续增量迁移（`0016..0018`）**：`0016_v17_finality_snapshots.sql`（终局证据快照）、`0017_actuarial_reservations_and_vouchers.sql`（精算订单预留、48H 待激活凭证账本与存量对账表）、`0018_hot_wallet_payout_debits.sql`（热钱包出账扣账缓存）；**按环境 `d1_migrations` 已应用记录顺序补齐**，任何依赖 `0016–0018` 表的 Worker 或 Daemon 必须在对应迁移通过验收后方可启用（缺失 `0017` 时商城下单/开箱/结算返回 `503 MIGRATION_0017_REQUIRED`，缺失 `0018` 时热钱包扣账核验 Fail-Closed 拒绝放行新单）。
   - **备份、迁移与恢复步骤（先备份、再演练、获授权后执行）**：
```bash
# 1) 生产备份（导出完整 SQL 快照并校验非空与完整性）
wrangler d1 export a9mini-v15-prod --remote --env production --output /tmp/a9mini-v15-prod-backup-$(date +%Y%m%d-%H%M%S).sql

# 2) 在从已验收提交导出的专用目录只读核对清单（波次 1A 仅含 0001..0015；完整升级含 0001..0018）
wrangler d1 migrations list a9mini-v15-prod --remote --env production

# 3) 生产备份已验证且取得逐文件书面授权后，在同一专用目录按序执行 apply：
wrangler d1 migrations apply a9mini-v15-prod --remote --env production

# 4) 回滚/恢复预案（仅在异常且经授权时使用，先导入隔离库验证再切换）：
# wrangler d1 execute a9mini-v15-prod --remote --env production --file /tmp/a9mini-v15-prod-backup-<ts>.sql
```
   验收项：先备份存量库再按序执行对应波次迁移，确认 `promo_budget_ledger`（550,000,000 A9 6 槽位）、`stake_referral_credits`、`round_jackpot_draws`、`captain_founding_bonuses` 唯一索引、`user_notification_prefs` 及（完成 `0016–0018` 后）`v17_round_finality_snapshots`、`presale_order_reservations`、`pending_reward_vouchers`、`actuarial_reconciliation_items`、`hot_wallet_payout_debits` 所有表索引就绪、`PRAGMA integrity_check = ok`。
3. **注入生产 Worker Secrets（写生产环境 · 须单独授权，严禁写入 wrangler.toml）**：
```bash
cd /Users/yu1/Desktop/A9mini/worker
npx wrangler secret put A9_BOT_TOKEN --env production
npx wrangler secret put A9_TG_WEBHOOK_SECRET --env production
npx wrangler secret put A9_ADMIN_TOKEN --env production
npx wrangler secret put TONCENTER_API_KEY --env production
```
4. **前端只读验收**：在移动端 `390×844` 打开正式 Telegram Mini App，确认广场/闯关/宝箱商城（`#/internal/market` 与 `#/market`）/战队/我的零报错、零 Emoji、数字完整不缩写、所有资金按钮只读禁用，且 `tonconnect-manifest.json` 握手正常。

### 1B. 主网 4 合约部署（v17.0 涨价解锁）、铸币弃权与 8,200,000,000 A9 注资（暂不开轮）
先验证 `v17/ci/artifacts.sha256`（4/4，已锁定 v17.0 涨价解锁：24H 锁仓（头矿 6H `A9_EARLY_WINDOW_SECONDS=21600` 享 5% 轻止损 / 之后 10% 止损，锁仓期可提前解押退 85% / 烧 15%）→ 封盘 12H 冲价 `A9_OBS_SECONDS=43200`（>= 8/12 通关）；通关退 100% 本金 + 秒领 20% 奖励 + 余下 80% 分 14 天逐秒线性解锁 `A9_VESTING_SECONDS=1209600`，支持随时对未解锁余额 3 折急提 / 7 折销毁；空轮无论胜负 100% 滚存零销毁；未通关自动退本 95%/90% 且奖池与团队结转向上取整折半；两段式 `MintOnce -> 验收到账 -> DropMinterAdmin` 弃权）与 Acton 单元测试全部通过，导出主网必填部署变量（`A9_DEPLOY_WALLET`、`A9_TREASURY_WALLET`、`A9_KEEPER_ADDRESS`、`A9_ROUND_OPENER_ADDRESS`、`A9_TEAM_WALLET_ADDRESS`、`A9_METADATA_URI`），先只读干跑预检，再由业主单独书面授权执行：
```bash
cd /Users/yu1/Desktop/A9mini/ops
export A9_DEPLOY_WALLET="<mainnet_deployer_wallet_name>"
export A9_TREASURY_WALLET="<mainnet_treasury_wallet_name>"
export A9_KEEPER_ADDRESS="<mainnet_keeper_addr>"
export A9_ROUND_OPENER_ADDRESS="<mainnet_opener_addr>"
export A9_TEAM_WALLET_ADDRESS="<mainnet_team_multisig_addr>"
export A9_METADATA_URI="https://app.a9.lat/a9.json"

# 1) 只读干跑预检（零链上消息，派生并核对合约地址与钱包余额；主网默认 earlyWindowSeconds=21600 / obsSeconds=43200 / vestingSeconds=1209600）
node scripts/deploy-v15.mjs --protocol v17 --profile mainnet --strict --dry-run

# 2) 业主书面授权后执行真实主网铸币、验明实收 10,000,000,000 A9 后再弃权、并注资 8,200,000,000 A9 至 RoundController（部署后暂不开轮）
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node scripts/deploy-v15.mjs --protocol v17 --profile mainnet --strict --execute
```
核验输出：
- `JettonMaster` `totalSupply === 10,000,000,000 A9` 且 `mintable === false`（永久弃权）；
- `RoundController` JettonWallet 余额精确为 `8,200,000,000 A9`，`currentRoundId === 0`，`teamWallet` 为正确的多签/硬件主网地址；
- `treasury` 留存 `1,800,000,000 A9` 供后续划拨至独立预售热钱包、推广热钱包与 STON.fi 流动池。

### 1C. 回填主网合约地址并部署只读 Worker（三开关保持 `"0"`）
> **关于预期的 `503 PRODUCTION_CONFIG_INCOMPLETE`**：生产 Worker 内置 Fail-Closed 安全门禁。在波次 1B 尚未部署主网合约并回填以下 4 个地址前，线上 `GET /api/config` 与 `GET /api/health` 返回 `503 PRODUCTION_CONFIG_INCOMPLETE` 属预期保护行为，须于本步回填地址并完成部署后再验收 `200 OK`。

确认 `[env.production.vars]` 全部必填变量非空（尤其 `A9_TON_PROOF_DOMAINS` 与两枚独立热钱包地址，缺任一项均触发 fail-closed 503）：
- `A9_NETWORK = "mainnet"`
- `A9_PROTOCOL_VERSION = "v17"`
- `A9_OBS_SECONDS = "43200"`、`A9_VESTING_SECONDS = "1209600"`、`A9_EARLY_WINDOW_SECONDS = "21600"`
- `TONCENTER_API_BASE = "https://toncenter.com/api/v2"`
- `A9_PUBLIC_ORIGIN = "https://app.a9.lat"`
- `A9_API_ORIGIN = "https://api.a9.lat"`（Telegram 战报卡片 `/c/img/*.png` 必须走 Worker API 域，绝不可误拼静态前端域）
- `A9_TG_BOT_HANDLE = "<BotUsername>"`
- `A9_ALLOWED_ORIGINS = "https://app.a9.lat,https://a9.lat"`
- `A9_TON_PROOF_DOMAINS = "app.a9.lat"`
- `A9_REQUIRE_RUNNER_HEARTBEAT = "1"`
- `A9_BROADCAST_WHALE_MIN_GRAM = "50"`（先保留默认 50，待放量后按需调优）
- `A9_JETTON_MASTER_ADDRESS` / `A9_ROUND_CONTROLLER_ADDRESS` / `A9_PROMO_HOT_WALLET_ADDRESS` / `A9_PRESALE_HOT_WALLET_ADDRESS`（两个热钱包地址必须严格不同）
- `A9_PRESALE_OPEN = "0"`、`A9_CHEST_OPEN_ENABLED = "0"`、`A9_BROADCAST_ENABLED = "0"`

```bash
cd /Users/yu1/Desktop/A9mini/worker
npx wrangler deploy --env production
```

### 1D. 波次 1 必过验收项
1. `GET https://api.<domain>/api/health` 返回 `200`，`checks.db.ok === true`；
2. `GET https://api.<domain>/api/config` 返回 `network: "mainnet"`、`protocolVersion: "v17"`、`presaleHotWallet.open: false`、`chestMall.openEnabled: false`、6 档宝箱纯整数 SKU（含 500 GRAM 传说宝箱、不限个人购箱上限）、无伪造数据；
3. 使用已鉴权且已绑定钱包的会话调用 `POST /api/presale/intent`（带 `skuId: "chest_bronze"`）返回 `400 PRESALE_CLOSED`（匿名请求先返回 `401`）；调用 `POST /api/chests/:id/open` 返回 `403 CHEST_OPEN_DISABLED`；
4. 移动端 `390×844` 打开正式 Telegram Mini App，完成 Telegram `initData` 与 `ton_proof` 验签绑定，全站只读无报错。

---

## 2. 波次 2：开放宝箱商城 + 推广 0.06 GRAM 领币（零闯关合约风险冷启动）

**前置门禁**：
- `presaleHotWallet` 与 `promoHotWallet` 相互完全独立且均已从 `treasury` 划入当批 A9 库存与 GRAM 启动储备；
- 独立签名主机已创建权限 `chmod 600` 的 `~/.config/a9-mainnet/daemon.env`，包含完整必填项：
  - `A9_NETWORK=mainnet`
  - `A9_PROTOCOL_VERSION=v17`
  - `CLOUDFLARE_ACCOUNT_ID=<account_id>`
  - `CLOUDFLARE_D1_DATABASE_ID=<prod_d1_id>`
  - `CLOUDFLARE_API_TOKEN=<d1_edit_token>`
  - `TONCENTER_API_BASE=https://toncenter.com/api/v2`
  - `TONCENTER_V3_API_BASE=https://toncenter.com/api/v3`（可选，默认自动派生）
  - `TONCENTER_API_KEY=<mainnet_key>`（与 `TONCENTER_MAINNET_API_KEY=<mainnet_key>`）
  - `A9_JETTON_MASTER_ADDRESS=<master_addr>`
  - `A9_PROMO_HOT_WALLET_ADDRESS=<promo_addr>` / `A9_PROMO_HOT_WALLET_NAME=<promo_wallet_name>`
  - `A9_PRESALE_HOT_WALLET_ADDRESS=<presale_addr>` / `A9_PRESALE_HOT_WALLET_NAME=<presale_wallet_name>`
  - `A9_PRESALE_OPEN=1`、`A9_RUNNER_ID=mainnet-payout-daemon-1`、`A9_DAEMON_INTERVAL_MS=10000`、`A9_DAEMON_HEALTH_PORT=18788`
  - 若开启波次 2 战报播报：同时配置 `A9_BROADCAST_ENABLED=1`、`A9_BOT_TOKEN=<bot_token>`、`A9_TG_BOT_HANDLE=<BotUsername>`、`A9_PUBLIC_ORIGIN=https://app.a9.lat`、`A9_API_ORIGIN=https://api.a9.lat`、`A9_BROADCAST_WHALE_MIN_GRAM=50`

### 2.1 独立签名主机启动 `payout-daemon.mjs`
先干跑验证连接生产 D1 与主网 TonCenter v3（零广播）：
```bash
cd /Users/yu1/Desktop/A9mini/worker
set -a && source ~/.config/a9-mainnet/daemon.env && set +a
node src/payout-daemon.mjs --once
```
确认输出无报错后，用守护进程（systemd / launchd / pm2）启动正式执行态：
```bash
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node src/payout-daemon.mjs --execute
```
确认 `GET https://api.<domain>/api/health` 中 `data.checks.runnerHeartbeats[i]` 显示 `network: "mainnet"` 且 `meta.status: "ok"`、`meta.executeLive: true`。

### 2.2 小额真钱冒烟验证与分步开闸（放量前必做）
1. **第一步（开购箱 + 开箱入账，保持群播报关闭）**：将 Worker 变量置为 `A9_PRESALE_OPEN = "1"`、`A9_CHEST_OPEN_ENABLED = "1"`、`A9_BROADCAST_ENABLED = "0"` 并部署；前端部署配置开启 `window.__A9_CONFIG__.liveFundsEnabled = true`；
2. 使用团队自有主网小号实测 4 笔真实小额闭环并逐项链上+库表对账：
   - `0.99 GRAM`（实付 `1.05 GRAM` 含 `0.06 GRAM` 发币 Gas）青铜箱购箱 → 买家链上 A9 `JettonWallet` 实测收到合并直发的一笔 TEP-74（`1,500 A9` 保底本金 + 区间随机加赠 `0–1,000 A9`，实得 `1,500–2,500 A9`）、`presale_orders` 为 `COMPLETED`、`presale_payouts` 为 `CONFIRMED`、`presale_referral_credits` 记账推荐人 6% 佣金并同步扣减 `promo_budget_ledger`（`presale_promo` 槽位）后入 `promo_balances`（同时为邀请人进行中的免费箱幂等 `+3` 助力）；
   - **免费宝箱开箱入账对账**：实测免费新手青铜宝箱（`200 A9`，0 助力免门槛秒开）调用 `POST /api/chests/:id/open` 返回 `200`（非 `403 CHEST_OPEN_DISABLED`），核对 `user_chests.status = 'OPENED'`、`chest_open_credits` 与 `promo_budget_ledger` 留痕、免费青铜箱精确入账 `prediction_rewards.pending_activation_raw`（且白银箱转为 `ACTIVE`）；
   - 过期单晚付 / 异常直转退款 → 实测 `gram_refund_v15.tolk` 按退款规则扣除 `0.03 GRAM` 链上退回 Gas 后原路退回（支付 `1.05 GRAM` 退回 `1.02 GRAM`；异常直转 `0.99 GRAM` 退回 `0.96 GRAM`），`presale_orders` 为 `REFUNDED`、`presale_payouts` 为 `CONFIRMED`；
   - **推广 0.06 GRAM 领币与最终到账对账**：推荐人/开箱领取人付 `0.06 GRAM` 发起领取 → 核对 `promo_claims.status = 'COMPLETED'`（带真实链上入账 `fee_tx_hash` 与出账 `payout_tx_hash`）、`promo_payouts.status = 'CONFIRMED'`（且 `promo_payouts.tx_hash === promo_claims.payout_tx_hash`）、`promo_balances.claimable_raw` 精确扣减且 `total_claimed_raw` 等额增加、**领取人主网 A9 `JettonWallet` 实测收到对应全部 A9 余额**、且 `promoHotWallet` GRAM 净增加（项目方 0 Gas 支出）。
3. **第二步（Bot 注册冒烟 + 账实对平后开启 TG 播报）**：
   - 先干跑再授权注册 Bot Webhook（`https://api.<domain>/api/telegram/webhook`）、菜单命令（`/start`、`/status`、`/help`）与左下角 WebApp 菜单按钮：
```bash
cd /Users/yu1/Desktop/A9mini/ops
node scripts/setup-tg-bot.mjs --dry-run \
  --webhook-url https://api.<domain>/api/telegram/webhook \
  --app-url https://app.<domain>
# 业主授权后真实注册：
OPS_EXECUTE=1 OPS_CONFIRM=YES node scripts/setup-tg-bot.mjs --execute \
  --webhook-url https://api.<domain>/api/telegram/webhook \
  --app-url https://app.<domain>
```
   - 冒烟 3 项必过：`POST /api/telegram/webhook` 缺或错 `X-Telegram-Bot-Api-Secret-Token` 必返 `401`；私聊 Bot 发送 `/start`、`/status`、`/help` 均收到零 Emoji 回复且 `/status` 无轮次时明确显示待核验；打开小程序【我的 -> 提醒与设置】验证「结算与领取」开关持久化、整点推送行显示「个人整点推送暂未开放」并置灰。
   - 核验 D1 真实表 `presale_orders`、`presale_payouts`、`presale_referral_credits`、`user_chests`、`chest_assists`、`chest_open_credits`、`prediction_rewards`、`promo_balances`、`promo_claims`、`promo_payouts`、`user_notification_prefs`、`runner_heartbeats` 与链上余额 100% 一致后，再将 `A9_BROADCAST_ENABLED = "1"`（`A9_BROADCAST_WHALE_MIN_GRAM` 先保持 `"50"`）部署并正式放量。

---

## 3. 波次 3：开启 `v17` 主网阶段 C 闯关锁仓

**前置门禁与波次 3 技术待办（完成并独立验收前严禁开启波次 3）**：
- **波次 3 技术待办 1 — 主网返佣/空投终局核验服务**：在链上终局、实际通关奖金、真实参与者与随机种子证据核验服务完成并独立验收前，主网 `POST /api/admin/v17/stake-referral/settle` 与 `POST /api/admin/v17/airdrop/draw` 代码级保持 `503 V17_CHAIN_SETTLEMENT_UNAVAILABLE`；
- **波次 3 技术待办 2 — 正式行情采集与轮次结算链路**：STON.fi 主网 A9/GRAM 初始流动性池建立后，完成 12 根 1H K 线采集、时间对齐与异常（缺段/重复/陈旧价格）自动化验证，主网严禁手工达标数旁路；
- **波次 3 技术待办 3 — 外部 W5 运维签名通道与角色合设确认**：若主网 `keeper` / `roundOpener` 不放在本机 `wallets.toml` 而由外部手机/硬件 W5 签名，须在开轮前补充外部 W5 轮次签名通道；同时须获业主书面确认接受 `bundle-mainnet-v17.0.json` 中 `keeper` / `roundOpener` 合用同一地址的现状；
- 再次核对 `RoundController` JettonWallet 余额精确为 `8,200,000,000 A9` 且 `teamWallet` 为正确多签/硬件地址；

### 3.1 轮次日常运维（主网强制严格 12 根 1H K 线对齐）
```bash
cd /Users/yu1/Desktop/A9mini/ops
export A9_ROUND_CONTROLLER_ADDRESS="<mainnet_v17_rc_addr>"

# 开轮（必须显式指定 --round，目标价须严格落在 [1.30x, 2.00x] 走廊内；由 A9_OPENER_WALLET 或 --signer 指定独立开轮钱包）
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node scripts/round-ops.mjs --protocol v17 --profile mainnet --action open-round \
    --round 1 --twap 116000 --target 174000 --execute

# 单笔结算（主网强制 12 根 --candles-file 与 --stake-close-at，自动与链上 get_round 交叉核验 target/stakeCloseAt；由 A9_KEEPER_WALLET 或 --signer 指定独立结算钱包；附 0.4 TON Gas）
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node scripts/round-ops.mjs --protocol v17 --profile mainnet --action settle-round \
    --round 1 --target 174000 --candles-file /path/to/r1-candles.json \
    --stake-close-at <unix_sec> --execute

# 若极端拥堵导致结算附带的团队释放/销毁 bounce 积压在 pendingTeamReleaseRaw / pendingBurnRaw，可无许可一键重放（幂等 O(1)）
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node scripts/round-ops.mjs --protocol v17 --profile mainnet --action retry-payouts --execute
```

---

## 4. 一键应急止损与回滚清单

若发现任何异常（RPC 持续抖动、余额对账偏差、`NEEDS_REVIEW` 积压）：
1. **30 秒关停新单入口**：将 Worker 变量 `A9_PRESALE_OPEN = "0"`、`A9_CHEST_OPEN_ENABLED = "0"`、`A9_BROADCAST_ENABLED = "0"` 重新部署（或前端将 `liveFundsEnabled` 置回 `false`）；
2. **保留 `payout-daemon.mjs` 在线或切回只读**：已支付未完成的订单会通过唯一 `queryId` 与 TonCenter v3 终局核验安全收尾或进入 `NEEDS_REVIEW`（绝不重复发币）；
3. **人工核账后解锁**：通过带 `A9_ADMIN_TOKEN` 的管理接口核查异常记录与 `runner_heartbeats`，确认链上与 D1 完全对平后再恢复开放。
