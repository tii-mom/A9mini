# A9 Protocol v15 — 极简合约套件

独立、零历史包袱的 A9 协议 v15 极简合约架构：以最少的代码完整实现 v14 核心玩法，非核心功能交由热钱包处理。

## 架构精简对比（v14 → v15）

| 维度 | v14 | **v15（本目录）** |
| :--- | :--- | :--- |
| **合约总数** | 8 个合约（22 文件） | **4 个合约（12 文件，自研业务仅 2 个）** |
| **总代码量** | 6,059 行 Tolk | **1,745 行 Tolk（减少 ~71%）** |
| **核心自研代码** | ~4,940 行 | **1,163 行（减少 ~76%）** |
| **代币合约** | 魔改 TEP-74（`JettonWallet` 448 行） | **100% 标准零魔改 TEP-74**（mint 100 亿一次即弃权） |
| **推广奖励** | 3 合约（`JunxiangDistributor` + `ClaimRecord` + `PaymentReceipt`） | **0 合约**（用户转 `0.06 TON` 覆盖 Gas → 热钱包自动发 A9） |
| **异常退款** | `DepositReceipt` 子合约 + `DepositBook` 位图 | **0 子合约**（异常入金当场用附带 Gas 原路退回） |
| **一键续期** | 3 合约跨链异步状态机（`RestakePending`） | **已移除**（前端普通“先领后质押”或批量交易） |
| **喂价与结算** | 24 笔 `SubmitCandle` + `CloseStaking` + 6h 冷静期 + `FinalizeRound` | **单笔 `SettleRound` 一步结算，达标秒开放领取** |

## 目录结构

```
v15/
├── Acton.toml
├── contracts/
│   ├── jetton/
│   │   ├── JettonMaster.tolk      # 标准 TEP-74（100 亿一次铸完即永久弃权）
│   │   ├── JettonWallet.tolk      # 100% 标准零魔改 TEP-74 钱包
│   │   ├── storage.tolk           # 极简 3 字段 WalletStorage
│   │   ├── messages.tolk          # 标准 TEP-74 消息
│   │   ├── fees-management.tolk   # 标准 Gas 校验
│   │   ├── jetton-utils.tolk      # 标准地址派生
│   │   ├── errors.tolk            # 标准错误码
│   │   └── sharding.tolk          # BASECHAIN / SHARD_DEPTH=8
│   ├── types.tolk                 # 常量、错误码、存储与精简视图
│   ├── ticket.tolk                # StakeTicket 存储与消息
│   ├── StakeTicket.tolk           # 极简质押凭证（单用户单轮）
│   └── RoundController.tolk       # 极简协议主控合约
└── tests/
    ├── helpers.tolk               # 测试环境与辅助函数
    ├── jetton.test.tolk           # 标准代币测试（铸币/弃权/转账/销毁）
    └── protocol.test.tolk         # 协议全规则单元测试（9 大场景）
```

## 核心接口速查（前端 / Worker 对接）

### 入站消息（Opcode）
- `0x52540001` **`OpenRound(queryId, twap24hUsdE8, targetPriceUsdE8)`**：`roundOpener` 开轮，校验 `[1.5×, 2.5×]` 走廊，立刻开启质押窗口。
- `0x52540002` **`SettleRound(queryId, roundId, qualifiedCandles, candleHash)`**：观察期满后由 `keeper` 或 `roundOpener` 单笔结算（需附带 `>= 0.25 TON`），达标即刻开放领取。
- `0x52540003` **`AbortRound(queryId)`**：观察期 + 超时（默认 7 天）后任何人可触发逃生门，退回本金、奖池滚存。
- `0x52540004` **`BurnInactiveLocked(queryId)`**：距上次达标满 90 天后任何人可触发，销毁未解锁份额（已解锁部分永久保留）。
- `0x5254000F` **`StakeDeposit`（TEP-74 `forward_payload`）**：格式为 `op(32) + roundId(8) + beneficiary(address?)`，需附带 `forwardTonAmount >= 0.1 TON`。
- `0x52540303` **`TicketClaim(queryId)`**：用户发往自己的 `StakeTicket`（需附带 `>= 0.2 TON`），自动领回本金 + 已解锁奖励，剩余 TON 退回用户。

### 推广奖励热钱包自费 Gas 流程（0 合约）
1. 用户在小程序点击领取 → 钱包向项目方推广热钱包转 **`0.06 TON`**（备注 `claim:<uid>:<nonce>`）。
2. 后端监听到账确认后，热钱包发一笔标准 TEP-74 `AskToTransfer` 将 A9 打给用户，且 `sendExcessesTo` 设为**热钱包自己**。
3. 单笔 Jetton 转账净耗 `0.015~0.045 TON`，用户支付的 `0.06 TON` 完全覆盖成本，项目方 0 Gas 支出。

## 编译与运行测试

```bash
cd /Users/yu1/Desktop/BAM/v15
export PATH="$HOME/.acton/bin:$PATH"
acton build
acton test
```
