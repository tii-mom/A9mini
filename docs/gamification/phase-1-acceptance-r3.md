# 第一阶段：验收第 3 轮定向整改说明（P0-A / P0-G / P0-I）

- **分支：** `feat/gamification-v1`
- **第 2 轮远程审查基线：** `1e4b0b55337cc2a2359d54e15a66cba95bdc864f`
- **本轮定向代码修复提交：** `bb113eb51ccf5b67e14cf81f6e0a99affcf38a2c`
- **状态：** 第 2 轮独立源码审查指出的 3 项剩余缺陷均已核实属实并完成根因修复与回归验证。**严格停留在第一阶段，未合并 `main`，未开始第二阶段，未修改生产配置或开启真实资金，未改动 `v15/` 合约产物，未改动 `/Users/yu1/Desktop/BAM`。**

---

## 一、审查问题逐项核实与根因修复

### 问题 1（P0-A）：真实推广领取单号可以掩盖错误金额 / 错收款钱包 / 错付款人 / 已过期或已消费的入账
- **核实结果：** **属实。** 已在 `1e4b0b5` 上实证复现：用户 B 持有效 0.06 GRAM 推广领取单向已分离的兑换热钱包转入 8 GRAM 并填写该 `claim:<id>` 时，`_isPromoFlowTransfer()` 仅因查得该领取单存在即返回 `true`，将其误归类为 `OTHER_FLOW / promo_claim`，异常队列数为 `0`。
- **根因：** `worker/src/presale-hotwallet.mjs` 中的 `_isPromoFlowTransfer()` 缺少收款地址归属、付款人身份、金额精确匹配及领取单状态四项校验，且未挂载 `promoEngine` 时按粉尘额度误归 `OTHER_FLOW`。
- **修复位置：** `worker/src/presale-hotwallet.mjs`
- **修复方案：** `_isPromoFlowTransfer(tx, memo, receivedNano, nowSec)` 强制满足全部 5 项条件才归类为 `OTHER_FLOW / promo_claim`：
  1. 备注匹配 `claim:<id>` 且已挂载 `promoEngine` 并查得该领取单；
  2. 收款地址匹配：`addressKey(tx.to) === addressKey(claim.payTo || promoEngine.hotWalletAddress)`（推广与兑换分钱包时，打到兑换热钱包的转账绝不归为推广业务）；
  3. 付款人归属匹配：`addressKey(tx.from) === addressKey(claim.walletAddress)`；
  4. 金额精确匹配：`receivedNano === BigInt(claim.feeRequiredNano)`（禁止 8 GRAM 等错额/大额入账借合法领取单号逃逸）；
  5. 状态合法：未过期的 `PENDING_FEE`，或已被推广流程用**同一笔** `tx.txHash` 消费（`FEE_CONFIRMED` / `PAYOUT_SENT` / `COMPLETED`），禁止旧单号掩盖新入账。
- **新增测试覆盖（Memory / D1-SQLite / 真实 Miniflare D1 三端）：**
  - 合法领取单号 + 8 GRAM 错额大额付款 → 进入 `ANOMALY (OPEN)` 并验证可人工全额退款；
  - 合法领取单号 + 错付款人 8 GRAM → 进入 `ANOMALY (OPEN)`；
  - 已消费旧领取单号 + 新交易 8 GRAM、已过期领取单号 + 8 GRAM → 进入 `ANOMALY (OPEN)`；
  - 同一笔 `txHash` 已被推广侧先消费的 0.06 GRAM → 仍准确归类 `OTHER_FLOW / promo_claim`；
  - 分离热钱包场景下，有效领取单向兑换热钱包转 8 GRAM → `ANOMALY (OPEN)`，转 0.06 GRAM → `IGNORE_DUST`，均绝不归类 `OTHER_FLOW`。

### 问题 2（P0-G）：已配置链上数据源但 TonCenter 请求失败时，用户余额仍可能被显示为 0
- **核实结果：** **属实。** 已在 `1e4b0b5` 上实证复现：配置 `jettonMasterAddress` 后，当 `get_wallet_data` 返回 HTTP 500 时，`fetchUserPortfolio()` 捕获异常并保留初始默认值 `a9BalanceRaw: "0"`，导致“链上查询失败”被伪装成“余额为 0”。
- **根因：** `worker/src/toncenter.mjs` 中 `fetchUserPortfolio()` 将 `a9BalanceRaw` 初始化为 `'0'`，且 `fetchUserJettonWallet()` 的 `catch` 未区分“RPC / HTTP / 节点故障”与“合约明确未部署（`uninitialized`）”。
- **修复位置：** `worker/src/toncenter.mjs`、`worker/src/api.mjs`、`a9-mini-app/js/pages/wealthverse.js`
- **修复方案：**
  1. `TonCenterClient.runGetMethod()` 对正常返回但 `exit_code !== 0` 的 TVM 异常标记 `err.isTvmError = true`，与 HTTP/网络错误区分；
  2. `fetchUserJettonWallet()` 仅在 `get_wallet_data` 成功，或 `isTvmError` 且经 `/getAddressInformation` 明确核实账户为 `state === 'uninitialized'` 时才返回具体余额（含真实 `'0'`）及 `balanceAvailable: true`；其余任何网络/HTTP 失败或 `active` 合约调用失败均返回 `a9BalanceRaw: null, balanceAvailable: false`；
  3. `fetchUserTicket()` 与 `fetchUserPortfolio()` 同步默认 `a9BalanceRaw = null, balanceAvailable = false`，返回 `balanceAvailable`、`ticketsAvailable`、`onchainAvailable`；`api.mjs` 在 `userReader` 抛错时同样兜底返回 `null` 与 `false`；
  4. `wealthverse.js` 在 `balanceAvailable === false || a9BalanceRaw === null` 时显示“待核验”，不再把不可用数据显示为 `0 A9`，同时对经核实的真实 0 余额准确显示 `0 A9`。
- **新增测试覆盖：**
  - `get_wallet_data` HTTP 500、`get_wallet_address` 网络抛错、`active` 合约 TVM 错、明确 `uninitialized` 合约返回真实 `'0'`、`get_ticket_data` HTTP 500、`GET /api/user/:wallet` 端到端失败降级，以及 Chromium 真实模式 `/profile` 渲染实测（`null/false` 显示“待核验”绝不显示 `0 A9`；`'0'/true` 显示 `0 A9`）。

### 问题 3（P0-I）：D1 `commitInbound()` 入账竞争处理存在两次独立提交的崩溃窗口
- **核实结果：** **属实。** 已在 `1e4b0b5` 上实证复现：当订单在 `planInbound` 与 `commitInbound` 之间过期触发竞争时，旧代码在 `db.batch()` 之后发起第二条独立 `UPDATE presale_inbound_txs SET decision = 'ANOMALY' ...`；若进程在两次写库之间崩溃，库中残留 `decision = 'CONFIRM', anomaly_status = null` 的幽灵记录，重启重扫直接返回 `REPLAY`，导致资金丢失在异常退款队列之外。
- **根因：** 将订单竞争判断后的入账分类修正拆分到了 `db.batch()` 事务之外的第二次独立数据库写调用。
- **修复位置：** `worker/src/d1-growth-store.mjs`
- **修复方案：** 重写 `D1PresaleRepo.commitInbound()`，将全部逻辑收敛进**单次 `db.batch()` 原子事务**：
  1. 若存在 `orderUpdate`，第一条语句尝试带状态白名单、过期时间守卫与防重放守卫（`AND NOT EXISTS (SELECT 1 FROM presale_inbound_txs WHERE tx_hash = ?)`）的条件 `UPDATE presale_orders`；
  2. 第二条语句执行单条条件 `INSERT INTO presale_inbound_txs ... SELECT ... CASE WHEN EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND inbound_tx_hash = ?) THEN ... ELSE 'ANOMALY' / 'order_state_race' / 'OPEN' / sender END`，在同事务内依据订单是否成功绑定本 `tx_hash` 一次性写入最终分类；
  3. 若存在 `payout`，第三条语句仅在订单绑定成功时条件插入，绝不产生孤儿 payout；
  4. 完全消除 batch 后的二次数据库写调用（`postBatchWrites === 0`）。无论在 batch 提交前还是提交后崩溃，数据库始终处于最终自洽状态。
- **新增测试覆盖（D1-SQLite 与真实 Cloudflare D1 Miniflare v3 双端实测）：**
  - 监控验证竞态下仅调用 1 次 `db.batch()` 且 `postBatchWrites === 0`；
  - 模拟 `db.batch()` 提交成功瞬间进程崩溃退出 → 新建实例重启后验证该入账已直接处于 `ANOMALY / order_state_race / OPEN`，重扫返回 `REPLAY`，运营可正常完成全额退款；
  - 模拟 `db.batch()` 提交前中途报错整批回滚 → 验证零残留记录，重启重扫后正常处理。

---

## 二、修改文件清单（共 6 个文件）

- `worker/src/presale-hotwallet.mjs`：强化 `_isPromoFlowTransfer()` 五重校验（收款钱包、付款人、金额、状态/同 `txHash` 消费）。
- `worker/src/toncenter.mjs`：区分 TVM 错误与网络/HTTP 错误；`fetchUserJettonWallet` / `fetchUserTicket` / `fetchUserPortfolio` 失败严格返回 `a9BalanceRaw: null`、`balanceAvailable: false`、`ticketsAvailable: false`、`onchainAvailable: false`。
- `worker/src/api.mjs`：`GET /api/user/:wallet` 保护 `userReader` 异常并统一返回可用性标记。
- `a9-mini-app/js/pages/wealthverse.js`：前端真实模式严格依据 `balanceAvailable !== false && a9BalanceRaw !== null` 渲染，区分“待核验”与真实 `0 A9`。
- `worker/src/d1-growth-store.mjs`：`D1PresaleRepo.commitInbound()` 改为单次 `db.batch()` 原子条件插入，彻底消除二次写库崩溃窗口。
- `worker/tests/p0-security.test.mjs`：补充 P0-A 6 类推广边界反例（Memory/SQLite/真实 D1）、P0-G 6 类 TonCenter 失败/未部署反例、P0-I D1-SQLite 与真实 Cloudflare D1 单事务崩溃恢复测试（总用例增至 **50 项无 Miniflare / 63 项含真实 Cloudflare D1**）。

---

## 三、复验执行结果（完整原始日志见 `docs/gamification/phase-1-test-output-r3.txt`）

| 测试项 | 运行环境 | 结果 |
|---|---|---|
| `node worker/tests/worker.test.mjs` | Node v24.22.3 | **19/19 通过** |
| `node worker/tests/p0-security.test.mjs` | Node v24.22.3（Memory + node:sqlite） | **50/50 通过** |
| `MINIFLARE_MODULE=... node worker/tests/p0-security.test.mjs` | Node v24.22.3 + **真实 Miniflare v3 (`workerd` D1)** | **63/63 通过**（含 13 项真实 D1 测试及单事务 `commitInbound` 崩溃恢复） |
| `node a9-mini-app/js/batch-a-live-guard.test.mjs` | Node v24.22.3 | **6/6 通过** |
| `node a9-mini-app/js/v15-tx.test.mjs` | Node v24.22.3 | **6/6 通过** |
| `a9-mini-app/tests/wealthverse-browser.mjs` | Playwright + Chromium（390×844 & 360×780） | **52 项路由/视口与全量交互回归通过** |
| `/profile` 真实模式余额 `null` vs 真实 `0` 专项浏览器验证 | Playwright + Chromium（`/?mode=live`） | **通过** |
| `cd v15 && shasum -a 256 -c ci/artifacts.sha256` | 本地校验 | **4/4 `OK`** |

---

## 四、说明与边界确认

- 本轮不涉及新功能、不修改历史迁移文件（`0001`–`0004` 均未改动）、不修改 `v15/` 合约。
- 第 2 轮报告中列出的 **5 项生产资金上线阻断项仍然全部有效**，真实资金交易、链上签名、A9 固定兑换入口继续保持关闭。
