# A9mini `ops/` — v15 极简部署与轮次运维手册

本目录对应 **A9 Protocol v15（4 合约架构）**，零外部 npm 依赖，所有写操作脚本**默认 dry-run**，广播真实交易必须同时传 `--execute` 且设置 `OPS_EXECUTE=1 OPS_CONFIRM=YES`（主网另需 `OPS_CONFIRM_MAINNET=YES`）。

## 目录结构

```
ops/
├── .env.example                 # 环境变量模板（密钥不入库）
├── tolk/
│   ├── deploy_v15.tolk          # Acton 4 合约一键部署 + 100 亿一次铸造弃权 + 82 亿注资
│   └── round_ops_v15.tolk       # OpenRound / SettleRound / AbortRound / BurnInactiveLocked
└── scripts/
    ├── lib/v15-core.mjs         # 三档参数配置（testnet/testnet-fast/mainnet）、产物 SHA-256 校验、走廊计算、24 根 K 线聚合哈希、v15 守恒公式
    ├── deploy-v15.mjs           # 部署 CLI（默认 dry-run）
    ├── round-ops.mjs            # 轮次运维 CLI（默认 dry-run）
    └── selftest.mjs             # 离线自测脚本
```

## 快速命令

### 1. 离线自测（无需网络与私钥）
```bash
cd /Users/yu1/Desktop/A9mini/ops
node scripts/selftest.mjs
```

### 2. 部署 4 合约（测试网 / 快测档）
```bash
# Dry-run 预检（核对 4 份产物 SHA-256 与参数）
node scripts/deploy-v15.mjs --profile testnet-fast --dry-run

# 真实部署到测试网（极速演练档）
export PATH="$HOME/.acton/bin:$PATH"
OPS_EXECUTE=1 OPS_CONFIRM=YES \
  A9_DEPLOY_WALLET=deployer A9_TREASURY_WALLET=treasury \
  A9_KEEPER_ADDRESS=<keeper_addr> A9_TEAM_WALLET_ADDRESS=<team_addr> \
  node scripts/deploy-v15.mjs --profile testnet-fast --execute
```

### 3. 开轮与单笔结算（无需 24 次链上喂价，无 6h 冷静期）
```bash
# 开第 1 轮（twap=0 回落 P0=116000，target=232000 在 [1.5x, 2.5x] 走廊内）
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_ROUND_CONTROLLER_ADDRESS=<rc_addr> \
  node scripts/round-ops.mjs --action open-round --round 1 --twap 0 --target 232000 --execute

# 观察期满后，聚合链下 24 根 K 线 JSON 并单笔结算（达标立刻开放领奖）
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_ROUND_CONTROLLER_ADDRESS=<rc_addr> \
  node scripts/round-ops.mjs --action settle-round --round 1 --target 232000 --candles-file candles-r1.json --execute

# 逃生门（超时 7 天未结算退本金）或 90 天停滞清零
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_ROUND_CONTROLLER_ADDRESS=<rc_addr> \
  node scripts/round-ops.mjs --action abort-round --execute
```
