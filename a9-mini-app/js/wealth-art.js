/**
 * A9 Boxheads Archive S01 · 双轨 18 阶抽象纸箱人元数据与一一对应精装卡背
 * - activity 系列（9 阶）：通过累计获取 5 种宝箱（青铜 / 白银 / 黄金 / 白金 / 钻石）的数量解锁
 * - wealth   系列（9 阶）：仅当用户持有的 A9 代币市值达到对应 A1–A9 门槛后解锁
 * - 完整保留 tiers / tierVoices / tierDemoHints / characterArt 导出以兼容全站引用
 */

export const CHEST_TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

export const CHEST_TIER_META = {
  bronze:   { key: 'bronze',   zh: '青铜宝箱', shortZh: '青铜', en: 'Bronze Chest',   shortEn: 'Bronze',   tone: 'bronze' },
  silver:   { key: 'silver',   zh: '白银宝箱', shortZh: '白银', en: 'Silver Chest',   shortEn: 'Silver',   tone: 'silver' },
  gold:     { key: 'gold',     zh: '黄金宝箱', shortZh: '黄金', en: 'Gold Chest',     shortEn: 'Gold',     tone: 'gold' },
  platinum: { key: 'platinum', zh: '白金宝箱', shortZh: '白金', en: 'Platinum Chest', shortEn: 'Platinum', tone: 'platinum' },
  diamond:  { key: 'diamond',  zh: '钻石宝箱', shortZh: '钻石', en: 'Diamond Chest',  shortEn: 'Diamond',  tone: 'diamond' },
};

export const WEALTH_TIER_USD = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000];

export const BOXHEADS_SERIES = {
  activity: {
    key: 'activity',
    code: 'ACT',
    unlockType: 'chest_collection',
    labelZh: '宝箱持有系列',
    labelEn: 'Chest Holdings',
    badgeZh: '宝箱持有解锁',
    badgeEn: 'Chest Holding Unlock',
    descZh: '累计持有青铜、白银、黄金、白金、钻石 5 种宝箱解锁（免费助力开箱与宝箱商城购箱均计入），每阶均配专属精装卡背。',
    descEn: 'Unlock by holding Bronze, Silver, Gold, Platinum & Diamond chests (both free assist & Chest Mall count).',
    items: [
      {
        tier: 1, id: 'act-01', rarity: 'COMMON',
        nameZh: '牛皮初箱', nameEn: 'Kraft Box', styleZh: '经典牛皮纸箱', styleEn: 'Kraft Classic',
        traitZh: '原色牛皮纸箱 · 黑卫衣涂鸦王冠', traitEn: 'Kraft boxhead · black hoodie',
        voiceZh: '收齐前三只青铜宝箱，纸箱收藏之旅正式起航！', voiceEn: 'First 3 Bronze Chests held—the boxhead collection begins!',
        unlockRule: { chestTier: 'bronze', count: 3, requireAllTypes: false },
        shortReqZh: '青铜×3', shortReqEn: 'Bronze ×3',
        hintZh: '累计持有 3 个青铜宝箱解锁', hintEn: 'Hold 3 Bronze Chests',
        avatar: './assets/boxheads/activity/avatars/act-01.png',
        card: './assets/boxheads/activity/cards/act-01-card.png',
      },
      {
        tier: 2, id: 'act-02', rarity: 'UNCOMMON',
        nameZh: '纯白音盒', nameEn: 'Mono Beats', styleZh: '纯白耳机纸箱', styleEn: 'Mono Beats',
        traitZh: '极简纯白纸盒 · 黑色皇冠头戴耳机', traitEn: 'Pure white box · crown headphones',
        voiceZh: '九只青铜箱在手，戴上监听耳机听开箱节奏。', voiceEn: 'Nine Bronze Chests in—headphones on for the unboxing beat.',
        unlockRule: { chestTier: 'bronze', count: 9, requireAllTypes: false },
        shortReqZh: '青铜×9', shortReqEn: 'Bronze ×9',
        hintZh: '累计持有 9 个青铜宝箱解锁', hintEn: 'Hold 9 Bronze Chests',
        avatar: './assets/boxheads/activity/avatars/act-02.png',
        card: './assets/boxheads/activity/cards/act-02-card.png',
      },
      {
        tier: 3, id: 'act-03', rarity: 'RARE',
        nameZh: '青帽潮箱', nameEn: 'Teal Cap', styleZh: '青帽珊瑚纸箱', styleEn: 'Coral Cap',
        traitZh: '珊瑚暖橙纸盒 · 湖蓝街潮棒球帽', traitEn: 'Coral box · teal street cap',
        voiceZh: '持有三只白银宝箱，街头潮盒换装亮相！', voiceEn: 'Three Silver Chests held—streetwear boxhead stepping out!',
        unlockRule: { chestTier: 'silver', count: 3, requireAllTypes: false },
        shortReqZh: '白银×3', shortReqEn: 'Silver ×3',
        hintZh: '累计持有 3 个白银宝箱解锁', hintEn: 'Hold 3 Silver Chests',
        avatar: './assets/boxheads/activity/avatars/act-03.png',
        card: './assets/boxheads/activity/cards/act-03-card.png',
      },
      {
        tier: 4, id: 'act-04', rarity: 'EPIC',
        nameZh: '冰晶透盒', nameEn: 'Frost Prism', styleZh: '冰晶透明纸箱', styleEn: 'Frost Prism',
        traitZh: '半透明冰蓝棱镜盒 · 冰蓝潮流卫衣', traitEn: 'Translucent frost crystal boxhead',
        voiceZh: '九只白银宝箱淬炼成冰晶，每一面都折射清辉。', voiceEn: 'Nine Silver Chests forged into translucent frost prism.',
        unlockRule: { chestTier: 'silver', count: 9, requireAllTypes: false },
        shortReqZh: '白银×9', shortReqEn: 'Silver ×9',
        hintZh: '累计持有 9 个白银宝箱解锁', hintEn: 'Hold 9 Silver Chests',
        avatar: './assets/boxheads/activity/avatars/act-04.png',
        card: './assets/boxheads/activity/cards/act-04-card.png',
      },
      {
        tier: 5, id: 'act-05', rarity: 'LEGENDARY',
        nameZh: '红帽主场', nameEn: 'Crimson Cap', styleZh: '红帽正红纸箱', styleEn: 'Crimson Cap',
        traitZh: '正红白皇冠棒球帽 · 红白潮玩卫衣', traitEn: 'Crimson crown cap · red hoodie',
        voiceZh: '三只黄金宝箱到手，红帽主场火力全开！', voiceEn: 'Three Gold Chests secured—crimson home turf activated!',
        unlockRule: { chestTier: 'gold', count: 3, requireAllTypes: false },
        shortReqZh: '黄金×3', shortReqEn: 'Gold ×3',
        hintZh: '累计持有 3 个黄金宝箱解锁', hintEn: 'Hold 3 Gold Chests',
        avatar: './assets/boxheads/activity/avatars/act-05.png',
        card: './assets/boxheads/activity/cards/act-05-card.png',
      },
      {
        tier: 6, id: 'act-06', rarity: 'MYTHIC',
        nameZh: '黑金金缮', nameEn: 'Kintsugi Noir', styleZh: '黑金裂纹金缮箱', styleEn: 'Kintsugi Noir',
        traitZh: '曜黑碎金金缮纹 · 鎏金王冠印记', traitEn: 'Obsidian kintsugi gold-crack boxhead',
        voiceZh: '九只黄金宝箱加身，曜黑裂纹里流淌的全是真金。', voiceEn: 'Nine Gold Chests deep—every obsidian crack gleams gold.',
        unlockRule: { chestTier: 'gold', count: 9, requireAllTypes: false },
        shortReqZh: '黄金×9', shortReqEn: 'Gold ×9',
        hintZh: '累计持有 9 个黄金宝箱解锁', hintEn: 'Hold 9 Gold Chests',
        avatar: './assets/boxheads/activity/avatars/act-06.png',
        card: './assets/boxheads/activity/cards/act-06-card.png',
      },
      {
        tier: 7, id: 'act-07', rarity: 'ULTRA RARE',
        nameZh: '赛博绿电', nameEn: 'Neon Circuit', styleZh: '黑绿电路赛博箱', styleEn: 'Neon Circuit',
        traitZh: '荧光绿电路矩阵 · 暗夜极客涂装', traitEn: 'Acid-green circuit matrix boxhead',
        voiceZh: '三只白金宝箱接入高频回路，赛博绿电全线点亮！', voiceEn: 'Three Platinum Chests wired in—neon circuits charged!',
        unlockRule: { chestTier: 'platinum', count: 3, requireAllTypes: false },
        shortReqZh: '白金×3', shortReqEn: 'Platinum ×3',
        hintZh: '累计持有 3 个白金宝箱解锁', hintEn: 'Hold 3 Platinum Chests',
        avatar: './assets/boxheads/activity/avatars/act-07.png',
        card: './assets/boxheads/activity/cards/act-07-card.png',
      },
      {
        tier: 8, id: 'act-08', rarity: 'SUPREME',
        nameZh: '幻彩镭射', nameEn: 'Holo Prism', styleZh: '全息镭射变色箱', styleEn: 'Holo Chameleon',
        traitZh: '幻彩全息镭射膜 · 紫金潮鞋套装', traitEn: 'Iridescent holographic foil boxhead',
        voiceZh: '三只钻石宝箱折射全息光谱，晒卡焦点非你莫属。', voiceEn: 'Three Diamond Chests unlocked—iridescent from every angle.',
        unlockRule: { chestTier: 'diamond', count: 3, requireAllTypes: false },
        shortReqZh: '钻石×3', shortReqEn: 'Diamond ×3',
        hintZh: '累计持有 3 个钻石宝箱解锁', hintEn: 'Hold 3 Diamond Chests',
        avatar: './assets/boxheads/activity/avatars/act-08.png',
        card: './assets/boxheads/activity/cards/act-08-card.png',
      },
      {
        tier: 9, id: 'act-09', rarity: 'ARCHIVE',
        nameZh: '纯金典藏', nameEn: 'Gold Archive', styleZh: '3D 纯金典藏箱', styleEn: '3D Gold Archive',
        traitZh: '全镀金立体浮雕盒 · 典藏金箔涂装', traitEn: 'Full 3D gold-foil archive boxhead',
        voiceZh: '五箱大满贯加冕九钻，3D 纯金典藏为你封存！', voiceEn: 'All 5 chest tiers + 9 Diamonds—3D Gold Archive sealed!',
        unlockRule: { chestTier: 'diamond', count: 9, requireAllTypes: true },
        shortReqZh: '全5箱+钻×9', shortReqEn: 'All 5 + Dia ×9',
        hintZh: '集齐 5 种宝箱且累计持有 9 个钻石宝箱解锁', hintEn: 'All 5 chest types + 9 Diamond Chests',
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
    descZh: '仅当用户持有的 A9 代币市值达到对应 A1–A9 阶梯后解锁，配暗黑潮牌精装挂卡背板，专为持仓大佬打造。',
    descEn: 'Unlocked exclusively when your held A9 token value hits each A1–A9 tier, paired with dark archive backing cards.',
    items: [
      {
        tier: 1, id: 'wlt-01', rarity: 'COMMON', reqUsd: 1,
        nameZh: 'A1 咬钞萌新', nameEn: 'A1 Bill Rookie', styleZh: '街头嫩芽', styleEn: 'Street Sprout',
        traitZh: '红血丝咬钞纸箱 · 头顶红嫩芽', traitEn: 'Red-eyed cardboard · bill in mouth',
        voiceZh: '嘴里咬着第一张筹码，熬夜也要盯完这轮！', voiceEn: 'First stack in my teeth—staying up for the close!',
        shortReqZh: '$1', shortReqEn: '$1',
        hintZh: '持有 A9 代币市值达 $1 解锁', hintEn: 'Hold $1+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-01.png',
        card: './assets/boxheads/wealth/cards/wlt-01-card.png',
      },
      {
        tier: 2, id: 'wlt-02', rarity: 'UNCOMMON', reqUsd: 10,
        nameZh: 'A2 雷达哨兵', nameEn: 'A2 Radar Scout', styleZh: '雷达猎手', styleEn: 'Field Scout',
        traitZh: '橘红战术护目镜 · 双筒绿光雷达', traitEn: 'Amber visor · neon radar binoculars',
        voiceZh: '雷达已锁定目标底价，早鸟机会绝不漏网！', voiceEn: 'Target price locked on radar—never missing early bird!',
        shortReqZh: '$10', shortReqEn: '$10',
        hintZh: '持有 A9 代币市值达 $10 解锁', hintEn: 'Hold $10+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-02.png',
        card: './assets/boxheads/wealth/cards/wlt-02-card.png',
      },
      {
        tier: 3, id: 'wlt-03', rarity: 'RARE', reqUsd: 100,
        nameZh: 'A3 火漆翼使', nameEn: 'A3 Waxwing Courier', styleZh: '羽翼火漆', styleEn: 'Angel Parcel',
        traitZh: '×★ 涂鸦白快递箱 · 飞翼与红火漆', traitEn: 'X-star winged box · dripping wax seal',
        voiceZh: '火漆封缄，你的专属战利品准时降落。', voiceEn: 'Wax-sealed drop incoming—right on schedule.',
        shortReqZh: '$100', shortReqEn: '$100',
        hintZh: '持有 A9 代币市值达 $100 解锁', hintEn: 'Hold $100+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-03.png',
        card: './assets/boxheads/wealth/cards/wlt-03-card.png',
      },
      {
        tier: 4, id: 'wlt-04', rarity: 'SR', reqUsd: 1000,
        nameZh: 'A4 钻石手', nameEn: 'A4 Diamond Hands', styleZh: '钻石双手', styleEn: 'Diamond Hands',
        traitZh: '多面体蓝钻棱头 · 发光晶体钻石手', traitEn: 'Faceted diamond head · crystal hands',
        voiceZh: '压力越大钻石越亮，拿稳凭证坐等通关！', voiceEn: 'Pressure creates legends—diamond hands till settle!',
        shortReqZh: '$1,000', shortReqEn: '$1,000',
        hintZh: '持有 A9 代币市值达 $1,000 解锁', hintEn: 'Hold $1,000+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-04.png',
        card: './assets/boxheads/wealth/cards/wlt-04-card.png',
      },
      {
        tier: 5, id: 'wlt-05', rarity: 'SPEC RARE', reqUsd: 10000,
        nameZh: 'A5 红白狂怒', nameEn: 'A5 Famicom Fury', styleZh: '红白狂怒', styleEn: 'Famicom Fury',
        traitZh: '十字键红白战损箱 · 红头带与怒眼 LED', traitEn: 'Battle-worn Famicom box · glowing LED eyes',
        voiceZh: 'GAME OVER? NEVER! 赛点时刻才是我的主场！', voiceEn: 'GAME OVER? NEVER! Match point is my playground!',
        shortReqZh: '$10,000', shortReqEn: '$10,000',
        hintZh: '持有 A9 代币市值达 $10,000 解锁', hintEn: 'Hold $10,000+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-05.png',
        card: './assets/boxheads/wealth/cards/wlt-05-card.png',
      },
      {
        tier: 6, id: 'wlt-06', rarity: 'UR', reqUsd: 100000,
        nameZh: 'A6 巨鲸船长', nameEn: 'A6 Captain Whale', styleZh: '巨鲸船长', styleEn: 'Captain Whale',
        traitZh: '蓝鲸方盒船长 · 金框单片镜与骷髅帽', traitEn: 'Whale boxhead pirate · gold monocle',
        voiceZh: '更大的风浪，才配得上真正的巨鲸船长。', voiceEn: 'Bigger seas, bolder souls—full steam ahead!',
        shortReqZh: '$100,000', shortReqEn: '$100,000',
        hintZh: '持有 A9 代币市值达 $100,000 解锁', hintEn: 'Hold $100,000+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-06.png',
        card: './assets/boxheads/wealth/cards/wlt-06-card.png',
      },
      {
        tier: 7, id: 'wlt-07', rarity: 'EPIC', reqUsd: 1000000,
        nameZh: 'A7 阳线狂魔', nameEn: 'A7 Candle Maniac', styleZh: '大阳线狂想', styleEn: 'Candle Mind',
        traitZh: '荧光绿 K 线莫西干 · 鲨鱼齿与燃烧绿柱', traitEn: 'Neon green K-line mohawk · blazing candle',
        voiceZh: '满脑子都是大阳线，24 根绿柱给我冲穿天际！', voiceEn: 'All green candles in my head—send all 24 slots!',
        shortReqZh: '$1,000,000', shortReqEn: '$1,000,000',
        hintZh: '持有 A9 代币市值达 $1,000,000 解锁', hintEn: 'Hold $1,000,000+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-07.png',
        card: './assets/boxheads/wealth/cards/wlt-07-card.png',
      },
      {
        tier: 8, id: 'wlt-08', rarity: 'LEGENDARY', reqUsd: 10000000,
        nameZh: 'A8 紫金大亨', nameEn: 'A8 Purple Tycoon', styleZh: '紫金大亨', styleEn: 'Purple Tycoon',
        traitZh: '紫绒红玫瑰高礼帽 · 满口金牙与宝石权杖', traitEn: 'Velvet rose top hat · gold grill & scepter',
        voiceZh: 'A9 宝箱商城与金库账本都在掌控之中。', voiceEn: 'Wealth builds differently—every tally accounted for.',
        shortReqZh: '$10,000,000', shortReqEn: '$10,000,000',
        hintZh: '持有 A9 代币市值达 $10,000,000 解锁', hintEn: 'Hold $10,000,000+ in A9 value',
        avatar: './assets/boxheads/wealth/avatars/wlt-08.png',
        card: './assets/boxheads/wealth/cards/wlt-08-card.png',
      },
      {
        tier: 9, id: 'wlt-09', rarity: 'GOD TIER', reqUsd: 100000000,
        nameZh: 'A9 黑金至尊', nameEn: 'A9 Obsidian Sovereign', styleZh: '螺旋至尊王', styleEn: 'Supreme Sovereign',
        traitZh: '黑金裂纹红宝石冠 · 螺旋眼与红绒披风', traitEn: 'Obsidian gold crown · spiral eyes & royal cape',
        voiceZh: '绝对价值，永恒统治——这才是 A9 终极图腾。', voiceEn: 'Absolute value, eternal reign—the ultimate A9 icon.',
        shortReqZh: '$100,000,000', shortReqEn: '$100,000,000',
        hintZh: '持有 A9 代币市值达 $100,000,000（1 亿美金）解锁', hintEn: 'Hold $100,000,000+ in A9 value',
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

/**
 * 统计用户累计持有的 5 种宝箱数量：
 * - 优先使用后端 /api/chests/me 返回的统一 chestHoldings 汇总（已含免费开箱 + 商城 BOOST/INSTANT 全量订单）
 * - 回退时本地合并 freeChests（OPENED）+ shopChests（按 orderId 去重）
 */
export function summarizeChestCounts(chestsPayload) {
  const holdings = chestsPayload?.chestHoldings;
  if (holdings && typeof holdings === 'object') {
    const counts = {};
    for (const k of CHEST_TIER_ORDER) {
      counts[k] = Math.max(0, Number(holdings[k] || 0));
    }
    const distinctTypes = CHEST_TIER_ORDER.filter((k) => counts[k] > 0).length;
    const total = CHEST_TIER_ORDER.reduce((sum, k) => sum + counts[k], 0);
    return { ...counts, distinctTypes, total };
  }

  const counts = { bronze: 0, silver: 0, gold: 0, platinum: 0, diamond: 0 };
  const freeList = Array.isArray(chestsPayload?.freeChests) ? chestsPayload.freeChests : [];
  const shopList = Array.isArray(chestsPayload?.shopChests) ? chestsPayload.shopChests : [];

  for (const c of freeList) {
    const t = String(c?.tier || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, t) && c?.status === 'OPENED') {
      counts[t] += 1;
    }
  }
  for (const c of shopList) {
    const t = String(c?.tier || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, t) && c?.status !== 'CANCELLED') {
      counts[t] += 1;
    }
  }

  const distinctTypes = CHEST_TIER_ORDER.filter((k) => counts[k] > 0).length;
  const total = CHEST_TIER_ORDER.reduce((sum, k) => sum + counts[k], 0);
  return { ...counts, distinctTypes, total };
}

/** 评估互动系列单阶是否满足宝箱解锁条件 */
export function evaluateActivityUnlock(item, chestCounts) {
  const rule = item?.unlockRule || { chestTier: 'bronze', count: 1, requireAllTypes: false };
  const counts = chestCounts || { bronze: 0, silver: 0, gold: 0, platinum: 0, diamond: 0, distinctTypes: 0 };
  const current = Number(counts[rule.chestTier] || 0);
  const target = Math.max(1, Number(rule.count || 1));
  const distinctTypes = Number(counts.distinctTypes || 0);
  const hasAllTypes = !rule.requireAllTypes || distinctTypes >= CHEST_TIER_ORDER.length;
  const unlocked = current >= target && hasAllTypes;

  let progressPct = Math.min(100, Math.round((current / target) * 100));
  if (rule.requireAllTypes) {
    const typePct = Math.min(1, distinctTypes / CHEST_TIER_ORDER.length);
    const diaPct = Math.min(1, current / target);
    progressPct = Math.round(((typePct + diaPct) / 2) * 100);
  }
  return {
    unlocked,
    current,
    target,
    chestTier: rule.chestTier,
    requireAllTypes: Boolean(rule.requireAllTypes),
    distinctTypes,
    hasAllTypes,
    progressPct: unlocked ? 100 : progressPct,
  };
}

/** 评估市值系列单阶是否满足持仓市值门槛 */
export function evaluateWealthUnlock(item, holdingUsd = 0) {
  const target = Number(item?.reqUsd || WEALTH_TIER_USD[(Number(item?.tier) || 1) - 1] || 1);
  const current = Math.max(0, Number(holdingUsd) || 0);
  const unlocked = current >= target;
  const progressPct = unlocked ? 100 : Math.min(99, Math.round((current / target) * 100));
  return { unlocked, current, target, progressPct };
}

export const characterArt = (tier = 1, series = 'activity') => getBoxheadItem(tier, series).avatar;
export const characterCardArt = (tier = 1, series = 'activity') => getBoxheadItem(tier, series).card;

// 兼容旧版导出字段（默认映射至宝箱互动系列）
export const tiers = BOXHEADS_SERIES.activity.items.map((it) => [it.nameZh, it.nameEn, it.traitZh, it.traitEn]);
export const tierVoices = BOXHEADS_SERIES.activity.items.map((it) => [it.voiceZh, it.voiceEn]);
export const tierDemoHints = BOXHEADS_SERIES.activity.items.map((it) => [it.hintZh, it.hintEn]);
export const artRoot = './assets/boxheads/';
