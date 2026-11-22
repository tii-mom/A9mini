# A9mini — A9 Protocol 新主项目（v15 极简架构）

本目录是 A9 Protocol 的新主项目，采用 **v15 极简 4 合约架构**（已通过本地 Acton 11/11 单元测试）。小程序唯一运行与发布目录为 `a9-mini-app/`，采用「暖棉纸立体书 × 实体厚卡纸贴纸」统一视觉与交互体系。静态托管根目录指向该目录，默认入口为 `index.html`。BAM（`/Users/yu1/Desktop/BAM`）仅作为只读参考来源。

## 目录

| 路径 | 用途 |
|---|---|
| `v15/` | A9 v15 极简 4 合约套件（标准 TEP-74 `JettonMaster`/`JettonWallet` + `RoundController` + `StakeTicket`）与 11 项单元测试 |
| `ops/` | v15 部署脚本、轮次运维（`OpenRound` / `SettleRound` / `AbortRound` / `BurnInactiveLocked`）、测试网/主网参数与离线自测 |
| `a9-mini-app/` | Telegram Mini App 实现（原生 ES Modules，零构建） |
| `stitch_a9_telegram_mini_app/` | 设计参考，只读 |
| `docs/` | 迁移记录、v15 合约基线与测试计划、验收报告 |

## 当前进度

- **已完成**：
  1. `v15/` 4 合约重构（从 v14 的 8 合约 6,059 行精简至 4 合约 1,745 行），`acton build && acton test` **11/11 全绿**，编译产物 SHA-256 锁定于 `v15/ci/artifacts.sha256`。
  2. `ops/` 极简部署与轮次运维工具链就绪（默认 dry-run，含离线自测与测试网/主网参数配置）。
  3. `a9-mini-app/` 已完成 demo/live 模式隔离与只读首页接入（下一步切至 v15 规则并接通 TonConnect 真实交易）。
- **待推进**：`worker/`（v15 状态索引 + `0.06 TON → 自动发 A9` 推广热钱包发币 Runner）、`a9-mini-app/` v15 真金链路、Testnet 全链路验收。

## 常用命令

```bash
# 1. 合约编译与单元测试（11/11）
cd /Users/yu1/Desktop/A9mini/v15
export PATH="$HOME/.acton/bin:$PATH"
acton build && acton test
shasum -a 256 -c ci/artifacts.sha256

# 2. 运维工具离线自测与 dry-run 检查
cd /Users/yu1/Desktop/A9mini/ops
node scripts/selftest.mjs
node scripts/deploy-v15.mjs --network testnet --dry-run

# 3. 本地启动前端
cd /Users/yu1/Desktop/A9mini/a9-mini-app && node dev-server.mjs
```
