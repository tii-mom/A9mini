# 第一阶段报告：基线清点 + P0 安全与数据真实性

**基线：** `9f138fb4bd673aefe91d02ab59842f33ddd84adb`（本地 `main` = `origin/main`，开工前无新提交）
**实施分支：** `feat/gamification-v1`
**第一阶段代码提交：** `16c62e4599bcc130f3b64840a6d251e0ff9845d4`（29 个文件，+2978 / −586）。本报告的 SHA 记录另有一次文档提交。
**原始测试输出：** `docs/gamification/phase-1-test-output.txt`

## 1. 完成内容

### P0-1 服务端身份
- 新增 `worker/src/auth.mjs`，负责以下几件事：
  - 按 Telegram 官方算法校验 `initData`：HMAC-SHA256，密钥为 `HMAC("WebAppData", bot_token)`，比较时用常量时间，`auth_date` 有效期 24 小时。
  - 用户 ID 只取自验签通过的数据。
- TON Connect `ton_proof` 钱包归属验证：
  - 服务端发放一次性载荷，15 分钟过期，只能由申请它的 Telegram 用户使用。
  - 校验域名白名单和时间戳。
  - 用 Ed25519 和链上 `get_public_key` 验证签名。
- Telegram 与钱包的绑定由服务端维护：
  - 存储分两种：`MemoryIdentityStore` 和 `D1IdentityStore`。
  - 一个钱包只能绑定一个 Telegram 账号。
  - 换钱包需要重新验证；断开钱包时解除绑定。
- `api.mjs` 改造：所有私有接口改为从“已验签身份 + 服务端绑定钱包”取账户。请求体或路径里的 `userId`、`walletAddress` 只用于比对，不一致返回 403。
  - 新增接口：`/api/me`、`/api/auth/ton-proof/payload`、`/api/auth/ton-proof/verify`、`/api/auth/wallet/unbind`。
  - `/api/user/:wallet` 对任何人只返回链上公开数据；推广余额、额度、商会信息只返回给钱包本人。
- 前端改造：
  - `data.js` 在真实模式下附带 `Authorization: tma <initData>`；演示模式永远不附带。
  - `tonconnect.js` 连接钱包时执行 ton_proof；断开时解除绑定；恢复连接时只认可服务端已有的绑定。

### P0-2 A9 订单状态机
- 重写 `presale-hotwallet.mjs` 和 `presale-runner.mjs`。
  - 订单状态：`PENDING_PAYMENT → PAYMENT_CONFIRMED → PAYOUT_PENDING → PAYOUT_SENT → COMPLETED`。
  - 异常与退款状态：`PAYOUT_RETRY`、`NEEDS_REVIEW`、`REFUND_PENDING → REFUND_SENT → REFUNDED`、`EXPIRED`、`CANCELLED`。
- 先落库、后广播：
  - 发币记录先持久化为 `BROADCASTING`，再调用广播。
  - 状态不确定的发币（进程崩溃、超时）必须先查链；没有链上核验器时转人工，绝不盲目重发。
- 唯一约束：入账交易哈希、`a9:<订单号>`、`refund:<入账哈希>`、发币交易哈希、每单一笔推荐奖励。
- 备注不能单独作为凭据：付款地址必须是订单钱包，金额必须完全一致；否则按原规则退款。
- 额度与总池在建单时原子预占：D1 用单条带条件的 `INSERT…SELECT…WHERE`。未付款订单 30 分钟后释放预占。
- 演习模式只做纯读取的计划，不写任何数据，也不调用广播。
- 推荐奖励只在 `COMPLETED` 之后记账，且只记一次；记账中途崩溃转人工复核，不会重复入账。
- 金额全部用 BigInt 精确换算（新增 `money.mjs`），不再使用 `Math.round(Number*1e9)`。
- 新增 D1 实现 `D1PresaleRepo`，与内存实现共用同一套业务逻辑。
- 增量迁移：
  - `worker/migrations/0001_baseline_v15.sql`：原表结构，原样保留。
  - `worker/migrations/0002_p0_identity_presale_state.sql`：只新增列和表，不删除任何数据。
  - `schema.sql` 同步更新，用于全新安装。

### P0-3 数据真实性
- `bot/a9_bot.py`：删除所有写死的轮次、价格、质押、收益数字和假的深链 ID。数据改为从 `A9_API_BASE` 读取，读取失败时显示“待核验”。
- 真实模式下的假数据已改掉：
  - 邀请人列表：真实模式显示“暂无数据”，演示模式标注“演示样例”。
  - 预热排名 `No.08`、预计奖励 `400,000`：真实模式显示 `--` 或“待核验”。
  - 奖池回退值 `700,000,000`：改为“待核验”。
  - 分享图的兜底目标价 `$0.0023`：改为 `--`。
- 群组绑定：只填写 `@群名` 不再记为 `bound`，统一为 `verifying`，等第六阶段的真实校验。演示提示标注“[演示]”。

## 2. 修改文件
- 新增：
  - `worker/src/auth.mjs`、`worker/src/ton-address.mjs`、`worker/src/money.mjs`
  - `worker/migrations/0001_baseline_v15.sql`、`worker/migrations/0002_p0_identity_presale_state.sql`
  - `worker/tests/p0-security.test.mjs`、`worker/tests/helpers/test-env.mjs`
  - `docs/gamification/*`
- 修改：
  - 后端：`worker/src/{api,presale-hotwallet,presale-runner,d1-growth-store,cf-worker,server,toncenter,social-store,growth-engine}.mjs`、`worker/schema.sql`、`worker/.env.example`
  - 原测试：`worker/tests/worker.test.mjs`
  - 前端与机器人：`a9-mini-app/js/{data,tonconnect,tma,share}.js`、`a9-mini-app/js/pages/{team,round_stages,warmup_market}.js`、`a9-mini-app/bot/a9_bot.py`
- 未改动：`v15/`。`ci/artifacts.sha256` 中 4 个哈希全部一致，没有重新编译。

## 3. 测试结果（原始输出见 phase-1-test-output.txt）

| 命令 | 结果 |
|---|---|
| `node worker/tests/worker.test.mjs` | 19/19 通过（改造前基线同样 19/19） |
| `node worker/tests/p0-security.test.mjs` | 30/30 通过（新增） |
| `node a9-mini-app/js/batch-a-live-guard.test.mjs` | 6/6 通过 |
| `node a9-mini-app/js/v15-tx.test.mjs` | 6/6 通过 |
| `node a9-mini-app/tests/wealthverse-browser.mjs` | **未运行**：本机没有安装 Playwright |
| 机器人模板实际输出（未配置 `A9_API_BASE`） | 三条消息全部显示“待核验”，不含任何数字（输出附在 phase-1-test-output.txt 末尾） |

原测试有 7 处为适配新身份和状态机做了修改，原有的安全语义全部保留：
- 推广/预售/激活接口改为必须带签名身份；
- 推荐奖励改为在发币确认后才入账；
- 群组状态改为 `verifying`；
- 两个 D1 用例由字符串匹配的假库改为真实 SQLite。

## 4. 未完成 / 已知问题
1. **没有真实的链上发币核验器。** 生产中广播后的订单会停在 `PAYOUT_SENT`，不会自动变成 `COMPLETED`。这是有意的安全默认：这一路径同时影响激活资格和推荐奖励记账。需要先确定 acton 脚本返回的交易哈希的含义，再按 `query_id` 实现 TonCenter 查询。
2. **生产运行链路是断开的（基线已存在的问题）。** Cloudflare Worker 在 D1 中建单，但 `presale-runner` 只在 Node 的 `server.mjs` 中运行，用的是内存存储，看不到 D1 里的订单。开放真实兑换前，必须决定由哪个进程用 D1 驱动发币。
3. **ton_proof 暂不支持尚未部署的钱包。** 这类钱包读不到 `get_public_key`，会返回 `WALLET_PUBKEY_UNAVAILABLE`。支持它需要解析 `walletStateInit` 并计算 cell 哈希，可放在后续阶段。
4. `TonCenterClient.fetchInboundTransfers` 对所有交易都标记为 `finalized`，也不区分交易是否 aborted 或 bounced。状态机已能识别这些字段，但数据源还需要补上。
5. `server.mjs` 本地开发用的轮次数据（如 `stakeCount: 18`）属于本地样例，界面上没有标注来源。
6. 群组真实校验（P5-2）在第六阶段完成；目前只保证不会显示假的“已绑定”。
7. 预热奖池 8,000,000 / 80,000,000 A9 等规则常量没有出现在 AGENTS.md 的 v15 口径里，需要业主确认是否仍然有效。

## 5. 是否影响真实资产业务
- 没有开启任何真实资金动作。
- 真实模式的只读限制不变（`LIVE_FUNDS_DISABLED`）。
- 兑换比例、限额、退款费率、推荐比例均未改动。
- 退款规则有两处收紧，需要业主确认：
  - 付款时没有匹配订单的转账，原来在额度内会直接发币，现在按“用户过错”退款，扣 0.05 GRAM。
  - 付款金额与订单不一致，现在退款，不再按实付金额发币。
- 旧数据中的 `PAID_A9` 订单不再被视为“已确认交付”：
  - 有发币哈希的显示为 `PAYOUT_SENT`，没有的显示为 `NEEDS_REVIEW`；
  - 两种都仍占用额度，但都不计入激活资格。

## 6. 需要测试环境、Bot 或真机才能验证
- 真实 Telegram 客户端里的 `initData` 验签：需要真实 Bot Token 和部署好的接口。
- 真实钱包（Tonkeeper 等）的 ton_proof：需要部署域名和 manifest，并配置 `A9_TON_PROOF_DOMAINS`。
- 浏览器回归测试：需要先安装 Playwright。

## 7. 需要业主确认的参数
- `initData` 有效期：当前 24 小时（`INIT_DATA_MAX_AGE_SEC`）。
- ton_proof 载荷有效期：15 分钟；时间戳允许误差：15 分钟。
- 未付款订单的预占时长：30 分钟（`ORDER_TTL_SEC`）。
- 上面第 5 节的两处退款规则收紧。
- 一个钱包只允许绑定一个 Telegram 账号（目前拒绝第二个账号绑定）。
- **AGENTS.md 与任务书存在冲突，需要书面更新 AGENTS.md：**
  - AGENTS.md 禁用“GRAM”一词，任务书要求改为 GRAM；
  - AGENTS.md 规定保留“石墨黑 + 荧光绿”，任务书要求“深紫 + 午夜蓝”；
  - AGENTS.md 规定重排导航须先确认。
  第二阶段开工前需要业主书面确认以哪一方为准。
