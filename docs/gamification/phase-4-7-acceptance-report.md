# A9mini 阶段四、五、六、七完成与全量八层回归验收报告

> **分支**：`feat/gamification-v1`  
> **视觉与产品主轴**：暖棉纸立体书 × 实体厚卡纸贴纸版（Paper-Craft & Sticker Diorama）  
> **覆盖阶段**：
> - **阶段四**：三档贴纸包/盒（`1.99 / 5.99 / 13.99 GRAM`）拆封工坊、纸艺藏品入库幂等与背包贴纸装扮系统
> - **阶段五**：商会（原团队）Telegram 群真实权限核验（防伪造绑定/防同名群冒用/权限失效降级）与 `startapp` 深链邀请首次归因加固
> - **阶段六**：主城商行三档贴纸道具包售卖（**方式 A**：道具包内含按 `1 GRAM = 2,002 A9` 精确折算的定额 A9 代币 + 确定性纸艺装扮 + 手账 EXP）与订单沙盒
> - **阶段七**：全量八层回归验证、移动端 `390×844` / `360×780` 窄屏实机验收与生产上线前 5 项阻断项检查清单

---

## 一、阶段四：三档贴纸包/盒与背包纸艺装扮系统

### 1.1 产品定位与三类资产物理分表
- **名称与纸艺素材升级**：彻底替换旧版奇幻“三档水晶”，采用契合暖棉纸立体书手账风格的寻常直观名称与冲压白边纸艺 SVG 素材：
  1. **基础贴纸包（`pack_basic`，`1.99 GRAM`）**：含 `3,983.98 A9` + `素棉立牌底座（frame_cotton）` + `初心火漆贴纸（badge_seal_red）` + `100 EXP`（素材：`a9-mini-app/assets/paper-craft/crystal-basic.svg`）。
  2. **进阶贴纸盒（`pack_plus`，`5.99 GRAM`）**：含 `11,991.98 A9` + `晴空烫金底座（frame_origami）` + `星航折纸贴纸（badge_star_compass）` + `350 EXP`（素材：`a9-mini-app/assets/paper-craft/crystal-starlight.svg`）。
  3. **豪华贴纸礼盒（`pack_deluxe`，`13.99 GRAM`）**：含 `28,007.98 A9` + `皇家金箔底座（frame_royal_foil）` + `传世皇冠金章（badge_royal_crown）` + `金箔典藏家称号（title_foil_collector）` + `1,000 EXP` + 金箔闪卡演出（`critFlair: true`，素材：`a9-mini-app/assets/paper-craft/crystal-legendary.svg`）。
- **三类资产严格物理隔离**：
  - 数据库增量迁移：`worker/migrations/0006_phase4_6_sticker_packs_inventory.sql`（同步更新 `worker/schema.sql`）。
  - 独立表 `user_inventory_items`、`user_cosmetic_loadout`、`user_pack_deliveries`，显式标注 `ledgerKind: 'IN_GAME_COSMETIC_DATABASE'`、`tradable: false`、`affectsA9Rate: false`，绝不污染链上 `JettonWallet` / `StakeTicket` / `presale_orders` 真实代币账本。
  - 金箔闪卡演出（`critFlair`）仅影响拆封视觉效果与主城/背包金箔外框装扮，绝不改变 `1 GRAM = 2,002 A9` 协议固定兑换比例或链上质押收益。

### 1.2 服务端幂等交付与背包换装持久化
- **后端引擎**：`InventoryEngine`（`worker/src/growth-engine.mjs`）与 `D1InventoryEngine`（`worker/src/d1-growth-store.mjs`）。
- **接口**：
  - `GET /api/inventory/me`：读取当前已验签 Telegram 用户的背包道具、三槽位装备栏（`frame` / `badge` / `title`）与拆封交付流水。
  - `POST /api/inventory/sandbox-open`：沙盒模式拆封三档贴纸包，按 `delivery_id` 主键与 `INSERT OR IGNORE` 保证重复请求、刷新页面或点击「跳过动画（`skipAnimation: true`）」100% 幂等，绝不重复入库。
  - `POST /api/inventory/equip`：校验用户必须实际拥有该装扮（否则返回 `400 ITEM_NOT_OWNED`）且槽位类型匹配，支持随时装备或卸下（`itemId: null`），并在 D1 中持久化保存。
- **前端展示**：
  - 在背包页（`#/profile`，`a9-mini-app/js/pages/profile.js`）上线「贴纸与纸艺装扮匣（`#a9-cosmetic-box`）」，支持按 `全部 / 底座 / 贴纸 / 称号` 筛选与一键「装备 / 卸下」。
  - 背包顶部个人立牌（`identityStage`，`a9-mini-app/js/pages/wealthverse.js`）实时渲染已装备的底座（`.cos-frame_cotton` / `.cos-frame_origami` / `.cos-frame_royal_foil`）、贴纸徽章与金箔称号。

---

## 二、阶段五：商会 TG 群真实核验与 `startapp` 邀请归因加固

### 2.1 商会 Telegram 群真实权限核验
- **杜绝假绑定**：会长在 `POST /api/team/bind-tg` 提交 `@群名` 时，状态始终为 `'verifying'`（核验中），绝不直接变成 `'bound'`。
- **四重真实核验（`POST /api/team/verify-tg`，`worker/src/social-store.mjs` & `worker/src/d1-growth-store.mjs`）**：
  1. **会长身份校验**：调用者已验签绑定的钱包必须等于商会 `captainWallet`，普通成员调用返回 `403 NOT_CAPTAIN`。
  2. **Bot 在群校验**：通过 Telegram Bot API `getChat` 核验机器人在目标群组内且类型合法，否则返回 `400 BOT_NOT_IN_GROUP`。
  3. **防同名群/群 ID 冒用**：校验目标群唯一真实 `tgChatId` 未被其他已绑定商会占用，若已被占用则拒绝并返回 `400 GROUP_ALREADY_BOUND`。
  4. **操作者群管理员校验**：通过 `getChatMember` 核验操作者的 Telegram `user_id` 在该群内为 `creator` 或 `administrator`，否则返回 `400 NOT_GROUP_ADMIN`。
- **权限失效自动降级**：已处于 `'bound'` 的商会群，若后续巡检或重新核验发现机器人被移出群或会长失去群管理员权限，状态自动降级为 `'expired'`。

- **前端联动闭环（`a9-mini-app/js/pages/team.js` & `a9-mini-app/js/app.js`）**：
  - 真实模式 `/team/bind-tg` 上线「两步式服务端四重核验面板」（1. 提交 `@群名` 进入 `verifying`；2. 发起 `POST /api/team/verify-tg` 实时核验），并显式说明 4 条防伪规则，静态只读浏览零自动写请求。
  - 真实模式启动时若同时存在真实 Telegram `initData` 与合法 `startapp` 参数（支持 `invite_TM-0001_<ref>`、`invite_G-*_<ref>` 等格式），自动静默调用 `POST /api/referral/attribution` 完成首次有效归因。

### 2.2 `startapp` 深链解析与首次有效归因
- **`parseStartAppParam`（`worker/src/social-store.mjs`）**：
  - 严格白名单校验 `^[A-Za-z0-9_-]{1,64}$`，拒绝任何畸形或注入参数。
  - 支持 `invite_<referrerId>`、`invite_<teamId>_<referrerId>` 与 `(round|burn|proof|bet)_<targetId>[_<referrerId>]`，并正确保留含 `_` 的 TON 友好地址或钱包标识。
- **跨别名防自邀与防环路（`POST /api/referral/attribution`）**：
  - 同时比对当前用户的 `telegramUserId` 与已绑定 `walletAddress` / `walletKey` 别名：即使用户尝试用自己绑定的钱包地址作为邀请码自邀，也会被精准拦截。
  - 严格执行 First-Touch 首次有效归因锁定（后续点击其他邀请链接绝不覆盖首次邀请人）与 8 层祖先链防环路互邀检查。

---

## 三、阶段六：主城商行 `1.99 / 5.99 / 13.99 GRAM` 贴纸道具包与订单沙盒

### 3.1 方式 A（买贴纸道具包即含定额 A9 代币 + 纸艺装扮）
- **三档精确核算（`worker/src/money.mjs` & `worker/src/presale-hotwallet.mjs`）**：
  - `pack_basic`：`1.99 GRAM`（`1,990,000,000 nano`）× `2,002` = **`3,983.98 A9`**（`3,983,980,000,000 raw`），12% 邀请返佣 = `478.0776 A9`（`478,077,600,000 raw`）。
  - `pack_plus`：`5.99 GRAM`（`5,990,000,000 nano`）× `2,002` = **`11,991.98 A9`**（`11,991,980,000,000 raw`），12% 邀请返佣 = `1,439.0376 A9`（`1,439,037,600,000 raw`）。
  - `pack_deluxe`：`13.99 GRAM`（`13,990,000,000 nano`）× `2,002` = **`28,007.98 A9`**（`28,007,980,000,000 raw`），12% 邀请返佣 = `3,360.9576 A9`（`3,360,957,600,000 raw`）。
- **订单与道具原子联动**：
  - `POST /api/presale/intent` 传入 `skuId` 时按官方 SKU 定价建单并预占额度；未传 `skuId` 的裸兑换保持 `5..200 GRAM` 默认边界。
  - **仅当链上确认发币成功（`COMPLETED`）时**，`_markConfirmed` 自动调用 `inventoryEngine.deliverPack({ userId, skuId, orderId, mode: 'ONCHAIN_ORDER' })` 将对应贴纸包道具原子入库；在 `PENDING_PAYMENT`、`PAYMENT_CONFIRMED`、`PAYOUT_SENT`、超时退款（`REFUNDED`）或错付异常（`ANOMALY`）状态下，绝不提前或错误发放道具。
  - `1.99 GRAM` 贴纸包订单若超时后到账，因 `1.99 GRAM >= 1.0 GRAM` 自动触发**免手续费全额被动退款**（退回完整 `1.99 GRAM`）。
- **主城商行前端（`#/internal/market`，`a9-mini-app/js/pages/warmup_market.js`）**：
  - 顶部展示三档贴纸礼盒直购货架（`.sticker-pack-shelf`），点击购买后弹出「纸艺拆封演出弹层（`#pack-unfold-stage`）」，支持一键「跳过动画（`#btn-skip-pack-anim`）」与直达背包穿戴。
  - 真实模式（`?mode=live`）下所有购买按钮与订单接口保持只读关闭保护（`LIVE_FUNDS_DISABLED` / `PRESALE_CLOSED`）。

---

## 四、阶段七：全量八层回归验证结果

| 验证层级 | 执行命令 | 结果 |
|---|---|---|
| **L1/L2/L4 后端核心与 D1 持久化单元测试** | `node worker/tests/worker.test.mjs` | **19 / 19 PASS** |
| **L3/L5/L6/L7 P0 安全 + 阶段三/四/五/六三引擎（Memory + SQLite D1 + Miniflare 真实 Cloudflare D1）全栈测试** | `MINIFLARE_MODULE=... node worker/tests/p0-security.test.mjs` | **68 / 68 PASS** |
| **前端真实模式资金拦截与 v15 BOC 交易构造测试** | `node --test a9-mini-app/js/batch-a-live-guard.test.mjs a9-mini-app/js/v15-tx.test.mjs` | **7 / 7 + 6 / 6 PASS** |
| **L8 Playwright 浏览器双视口（390×844 zh-CN 白昼 + 360×780 en-US 暗夜）+ 真实只读/离线重试端到端测试** | `PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... A9_TEST_URL=http://127.0.0.1:8092 A9_SCREENSHOTS=docs/gamification/phase-2-evidence node a9-mini-app/tests/wealthverse-browser.mjs` | **52 / 52 路由与视口检查 PASS（0 页面错误、0 水平溢出、0 真实模式写请求）** |
| **v15 合约编译产物 SHA-256 零改动校验** | `(cd v15 && shasum -a 256 -c ci/artifacts.sha256)` | **4 / 4 OK** |

---

## 五、生产真实资金上线前 5 项阻断项检查清单（当前保持安全关闭）

在未来业主正式授权开启主网真实资金（`A9_PRESALE_OPEN=1` 及前端真实资金开关）前，必须逐项完成以下 5 项生产环境核验：

1. **热钱包隔离与密钥注入**：生产环境分别独立配置 `A9_PRESALE_HOT_WALLET_ADDRESS`（商行收款热钱包）与 `A9_PROMO_HOT_WALLET_ADDRESS`（推广领奖热钱包），严禁混用；私钥仅通过受控环境变量注入发币 Runner，绝不入库。
2. **Cloudflare D1 生产迁移与备份**：在生产 D1 按顺序执行 `0001` 至 `0006` 迁移脚本，并确认 `presale_orders`、`presale_inbound_txs`、`presale_payouts`、`user_pack_deliveries` 唯一索引生效。
3. **Telegram Bot 生产 Token 与 Webhook / 群权限**：配置生产 `A9_BOT_TOKEN`、`A9_TON_PROOF_DOMAINS` 与 `A9_ADMIN_TOKEN`，并将官方 Bot 拉入需要核验的商会 Telegram 群组。
4. **扣费规则公示前保持零扣费**：在未向用户显著公示用户过错异常退款手续费前，保持 `A9_PRESALE_USER_FAULT_FEE_NANO` 未设置（默认 `0` 扣费全额退回）。
5. **测试网灰度演练**：先在 TON Testnet 完成 `1.99 / 5.99 / 13.99 GRAM` 真实链上转账、确认发币、超时退款与异常工单闭环演练，经业主书面签字后再切换主网。
