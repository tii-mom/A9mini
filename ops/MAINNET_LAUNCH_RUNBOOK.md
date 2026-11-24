# A9 · 财富大冒险 主网分波次上线执行手册（波次 1 → 波次 2 → 波次 3）

> **安全总则**：本手册严格遵循 `AGENTS.md` 安全边界——所有写操作脚本默认 dry-run；任何密钥、助记词与 API Token 严禁入库或粘贴进聊天记录；未完成前置波次验收前，严禁提前打开下一波次开关。

---

## 0. 主网前置物料准备（业主提供 / 本机生成）

| 序号 | 配置项 | 说明 | 获取/生成方式 |
|---|---|---|---|
| 1 | 正式域名 | 前端域名（如 `https://app.<domain>`）与 API 域名（如 `https://api.<domain>`） | Cloudflare DNS 接入正式域名并开启 HTTPS 代理 |
| 2 | 正式 Telegram Bot | `A9_BOT_TOKEN`（Secret）与 `A9_TG_BOT_HANDLE`（不含 `@`） | `@BotFather` 执行 `/newbot` 与 `/newapp` 绑定前端域名 |
| 3 | 主网 TonCenter Key | `TONCENTER_API_KEY`（Secret，Mainnet 档位，建议 >= 10 RPS） | `@tonapibot` 或 toncenter.com 申请 Mainnet Key |
| 4 | 5 个独立主网钱包 | `deployer`、`treasury`、`keeper/opener`、`presaleHotWallet`、`promoHotWallet`（**严禁复用或混用**） | 本机执行 `acton wallet new <name>`；助记词离线冷备 |
| 5 | 团队多签/硬件地址 | `A9_TEAM_WALLET_ADDRESS`（主网部署 `RoundController` 时永久固化） | 硬件钱包或 TON Multisig 主网地址 |
| 6 | 管理与 D1 Token | `A9_ADMIN_TOKEN`（Secret）与 `CLOUDFLARE_API_TOKEN`（仅 `Account: D1: Edit` 权限） | `openssl rand -hex 32` 与 Cloudflare Dashboard API Tokens |
| 7 | 代币元数据 JSON | `A9_METADATA_URI`（如 `https://app.a9.lat/a9.json`） | 上传符合 TEP-64 的 `a9.json`（精度 9、名称、Logo）至正式前端静态域 |

建议主网启动 GRAM 储备：
- `deployer`：`>= 5 GRAM`（部署合约 Gas）
- `treasury`：`>= 3 GRAM`（100 亿一次铸造弃权 + 82 亿注资 RoundController）
- `keeper` / `roundOpener`：`>= 3 GRAM`
- `presaleHotWallet`：`>= 5 GRAM`（A9 发币与被动退款 Gas 垫底）
- `promoHotWallet`：`>= 3 GRAM`（启动储备，用户每次 0.06 GRAM 找零持续净增）

---

## 1. 波次 1：拆分执行（波次 1A 前端/基础设施只读上线 → 波次 1B 主网铸币与 82 亿注资）

**拆分原则**：严禁将“前端静态站只读上线”与“主网不可逆铸币弃权 / 82 亿注资”捆绑在同一步。先在**零主网铸币、零资金暴露**前提下完成前端静态站、域名、Bot 与 D1 只读链路验收（波次 1A），再经业主单独书面授权执行主网 4 合约部署、铸币弃权与 82 亿注资（波次 1B，仍不开轮）。

### 1A. 前端静态站只读上线与生产基础设施预演（零链上铸币/注资）
> **生产写操作红线**：本步中的**远程生产 D1 迁移（`--remote`）**与**生产 Worker Secrets 注入（`wrangler secret put`）**均直接写入生产 Cloudflare 环境，**必须由业主单独书面授权后方可执行**；未获单独授权前仅可进行本地只读预演与静态资产核对。

1. **发布静态前端与元数据（含官网分域对齐）**：若独立官网（`a9-official-web/`）占根域 `https://a9.lat`，推荐 Mini App 部署至 `https://app.a9.lat` 并同步更新 `tonconnect-manifest.json` 的 `url`、`A9_PUBLIC_ORIGIN` 与 `A9_TON_PROOF_DOMAINS`，同时确保根域或静态域上的 `a9.json`、`tonconnect-manifest.json` 与 `assets/token/a9-token-2048.png` 返回 `HTTP 200` 且带 `Access-Control-Allow-Origin: *`（`a9-mini-app/_headers` 已内置）；确认 `window.__A9_CONFIG__.liveFundsEnabled = false`；
2. **生产 D1 迁移（0001..0010，写生产库 · 须单独授权）**：
```bash
cd /Users/yu1/Desktop/A9mini/worker
npx wrangler d1 migrations apply a9mini-v15-prod --remote --env production
```
   验收项：先备份存量库再按序执行 10 份迁移，确认 28 张表与 23 个索引就绪、`PRAGMA integrity_check = ok`。
3. **注入生产 Worker Secrets（写生产环境 · 须单独授权，严禁写入 wrangler.toml）**：
```bash
cd /Users/yu1/Desktop/A9mini/worker
npx wrangler secret put A9_BOT_TOKEN --env production
npx wrangler secret put A9_ADMIN_TOKEN --env production
npx wrangler secret put TONCENTER_API_KEY --env production
```
4. **前端只读验收**：在移动端 `390×844` 打开正式 Telegram Mini App，确认广场/闯关/宝箱商城（`#/internal/market` 与 `#/market`）/战队/我的零报错、零 Emoji、数字完整不缩写、所有资金按钮只读禁用，且 `tonconnect-manifest.json` 握手正常。

### 1B. 主网 4 合约部署、铸币弃权与 82 亿注资（暂不开轮）
先验证 `v16/ci/artifacts.sha256`（4/4）与 Acton 单元测试全部通过，导出主网必填部署变量（`A9_DEPLOY_WALLET`、`A9_TREASURY_WALLET`、`A9_KEEPER_ADDRESS`、`A9_ROUND_OPENER_ADDRESS`、`A9_TEAM_WALLET_ADDRESS`、`A9_METADATA_URI`），先只读干跑预检，再由业主单独书面授权执行：
```bash
cd /Users/yu1/Desktop/A9mini/ops
export A9_DEPLOY_WALLET="<mainnet_deployer_wallet_name>"
export A9_TREASURY_WALLET="<mainnet_treasury_wallet_name>"
export A9_KEEPER_ADDRESS="<mainnet_keeper_addr>"
export A9_ROUND_OPENER_ADDRESS="<mainnet_opener_addr>"
export A9_TEAM_WALLET_ADDRESS="<mainnet_team_multisig_addr>"
export A9_METADATA_URI="https://app.a9.lat/a9.json"

# 1) 只读干跑预检（零链上消息，派生并核对合约地址与钱包余额）
node scripts/deploy-v15.mjs --protocol v16 --profile mainnet --strict --dry-run

# 2) 业主书面授权后执行真实主网铸币、弃权与 82 亿注资（部署后暂不开轮）
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node scripts/deploy-v15.mjs --protocol v16 --profile mainnet --strict --execute
```
核验输出：
- `JettonMaster` `totalSupply === 10,000,000,000 A9` 且 `mintable === false`（永久弃权）；
- `RoundController` JettonWallet 余额精确为 `8,200,000,000 A9`，`currentRoundId === 0`，`teamWallet` 为正确的多签/硬件主网地址；
- `treasury` 留存 `1,800,000,000 A9` 供后续划拨至独立预售热钱包、推广热钱包与 STON.fi 流动池。

### 1C. 回填主网合约地址并部署只读 Worker（三开关保持 `"0"`）
确认 `[env.production.vars]` 全部必填变量非空（尤其 `A9_TON_PROOF_DOMAINS` 与两枚独立热钱包地址，缺任一项均触发 fail-closed 503）：
- `A9_NETWORK = "mainnet"`
- `A9_PROTOCOL_VERSION = "v16"`
- `TONCENTER_API_BASE = "https://toncenter.com/api/v2"`
- `A9_PUBLIC_ORIGIN = "https://app.a9.lat"`
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
2. `GET https://api.<domain>/api/config` 返回 `network: "mainnet"`、`protocolVersion: "v16"`、`presaleHotWallet.open: false`、5 档宝箱精确 SKU、无伪造数据；
3. 使用已鉴权且已绑定钱包的会话调用 `POST /api/presale/intent`（带 `skuId: "chest_bronze"`）返回 `400 PRESALE_CLOSED`（匿名请求先返回 `401`）；调用 `POST /api/chests/:id/open` 返回 `403 CHEST_OPEN_DISABLED`；
4. 移动端 `390×844` 打开正式 Telegram Mini App，完成 Telegram `initData` 与 `ton_proof` 验签绑定，全站只读无报错。

---

## 2. 波次 2：开放宝箱商城 + 推广 0.06 GRAM 领币（零闯关合约风险冷启动）

**前置门禁**：
- `presaleHotWallet` 与 `promoHotWallet` 相互完全独立且均已从 `treasury` 划入当批 A9 库存与 GRAM 启动储备；
- 独立签名主机已创建权限 `chmod 600` 的 `~/.config/a9-mainnet/daemon.env`，包含完整必填项：
  - `A9_NETWORK=mainnet`
  - `A9_PROTOCOL_VERSION=v16`
  - `CLOUDFLARE_ACCOUNT_ID=<account_id>`
  - `CLOUDFLARE_D1_DATABASE_ID=<prod_d1_id>`
  - `CLOUDFLARE_API_TOKEN=<d1_edit_token>`
  - `TONCENTER_API_BASE=https://toncenter.com/api/v2`
  - `TONCENTER_V3_API_BASE=https://toncenter.com/api/v3`（可选，默认自动派生）
  - `TONCENTER_API_KEY=<mainnet_key>`
  - `A9_JETTON_MASTER_ADDRESS=<master_addr>`
  - `A9_PROMO_HOT_WALLET_ADDRESS=<promo_addr>` / `A9_PROMO_HOT_WALLET_NAME=<promo_wallet_name>`
  - `A9_PRESALE_HOT_WALLET_ADDRESS=<presale_addr>` / `A9_PRESALE_HOT_WALLET_NAME=<presale_wallet_name>`
  - `A9_PRESALE_OPEN=1`、`A9_RUNNER_ID=mainnet-payout-daemon-1`、`A9_DAEMON_INTERVAL_MS=10000`、`A9_DAEMON_HEALTH_PORT=18788`

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
   - `0.99 GRAM` 青铜箱购箱 → 买家链上 A9 `JettonWallet` 实测到账 `1,981.98 A9`、`presale_orders` 为 `COMPLETED`、`presale_payouts` 为 `CONFIRMED`、`user_chests` 生成对应 `SHOP_BOOST` 膨胀箱、`presale_referral_credits` 记账推荐人 12% 佣金并入 `promo_balances`；
   - **宝箱开箱入账对账**：实测免费青铜宝箱 #1（`chest_assists` 满 2 位活跃钱包助力）与商城膨胀箱调用 `POST /api/chests/:id/open` 返回 `200`（非 `403 CHEST_OPEN_DISABLED`），核对 `user_chests.status = 'OPENED'`、`chest_open_credits` 留痕、免费青铜箱精确入账 `prediction_rewards.pending_activation_raw`（且青铜 #2 转为 `ACTIVE`）、商城膨胀箱增量精确入账 `promo_balances.claimable_raw`；
   - `0.99 GRAM` 过期单晚付 → 实测 `gram_refund_v15.tolk` 原路全额退回 `0.99 GRAM`，`presale_orders` 为 `REFUNDED`、`presale_payouts` 为 `CONFIRMED`；
   - **推广 0.06 GRAM 领币与最终到账对账**：推荐人/开箱领取人付 `0.06 GRAM` 发起领取 → 核对 `promo_claims.status = 'COMPLETED'`（带真实链上入账 `fee_tx_hash` 与出账 `payout_tx_hash`）、`promo_payouts.status = 'CONFIRMED'`（且 `promo_payouts.tx_hash === promo_claims.payout_tx_hash`）、`promo_balances.claimable_raw` 精确扣减且 `total_claimed_raw` 等额增加、**领取人主网 A9 `JettonWallet` 实测收到对应全部 A9 余额**、且 `promoHotWallet` GRAM 净增加（项目方 0 Gas 支出）。
3. **第二步（账实对平后开启 TG 播报）**：核验 D1 真实表 `presale_orders`、`presale_payouts`、`presale_referral_credits`、`user_chests`、`chest_assists`、`chest_open_credits`、`prediction_rewards`、`promo_balances`、`promo_claims`、`promo_payouts`、`runner_heartbeats` 与链上余额 100% 一致后，再将 `A9_BROADCAST_ENABLED = "1"`（`A9_BROADCAST_WHALE_MIN_GRAM` 先保持 `"50"`）部署并正式放量。

---

## 3. 波次 3：开启 `v16` 主网阶段 C 闯关质押

**前置门禁**：
- STON.fi 主网 A9/GRAM 初始流动性池已建立并产生稳定 24H TWAP 行情；
- 再次核对 `RoundController` JettonWallet 余额精确为 `8,200,000,000 A9` 且 `teamWallet` 为正确多签/硬件地址；

### 3.1 轮次日常运维（主网强制严格 K 线对齐）
```bash
cd /Users/yu1/Desktop/A9mini/ops
export A9_ROUND_CONTROLLER_ADDRESS="<mainnet_v16_rc_addr>"

# 开轮（必须显式指定 --round，目标价须严格落在 [1.50x, 2.50x] 走廊内）
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node scripts/round-ops.mjs --protocol v16 --profile mainnet --action open-round \
    --round 1 --twap 116000 --target 232000 --signer opener --execute

# 单笔结算（主网强制 --candles-file 与 --stake-close-at，校验 24 根连续 K 线对齐 86400s 观察窗）
OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES \
  node scripts/round-ops.mjs --protocol v16 --profile mainnet --action settle-round \
    --round 1 --target 232000 --candles-file /path/to/r1-candles.json \
    --stake-close-at <unix_sec> --signer keeper --execute
```

---

## 4. 一键应急止损与回滚清单

若发现任何异常（RPC 持续抖动、余额对账偏差、`NEEDS_REVIEW` 积压）：
1. **30 秒关停新单入口**：将 Worker 变量 `A9_PRESALE_OPEN = "0"`、`A9_CHEST_OPEN_ENABLED = "0"`、`A9_BROADCAST_ENABLED = "0"` 重新部署（或前端将 `liveFundsEnabled` 置回 `false`）；
2. **保留 `payout-daemon.mjs` 在线或切回只读**：已支付未完成的订单会通过唯一 `queryId` 与 TonCenter v3 终局核验安全收尾或进入 `NEEDS_REVIEW`（绝不重复发币）；
3. **人工核账后解锁**：通过带 `A9_ADMIN_TOKEN` 的管理接口核查异常记录与 `runner_heartbeats`，确认链上与 D1 完全对平后再恢复开放。
