/**
 * A9 Boxheads Archive S01 · 双轨 18 阶抽象纸箱人元数据与一一对应精装卡背
 * - activity 系列（9 阶）：用户通过平台打卡 / 集章 / 24H 预言 / 邀请互动解锁
 * - wealth   系列（9 阶）：仅当用户持有的 A9 代币市值达到对应门槛后解锁
 * - 完整保留 tiers / tierVoices / tierDemoHints / characterArt 导出以兼容全站引用
 */

export const BOXHEADS_SERIES = {
  activity: {
    key: 'activity',
    code: 'ACT',
    unlockType: 'platform_interaction',
    labelZh: '互动解锁系列',
    labelEn: 'Activity Series',
    badgeZh: '平台互动解锁',
    badgeEn: 'Interaction Unlock',
    descZh: '通过广场打卡、集章手账、24H 预言擂台与邀友互动解锁，每阶均配专属盲盒挂卡背板。',
    descEn: 'Unlock via daily stamps, 24H predictions & invites. Every tier pairs with a collectible backing card.',
    items: [
      {
        tier: 1, id: 'act-01', rarity: 'COMMON',
        nameZh: '经典牛皮纸箱', nameEn: 'Kraft Classic',
        traitZh: '原色牛皮纸箱 · 黑卫衣涂鸦王冠', traitEn: 'Kraft boxhead · black hoodie',
        voiceZh: '套上纸箱第一天，24H 观测盘先盯起来！', voiceEn: 'Day one in the box—eyes on the 24H board!',
        hintZh: '初始赠送 · 进入即点亮', hintEn: 'Starter · unlocked on entry',
        avatar: './assets/boxheads/activity/avatars/act-01.png',
        card: './assets/boxheads/activity/cards/act-01-card.png',
      },
      {
        tier: 2, id: 'act-02', rarity: 'UNCOMMON',
        nameZh: '纯白耳机纸箱', nameEn: 'Mono Beats',
        traitZh: '极简纯白纸盒 · 头戴王冠监听耳机', traitEn: 'Pure white box · crown headphones',
        voiceZh: '戴上耳机屏蔽噪音，只听整点达标钟声。', voiceEn: 'Headphones on—tuning out noise, listening for hourly stamps.',
        hintZh: '演示：手账累计盖章 ≥ 2 枚解锁', hintEn: 'Demo: 2+ handbook stamps',
        avatar: './assets/boxheads/activity/avatars/act-02.png',
        card: './assets/boxheads/activity/cards/act-02-card.png',
      },
      {
        tier: 3, id: 'act-03', rarity: 'RARE',
        nameZh: '青帽珊瑚纸箱', nameEn: 'Coral Cap',
        traitZh: '珊瑚暖橙纸盒 · 湖蓝街潮棒球帽', traitEn: 'Coral box · teal street cap',
        voiceZh: '早鸟 2.0× 通道已开，先上车的人最从容！', voiceEn: 'Early 2.0× window open—first movers stay chill!',
        hintZh: '演示：完成 1 次 24H 预言站队解锁', hintEn: 'Demo: lock 1 24H prediction',
        avatar: './assets/boxheads/activity/avatars/act-03.png',
        card: './assets/boxheads/activity/cards/act-03-card.png',
      },
      {
        tier: 4, id: 'act-04', rarity: 'EPIC',
        nameZh: '冰晶透明纸箱', nameEn: 'Frost Prism',
        traitZh: '透明折射冰晶盒 · 冰蓝潮流卫衣', traitEn: 'Translucent frost crystal boxhead',
        voiceZh: '晶莹剔透，每一小时判定均价全透明！', voiceEn: 'Crystal clear—every hourly TWAP verified on-chain!',
        hintZh: '演示：完成 1 笔兑换屋兑换解锁', hintEn: 'Demo: 1 Exchange swap',
        avatar: './assets/boxheads/activity/avatars/act-04.png',
        card: './assets/boxheads/activity/cards/act-04-card.png',
      },
      {
        tier: 5, id: 'act-05', rarity: 'LEGENDARY',
        nameZh: '红帽正红纸箱', nameEn: 'Crimson Cap',
        traitZh: '任天堂正红帽 · 红白机潮玩卫衣', traitEn: 'Nintendo red cap · crimson hoodie',
        voiceZh: '红白主场冲锋！把第 16 格金旗稳稳拿下！', voiceEn: 'Red & White home turf—plant that Slot 16 gold flag!',
        hintZh: '演示：完成 1 轮闯关参与解锁', hintEn: 'Demo: join 1 quest round',
        avatar: './assets/boxheads/activity/avatars/act-05.png',
        card: './assets/boxheads/activity/cards/act-05-card.png',
      },
      {
        tier: 6, id: 'act-06', rarity: 'MYTHIC',
        nameZh: '黑金裂纹金缮箱', nameEn: 'Kintsugi Noir',
        traitZh: '曜黑碎金金缮纹 · 鎏金王冠印记', traitEn: 'Obsidian kintsugi gold-crack boxhead',
        voiceZh: '历经震荡而不碎，裂缝里流淌的全是真金。', voiceEn: 'Forged in volatility—every crack gleams with gold.',
        hintZh: '演示：加入或查看战队解锁', hintEn: 'Demo: join a squad',
        avatar: './assets/boxheads/activity/avatars/act-06.png',
        card: './assets/boxheads/activity/cards/act-06-card.png',
      },
      {
        tier: 7, id: 'act-07', rarity: 'ULTRA RARE',
        nameZh: '黑绿电路赛博箱', nameEn: 'Neon Circuit',
        traitZh: '荧光绿电路矩阵 · 暗夜极客涂装', traitEn: 'Acid-green circuit matrix boxhead',
        voiceZh: '全绿电路上线，信号直通 16/24 通关线！', voiceEn: 'All-green circuits online—locked onto 16/24!',
        hintZh: '演示：连续打卡或集章 ≥ 6 枚解锁', hintEn: 'Demo: 6+ total stamps',
        avatar: './assets/boxheads/activity/avatars/act-07.png',
        card: './assets/boxheads/activity/cards/act-07-card.png',
      },
      {
        tier: 8, id: 'act-08', rarity: 'SUPREME',
        nameZh: '全息镭射变色箱', nameEn: 'Holo Chameleon',
        traitZh: '幻彩全息镭射膜 · 紫金潮鞋套装', traitEn: 'Iridescent holographic foil boxhead',
        voiceZh: '不同角度不同光芒，朋友圈晒卡焦点就是你。', voiceEn: 'Every angle shines—built to flex on X & TG.',
        hintZh: '演示：手账升至 Lv.3 解锁', hintEn: 'Demo: reach Logbook Lv.3',
        avatar: './assets/boxheads/activity/avatars/act-08.png',
        card: './assets/boxheads/activity/cards/act-08-card.png',
      },
      {
        tier: 9, id: 'act-09', rarity: 'ARCHIVE',
        nameZh: '3D 纯金典藏箱', nameEn: '3D Gold Archive',
        traitZh: '全镀金立体浮雕盒 · 黑金典藏框', traitEn: 'Full 3D gold-foil archive boxhead',
        voiceZh: '互动满册毕业！3D 纯金典藏卡背已为你封存。', voiceEn: 'Activity album complete—3D Gold Archive unlocked!',
        hintZh: '演示：点亮前 8 阶互动形象解锁', hintEn: 'Demo: collect ACT 01–08',
        avatar: './assets/boxheads/activity/avatars/act-09.png',
        card: './assets/boxheads/activity/cards/act-09-card.png',
      },
    ],
  },

  wealth: {
    key: 'wealth',
    code: 'WLT',
    unlockType: 'a9_market_cap_holding',
    labelZh: 'A9 市值达标系列',
    labelEn: 'A9 Wealth Series',
    badgeZh: '持仓市值达标解锁',
    badgeEn: 'A9 Holding Value Unlock',
    descZh: '仅当用户持有的 A9 代币市值达到对应阶梯后解锁，配暗黑潮牌精装挂卡背板，专为持仓大佬打造。',
    descEn: 'Unlocked exclusively when your held A9 token value hits each tier, paired with dark archive backing cards.',
    items: [
      {
        tier: 1, id: 'wlt-01', rarity: 'COMMON',
        nameZh: '街头嫩芽', nameEn: 'Street Sprout',
        traitZh: '红血丝咬钞纸箱 · 头顶红嫩芽', traitEn: 'Red-eyed cardboard · bill in mouth',
        voiceZh: '嘴里咬着第一张筹码，熬夜也要盯完这轮！', voiceEn: 'First stack in my teeth—staying up for the close!',
        hintZh: '持有 A9 代币市值达标 LV.01 解锁', hintEn: 'Unlock at LV.01 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-01.png',
        card: './assets/boxheads/wealth/cards/wlt-01-card.png',
      },
      {
        tier: 2, id: 'wlt-02', rarity: 'UNCOMMON',
        nameZh: '雷达猎手', nameEn: 'Field Scout',
        traitZh: '橘红战术护目镜 · 双筒绿光雷达', traitEn: 'Amber visor · neon radar binoculars',
        voiceZh: '雷达已锁定目标底价，早鸟机会绝不漏网！', voiceEn: 'Target price locked on radar—never missing early bird!',
        hintZh: '持有 A9 代币市值达标 LV.02 解锁', hintEn: 'Unlock at LV.02 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-02.png',
        card: './assets/boxheads/wealth/cards/wlt-02-card.png',
      },
      {
        tier: 3, id: 'wlt-03', rarity: 'RARE',
        nameZh: '羽翼火漆', nameEn: 'Angel Parcel',
        traitZh: '×★ 涂鸦白快递箱 · 折纸翼与红火漆', traitEn: 'X-star winged box · dripping wax seal',
        voiceZh: '火漆封缄，你的专属空投战利品准时降落。', voiceEn: 'Wax-sealed drop incoming—right on schedule.',
        hintZh: '持有 A9 代币市值达标 LV.03 解锁', hintEn: 'Unlock at LV.03 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-03.png',
        card: './assets/boxheads/wealth/cards/wlt-03-card.png',
      },
      {
        tier: 4, id: 'wlt-04', rarity: 'SR',
        nameZh: '钻石双手', nameEn: 'Diamond Hands',
        traitZh: '多面体冰晶棱头 · 发光钻石双手', traitEn: 'Faceted diamond head · crystal hands',
        voiceZh: '压力越大钻石越亮，拿稳凭证坐等通关！', voiceEn: 'Pressure creates legends—diamond hands till settle!',
        hintZh: '持有 A9 代币市值达标 LV.04 解锁', hintEn: 'Unlock at LV.04 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-04.png',
        card: './assets/boxheads/wealth/cards/wlt-04-card.png',
      },
      {
        tier: 5, id: 'wlt-05', rarity: 'SPEC RARE',
        nameZh: '红白狂怒', nameEn: 'Famicom Fury',
        traitZh: '十字键红白战损箱 · 发光红眼与红飘带', traitEn: 'Battle-worn Famicom box · glowing eyes',
        voiceZh: 'GAME OVER? NEVER! 赛点时刻才是我的主场！', voiceEn: 'GAME OVER? NEVER! Match point is my playground!',
        hintZh: '持有 A9 代币市值达标 LV.05 解锁', hintEn: 'Unlock at LV.05 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-05.png',
        card: './assets/boxheads/wealth/cards/wlt-05-card.png',
      },
      {
        tier: 6, id: 'wlt-06', rarity: 'UR',
        nameZh: '巨鲸船长', nameEn: 'Captain Whale',
        traitZh: '蓝鲸方盒船长 · 金框单片镜与海盗帽', traitEn: 'Whale boxhead pirate · gold monocle',
        voiceZh: '更大的风浪，才配得上真正的巨鲸船长。', voiceEn: 'Bigger seas, bolder souls—full steam ahead!',
        hintZh: '持有 A9 代币市值达标 LV.06 解锁', hintEn: 'Unlock at LV.06 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-06.png',
        card: './assets/boxheads/wealth/cards/wlt-06-card.png',
      },
      {
        tier: 7, id: 'wlt-07', rarity: 'EPIC',
        nameZh: '大阳线狂想', nameEn: 'Candle Mind',
        traitZh: '荧光绿 K 线莫西干 · 燃烧大阳线蜡烛', traitEn: 'Neon green K-line mohawk · blazing candle',
        voiceZh: '满脑子都是大阳线，24 根绿柱给我冲穿天际！', voiceEn: 'All green candles in my head—send all 24 slots!',
        hintZh: '持有 A9 代币市值达标 LV.07 解锁', hintEn: 'Unlock at LV.07 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-07.png',
        card: './assets/boxheads/wealth/cards/wlt-07-card.png',
      },
      {
        tier: 8, id: 'wlt-08', rarity: 'LEGENDARY',
        nameZh: '紫金大亨', nameEn: 'Purple Tycoon',
        traitZh: '紫绒红玫瑰礼帽 · 纯金牙与宝石权杖', traitEn: 'Velvet rose top hat · gold grill & cane',
        voiceZh: 'A9 兑换屋与金库账本都在掌控之中。', voiceEn: 'Wealth builds differently—every tally accounted for.',
        hintZh: '持有 A9 代币市值达标 LV.08 解锁', hintEn: 'Unlock at LV.08 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-08.png',
        card: './assets/boxheads/wealth/cards/wlt-08-card.png',
      },
      {
        tier: 9, id: 'wlt-09', rarity: 'GOD TIER',
        nameZh: '螺旋至尊王', nameEn: 'Supreme Sovereign',
        traitZh: '黑金裂纹红披风 · 红白螺旋眼与悬浮钻', traitEn: 'Obsidian gold king · red-white spiral eyes',
        voiceZh: '绝对价值，永恒统治——这才是 A9 终极图腾。', voiceEn: 'Absolute value, eternal reign—the ultimate A9 icon.',
        hintZh: '持有 A9 代币市值达标 LV.09 解锁', hintEn: 'Unlock at LV.09 A9 holding value',
        avatar: './assets/boxheads/wealth/avatars/wlt-09.png',
        card: './assets/boxheads/wealth/cards/wlt-09-card.png',
      },
    ],
  },
};

export function getBoxheadItem(tier = 1, series = 'activity') {
  const s = BOXHEADS_SERIES[series] || BOXHEADS_SERIES.activity;
  const idx = Math.max(0, Math.min(8, (Number(tier) || 1) - 1));
  return s.items[idx];
}

export const characterArt = (tier = 1, series = 'activity') => getBoxheadItem(tier, series).avatar;
export const characterCardArt = (tier = 1, series = 'activity') => getBoxheadItem(tier, series).card;

// 兼容旧版导出字段（默认映射至互动解锁系列）
export const tiers = BOXHEADS_SERIES.activity.items.map((it) => [it.nameZh, it.nameEn, it.traitZh, it.traitEn]);
export const tierVoices = BOXHEADS_SERIES.activity.items.map((it) => [it.voiceZh, it.voiceEn]);
export const tierDemoHints = BOXHEADS_SERIES.activity.items.map((it) => [it.hintZh, it.hintEn]);
export const artRoot = './assets/boxheads/';
