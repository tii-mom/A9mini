# AGENTS.md — A9mini 工作约定

## 项目边界与分支协作
- BAM（`/Users/yu1/Desktop/BAM`）是**只读迁移来源**。不得在 BAM 中提交任何实现改动；BAM 历史未跟踪文件一律不碰。
- `a9-official-web/` 由独立官网 worktree（`codex/a9-official-web` / `fix/official-web-postlaunch-polish`）并行开发，非明确授权不得修改或提交该目录。
- 所有小程序、Worker、Bot、Ops 与生产合约实现、配置、文档、测试落在 `/Users/yu1/Desktop/A9mini`。
- `stitch_a9_telegram_mini_app/` 只作视觉参考；`.a9-cloudflare-release/` 与 `.a9-official-site-preview/` 为本地预览目录，禁止入库。
- **分支纪律**：小程序/后端/运维集成统一在 `release/a9-rc1`；未经业主明确验收通过与书面授权，不得合并 `main` 或执行生产发布。

## 设计红线
- 视觉体系统一为「任天堂第一方红白触感界面」（以双端 `css/tokens.css` 为单源真值：雪白底 `#F4F5F8` + 任天堂正红 `#E60012`，支持暗夜石墨 `#121318` 主题），保留现役生产素材 `assets/boxheads/`（36 张）与 `assets/token/` 官方代币图标，绝不可删除（旧 `assets/paper-craft/` 已由纯矢量图标替代并经业主确认退役清理）。
- 主导航与命名体系统一为 **广场 / 闯关 / 战队 / 我的**（应用总称 `A9 · 财富大冒险`，宝箱购箱入口 `宝箱商城` / Chest Mall，中英双语同步）；历史路由与深链（`#/internal/market`、`#/market`、`#/claim`、`#/rewards`、`#/warmup`、`#/team/invite`、`#/risk/audit`）必须持续可用。
- 优先复用 `css/tokens.css`、`components.css`、`animations.css`，不新建互相覆盖的样式系统；不迁入 BAM 的 CSS / 组件样式 / 视觉规范。
- **全站数字完整展示，不缩写**（如 `10,000,000,000 A9`、`700,000,000 A9`、`550,000,000 A9`、`200,000,000 A9`，严禁 `100 亿` / `7 亿` / `200M` / `700M` 等缩写）；金额单位统一；零 Emoji、零原生系统控件。

## 模式隔离与四道生产总闸（不可绕过）
- `config.isDemo === true`：允许模拟钱包、模拟余额、随机行情、随机哈希、模拟开箱/领取、阶段与角色场景切换。
- `config.isDemo === false`（`?mode=live`）：**默认严格只读**，资金动作一律拦截；钱包 SDK / 配置 / 接口缺失时显示明确异常与重试；`lockMode: true` 时禁止 `?mode=demo` 切换。
- **四道独立生产总闸**（未获对应上线波次单独授权前一律保持关闭）：
  1. 前端实盘签名总闸：`window.__A9_CONFIG__.liveFundsEnabled === true`（仅允许由受信任部署配置显式注入，URL 参数绝不可开启，且 `tonconnect.js` 签发瞬间复验 `assertWalletReadyForLiveTx()` 与 `ton_proof`）；
  2. 宝箱商城下单开关：`worker/wrangler.toml` `A9_PRESALE_OPEN = "0"`；
  3. 免费开箱与队长 5,000 A9 创世金库发放开关：`A9_CHEST_OPEN_ENABLED = "0"`（并通过 `/api/config` `chestMall.openEnabled` 透出）；
  4. Telegram 群/私聊播报开关：`A9_BROADCAST_ENABLED = "0"`。
- `js/demo-data.js` 是唯一允许出现模拟资金数据的地方；`tx-ux.js` 仅使用 `sessionStorage` 追踪在途交易且实施全局单槽防重锁。
- `localStorage` 键 `a9_ui_prefs_v1` 只存 `settings`、`user.profileMode`、`user.autoRenew`（键位兼容保留）。不得把余额、凭证、轮次、行情写入任何持久化存储。
- 模式不写入 `localStorage`；URL 参数仅在未开启 `lockMode` 时优先于 `window.__A9_CONFIG__`。

## 数据契约与后端存储
- `js/data.js` 是唯一前端读取层，复用统一 `ENDPOINTS` 与 `ApiResponse<T>` 信封（`{ok, data, ts}` / `{ok:false,error}`），并以 `PROTOCOL_SPECS` 作为前端参数单源真值。
- 服务端状态与时间驱动轮次阶段、倒计时、目标价、判定均价与达标时段；缺值用 `null` 并在 UI 显示明确状态（严防 `Number(null) === 0`），**绝不把 0 当成真实价格，也不把演示数字当真实余额**。
- Worker D1 迁移清单当前为 `worker/migrations/0001..0015`（含 `0014_v17_price_unlock.sql` 与 `0015_v17_1_chest_direct_payout.sql`，已落盘迁移脚本禁止原地改写；新变更只能追加新编号迁移）。

## v17.0 涨价解锁（Price-Unlock）+ v17.1 宝箱直发唯一主网架构
- **4 合约极简架构**（`A9mini/v17/` 为全项目唯一维护与生产合约套件，`ci/artifacts.sha256` 4/4 已锁定，`v16/` 只读存档未改；严格 O(1) 零待决字典、32 位无限轮次、仅 6 个源码文件）：标准零魔改 TEP-74 `JettonMaster` + `JettonWallet`（`10,000,000,000 A9` 一次铸完验明即永久弃权）、极简 `RoundController`（4 态状态机，单笔 `SettleRound`，附带 >= 0.06 GRAM 的无效入金即时原路退回）、极简 `StakeTicket`（单用户单轮，头矿/普通分账记账）。
- **奖池分完为止（无固定 10 轮上限、无第 10 轮 $0.50 底线）**：总奖励池 `7,000,000,000 A9`（每轮基础 `700,000,000 A9` + `carryRaw` 滚存）+ 团队池 `1,200,000,000 A9`（每轮基础 `120,000,000 A9` + `teamCarryRaw` 按实发比例释放），主网部署由 `treasury` 一次性注资 `8,200,000,000 A9` 至 `RoundController`。
- **链上核心玩法（v17.0 涨价解锁 · 全币圈母语版）**：
  - 目标价走廊 `[1.30×, 2.00×]`；最低锁仓 `100 A9`；全员 `1 A9 = 1 份` 公平分奖；单轮奖金封顶 `5×`（超额 100% 滚存下轮）。
  - 单轮节奏：`24H` 锁仓（前 `6H = 21,600s` 为「头矿 6H · 5% 止损」，之后为「10% 止损」，同地址按 `earlyAmountRaw / lateAmountRaw` 分账防追加白嫖）→ 封盘禁进禁出 → `12H` 冲价（`12` 根 1H K 线，`≥ 8/12` 达标通关）。
  - 提前解押（`OP_TICKET_EARLY_EXIT = 0x52540306`，附 `0.34 GRAM` 双动作 Gas）：仅限 `24H` 锁仓期内（`now < stakeCloseAt`）可执行，退 `85%` 本金、扣 `15%` 销毁；进入 `12H` 冲价期自动拒绝（`Errors.LockClosed = 225`）。
  - 通关与 3 折急提：退 `100%` 本金 + `20%` 秒提（`0.22 GRAM` Gas），余下 `80%` 分 `14` 天（`1,209,600s`）逐秒解锁（每日 `5.71%`，永久不倒扣）；支持随时对**尚未解锁的未来余额**走 `3 折急提`（`instantDiscount = true`，`0.34 GRAM` 双动作 Gas：`30%` 秒提 + `70%` 直接销毁；满 14 天后误传零销毁 100% 实发）。
  - 未通关（永不爆仓 · 自动止损）：头矿 6H 自动退 `95%` 本金（烧 `5%`）、普通自动退 `90%` 本金（烧 `10%`），另烧向上取整一半奖池与一半团队结转；零锁仓空轮无论胜负 100% 滚存零销毁；7 天超时 `AbortRound` 无许可 `100%` 无损退本；事件 `EvEarlyExited = 0x52540109`、`EvInstantCashout = 0x5254010A`。
- **v17.1 宝箱商城与链下推广体系（0 合约 · 项目方 0 Gas）**：
  - **宝箱商城（6 档纯区间随机 · 合并直发钱包）**：`0.99–500 GRAM` 共 6 档纯整数 SKU（含 500 GRAM 传说宝箱、不限个人购箱上限），保底本金 + 纯随机加赠（`0%–+66.7%`）合并一笔 TEP-74 直发买家钱包；下单仅收一次 `+0.06 GRAM` 配送 Gas，逾期/异常退款扣除 `0.03 GRAM` Gas；配 6 档任天堂开箱剧场（`js/chest-theater.js`）。
  - **免费宝箱与推广熔断账本（总硬顶 `550,000,000 A9` · 6 桶 BigInt+CAS 原子扣减）**：
    - `presale_promo`：`48,000,000 A9`（商城直推 6% 返佣 + 宝箱加赠）
    - `free_chest_captain`：`100,000,000 A9`（5 阶免费箱：青铜 200 A9 免助力秒开起，好友购箱 1 抵 3 助力 + 队长绑 ≥50 人 TG 群且满 3 成员享 5,000 A9 创世金库）
    - `prediction`：`100,000,000 A9`（12H 预言擂台 + 首轮 500 A9 保底体验金）
    - `warmup`：`52,000,000 A9`（下轮预热预约宝箱）
    - `stake_referral`：`200,000,000 A9`（v17 好友通关奖金 8% 返佣，`worker/src/v17-rewards.mjs`）
    - `round_airdrop`：`50,000,000 A9`（v17 每轮 `100,000 A9` 等权空投抽奖，SHA-256 确定性开奖公示）
  - **0.06 GRAM 一键领币**：用户向独立推广热钱包转 `0.06 GRAM`（覆盖 Gas，找零回热钱包），热钱包自动发 A9，项目方 0 Gas 支出。
- **全币圈母语术语与全局禁用词守卫**：
  - 核心口径：`涨价解锁 / 头矿 6H · 5% 止损 / 24H 锁仓 → 12H 冲价 / 提前解押（扣 15% 销毁）/ 永不爆仓 · 自动止损 / 20% 秒提 + 14 天逐秒解锁 / 3 折急提（7 折销毁）/ 异常中止 · 退回本金 / 宝箱商城（合并直发钱包）`。
  - 原生币对外名称与代码统一为 **GRAM**；**TON** 仅保留为区块链名称与技术协议名称。
  - **严禁出现旧术语与违规文案**（已由 `a9-mini-app/js/batch-a-live-guard.test.mjs` 全局强断言守卫）：`十城`、`军饷`、`攻城令`、`主城`、`商会`、`背包`、`主城商行`、`A9 兑换屋`、`暴击`、`早鸟`、`Early Bird`、`链上质押`、`自动连闯`、`Auto-Continue`、`1 GRAM = 2,002 A9`、`24H 预言/观测盘/竞猜`、`16/24`、`15x`、`No Liq`、`200M`、`700M`。

## 仍然有效的安全边界（业主重申）
- 未经业主授权不得修改已锁定哈希的 `v17`（与存档 `v16`）合约及其编译产物、主网部署包 `ops/deploy-console/bundle-mainnet-v17.0.json` 与既有 D1 迁移脚本。
- 未经波次单独授权，四道生产总闸必须保持关闭，不得开启真实资金交易、链上签名、转账、锁仓或自动发币。
- 不得混用演示数据与真实数据，不得伪造资产、收益、支付、绑定、分享或用户人数。
- 未经业主明确通知验收通过，不进入下一阶段、不合并生产分支 `main`。

## 合约、运维与上线波次
- 唯一生产合约源码与锁定哈希位于 `A9mini/v17/`（`ci/artifacts.sha256`）；主网部署脚本使用 `ops/tolk/deploy_v17.tolk`、`ops/scripts/deploy-v15.mjs --protocol v17`、`ops/scripts/round-ops.mjs --protocol v17`（全部默认 dry-run，真实广播需显式 `--execute` 与环境变量确认），分波次步骤见 `ops/MAINNET_LAUNCH_RUNBOOK.md`。
- 主网部署、资产迁移、生产 D1 迁移（`--remote`）、Secrets 注入、Bot Webhook / Telegram 入口切换需单独书面授权；密钥由环境注入，严禁入库。

## 验收与必跑基线
- 视口 `390×844` 及更窄；检查底栏遮挡、倒计时/按钮溢出折行、长金额完整展示、暗夜主题对比度、多语言、Telegram 安全区与弹层。
- 提交前必跑全栈基线：
  - `node --test a9-mini-app/js/batch-a-live-guard.test.mjs a9-mini-app/js/v15-tx.test.mjs worker/tests/*.test.mjs ops/scripts/selftest.mjs`
  - `python3 -m unittest a9-mini-app/bot/test_a9_bot.py`
  - `(cd v17 && shasum -a 256 -c ci/artifacts.sha256) && (cd v16 && shasum -a 256 -c ci/artifacts.sha256)`
- 区分「原有失败」与「迁移引入失败」，不得把演示环境结果写成链上实测。
