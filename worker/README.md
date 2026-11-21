# A9mini `worker/` — v15 状态索引与推广热钱包自动发币服务

对应 **A9 Protocol v15（4 合约 + 0 合约推广热钱包）**，零外部 npm 依赖，同时兼容本地 Node.js 调试与 Cloudflare Worker / D1 部署。

## 核心能力

1. **v15 链上状态读取与 API 适配（`src/v15-indexer.mjs` + `src/api.mjs`）**
   - 统一返回 `{ ok: true, data, ts }` / `{ ok: false, error: { code, message } }` 信封，直接对接 `a9-mini-app/js/data.js`。
   - 完整暴露 v15 状态：无固定 10 轮上限、剩余 70 亿奖池与 `carryRaw`、三档阶梯解锁（`immediateBps` / `lockedSlices` / `unlockedSlices` / `burnedSlices`）、90 天停滞计时与 30 天兜底终局。
2. **推广奖励 0 合约热钱包自费 Gas 引擎（`src/promo-hotwallet.mjs`）**
   - 用户点击领取 → 调用 `POST /api/promo/intent` 生成唯一单号与备注 `claim:<claimId>`，要求用户向推广热钱包转 **`0.06 TON`**。
   - 监听服务验证入账交易（`finality=finalized`、收款地址匹配、实收 `>= 0.06 TON`、备注精确匹配且未重放）→ 状态流转至 `FEE_CONFIRMED`。
   - 热钱包发送标准 TEP-74 `AskToTransfer` 把 A9 打给用户，且强制将 `sendExcessesTo` 设为**推广热钱包自己**，单笔净耗 `0.015~0.045 TON`，项目方 0 Gas 成本。

## 本地运行与测试

```bash
cd /Users/yu1/Desktop/A9mini/worker

# 1. 运行全套单元测试
node tests/worker.test.mjs

# 2. 启动本地 API 服务（默认 127.0.0.1:8799，供 a9-mini-app/?mode=live 直连）
node src/server.mjs
```
