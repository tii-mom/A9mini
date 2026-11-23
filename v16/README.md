# A9 v16 候选版

轮号由 8 位扩为 32 位，编码范围为 `1–4,294,967,295`。轮次字典、胜场计数、凭证地址推导和四个锁定轮次槽位随之扩宽。奖池、奖励倍数、阶梯解锁和 30 天兜底规则沿用 v15，兜底仍由奖池耗尽触发。

v16 使用独立部署地址。质押通知使用 `0x52540010 + uint32 roundId`，随后是可选受益人。前端候选环境可通过 `window.__A9_CONFIG__.stakeProtocolVersion = 'v16'` 选择新版质押编码。现役前端和运维命令默认使用 v15，Live 页面资金入口继续关闭。老版本部署上已有的凭证继续通过原控制器领取。候选版不存在资产或凭证自动迁移。

本地验证命令从仓库根目录运行。

```sh
(cd v16 && acton test && shasum -a 256 -c ci/artifacts.sha256)
node a9-mini-app/js/v15-tx.test.mjs
node ops/scripts/deploy-v15.mjs --protocol v16 --profile testnet-fast --dry-run
node ops/scripts/round-ops.mjs --protocol v16 --profile testnet-fast --action settle-round --round 256 --qualified 18 --candle-hash 0x1234 --dry-run
```

Acton 边界用例重现奖池尚有滚存时，从第 255 轮开到第 256 轮，并同时验证两个凭证的地址、结算、跨轮解锁和到账余额。候选版还需要独立测试网部署及闭环验收。
