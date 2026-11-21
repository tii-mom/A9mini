# a9-mini-app 实现说明

原生 ES Modules 静态应用，无构建步骤。

## 运行

```bash
node dev-server.mjs          # http://127.0.0.1:8091
```

- `/` → 明确标识的演示模式（模拟钱包/余额/行情/哈希/领取）
- `/?mode=live` → 从 BAM Worker 读取真实只读数据（同源代理 `/api/*`）
- 纯静态托管也可以：`python3 -m http.server 8091`，但此方式下 live 模式需要直连已放行 CORS 的 BAM 地址。

## 目录职责

| 文件 | 职责 |
|---|---|
| `js/config.js` | 模式、API 地址、BAM 版本记录 |
| `js/data.js` | 唯一只读数据层；BAM API 契约、焦点轮选择、视图模型、v13 估算 |
| `js/demo-data.js` | **唯一**允许出现模拟资金数据/随机行为的文件 |
| `js/store.js` | 内存状态；持久化白名单只有 UI 偏好；资金动作按模式 gating |
| `js/app.js` | 引导、轮询、来源标记、加载/过期/错误/重试状态、倒计时 |
| `js/tonconnect.js` | TON Connect；真实模式无伪造连接/交易结果 |
| `js/pages/round_stages.js` | 观察页、24H 时段记录、结算态 |
| `js/pages/round_hub.js` | 首页主操作、参与确认、三态交易弹层 |
| `js/pages/profile.js` | 我的：可领取 → 参与中/待解锁 → 凭证/海报/设置 |
| `dev-server.mjs` | 静态托管 + `/api/*` 同源代理 |

## 只读链路

```
打开小程序
  → app.js syncData()
  → data.js loadSnapshot()
      live: GET /api/config + /api/rounds → pickFocusRound() → GET /api/rounds/:id
      demo: demoFixture()（数据来自 BAM 真实接口样本，明确标识为测试数据）
  → mapRoundView() 写入内存
  → 渲染首页 / 观察页 / 我的
```

服务端提供：轮次状态、倒计时 `secondsRemaining`、目标价 `targetPriceUsdE8`、判定均价 `priceUsdE8`、逐时段 `candles[*].qualified`。前端不自行推演这些值。

## 已知边界

- 本轮**不接资金写入**。真实模式点击参与/领取会明确提示等待合约版本交付。
- a9mini 现有界面以 TON 计质押，BAM 原生以 A9 raw 计质押（9 位精度）。`estimateRewardA9()` 做了兼容折算，属于界面估算口径，合约版本交付后必须复核。
- 团队、榜单、预热、内盘的实时数据接入属于下一阶段；当前这些页面在真实模式仍显示空态或演示数据，不得视为已验收。
- CDN 不可达时 TON Connect / Telegram SDK / 字体加载失败，页面仍以只读模式运行；真机 Telegram 与钱包确认尚未实测。
