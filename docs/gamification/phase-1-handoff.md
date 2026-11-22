# A9mini 第一阶段交接说明

- **编写：** AWS Quick（Smart 模式）。第一阶段全部代码都是本工具写的，本地 Gemini 没有参与。
- **日期：** 2026-11-22
- **分支：** `feat/gamification-v1`（已推送）
- **审查对象：** `ae5fd0ccad65cc45830d64921382aeefa0cfc235`
- **基线：** `9f138fb4bd673aefe91d02ab59842f33ddd84adb`
- **状态：** 第一阶段**未通过**独立验收。本文档只记录问题，**没有修改任何业务代码**。

> 这份文档以下面的复现脚本为准。我此前在报告里写的“37/37 通过”只说明测到的部分是对的，**不能**证明资金安全。

---

## 1. 先跑这个脚本

```
cd A9mini
node docs/gamification/phase-1-defect-repro.mjs     # 需要 Node 22.5 或更高版本
```

脚本只用内存存储和临时 SQLite 库，不会碰任何真实数据。每一行输出二选一：
- `CONFIRMED`：缺陷存在；
- `NOT REPRODUCED`：修复后应该显示这个。

在 `ae5fd0c` 上的实际输出：

```
CONFIRMED       D1 [memory] A's untouched order after B's refund = REFUNDED
CONFIRMED       D2 [memory] delivered order after duplicate refund = REFUNDED; activation eligibility = false
NOT REPRODUCED  D4 [memory] two anomalies on one order -> REFUND_QUEUED, REFUND_QUEUED
CONFIRMED       D1 [d1-sqlite] A's untouched order after B's refund = REFUNDED
CONFIRMED       D2 [d1-sqlite] delivered order after duplicate refund = REFUNDED; activation eligibility = false
CONFIRMED       D4 [d1-sqlite] two anomalies on one order -> REFUND_QUEUED, ERR ALREADY_RESOLVED
CONFIRMED       D3 [runner] 7 GRAM transfer without memo -> anomalies recorded = 0
CONFIRMED       D5 [d1-sqlite] legacy order visible = 0, quota used = 0 GRAM, new over-quota order -> EXCEEDS_POOL
CONFIRMED       D6 [config] engine.open default = true; cf-worker sets open explicitly = false
```

D4 只在 D1 上出现，内存实现不会。这说明两种存储的行为不一致，这本身就是缺陷。

---

## 2. 已复现的缺陷

| 编号 | 严重度 | 现象 | 谁发现的 |
|---|---|---|---|
| D1 | 高 | B 用 A 的订单号付款，运营给 B 退款后，**A 没付过款的订单被改成“已退款”** | 同事审查 |
| D2 | **严重** | 订单已完成后用户又付了一次，退还这笔重复付款时，**已交付的订单被改成“已退款”**，用户同时失去 A9 奖励的激活资格 | 本次排查 |
| D3 | 高 | 没写备注或备注不是 `buy:` 开头的转账，被发币程序**直接跳过**，系统里没有任何记录，等于吞款 | 同事审查 |
| D4 | 高 | 同一订单号被两个不同的人误付时，D1 上第二笔退款无法处理，还错误地报“已处理”（`ALREADY_RESOLVED`）。第二位付款人的钱卡住 | 本次排查 |
| D5 | 中高 | 旧数据中用真实友好地址（`EQ…`）存的订单：**本人查不到历史订单**，额度显示“已用 0”。建单时实际已经按额度拒绝，但报错码是错的（`EXCEEDS_POOL`，应为 `OVER_QUOTA`）。这违反了任务书“保留历史订单读取能力”的要求 | 本次排查 |
| D6 | 高 | 服务端的兑换开关默认是**开启**，Cloudflare Worker 也没有显式关闭。只要配置了热钱包地址，接口就能接受真实兑换订单，目前只靠前端拦截。这个问题基线就有，第一阶段没有修 | 本次排查 |

### 根因

1. **退款记录把两个对象混成了一个（D1、D2、D4）。**
   - 一个是“备注里引用的订单”，另一个是“这笔钱真正所属的订单”。
   - `resolveAnomaly` 生成退款记录时，直接用入账备注匹配到的 `orderId` 作为退款所属订单，不管付款人是不是订单主人，也不管订单是不是已经完成。
   - 处理退款时，`_orderPatchForPayout` 修改订单状态**没有指定“只能从哪些状态改”**，所以 `COMPLETED` 和 `PENDING_PAYMENT` 都会被改成 `REFUNDED`。
   - D1 的表上有 `UNIQUE (order_id, kind)` 约束，同一订单只能有一笔退款，内存实现没有这个约束，于是出现 D4。
2. **规则改了，调用方没跟着检查（D3）。**
   - 第一轮验收把“没有有效订单号的入账”改成了异常处理，但只改了引擎。发币程序 `PresalePayoutRunner.tick()` 在调用引擎之前就过滤掉了非 `buy:` 开头的交易。
   - 注意：`cf-worker.mjs` 允许兑换热钱包回退使用推广热钱包（`A9_PRESALE_HOT_WALLET_ADDRESS || A9_PROMO_HOT_WALLET_ADDRESS`），所以这个钱包上可能还有推广领取的 `claim:` 交易。修复时不能简单地把所有交易都当成兑换异常，见第 3 节。
3. **测试只测了单个函数，没测完整流程（全部）。**
   - 测试验证了“B 付款后 A 的订单暂时不变”，但没有继续验证“给 B 退款完成后 A 的订单是否还不变”。
   - 测试直接调用引擎，没有从发币程序入口开始。
   - 旧数据迁移测试用的是占位地址 `EQ_LEGACY`，它不是合法地址，`addressKey` 会原样返回字符串，所以掩盖了 D5。
   - 上一版报告里“旧 PAID_A9 订单仍计入额度”这句话，只在占位地址下成立。

---

## 3. 建议的修复方式（尚未实施）

接手方可以另选方案，但必须满足第 4 节的不变量。

1. **退款记录与订单解耦。**
   - 退款以入账交易为主键，关联到 `inboundTxHash`。
   - 只有付款人就是订单主人、而且这笔入账就是该订单本身的付款时，才设置 `orderId`。目前只有“过期或关闭后的正确付款”和“订单主人付错金额”两种情况。
   - 误付、重复付款的退款，`orderId = null`，订单本身不动。
2. **所有由退款或发币驱动的订单状态修改，都必须指定允许的旧状态。**
   - 退款只能从 `REFUND_PENDING`、`REFUND_SENT`、`PAYMENT_EXCEPTION` 改到 `REFUNDED`。
   - 发币只能从 `PAYOUT_*` 改到 `COMPLETED`。
   - 条件不匹配时不修改，并写一条审计日志。
3. **修正 D1 唯一约束（需要新的增量迁移）。** 把 `UNIQUE (order_id, kind)` 换成只对 `kind = 'A9'` 生效的部分唯一索引。退款的唯一性由 `payout_id = refund:<入账哈希>` 保证。同时补充 SQLite 和内存实现结果一致的测试。
4. **发币程序交出全部入账，由引擎统一分类。**
   - 推荐做法：兑换必须使用独立热钱包，删除回退到推广热钱包的逻辑。
   - 如果必须共用，引擎就要显式识别推广流程的 `claim:` 交易，记为“其他流程”并留下记录，不能静默跳过。
5. **旧数据（D5）。** SQL 里没法算地址的标准形式，所以要写一次性回填脚本，给旧订单补上 `wallet_key`。补之前，所有查询要同时按友好地址和标准形式匹配。建单失败时的报错码也要改正。
6. **兑换开关（D6）。** 服务端默认关闭。只有显式设置 `A9_PRESALE_OPEN=1` 才开启，并且要在 `/api/config` 里如实返回当前开关状态。

---

## 4. 必须写成测试的不变量

每一条都要**从发币程序入口一直测到最终状态**，并且在内存和 D1（SQLite，条件允许时加 Miniflare）两种存储上分别运行：

1. 给 X 退款，只能修改 X 自己付款的那个订单，其他任何订单的状态都不变。
2. 状态为 `COMPLETED` 的订单，任何退款或异常处理流程都不能改动它。
3. 同一笔入账最多只产生一笔发币或退款；每笔入账都恰好有一条入账记录，不存在被静默跳过的入账。
4. 任何入账金额 = 发出的 A9 等值金额 + 退款金额 + 已公示扣费 + 仍在待处理中的金额。不能有对不上账的部分。
5. 同一订单号被 N 个不同的人误付时，N 笔退款都能各自处理。
6. 旧数据订单对本人可见，并且计入额度。测试必须使用合法地址。
7. 服务端没有显式开启时，建兑换订单的接口一律拒绝。

---

## 5. 仍然有效的资金上线阻断项

这些和上面的缺陷是两回事，修完缺陷也不代表它们解决了：

1. 没有链上发币确认器。
2. Worker 写的是 D1，Node 发币程序用的是内存，两边的数据不互通。
3. TonCenter 返回的交易状态不可靠：最终确认、失败、弹回都无法准确识别。
4. 没有在真实 Cloudflare D1（Miniflare 或 workerd）上运行过测试。
5. 没有用真实钱包、在本项目域名上端到端验证过 ton_proof。

详细内容见 `phase-1-acceptance-r1.md` 第二、三节。

---

## 6. 需要复核的设计决定

- **72 小时延迟换绑**（`REBIND_DELAY_SEC`）：这是我主动加的，任务书和业主都没有要求过。它新增了一组“换绑等待中”的状态分支和一条在读取时自动生效的逻辑（`getBinding` 读取时会执行升级）。建议审查方先判断现有绑定模型是否已经够用，再决定保留、简化还是删除。
- **0.1 GRAM 及以下的小额转账：** 目前有记录但不退款，沿用原规则，等业主确认。
- **用户过错扣费：** 规则还没公示，所以目前用户过错也只能全额退款。

---

## 7. 我没有验证过的内容

- 真实 Cloudflare D1：本机装不上 miniflare。测试里已经预留了 `[d1-miniflare]` 这一组，装上后会自动运行。
- 真实钱包的 ton_proof：只用 4 条公开的真实钱包回复数据和自己生成的密钥测过。
- 浏览器回归测试 `wealthverse-browser.mjs`：本机没有 Playwright。
- TonCenter 真实网络返回的数据。
- 第一阶段对前端的改动（`data.js`、`tonconnect.js`）没有在 Telegram 客户端或浏览器里实际运行过。

---

## 8. 接手须知

- **提交顺序：**
  - `16c62e4`：第一阶段代码
  - `2be6ea5`：文档
  - `b0d805b`：AGENTS.md，业主授权的三项修改
  - `74c2457`：第一轮验收修改
  - `ae5fd0c`：文档
  - 本交接说明是另一次只含文档的提交
- **运行测试：** 在仓库根目录直接执行 `node worker/tests/*.test.mjs` 和 `node a9-mini-app/js/*.test.mjs`。
  - 原始测试输出里的 `NODE_OPTIONS=--preserve-symlinks…` 和 git 的特殊路径，只是 AWS Quick 运行环境的限制，正常开发机不需要。
- **文档阅读顺序：**
  1. 本文件
  2. `phase-1-acceptance-r1.md`
  3. `phase-1-report.md`：其中与本文件冲突的内容，以本文件为准
- **底线约束**（AGENTS.md 和业主明确要求）：
  - 不改 v15 合约；
  - 不开启真实资金操作；
  - 不混用演示数据和真实数据；
  - 不伪造数据；
  - 未经业主通知不进入第二阶段，不合并 `main`。
- **建议的工作流程：** 开发方修复 → 独立方验收 → 开发方修复 → 独立方复验。开发方不能自己宣布资金相关代码通过验收。
