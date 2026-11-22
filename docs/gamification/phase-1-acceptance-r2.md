# 第一阶段：验收第 2 轮独立整改与交付报告

- **分支：** `feat/gamification-v1`
- **原始项目基线：** `9f138fb4bd673aefe91d02ab59842f33ddd84adb`
- **接管前远程最新提交：** `ae5fd0ccad65cc45830d64921382aeefa0cfc235`
- **接管前本地交接提交：** `6f692ab2f5e9f27e0499e2df0b245865cf22d787`（仅含 `phase-1-handoff.md` 与只读复现脚本 `phase-1-defect-repro.mjs`）
- **本轮代码修复提交：** `a91b6261f1cf947589600e39bb34388741e5d525`
- **当前状态：** 第一阶段整改已完成并重新提交独立验收。**严格停留在第一阶段，未进入第二阶段，未合并 `main`，未开启任何真实资金操作，未改动 `v15/` 智能合约及编译产物，未改动 `/Users/yu1/Desktop/BAM`。**

---

## 一、验收状态总览

| 项目 | 判定 | 说明 |
|---|---|---|
| P0-A（D3）：无备注入账漏记与热钱包入账分类 | **通过** | 移除发币程序提前过滤，统一由引擎分类全部 8 类入账并留痕，区分合法推广 `claim:` 流程与兑换异常 |
| P0-B（D1 / D2）：异常退款误改他人或已完成订单 | **通过** | 退款对象以 `inboundTxHash` 为核心，与备注引用订单解耦；严格四条件绑定与状态白名单守卫 |
| P0-C（D4）：多笔异常退款数据库唯一性 | **通过** | 新增 `0004_presale_payouts_uniqueness.sql` 增量迁移，拆分为 A9 订单部分唯一与 REFUND 入账部分唯一；Memory / SQLite / 真实 D1 三端一致 |
| P0-D：未公示手续费时无法退款 | **通过** | 未配置 `userFaultFeeNano` 时，`USER` / `SYSTEM` / `UNKNOWN` 一律零手续费全额退款；配置后仅 `USER` 扣费 |
| P0-E：退款确认与状态更新原子性 | **通过** | `markPayoutSent` / `markPayoutRetry` / `markPayoutNeedsReview` / `completeA9` / `completeRefund` 全部收口单事务 `db.batch()`，SQLite 与真实 Miniflare D1 均通过崩溃回滚实测 |
| P0-F：`ton_proof` 公钥信任边界 | **通过（本地向量与单元测试）** | 拒绝未审核自定义非标准合约的链上 `get_public_key`；`WalletTg` 增加四重校验；前端恢复连接显式区分 `restored_binding` 与 `fresh_proof`；**真机钱包端到端待部署联调** |
| P0-G：剩余真实数据与伪数据清理 | **通过** | 清理 `server.mjs`、`cf-worker.mjs`、`v15-indexer.mjs`、OG HTML/SVG/PNG、`a9_bot.py` 及前端 9 个文件的真实模式伪造数字与默认轮次 |
| P0-H：商会接口与信息访问边界 | **通过** | `GET /api/team/:wallet` 强制 Telegram + 钱包验签本人鉴权；向非会长成员隐藏 `tgChatId` |
| P0-I + D5 + D6：不变量回归、历史地址兼容、默认关闸 | **通过** | 补齐过期竞争守卫、`NEEDS_REVIEW` 不重试、账本守恒、历史友好地址查询/额度/回填、默认 `open=false` 且禁止回退推广热钱包 |
| v15 合约产物完整性 | **通过** | `v15/ci/artifacts.sha256` 4 项编译产物全部 `OK` |
| **生产真实资金上线准入** | **不通过（阻断项未解除）** | 见第七节：5 项生产资金上线阻断项仍有效，必须保持 `liveFundsEnabled = false` 与 `A9_PRESALE_OPEN = 0` |

---

## 二、逐项问题根因分析与修复说明（现象 → 机制 → 根因 → 验证 → 修复）

### 1. P0-A（含 D3）：修复无备注入账漏记与交易归属分类
- **现象：** 向兑换热钱包转入 7 GRAM 无备注或非 `buy:` 备注转账后，调用 `PresalePayoutRunner.tick()`，系统记录的异常入账数为 `0`，资金静默消失。
- **机制：** 链上入账从 `TonCenterClient.fetchInboundTransfers` 进入 `PresalePayoutRunner.tick()`，再调用 `PresaleHotWalletEngine.ingestInbound()`。
- **根因：** `worker/src/presale-runner.mjs` 在调用引擎前执行了 `if (!tx?.memo || !String(tx.memo).startsWith('buy:')) continue;`，绕过了引擎的异常识别逻辑。同时旧 `cf-worker.mjs` 允许兑换热钱包回退复用推广热钱包，若直接放开而不分类会把推广 `claim:` 交易误判为兑换异常。
- **验证方法：** 从 `PresalePayoutRunner.tick()` 完整入口注入全部 8 类入账（有效订单、无备注、错误订单号、错付款人、错金额、重复付款、合法推广 `claim:` 0.06 GRAM、粉尘 ≤0.1 GRAM 以及大额伪造 `claim:`），验证分类准确且二次扫描零重复记录。
- **修复方向与结果：**
  1. 移除 `worker/src/presale-runner.mjs` 中的前缀提前跳过逻辑，将全部入账交由引擎统一分类并补充统计字段（`anomalies`、`otherFlow`、`dust`、`refunded`）。
  2. 在 `worker/src/presale-hotwallet.mjs` 的 `planInbound()` 中新增 `_isPromoFlowTransfer()`：仅当存在匹配 `claim:` 的合法推广领取单（或明确属于推广费小额通道）时标记 `OTHER_FLOW / promo_claim` 并完整落库留痕；大额无合法推广单的 `claim:` 转账仍入 `ANOMALY` 防止吞款。
  3. 在 `cf-worker.mjs` 与 `server.mjs` 中取消兑换热钱包向推广热钱包的静默回退，强制独立配置 `A9_PRESALE_HOT_WALLET_ADDRESS`。

### 2. P0-B（含 D1 / D2）：修复异常退款误改他人订单或已完成订单
- **现象：**
  - D1：用户 A 创建 10 GRAM 订单未付款；用户 B 错用 A 的备注付 10 GRAM；运营给 B 退款完成后，A 的未付款订单被改成 `REFUNDED`。
  - D2：用户 A 订单已 `COMPLETED` 后误重复付款；退还重复付款后，A 的 `COMPLETED` 订单被改回 `REFUNDED`，A 同时丧失已完成的 A9 激活资格。
- **机制：** 异常入账在 `presale_inbound_txs` 中记录了备注解析出的 `order_id`；`resolveAnomaly` 生成 `REFUND` 类型的 `presale_payouts` 行，后续发币确认环节根据 `payout.orderId` 回写 `presale_orders`。
- **根因：** 混用了“备注中引用的订单（审计字段）”与“该笔资金实际归属的订单（所有权字段）”，且 `_orderPatchForPayout` 更新 `presale_orders` 时没有限定允许转移的旧状态白名单。
- **验证方法：** 构造 D1（B 错付退款后 A 仍可正常付款完成且额度准确）和 D2（已 `COMPLETED` 订单被重复付款并退款后仍为 `COMPLETED` 且 `hasCompletedPurchase === true`）全链路端到端测试，覆盖 Memory / SQLite / 真实 Miniflare D1。
- **修复方向与结果：**
  1. `resolveAnomaly` 中仅当同时满足四项严格条件时才将退款绑定到订单：`inbound.reason === 'amount_mismatch'`、`order.inboundTxHash === txHash`、`addressKey(inbound.sender) === order.walletKey`、`order.status === PAYMENT_EXCEPTION`。
  2. 错付款人、无订单号、重复付款等场景的退款记录设置 `payout.orderId = null`（原备注订单保留在 `presale_inbound_txs.order_id` 供审计），绝不修改原订单状态与额度。
  3. 退款确认仅允许修改处于 `REFUND_PENDING` / `REFUND_SENT` / `PAYMENT_EXCEPTION` 且 `inbound_tx_hash` 匹配的订单；发币确认仅允许修改处于 `PAYOUT_*` 的订单。

### 3. P0-C（含 D4）：修复多笔异常退款的数据库唯一性冲突
- **现象：** B、C 两人先后错用 A 的同一订单备注转账；在内存实现中两笔都能退款，但在 D1/SQLite 中第二笔 `resolveAnomaly` 抛出误导性错误 `ALREADY_RESOLVED`，导致第二笔用户资金卡死。
- **机制：** `0002_p0_identity_presale_state.sql` 在 `presale_payouts` 上建立了表级 `UNIQUE(order_id, kind)`；`D1PresaleRepo.resolveAnomaly` 又把所有 `UNIQUE` 约束异常统一吞并翻译为 `ALREADY_RESOLVED`。
- **根因：** 合法 A9 发币是一单一笔（以 `order_id` 为唯一维度），但异常退款是一笔入账一笔退款（以 `inbound_tx_hash` 为唯一维度）；把两种语义强压在同一个 `UNIQUE(order_id, kind)` 上造成业务死锁，同时掩盖了真实的数据库约束错误。
- **验证方法：** 增量执行 `0001 -> 0002 -> 0003 -> 0004` 迁移（预置已有 `presale_payouts` 历史数据确认无丢失），在 Memory / SQLite / 真实 Miniflare D1 上验证同一订单 2 笔错付均可独立生成并完成退款，而同一入账交易重复触发退款被严格拒绝。
- **修复方向与结果：**
  1. 新增增量迁移 `worker/migrations/0004_presale_payouts_uniqueness.sql`（不修改 `0001`/`0002`/`0003`），重建 `presale_payouts` 并完整迁移历史数据，改为两条部分唯一索引：
     - `idx_presale_payouts_a9_order`：`UNIQUE(order_id) WHERE kind = 'A9' AND order_id IS NOT NULL`
     - `idx_presale_payouts_refund_inbound`：`UNIQUE(inbound_tx_hash) WHERE kind = 'REFUND' AND inbound_tx_hash IS NOT NULL`
  2. 同步更新 `worker/schema.sql`；`MemoryPresaleRepo` 对齐强制执行同样两条唯一约束；`D1PresaleRepo.resolveAnomaly` 仅针对入账状态冲突返回 `ALREADY_RESOLVED`，不再吞噬无关约束异常。

### 4. P0-D：修复未公示手续费时无法退款
- **现象：** 当系统未配置已公示的用户过错扣费参数 `userFaultFeeNano` 时，运营以 `faultParty = 'USER'` 执行退款会抛出 `FEE_RULE_NOT_PUBLISHED`，导致退款卡死。
- **机制：** `resolveAnomaly` 在 `faultParty === 'USER'` 分支强制要求存在非零已公示扣费规则。
- **根因：** 未按“未公示手续费规则前，所有责任方一律零手续费全额退回”的暂定安全基线实现。
- **验证方法：** 测试未配置 `userFaultFeeNano` 时 `USER` / `SYSTEM` / `UNKNOWN` 均生成 100% 全额零手续费退款；显式配置合法 `userFaultFeeNano` 后仅 `USER` 扣费且不超过原入账金额，`SYSTEM` / `UNKNOWN` 仍全额退款。
- **修复方向与结果：** 修改 `worker/src/presale-hotwallet.mjs` 中 `resolveAnomaly` 与 `_refundAmount` 的计费规则：未配置 `userFaultFeeNano` 时所有责任方按 `feeNano = 0n` 全额退款；配置后仅对 `USER` 扣费。

### 5. P0-E：修复退款确认与多表状态更新原子性
- **现象：** `_markConfirmed` 的退款分支、`_needsReview`、`SENT`/`RETRY` 更新将 `presale_payouts` 和 `presale_orders` 拆成多次独立写库调用，中途进程崩溃或写库失败会导致 payout 已 `CONFIRMED` 而订单停留在 `REFUND_SENT` 等半提交不一致状态。
- **机制：** `D1PresaleRepo` 此前只在 `commitInbound`、`resolveAnomaly` 和 `completeA9` 使用了 `db.batch()`，其余状态联动分散在引擎层的顺序 `await` 调用中。
- **根因：** 引擎层把多表联动状态机拆分为细粒度 CRUD 调用，破坏了数据库事务边界。
- **验证方法：** 在 SQLite 和真实 Cloudflare D1 (Miniflare v3) 上对 `completeRefund`、`markPayoutSent`、`markPayoutRetry`、`markPayoutNeedsReview` 注入写库失败，验证整批语句原子回滚、重启恢复后成功完成且不重复广播。
- **修复方向与结果：** 在 `MemoryPresaleRepo` 与 `D1PresaleRepo` 中将 `markPayoutSent`、`markPayoutRetry`、`markPayoutNeedsReview`、`completeA9`、`completeRefund` 全部收口为单事务 `db.batch()` 原子方法，并附加旧状态白名单和推荐佣金 `WHERE EXISTS(... status='COMPLETED')` 守卫。

### 6. P0-F：收紧 `ton_proof` 公钥信任边界与前端恢复态展示
- **现象：**
  1. 后端对任何未知/自定义合约，只要链上暴露 `get_public_key` get-method 就直接信任其返回的公钥，存在恶意合约自报攻击者可控公钥的风险。
  2. 缺少对 `WalletTg` 的活跃状态、官方 trampoline 代码哈希与链上公钥组合验证。
  3. 前端 `tonconnect.js` 恢复历史会话时直接将 `walletVerified` 设为 `true`，与本次新鲜 `ton_proof` 签名混淆。
- **机制：** `verifyTonProof` 在 `inspectWalletStateInit` 无法匹配已知标准钱包代码哈希时，无条件回落到 `publicKeyResolver(address)`。
- **根因：** 未按 TON Connect 官方 `ton_proof` 规范将“受信任的已知钱包代码哈希”作为公钥提取前提。
- **验证方法：** 构造未知自定义合约 `StateInit` + 链上 `get_public_key` 返回匹配的 Ed25519 公钥，断言被明确拒绝（`PROOF_UNSUPPORTED_WALLET`）；构造 `WalletTg`（trampoline 代码哈希 `9149ae51c1e4689710cebf7830297b16acfbadb363a920a537893e7ffeeca768`）在非活跃/伪造代码/缺链上公钥时全部拒绝，仅四重校验全通过时放行；4 条真实钱包样本继续 100% 通过。
- **修复方向与结果：**
  1. `worker/src/ton-cell.mjs` 新增 `WALLET_TG_TRAMPOLINE_HASH` 与 `inspectCodeBocIdentity()`，区分 `standard` / `wallet_tg` / `unsupported`。
  2. `worker/src/toncenter.mjs` 新增 `fetchWalletAccountState(walletAddress)` 读取 `/getAddressInformation` 的 `state` 与 `codeBoc`。
  3. `worker/src/auth.mjs` 的 `verifyTonProof` 拒绝 `unsupported` 合约（绝不调用或信任其 `get_public_key`）；对 `wallet_tg` 强制核验 StateInit 代码哈希、链上 `state === 'active'`、链上活跃代码哈希与 `get_public_key()` 四重一致。
  4. `a9-mini-app/js/tonconnect.js` 与 `store.js` 拆分 `walletVerified`（仅本次新鲜验签通过为 `true`）与 `walletVerificationState`（`fresh_proof` / `restored_binding` / `unverified`），恢复连接时标准化比对地址并明示“历史绑定 · 本次未重验”。

### 7. P0-G：清理剩余真实数据与伪数据混用
- **现象：** 未接链上数据源时：`server.mjs` 默认构造虚假第 1 轮（含目标价、均价、质押额与人数 18）；`cf-worker.mjs` 与 `v15-indexer.mjs` 硬填 70 亿/12 亿奖池；OG HTML/SVG/PNG 输出 `700,000,000` / `700M` / `$0.0023`；`a9_bot.py` 误读不存在的 `twap24hUsdE8`；前端 `warmup_market.js` 等在真实模式仍有 `400,000` / `8,000,000` / 默认第 1 轮、`tma.js` 返回伪造 ID `4402919`。
- **机制：** 早期原型默认回退值散落在后端索引器、OG 渲染器、本地服务、机器人与前端多处页面。
- **根因：** 缺少“无真实链上数据时全链路显式降级为 `null` / `dataAvailable: false` / 待核验”的统一契约检查。
- **验证方法：** 无链上环境变量拉起 `server.mjs`、调用 `cf-worker.fetch`、运行 `a9_bot.py` 离线/在线脚本、在 Chromium 无头浏览器中打开 `/?mode=live` 遍历 7 个核心页面，逐项断言零伪造数字与正确空态。
- **修复方向与结果：** 全量清理 `server.mjs`、`cf-worker.mjs`、`v15-indexer.mjs`、`growth-engine.mjs`、`api.mjs`、`a9_bot.py` 及前端 9 个文件，无真实数据源时严格输出 `null`、`dataAvailable: false`、`DATA PENDING` 或“待核验”。

### 8. P0-H：收紧商会接口与信息访问边界
- **现象：** 匿名访问和跨用户访问 `GET /api/team/:wallet` 均返回 `200 OK`，并暴露内部 `tgChatId`（如 `-1001234567890`）与群绑定状态。
- **机制：** `worker/src/api.mjs` 中 `GET /api/team/:wallet` 未接入 `auth.wallet(wallet)` 鉴权，且 `/api/user/:wallet` 与 `POST /api/team/join` 直接原样返回团队对象。
- **根因：** 早期演示态遗留的公开只读端点未按最小必要原则划分敏感字段与归属权限。
- **验证方法：** 新增安全测试验证匿名请求返回 `401`、未验签或跨用户请求返回 `403`、普通成员请求成功但响应剥离 `tgChatId`、仅会长可见完整 `tgChatId`。
- **修复方向与结果：** `GET /api/team/:wallet` 接入 `auth.wallet(wallet)` 强制本人已验签鉴权；新增 `sanitizeTeamView(team, viewerWalletKey)`，在 `/api/team/:wallet`、`/api/user/:wallet`、`POST /api/team/join` 中对非会长一律剥离 `tgChatId`。

### 9. P0-I + D5 + D6：不变量回归、过期竞争守卫、历史地址兼容与默认关闸
- **现象与根因：**
  - **过期竞争超卖风险（P0-I）：** 订单在 `planInbound` 检查未过期后、写入 `commitInbound` 前若已过期释放池子被他人抢单，原 `UPDATE presale_orders` 未带 `expires_at >= nowSec` 守卫会导致池子超卖。
  - **D5（历史真实友好地址失效）：** 0001 迁移后存有真实 `EQ…` 友好地址且 `wallet_key IS NULL` 的历史订单，新逻辑按 `wallet_key` 查询导致本人不可见、额度归零，且建单时落入池容分支误报 `EXCEEDS_POOL`。
  - **D6（默认开启兑换）：** `PresaleHotWalletEngine` 构造函数默认 `open = true`，`cf-worker.mjs` 未显式设置 `open`，且配置缺失时回退到推广热钱包。
  - **跨地址格式自推荐：** `bindReferral` 直接比较字符串，可用同一钱包的不同编码形式（raw / `EQ` / `UQ`）绕过自推荐拦截。
- **修复方向与结果：**
  1. `commitInbound` 的 `CONFIRM` 路径在 Memory 与 D1 均新增 `notExpiredAt` 原子守卫，竞态时转入 `ANOMALY (order_state_race)` 且绝不插入孤儿 payout。
  2. `worker/src/ton-address.mjs` 新增 `formatTonAddress()` 与 `addressAliases()`；`D1PresaleRepo` 全面兼容 `wallet_key IS NULL` 的历史真实友好地址订单（查询、额度统计、原子建单准确报 `OVER_QUOTA`），并提供幂等回填方法 `backfillLegacyWalletKeys()`。
  3. `PresaleHotWalletEngine` 默认 `open = false`；`cf-worker.mjs` 与 `server.mjs` 仅在 `A9_PRESALE_OPEN === '1'` 且独立配置 `A9_PRESALE_HOT_WALLET_ADDRESS` 时才开放兑换，`/api/config` 如实输出 `enabled` / `open` 状态。
  4. `SocialStore` 与 `D1SocialStore` 的 `bindReferral` 统一使用 `addressKey()` 归一化地址比对。

---

## 三、修改文件清单

### 后端核心与存储（15 个文件）
- `worker/src/presale-hotwallet.mjs`：默认 `open = false`；统一 8 类入账分类含 `_isPromoFlowTransfer`；P0-B 退款与订单解耦及四条件绑定；P0-D 零手续费全额退款规则；P0-E 原子状态更新方法；P0-I 过期竞争守卫与内存唯一约束对齐。
- `worker/src/presale-runner.mjs`：移除 `buy:` 前缀提前过滤，全量入账送引擎分类并补全计数汇总。
- `worker/src/d1-growth-store.mjs`：实现 `markPayoutSent` / `markPayoutRetry` / `markPayoutNeedsReview` / `completeA9` / `completeRefund` 单事务 `db.batch()` 原子操作；修复 `resolveAnomaly` 并发与异常吞噬；增加 `commitInbound` 过期守卫与防孤儿 payout；兼容 `wallet_key IS NULL` 历史友好地址并提供 `backfillLegacyWalletKeys()`；`bindReferral` 使用 `addressKey`。
- `worker/src/ton-address.mjs`：新增 `formatTonAddress()` 与 `addressAliases()`。
- `worker/src/ton-cell.mjs`：新增 `WALLET_TG_TRAMPOLINE_HASH` 与 `inspectCodeBocIdentity()`，识别 `standard` / `wallet_tg` / `unsupported`。
- `worker/src/toncenter.mjs`：新增 `fetchWalletAccountState()`（调用 `/getAddressInformation` 获取账户活跃态与代码 BoC）。
- `worker/src/auth.mjs`：`verifyTonProof` 新增 `walletStateResolver`，拒绝未审核自定义合约，增加 `WalletTg` 四重校验。
- `worker/src/api.mjs`：透传 `walletStateResolver`；收紧 `GET /api/team/:wallet` 本人验签鉴权；新增 `sanitizeTeamView` 对非会长剥离 `tgChatId`；无链上数据时 OG HTML 不再输出虚假奖池与轮次状态。
- `worker/src/growth-engine.mjs`：`renderOgCardSvg` / `renderOgCardPng` 移除硬编码 `700,000,000`、`700M`、`$0.0023`，无数据时输出 `DATA PENDING`。
- `worker/src/v15-indexer.mjs`：`buildV15ConfigPayload` 无链上数据时输出 `poolState.dataAvailable = false` 与全 `null` 字段。
- `worker/src/cf-worker.mjs`：移除 70 亿/12 亿硬编码默认值；移除兑换热钱包回退推广热钱包逻辑；显式 `open: env.A9_PRESALE_OPEN === '1'`；透传 `walletStateResolver`。
- `worker/src/server.mjs`：移除默认伪造第 1 轮数据；移除兑换热钱包回退推广热钱包逻辑；显式 `open: process.env.A9_PRESALE_OPEN === '1'`；透传 `walletStateResolver`。
- `worker/src/social-store.mjs`：`bindReferral` 改用 `addressKey` 防止跨格式自推荐/环推荐。
- `worker/.env.example`：补充 `A9_PRESALE_HOT_WALLET_ADDRESS=` 与 `A9_PRESALE_OPEN=0` 配置说明。
- `a9-mini-app/bot/a9_bot.py`：修复读取 `priceUsdE8`（兼容旧 `twap24hUsdE8` 且 `priceValid=False` 不输出 0），补全 `FAILED_PERMANENT` / `TECHNICAL_ABORTED` / `STAKING_CLOSED` 标签。

### 数据库结构与增量迁移（2 个文件，历史迁移 `0001/0002/0003` 未修改）
- `worker/migrations/0004_presale_payouts_uniqueness.sql`（**新增**）：重建 `presale_payouts` 保留全部历史数据，移除 `UNIQUE(order_id, kind)`，新增 `idx_presale_payouts_a9_order` 与 `idx_presale_payouts_refund_inbound` 两条部分唯一索引。
- `worker/schema.sql`：同步全新建库结构与上述两条部分唯一索引。

### 前端（10 个文件）
- `a9-mini-app/js/tonconnect.js`：区分本次新鲜 `ton_proof` 验签态（`fresh_proof`）与恢复历史绑定态（`restored_binding`），恢复连接时不再将 `walletVerified` 标为 `true`。
- `a9-mini-app/js/store.js`：新增 `walletVerificationState`；真实模式下 `round` 初始数据字段全为 `null`（不再默认第 1 轮）。
- `a9-mini-app/js/demo-data.js`：演示模式显式补充初始演示轮次，与真实模式彻底分离。
- `a9-mini-app/js/tma.js`：非 Telegram 环境 `getUser()` 返回 `null`，不再伪造 ID `4402919`。
- `a9-mini-app/js/pages/warmup_market.js`、`round_hub.js`、`profile.js`、`system.js`、`share.js`、`poster.js`：清理真实模式中的硬编码示例金额（`400,000` / `160,000` / `64,000` / `8,000,000`）、默认第 1 轮与未验签提示。

### 自动化测试（3 个文件）
- `worker/tests/helpers/test-env.mjs`：`MIGRATIONS` 纳入 `0004_presale_payouts_uniqueness.sql`。
- `worker/tests/p0-security.test.mjs`：扩充至 48 项（无 Miniflare）/ 61 项（含真实 Miniflare D1），覆盖全部 P0-A ~ P0-I、D1 ~ D6 场景与不变量断言。
- `worker/tests/worker.test.mjs`：适配 D6 默认关闭（建单测试显式传 `open: true`）与 P0-D 零手续费退款规则。

---

## 四、新增失败场景与不变量测试清单

所有核心资金与状态机测试均在 `memory`、`d1-sqlite` 与真实 `d1-miniflare`（Cloudflare `workerd` 运行时）三套后端上完整跑通：

1. **P0-A 全入口入账分类测试**：从 `PresalePayoutRunner.tick()` 完整入口验证 8 类入账（有效订单、无备注、错误订单号、错付款人、错金额、重复付款、合法推广 `claim:` 0.06 GRAM、粉尘 ≤0.1 GRAM 及大额无推广单 `claim:`），并验证重复 `tick()` 幂等零重复记录。
2. **P0-B & P0-C 异常退款隔离与多笔错付并发测试**：A 建单 10 GRAM；B、C 两人错用 A 备注付款并分别获退款后，验证 A 订单保持 `PENDING_PAYMENT`、额度未损且随后正常付款完成 `COMPLETED`；A 再发重复付款并退款后，原 `COMPLETED` 订单与 `hasCompletedPurchase` 激活资格保持不变。
3. **P0-D 未公示手续费退款测试**：未配置 `userFaultFeeNano` 时 `USER` / `SYSTEM` / `UNKNOWN` 三类责任方均全额零手续费退款；配置后仅 `USER` 扣费且扣费不超本金。
4. **P0-E 原子性崩溃回滚测试**：在 SQLite 与真实 Cloudflare D1 (Miniflare v3) 上对 `completeRefund` 事务中间注错，断言 `presale_payouts` 与 `presale_orders` 整批原子回滚、重试恢复后一致提交且不重发。
5. **P0-I 不变量测试**：
   - 过期与入账确认并发竞争（`notExpiredAt`）不可超卖总池；
   - `NEEDS_REVIEW` 状态永不被自动重试；
   - 账本守恒校验：`入账总额 === A9 等值本金 + 退款金额 + 已公示扣费 + 待处理金额`；
   - 增量迁移 `0001 -> 0004` + D5 真实友好地址（`EQ…` / `UQ…`）历史 `PAID_A9` 订单可见性、额度占用、超额准确报 `OVER_QUOTA`、`backfillLegacyWalletKeys()` 回填与旧 `presale_payouts` 完整保留。
6. **D6 默认关闸测试**：`PresaleHotWalletEngine` 与 `D1PresaleStore` 默认 `open = false` 拒绝建单（`PRESALE_CLOSED`）；`cf-worker` 在仅配置 `A9_PROMO_HOT_WALLET_ADDRESS` 时绝不回退启用兑换，且无 `A9_PRESALE_OPEN=1` 时建单接口返回拒绝。
7. **P0-F `ton_proof` 公钥边界测试**：未知自定义合约即使链上 `get_public_key` 匹配也被 `PROOF_UNSUPPORTED_WALLET` 拒绝；`WalletTg` 缺少活跃状态/伪造代码/缺链上公钥均被拒绝，四重通过才接受。
8. **P0-G 真实数据零伪造测试**：`cf-worker`、`server.mjs`、`a9_bot.py` 与 Chromium `/?mode=live` 7 路由实测，无链上数据源时均返回 `dataAvailable: false` / `null` / `DATA PENDING` / `待核验`。
9. **P0-H 商会权限边界测试**：匿名访问 `GET /api/team/:wallet` 返回 `401`，未验签/跨用户返回 `403`，普通成员不返回 `tgChatId`，仅会长返回 `tgChatId`。

---

## 五、实际测试执行结果（原始输出见 `docs/gamification/phase-1-test-output-r2.txt`）

| 测试项 / 验收命令 | 运行环境 | 结果 |
|---|---|---|
| `node worker/tests/worker.test.mjs` | Node v24.22.3（Memory + node:sqlite） | **19/19 通过** |
| `node worker/tests/p0-security.test.mjs` | Node v24.22.3（Memory + node:sqlite） | **48/48 通过** |
| `MINIFLARE_MODULE=... node worker/tests/p0-security.test.mjs` | Node v24.22.3 + **真实 Miniflare v3 (`3.20250718.3` / Cloudflare workerd D1)** | **61/61 通过**（含 13 项真实 D1 测试） |
| `node a9-mini-app/js/batch-a-live-guard.test.mjs` | Node v24.22.3 | **6/6 通过** |
| `node a9-mini-app/js/v15-tx.test.mjs` | Node v24.22.3 | **6/6 通过** |
| `a9-mini-app/tests/wealthverse-browser.mjs` | **Playwright + Chromium（390×844 中文浅色 & 360×780 英文暗色）** | **52 项路由/视口 + 交互/离线重试/安全区/长余额/零写请求全通过** |
| P0-G 真实模式 7 路由专项浏览器审计 | Playwright + Chromium（`/?mode=live`） | **通过**（零假数据、零溢出、零 JS 报错、`A9TMA.getUser() === null`） |
| `worker/src/server.mjs` 无链上配置 HTTP 实测 | Node HTTP 实时启动 | **通过**（`dataAvailable: false`、空轮次、兑换关闭、OG/SVG 为 `DATA PENDING`） |
| `a9-mini-app/bot/a9_bot.py` 离线/在线实测 | Python 3.9.6 | **通过**（离线全“待核验”，在线正确解析 `priceUsdE8` 与新状态，`priceValid=False` 不输出 0） |
| D1–D6 修复后等价复现对照 | Memory + node:sqlite | **D1–D6 全部 `NOT REPRODUCED`**（注：直接运行未修改的历史脚本 `phase-1-defect-repro.mjs` 会在第一笔建单即触发 D6 `PRESALE_CLOSED` 拦截，符合默认关闸预期） |
| `cd v15 && shasum -a 256 -c ci/artifacts.sha256` | 本地校验 | **4/4 `OK`**（`v15/` 无任何改动） |

### 尚未运行的测试及原因
1. **真实钱包在正式部署域名上的 `ton_proof` 端到端联调（含真实 `WalletTg` 客户端）**：尚未部署公网 HTTPS 域名与配置正式 `tonconnect-manifest.json` / `A9_TON_PROOF_DOMAINS`，本地只能用真实抓包样本（TonProof.NET MIT 向量）与结构化单元测试验证。
2. **真实 Telegram 客户端（iOS / Android / Desktop）内的 `initData` 与安全区真机验收**：本机测试基于 Chromium 无头浏览器与 `node:crypto` 模拟的合法 Telegram HMAC-SHA256 签名，待部署预览环境后在真实 Telegram 客户端验收。
3. **线上 Cloudflare 账号实际绑定的生产 D1 实例与线上 Worker 环境**：本地已通过 Miniflare v3 (`workerd` + 真实 D1 引擎) 跑通 13/13 用例，但线上生产 Cloudflare 环境部署需单独授权。
4. **真实 TON 测试网/主网交易的 TonCenter v3 终局性/失败/弹回回归测试**：TonCenter 改造属于资金上线阻断项，本阶段未改动真实链上发币与广播链路。

---

## 六、业务规则变更与需要业主确认事项

### 本轮明确的规则调整（均按任务书 V2.0 及安全基线落实）
1. **P0-D 未公示手续费规则：** 在尚未公示并配置 `A9_PRESALE_USER_FAULT_FEE_NANO` 前，`USER` 责任方同样按 **0 手续费全额退款**，不再抛出 `FEE_RULE_NOT_PUBLISHED` 阻断退款。
2. **D6 服务端默认关闸与热钱包隔离：** 兑换引擎默认 `open = false`，且移除“未配兑换热钱包时自动回退复用推广热钱包”的行为；服务端须同时独立配置 `A9_PRESALE_HOT_WALLET_ADDRESS` 与显式 `A9_PRESALE_OPEN=1` 才允许创建兑换订单。
3. **P0-F 钱包白名单策略：** 默认拒绝未审核自定义非标准合约（即使其实现链上 `get_public_key`）；已知标准钱包（v3r1/v3r2/v4r2/v5beta/v5r1）及经四重校验的 `WalletTg` 可通过。
4. **P0-H 商会数据权限：** `GET /api/team/:wallet` 从公开端点收紧为仅本人已验签可访问，且仅会长可见内部 `tgChatId`。

### 仍需业主书面确认的既有事项（沿用第 1 轮待决清单）
- 换绑延迟 `REBIND_DELAY_SEC = 72 小时` 是否最终定案。
- `≤ 0.1 GRAM` 粉尘转账是否继续沿用“落库留痕但不退款”规则。
- 用户过错扣费公示文案与具体金额（公示配置前继续全额免费退）。
- Worker（D1）与 Node 发币程序的正式连接方案（第 1 轮报告第二节第 5 项中的方案 A / B / C，推荐方案 C）。

---

## 七、生产资金上线阻断项（仍然有效，未因本轮测试通过而解除）

以下阻断项**全部保留**，真实资金功能与 A9 固定兑换入口继续保持关闭：

1. **未实现可信链上发币最终确认器（`payoutVerifier`）**：广播后的订单仍停留在 `PAYOUT_SENT` / 不确定状态转人工，尚无按 `query_id` 与主链终局性核验上链结果的生产实现。
2. **Worker（D1）与 Node 发币程序（内存）存储链路未打通**：生产架构方案（A/B/C）待业主审批后另行实施。
3. **TonCenter v2 交易状态不可靠**：当前无法准确区分主链最终确认（finality）、`aborted`、`bounced` 且缺少持久化 `lt` 分页游标，上线前必须切换至 TonCenter v3 并做测试网真交易回归。
4. **线上 Cloudflare 账号真实部署 D1 尚未实测**：本地 Miniflare v3 (`workerd`) 已实测 13/13 通过（含 0001→0004 迁移与 `db.batch()` 原子回滚），但上线前仍需在目标 Cloudflare 预发环境执行实际 `wrangler d1 migrations apply` 与压测。
5. **真实域名与真实钱包 `ton_proof` 端到端未联调**：需在正式 HTTPS 测试域名部署并完成真实 Tonkeeper / WalletTg 等钱包客户端验签实测。

---

## 八、提交记录

- `16c62e4`：第一阶段初始实现
- `2be6ea5`：第一阶段提交记录与机器人输出
- `b0d805b`：AGENTS.md 按业主授权调整三条约定
- `74c2457`：第一阶段验收第 1 轮修改
- `ae5fd0c`：第一阶段验收第 1 轮报告与测试输出
- `6f692ab`：第一阶段交接说明与 D1–D6 复现脚本
- `a91b6261f1cf947589600e39bb34388741e5d525`：第一阶段验收第 2 轮 P0-A ~ P0-I 及 D1–D6 根因修复与 61 项安全/D1 测试
- 本验收报告与测试原始输出提交：见分支最新 `git log`
