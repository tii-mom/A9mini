# A9mini `ops/` — v16 极简部署与轮次运维手册

本目录对应 **A9 Protocol v16（唯一 4 合约架构，严格 O(1) 零待决字典 + 32 位轮次）**，零外部 npm 依赖，所有写操作脚本**默认 dry-run**，广播真实交易必须同时传 `--execute` 且设置 `OPS_EXECUTE=1 OPS_CONFIRM=YES`（主网另需 `OPS_CONFIRM_MAINNET=YES`）。

## 目录结构

```
ops/
├── .env.example                 # 环境变量模板（密钥不入库）
├── MAINNET_LAUNCH_RUNBOOK.md    # 主网分波次上线执行手册
├── tolk/
│   ├── deploy_v16.tolk          # Acton 4 合约一键部署 + 100 亿一次铸造弃权 + 82 亿注资
│   ├── round_ops_v16.tolk       # OpenRound / SettleRound / AbortRound / BurnInactiveLocked
│   ├── promo_payout_v15.tolk    # 0 合约推广/宝箱热钱包 TEP-74 A9 发币脚本
│   └── gram_refund_v15.tolk     # 异常或售罄 GRAM 原路被动退款脚本
└── scripts/
    ├── lib/v15-core.mjs         # 三档参数配置、v16 产物 SHA-256 校验、走廊计算、24 根 K 线聚合哈希
    ├── deploy-v15.mjs           # 部署 CLI（默认 protocol=v16, dry-run）
    ├── round-ops.mjs            # 轮次运维 CLI（默认 protocol=v16, dry-run）
    └── selftest.mjs             # 离线自测脚本
```

## 快速命令

```bash
cd /Users/yu1/Desktop/A9mini/ops
node scripts/selftest.mjs
node scripts/deploy-v15.mjs --profile mainnet --strict --dry-run
```
