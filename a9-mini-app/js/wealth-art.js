/**
 * A9 财富大冒险 · A1~A9 实体厚卡纸角色立牌元数据（与 assets/wealthverse/game/a1~a9.png 逐一精确校对）
 * [0] 中文称谓, [1] 英文称谓, [2] 中文服饰特征, [3] 英文服饰特征
 */
export const tiers = [
  ['链上萌新', 'Newcomer', '深蓝星徽探险帽与指南针', 'Navy compass explorer cap'],
  ['早鸟猎人', 'Early Scout', '琥珀护目镜与双筒望远镜', 'Amber goggles & binoculars'],
  ['闯关奇兵', 'Quest Ranger', '羽翼白兜帽与火漆邮包', 'Winged hood & wax-sealed parcel'],
  ['钻石手', 'Diamond Hand', '银纹蓝晶护甲与浮空棱晶', 'Silver-inlaid azure crystal armor'],
  ['暴击先锋', 'Crit Vanguard', '绯红金绣大衣与红宝石金爵', 'Crimson gold coat & ruby chalice'],
  ['星鲸巨鳄', 'Star Whale', '金锚三角船长帽与星鲸披风', 'Gilded tricorn & star-whale cape'],
  ['金库女王', 'Vault Queen', '森绿花叶金冠与翡翠礼裙', 'Emerald botanical crown & gown'],
  ['财富女爵', 'Wealth Duchess', '紫羽玫瑰礼帽与雕花金杖', 'Plum rose top hat & gilt cane'],
  ['传奇', 'Legend', '红绒金箔王冠与貂绒礼袍', 'Velvet gold crown & royal cloak'],
];

/** 角色立牌轻点翻身时的专属纸艺气泡台词 */
export const tierVoices = [
  ['带着第一枚金币出发，一起盯紧 24H 观测盘！', 'First gold coin in hand—let’s watch the 24H board!'],
  ['早鸟 2.0× 权重已锁定视野，先手出击最从容！', 'Early 2.0× weight locked in sight—first movers stay calm!'],
  ['滴答！你的火漆印专属包裹已经稳稳送达。', 'Special delivery! Your wax-sealed parcel has arrived.'],
  ['每一道折痕与刻度，都必须严丝合缝。', 'Every crease and tick must line up to perfection.'],
  ['把红旗稳稳插到第 16 格，这轮才算漂亮！', 'Plant the gold flag at Slot 16—that’s how we win!'],
  ['顺着星鲸航线全速前行，目标底价就在前方！', 'Full speed on the star-whale route toward target!'],
  ['让每一枚达标印章，在奖金金库里生根发芽。', 'Let every qualified stamp bloom in the Prize Vault.'],
  ['A9 兑换屋随时开门，好账本从不缺席。', 'A9 Exchange is always open—every tally checks out.'],
  ['24 段全盘稳控，这就是 A9 传奇的气场！', 'All 24 slots mastered—true A9 Legend aura!'],
];

/** 演示模式图鉴收集册提示条件（仅用于前端演示收藏展示，真实模式统一标示待链上核验） */
export const tierDemoHints = [
  ['初始赠送 · 注册即解锁', 'Starter sticker · unlocked'],
  ['演示手账集章 ≥ 2 枚解锁', 'Demo: 2+ handbook stamps'],
  ['演示完成 1 次观测查看解锁', 'Demo: inspect 24H slots'],
  ['演示完成 1 笔兑换屋兑换解锁', 'Demo: complete 1 exchange swap'],
  ['演示完成 1 轮入场闯关解锁', 'Demo: join 1 quest round'],
  ['演示加入或查看战队解锁', 'Demo: join a squad'],
  ['演示累计达标 3 轮解锁', 'Demo: 3 qualified rounds'],
  ['演示手账升至 Lv.3 解锁', 'Demo: reach Handbook Lv.3'],
  ['演示集齐前 8 阶典藏解锁', 'Demo: collect A1–A8'],
];

export const artRoot = './assets/wealthverse/';
export const characterArt = (tier) => artRoot + 'game/a' + tier + '.png';
