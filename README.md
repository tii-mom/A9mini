# A9mini — A9 Protocol 主项目（v16 极简 O(1) 架构）

本目录是 A9 Protocol 的唯一主项目，采用 **v16 极简 4 合约零待决字典架构**（严格 O(1) 状态、32 位无限轮次、6 个合约源码文件，编译产物 SHA-256 已锁定于 `v16/ci/artifacts.sha256`）。小程序唯一运行与发布目录为 `a9-mini-app/`，采用「任天堂红白雪宣纸立体书 × 实体厚卡纸贴纸」统一视觉与交互体系。

## 目录

| 路径 | 用途 |
|---|---|
| `v16/` | A9 v16 唯一主网 4 合约套件（标准 TEP-74 `JettonMaster`/`JettonWallet` + `RoundController` + `StakeTicket`）与 Acton 单元测试 |
| `ops/` | v16 部署脚本、轮次运维（`OpenRound` / `SettleRound` / `AbortRound` / `BurnInactiveLocked`）、主网发布手册与离线自测 |
| `worker/` | Cloudflare Worker + D1 后端（链上状态缓存、Telegram `initData` + `ton_proof` 身份绑定、推广/兑换热钱包状态机、预热与宝箱商城） |
| `a9-mini-app/` | Telegram Mini App（原生 ES Modules，零构建）与配套 Bot（`bot/a9_bot.py`） |
| `a9-official-web/` | 项目官网（独立窗口维护，含 Cloudflare Worker 静态托管配置） |
| `stitch_a9_telegram_mini_app/` | 设计参考，只读 |
| `docs/` | 迁移记录、验收手册与历史归档文档 |

## 常用命令

```bash
# 1. v16 合约编译、单元测试与锁定哈希校验
cd /Users/yu1/Desktop/A9mini/v16
export PATH="$HOME/.acton/bin:$PATH"
acton test && shasum -a 256 -c ci/artifacts.sha256

# 2. 运维工具离线自测与 dry-run 预检
cd /Users/yu1/Desktop/A9mini/ops
node scripts/selftest.mjs
node scripts/deploy-v15.mjs --network testnet --dry-run

# 3. Worker / Mini App / Bot 单元测试
cd /Users/yu1/Desktop/A9mini
node --test worker/tests/*.test.mjs
node a9-mini-app/js/v15-tx.test.mjs
node a9-mini-app/js/batch-a-live-guard.test.mjs
python3 -m unittest a9-mini-app/bot/test_a9_bot.py

# 4. 本地启动前端开发服务
cd /Users/yu1/Desktop/A9mini/a9-mini-app && node dev-server.mjs
```
