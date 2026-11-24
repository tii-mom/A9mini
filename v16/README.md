# A9 Protocol v16 — 极简 4 合约主网套件

在完整保留 A9 全部核心玩法与 32 位无限轮次（`1–4,294,967,295`）的基础上，彻底移除臃肿的待决字典与恢复补丁，回归严格 O(1) 零待决字典设计。

## 精简结构（共 4 个合约、6 个源码文件）

```
v16/
├── Acton.toml
├── ci/artifacts.sha256
├── contracts/
│   ├── jetton/
│   │   ├── storage.tolk           # 标准零魔改 TEP-74 存储、消息、Gas 与地址派生
│   │   ├── JettonMaster.tolk      # 标准 TEP-74（100 亿一次铸完即永久弃权）
│   │   └── JettonWallet.tolk      # 标准零魔改 TEP-74 钱包
│   ├── types.tolk                 # 协议常量、O(1) 主控/凭证存储、消息与视图
│   ├── StakeTicket.tolk           # 极简单用户单轮质押凭证
│   └── RoundController.tolk       # 极简协议主控合约（零待决字典）
└── tests/
    ├── helpers.tolk
    ├── jetton.test.tolk
    └── protocol.test.tolk
```

## 核心接口（Opcode）
- `0x52540001` **`OpenRound(queryId, twap24hUsdE8, targetPriceUsdE8)`**：`roundOpener` 开轮，校验 `[1.5×, 2.5×]` 价格走廊。
- `0x52540002` **`SettleRound(queryId, roundId, qualifiedCandles, candleHash)`**：观察期满后单笔结算（`>= 0.25 GRAM`）。
- `0x52540003` **`AbortRound(queryId)`**：超时后无权限逃生门，全额退回本金、奖池滚存。
- `0x52540004` **`BurnInactiveLocked(queryId)`**：距上次达标满 90 天后销毁未决切片，保留已解锁奖励。
- `0x52540010` **`StakeDeposit`（TEP-74 `forward_payload`）**：`op(32) + roundId(32) + beneficiary(address?)`；无效入金即时原路退回。
- `0x52540303` **`TicketClaim(queryId)`**：发往用户的 `StakeTicket`（`>= 0.20 GRAM`），领取本金 + 已解锁奖励，余量 Gas 原路退回。

## 本地验证

```sh
(cd v16 && acton test && shasum -a 256 -c ci/artifacts.sha256)
node a9-mini-app/js/v15-tx.test.mjs
node ops/scripts/selftest.mjs
```
