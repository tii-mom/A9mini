# A9 协议 v17.0 — 涨价解锁（Price-Unlock）4 合约极简架构

## 核心规则（单一事实源）
- **4 合约极简 O(1) 架构**：零魔改标准 TEP-74 `JettonMaster` + `JettonWallet`（100 亿一次铸完即永久弃权）+ `RoundController` + `StakeTicket`。
- **全员 1:1 公平分奖 + 头矿 6H 轻止损**：彻底取消权重系数，1 A9 = 1 份；最低锁仓 `100 A9`；单轮奖金封顶 `5×`（超额 100% 滚存下轮）。
- **24H 锁仓 → 12H 冲价**：
  - 前 6 小时（`21,600s`）锁仓享 **5% 止损**（未通关退 95%）；6 小时后锁仓享 **10% 止损**（未通关退 90%），同地址分段精确记账（`earlyAmountRaw` / `lateAmountRaw`）。
  - 24H 锁仓期内随时支持 **提前解押**（`OP_TICKET_EARLY_EXIT = 0x52540306`，退 85% 本金，扣 15% 直接销毁）；进入 12H 冲价期后封盘禁进禁出（`Errors.LockClosed = 225`）。
  - 12H 冲价期内 ≥ `8/12` 根 1H K 线达到 `[1.30×, 2.00×]` 目标价即通关。
- **通关解锁与 3 折急提**：
  - 100% 本金 + 20% 奖金秒提，余下 80% 分 14 天（`1,209,600s`）逐秒解锁；
  - 任意时刻可勾选 `instantDiscount = true` 走 **3 折急提**（已解锁部分 100% 实发，仅对尚未解锁余额 30% 实发、70% 直接销毁；满 14 天后误传 `instantDiscount = true` 零销毁 100% 实发）。
- **事件与操作码**：
  - `OP_TICKET_CLAIM = 0x52540303`（新增 `instantDiscount: bool`）
  - `OP_TICKET_EARLY_EXIT = 0x52540306` / `OP_TICKET_EARLY_EXIT_REQ = 0x52540307`
  - `EvEarlyExited = 0x52540109` / `EvInstantCashout = 0x5254010A`
