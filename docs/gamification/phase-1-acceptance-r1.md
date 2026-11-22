# 第一阶段：验收第 1 轮补充证据与修改说明

- **分支：** `feat/gamification-v1`
- **基线：** `9f138fb4bd673aefe91d02ab59842f33ddd84adb`
- **本轮提交：** 见文末"提交记录"
- **当前状态：** 等待代码上传和独立验收。不进入第二阶段，不合并 `main`，不开放任何真实资金操作。

---

## 一、本轮按业主决定所做的修改

### 1. 退款规则（第三条）

| 场景 | 修改前（16c62e4） | 修改后 |
|---|---|---|
| 入账没有有效订单号 | 自动退款，并扣 0.05 GRAM | 记为**异常入账**（`ANOMALY / no_matching_order`）。记录付款人、金额和退款去向，不自动退款，也不自动扣费 |
| 付款人与订单钱包不一致 | 自动退款并扣费 | 记为异常（`sender_mismatch`）。订单不受影响，退款去向为实际付款人 |
| 订单已不可付款（重复付款） | 自动退款并扣费 | 记为异常（`order_not_payable`） |
| 付款金额与订单不一致 | 自动退款并扣费 | 记为异常（`amount_mismatch`）。订单进入 `PAYMENT_EXCEPTION`，不发币 |
| 金额正确，但兑换已关闭或订单已过期 | 被动全额退款 | 不变：沿用原有被动退款规则。订单最低 5 GRAM，因此一定是全额退款 |
| ≤ 0.1 GRAM 的小额转账 | 忽略 | 不变，但仍在 `presale_inbound_txs` 留有记录。**需要业主确认是否仍沿用原规则** |

**异常处理流程**（`resolveAnomaly`，以及管理接口 `/api/admin/presale/anomalies`）：
- 必须填写操作人；责任方由人工判定，只能是 `USER`、`SYSTEM` 或 `UNKNOWN` 之一。
- `SYSTEM` 或 `UNKNOWN`：全额退回原付款人，**不收任何费用**。
- `USER`：只有在配置了已公示的扣费规则（`A9_PRESALE_USER_FAULT_FEE_NANO`）时才会扣费；没有配置时拒绝处理，返回 `FEE_RULE_NOT_PUBLISHED`。**当前没有配置这项规则。**
- 选择“不退款结案”时必须填写说明，例如已在其他渠道退款。
- 同一笔异常只能处理一次，并发处理也只会生成一笔退款。D1 中这一步在单个事务内完成。

### 2. 时间与账户规则（第四条）
- **`initData` 有效期 24 小时，但它不等于会话安全。** 原因分析和测试见第二节。
- **钱包证明的签名时间偏差从 15 分钟收紧到 10 分钟**（`TON_PROOF_MAX_SKEW_SEC = 600`），早于或晚于当前时间都会校验。挑战载荷仍然 15 分钟有效，只能使用一次。
- **未付款订单预占 30 分钟。** 过期后才到账的资金：金额正确的按原规则被动全额退款；金额不对的进入异常流程。两种情况都有记录，都不会被吞，也不会发币。
- **一个钱包只能绑定一个 Telegram 账号**（`wallet_key` 有唯一约束）。“断开连接”和“解除绑定”分开处理：
  - 在前端断开钱包，**不会**解除服务端的长期绑定。
  - 换成另一个钱包需要新钱包的 ton_proof，换绑先进入等待状态，`REBIND_DELAY_SEC`（72 小时，**需要业主确认**）后才生效。
  - 等待期内，当前钱包可以签名取消换绑。
  - 解除绑定需要当前钱包签名，不需要签名就能解绑的旧接口已删除。
  - 如果旧钱包丢失，恢复方式是走延迟换绑。

### 3. AGENTS.md
单独提交为 `b0d805b`，只改了三条与任务书冲突的规定：GRAM 命名、新配色、导航重排。所有安全边界保留，并新增一节“仍然有效的安全边界”。

---

## 二、验收重点逐项证据

### 1. ton_proof：StateInit、地址、公钥来源、网络、签名格式
**实现位置：**
- `worker/src/ton-cell.mjs`：新增 BoC 解析和 cell 哈希计算，支持普通 cell 和 library cell。
- `worker/src/auth.mjs`：新增 `verifyTonProof`。

**校验顺序：**
1. **网络：** 钱包上报的 `account.chain` 必须等于服务端的 `A9_NETWORK`（主网 `-239`，测试网 `-3`）。服务端没有配置网络时直接拒绝，不放行。主网上拒绝测试网专用（test-only）地址。
2. **StateInit：** `walletStateInit` 必须提供，而且它的 cell 哈希必须等于地址哈希。这保证了下面拿到的公钥确实属于这个地址。
3. **公钥来源：**
   - 对已知标准钱包（v3r1、v3r2、v4r2、v5beta、v5r1），从 StateInit 的 data 中直接读取公钥；
   - 同时可以通过链上 `get_public_key` 读取；
   - 两个来源都有时必须一致；钱包上报了 `account.publicKey` 的，也必须一致。
4. **其余校验：** 域名白名单、时间戳在 ±10 分钟内、Ed25519 签名。挑战载荷在这些校验之前就被消费，一次性有效，并且绑定到申请它的 Telegram 用户。

**签名格式依据：** 逐字节对照了 TON Connect 官方示例服务端 `demo-dapp-with-react-ui` 中的 `src/server/services/ton-proof-service.ts`：
- 消息为 `ton-proof-item-v2/` + 工作链（int32 大端）+ 地址哈希 + 域名长度（uint32 小端）+ 域名 + 时间戳（uint64 小端）+ payload；
- 签名对象为 `sha256(0xffff ‖ "ton-connect" ‖ sha256(message))`。

**钱包识别依据：** 用我们自己写的 cell 哈希，重新计算了官方 `@ton/ton` 钱包代码 BoC，得到的 v3r2、v4r2、v5r1 代码哈希与公开值一致。测试会自动比对这一点。

**真实钱包数据：** `worker/tests/fixtures/ton-proof-fixtures.json` 收录了 4 条真实钱包的 ton_proof 回复，来源是 TonProof.NET 项目（MIT 许可）的测试数据：v4r2 主网、v4r2 测试网、v5beta 测试网、v3r1 主网。

**测试结果：**
- 4 条真实数据全部通过：地址、公钥、签名都一致。说明：来源项目把其中一条标为“V5”，实际是 v5beta 钱包。
- 以下篡改全部被拒绝：
  - 签名、payload、时间戳被改动；
  - 换用别的钱包的 StateInit，或缺少 StateInit；
  - 钱包上报的公钥不一致，或链上公钥不一致；
  - 网络错误，或服务端未配置网络；
  - 域名不在白名单；
  - 时间戳偏差超过 ±600 秒（599 秒通过）。

**尚未覆盖：**
- 真实钱包在本项目域名上的端到端连接，需要部署和真机验证；
- 非标准钱包（如 v4r1、v1、v2、多签）只能依赖链上 `get_public_key`；尚未部署的非标准钱包会被拒绝。

### 2. D1 中的事务行为
**已在真实 SQLite 上验证**（`node:sqlite`，SQL 语句与 D1 完全相同，唯一约束、条件 UPDATE、batch 回滚都真实执行）：
- **额度预占：** 用单条 `INSERT … SELECT … WHERE` 完成“检查剩余额度并插入订单”。6 个并发请求抢同一个钱包的额度，只成功 4 个；总池也不会超卖；过期订单会释放额度。
- **状态转移：** 每次更新都带 `WHERE status IN (…)` 条件，只有旧状态匹配才能改。用 batch 把“入账记录 + 订单状态 + 发币或退款记录”一起提交，任一条失败就整体回滚。
- **重复交易与重复订单：** `presale_inbound_txs.tx_hash` 是主键，`presale_payouts` 的 `payout_id`、`(order_id, kind)`、`tx_hash` 都有唯一约束。同一笔入账再次处理是空操作，同一订单只会生成一笔发币记录。
- **异常处理只能一次：** 先执行条件 UPDATE，只有成功才会插入退款记录，两步在同一事务内。

**未完成：在真实 Cloudflare D1（workerd）上运行。** 我的执行环境装不了 miniflare。测试代码已经预留了 `[d1-miniflare]` 这一组，装上 miniflare 后会自动加入：
```
cd worker && npm i --no-save miniflare && node tests/p0-security.test.mjs
```
在真实 D1 上跑通之前，第 2 项只算“SQLite 等价验证”，不算“D1 实测”。

### 3. 广播失败、结果不确定、进程重启
测试在内存和 SQLite 两种存储上都跑过：
- **广播失败、确定没发出**（`notSent`）：订单进入 `PAYOUT_RETRY`，重试成功后只发一次。
- **结果不确定**（例如超时后才报错）：
  - 不会立即重发；
  - 等待期过后先查链上记录；
  - 没有配置链上核验器时转为 `NEEDS_REVIEW`，发送次数保持 1；
  - 配置了核验器时，查到“已上链”就直接 `COMPLETED`，发送次数为 0。
- **进程重启：**
  - 已广播的订单由新进程从数据库恢复，经核验后完成，不会重发；
  - 记录已写成 `BROADCASTING`、但广播结果还没回写时进程崩溃：在等待期内不动，过期后先查链，再决定是否重发。
- 达到最大重试次数后转人工处理。

**限制：** 所有“查链”都依赖链上发币核验器（`payoutVerifier`）。**目前还没有真实实现**，见第三节阻断项 1。

### 4. TonCenter 对失败、弹回、最终确认交易的识别
**结论：目前不能准确识别，这仍是资金上线阻断项。**

`TonCenterClient.fetchInboundTransfers`（v2 `getTransactions`）的问题：
- 对所有交易都写死 `finality: 'finalized'`，没有核对主链确认；
- 不读取交易是否 aborted，也不读取计算阶段和动作阶段是否成功；
- 不区分 `in_msg.bounced`，我们自己发出后被弹回的转账可能被当成用户入账；
- 每次只取最近 30 条，没有游标，入账量大时可能漏单；
- 只解析文本备注。

状态机已经能处理 `aborted`、`bounced` 字段，并拒绝非 `finalized` 的交易，但数据源还提供不了可信的值。

**建议方案（未实施）：**
- 改用 TonCenter v3 `/api/v3/transactions`，读取 `description.aborted`、`compute_ph.success`、`action.success`、`in_msg.bounced`、`mc_block_seqno`；
- 只有交易已被主链区块收录才视为确认；
- 按 lt 分页，游标持久化；
- 用测试网的真实交易（成功、失败、弹回各一笔）做回归测试。

### 5. Worker 写 D1 与实际发币程序之间的连接
**现状（基线已存在）：** Worker 把订单写进 D1；发币程序 `PresalePayoutRunner` 只在 Node 的 `server.mjs` 里运行，用的是内存存储，看不到 D1 里的订单。**两边是断开的，这是资金上线阻断项。**

可选方案：

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A | Worker 用 Cron Trigger 直接跑发币程序，在 Worker 内签名 | 链路最短 | 热钱包私钥要放进 Cloudflare Secret，Worker 里需要 TON 签名库 |
| B | 本地运维程序通过 Cloudflare D1 HTTP API 读写 D1 | 私钥不上云 | 需要另行验证 D1 HTTP API 对多语句事务的支持；数据库凭据要放在本地 |
| **C（建议）** | Worker 提供带签名鉴权的内部接口：“领取下一笔待发”“回报广播结果”。所有状态转移都在 Worker 内用 D1 事务完成；本地程序只负责签名和广播，按 `payoutId` / `query_id` 保证幂等 | 状态只有一个写入方；私钥不上云；本地程序无状态，可以随时重启 | 内部接口的鉴权和重放防护需要单独设计和审计 |

**本轮没有实施，需要业主批准选定的方案。**

---

## 三、资金上线阻断项（仍然有效，不因测试通过而解除）

1. **没有链上发币确认器。** 广播后的订单停在 `PAYOUT_SENT`，不会自动变成 `COMPLETED`；结果不确定的发币一律转人工。还需要做两件事：确认 acton 广播脚本返回的哈希是什么含义，再按 `query_id` 实现核验。
2. **Worker（D1）与 Node 发币程序（内存）的存储链路断开**，见第二节第 5 项。
3. **TonCenter 错误标记交易状态**：最终确认、失败、弹回都无法识别，见第二节第 4 项。
4. **还没有在真实 Cloudflare D1 / workerd 上运行测试**，见第二节第 2 项。
5. **ton_proof 还没用真实钱包在本项目域名上端到端验证过**。需要部署、配置 manifest 和 `A9_TON_PROOF_DOMAINS`。

---

## 四、需要业主确认
- 换绑延迟 `REBIND_DELAY_SEC` = 72 小时。
- ≤ 0.1 GRAM 小额转账是否继续按原规则忽略（目前有记录，但不退款）。
- 用户过错扣费规则的公示内容和金额。在此之前，用户过错也只能全额退款。
- 第二节第 5 项选哪个连接方案。

---

## 五、测试结果（原始输出见 `phase-1-test-output.txt`）

| 命令 | 结果 |
|---|---|
| `node worker/tests/worker.test.mjs` | 19/19 通过 |
| `node worker/tests/p0-security.test.mjs` | 37/37 通过；`[d1-miniflare]` 组因未安装 miniflare 跳过（运行时会打印提示） |
| `node a9-mini-app/js/batch-a-live-guard.test.mjs` | 6/6 通过 |
| `node a9-mini-app/js/v15-tx.test.mjs` | 6/6 通过 |
| `node a9-mini-app/tests/wealthverse-browser.mjs` | 未运行：本机没有安装 Playwright |

`v15/` 没有改动。

---

## 六、提交记录
- `16c62e4`：第一阶段代码
- `2be6ea5`：文档，记录 SHA 和机器人输出
- `b0d805b`：AGENTS.md，按业主授权修改三条冲突规定
- `74c2457450de85eb73cc4bcba0d510b6b63463a8`：验收第 1 轮代码修改
- 本文件所在的文档提交：见分支历史（`git log`）
