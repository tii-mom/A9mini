/**
 * A9 Viral Growth Sharing Toolkit (Scheme 3 X Dynamic OG + Scheme 2 TG Story Helper)
 * - Zero Emoji, Zero guaranteed-return claims, full numbers only
 * - apiOrigin strictly falls back to window.location.origin when config.apiBase is empty
 */

import { config } from './config.js';
import { store } from './store.js';
import { getEffectiveUserId } from './data.js';
import { A9TMA, A9Haptic } from './tma.js';
import { escapeHtml, formatNum, showToast, copyText, openModal, closeModal } from './components.js';
import { icon } from './icons.js';
import { L } from './i18n.js';

export function getBotHandle() {
  const fromServer = store.state.round?.protocolConfig?.botHandle || store.state.round?.protocolConfig?.tgBotHandle;
  const fromGlobal = typeof window !== 'undefined' ? (window.__A9_CONFIG__?.botHandle || window.__A9_CONFIG__?.tgBotHandle) : '';
  return String(fromServer || fromGlobal || 'A9_TonBot').replace(/^@+/, '');
}

/** 生成标准 Telegram Mini App 深链：https://t.me/<bot>?startapp=<param> */
export function buildTmaDeepLink(startParam) {
  const safeParam = String(startParam || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const bot = getBotHandle();
  return safeParam ? `https://t.me/${bot}?startapp=${encodeURIComponent(safeParam)}` : `https://t.me/${bot}`;
}

export function getShareRef() {
  const uid = getEffectiveUserId(store.state.user);
  if (uid) return uid;
  const short = (store.state.user.shortAddress || '').replace(/[^a-zA-Z0-9]/g, '');
  return short || 'a9';
}

/** Worker 动态 OG 短链：/c/:type/:id?ref=<uid> */
export function buildOgShareUrl(type, id, userRef = getShareRef()) {
  const apiOrigin = config.apiBase || window.location.origin;
  const base = `${apiOrigin}/c/${encodeURIComponent(type)}/${encodeURIComponent(String(id ?? '1'))}`;
  return userRef ? `${base}?ref=${encodeURIComponent(userRef)}` : base;
}

/** Telegram startapp 归因深链 */
export function buildStartAppLink(type, id, userRef = getShareRef()) {
  const safeId = String(id ?? '1').replace(/^A9-STAKE-/, '');
  const param = `${type}_${safeId}${userRef ? `_${userRef}` : ''}`;
  return `${window.location.origin}${window.location.pathname}?mode=${config.mode}&startapp=${encodeURIComponent(param)}`;
}

function buildAngles(type, id, ctx = {}) {
  const r = store.state.round;
  const pred = store.state.prediction || {};
  const rawRound = ctx.roundId ?? r.currentRound;
  const roundNum = rawRound ? rawRound : L('待核验', 'TBD');
  const rawPassed = ctx.qualified ?? r.qualifiedCandles;
  const passed = rawPassed !== null && rawPassed !== undefined ? rawPassed : '—';
  const required = ctx.required ?? r.minQualifiedCandles ?? 8;
  const target = r.targetPrice ? `$${Number(r.targetPrice).toFixed(4)}` : L('待定', 'TBD');
  const pool = r.rewardBudgetA9 === null || r.rewardBudgetA9 === undefined ? L('待核验', 'pending') : `${formatNum(r.rewardBudgetA9)} A9`;
  const streak = Number(ctx.streak ?? pred.streak) || 0;
  const rawWr = ctx.winRate ?? pred.winRate;
  const winRate = rawWr !== null && rawWr !== undefined && Number.isFinite(Number(rawWr)) ? Number(rawWr) : null;
  const rankTag = streak >= 2
    ? L(`（当前 ${streak} 连胜${winRate !== null ? ` · ${winRate}% 胜率` : ''}）`, ` (${streak}-win streak${winRate !== null ? ` · ${winRate}% win rate` : ''})`)
    : (winRate !== null ? L(`（预言胜率 ${winRate}%）`, ` (${winRate}% win rate)`) : '');

  if (type === 'proof') {
    const stakeTon = formatNum(ctx.stakeTon || 0);
    const mult = (Number(ctx.multiplier) || 1).toFixed(1);
    return [
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `A9 第 ${roundNum} 轮涨价解锁凭证 #${id} 已生成：锁仓 ${stakeTon} A9（全员 1:1 分奖 · 永不爆仓），当前 12H 冲价达标 ${passed}/${required}，目标底价 ${target}。`,
          `A9 Round #${roundNum} Price-Unlock Pass #${id}: ${stakeTon} A9 locked (1:1 fair split · no liquidation). 12H Push ${passed}/${required}, target ${target}.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `已上车 A9 第 ${roundNum} 轮涨价解锁池，本轮奖池 ${pool}（封顶 5x · 永不爆仓，头矿 6H 仅 5% 止损），12H 冲价正在推进中！`,
          `Locked into A9 Round #${roundNum} Price-Unlock (${pool} pool, 5x cap, no liquidation, First 6H 5% Stop-Loss). Watching the 12H Push live!`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `把 ${stakeTon} A9 锁进了 A9 第 ${roundNum} 轮涨价解锁池，目前 12H 冲价 ${passed}/${required} 段达标，赢了最高 5 倍币，没过也退 95%/90% 本金，稳！`,
          `Locked ${stakeTon} A9 into A9 Round #${roundNum}. 12H Push is ${passed}/${required}—up to 5x if we pass, 95%/90% refunded if not!`
        )
      }
    ];
  }

  if (type === 'burn') {
    const missGap = Number.isFinite(Number(passed)) ? Math.max(1, Number(required) - Number(passed)) : null;
    const gapText = missGap !== null
      ? L(`就差 ${missGap} 根小时线通关`, `missed by just ${missGap} hourly slot(s)`)
      : L('未满 8/12 达标线', 'missed the 8/12 line');
    return [
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `A9 第 ${roundNum} 轮 ${gapText}（定格 ${passed}/${required} 段）——永不爆仓 · 自动止损：合约已开放头矿 6H 退 95% / 普通退 90% 本金，止损份额与半数奖池已链上通缩销毁。`,
          `A9 Round #${roundNum} ${gapText} (${passed}/${required} slots)—No Liquidation · Auto Stop-Loss: 95% (First 6H) / 90% refund open while stop-loss & half-pool burn on-chain.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `真通缩不嘴炮：A9 第 ${roundNum} 轮未通关触发自动止损，头矿 6H 退 95% / 普通退 90%，半数奖池链上永久通缩！下轮 ${pool} 奖池即将重开，链上规则铁面无私。`,
          `Real on-chain deflation: A9 Round #${roundNum} triggered Auto Stop-Loss (95% First 6H / 90% refund) + half-pool permanent burn. Next ${pool} pool opens soon.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `现场目击 A9 第 ${roundNum} 轮结算：12H 冲价最终 ${passed}/${required} 段，${gapText}，永不爆仓自动止损退本（95%/90%）并通缩销毁半数奖池。下轮再战！`,
          `Witnessed A9 Round #${roundNum} settlement: 12H Push ended at ${passed}/${required} slots (${gapText})—No Liquidation · Auto Stop-Loss refund (95%/90%) & half-pool burn. Ready for next round!`
        )
      }
    ];
  }

  if (type === 'chest') {
    const label = ctx.label || L('白银助力箱', 'Silver Co-Op Chest');
    const isBoost = ctx.source === 'SHOP_BOOST';
    const need = Math.max(0, Number(ctx.requiredAssists || 2) - Number(ctx.currentAssists || 0));
    const rewardText = ctx.rewardText || '1,000 A9';
    return [
      {
        key: 'gift',
        label: isBoost ? L('手气爆棚战报', 'Top Roll Report') : L('双向开箱礼', 'Co-Op Gift'),
        text: isBoost
          ? L(
              `手气爆棚！刚在 A9 宝箱商城开【${label}】拿到 ${rewardText}（保底 + 随机加赠合并直发钱包），0.99 GRAM 起试试手气或免费领 200 A9 新手箱！`,
              `Lucky roll! Opened [${label}] in A9 Chest Mall for ${rewardText} (base + random bonus paid directly to wallet). Try from 0.99 GRAM or claim free 200 A9 Starter Chest!`
            )
          : L(
              `A9 双向开箱礼：帮我助力开启【${label}】（${rewardText}，还差 ${need} 位同路人），确认同行立刻领可秒开的 200 A9 青铜新手箱！`,
              `A9 Co-Op Gift: assist [${label}] (${rewardText}, ${need} partner(s) left) with an active TON wallet and instantly open your own 200 A9 Bronze Starter Chest!`
            )
      },
      {
        key: 'banter',
        label: L('站队对赌战报', 'Battle Call'),
        text: isBoost
          ? L(
              `A9 第 ${roundNum} 轮 12H 冲价正热（${passed}/${required} 段）！刚开【${label}】合并直发 ${rewardText}，顺便来 12H 预言擂台 0 GRAM 站队 PASS / BURN！`,
              `A9 Round #${roundNum} 12H Push is heating up (${passed}/${required} slots)! Unboxed [${label}] for ${rewardText} direct payout—pick PASS or BURN for 0 GRAM.`
            )
          : L(
              `A9 第 ${roundNum} 轮 12H 冲价线（${passed}/${required} 段）！差 ${need} 位活跃钱包同路人一起开【${label}】，同行秒领 200 A9 青铜新手箱！`,
              `A9 Round #${roundNum} (${passed}/${required} slots)! Need ${need} active-wallet partner(s) for [${label}]—get an instant 200 A9 Bronze Starter Chest.`
            )
      },
      {
        key: 'data',
        label: L('链上规则透明', 'Transparent'),
        text: isBoost
          ? L(
              `A9 宝箱商城透明规则：6 档纯区间随机开箱，保底 + 随机加赠（最高 +275,000 A9）合并一笔直发钱包，只收一次 0.06 GRAM Gas，全网 2 亿 A9 硬顶公开可查。`,
              `A9 Chest Mall rules: 6 random-range tiers sending base + random bonus (up to +275,000 A9) directly to your wallet in one tx (0.06 GRAM gas once), 200M A9 Phase 1 cap.`
            )
          : L(
              `A9 协议双向开箱礼：仅需连接链上活跃 TON 钱包校验（0 扣款、防女巫公开可查），同行推进【${label}】并立得可秒开的 200 A9 青铜新手箱。`,
              `A9 Protocol Co-Op Gift: active TON wallet check (0 transfer, transparent anti-sybil) advances [${label}] and unlocks an instant 200 A9 Bronze Starter Chest.`
            )
      }
    ];
  }

  if (type === 'bet') {
    const sideLabel = ctx.side === 'BURN' ? L('未通关空军 FAIL', 'FAIL') : L('通关多军 PASS', 'PASS');
    const slotNote = (ctx.guessSlots !== null && ctx.guessSlots !== undefined)
      ? L(`，精准卡位 ${ctx.guessSlots}/12 段`, `, exact call ${ctx.guessSlots}/12`)
      : '';
    return [
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `12H 冲价，达标 ≥ 8/12 派奖还是自动止损？我在 A9 第 ${roundNum} 轮 12H 预言擂台押了【${sideLabel}】${slotNote}${rankTag}。当前 ${passed}/${required} 段，目标底价 ${target}。`,
          `12H price sprint—pass ≥ 8/12 or auto stop-loss? I locked [${sideLabel}]${slotNote}${rankTag} in A9 Round #${roundNum} 12H Prediction Arena (${passed}/${required} slots, target ${target}).`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `0 GRAM 免费上车 A9 第 ${roundNum} 轮 12H 预言擂台！我已锁定【${sideLabel}】${slotNote}，新人首轮参与即保底 500 A9 待解锁体验金，敢不敢来对赌判断？`,
          `0 GRAM free entry in A9 Round #${roundNum} 12H Prediction Arena! Locked [${sideLabel}]${slotNote}. First-round rookies get a 500 A9 vault floor—come test your call.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `0 成本先站个队：A9 第 ${roundNum} 轮我选【${sideLabel}】${slotNote}。现在 ${passed}/${required} 段，猜对瓜分奖池、首轮猜错也保底 500 A9 赠金，看戏站队不亏。`,
          `Zero-cost stand on A9 Round #${roundNum}: [${sideLabel}]${slotNote}. Currently ${passed}/${required} slots—500 A9 rookie floor even on a first miss.`
        )
      }
    ];
  }

  // Default: 'round' 24H 赛点
  return [
    {
      key: 'data',
      label: L('数据派', 'Data'),
      text: L(
        `12H 冲价赛点：A9 第 ${roundNum} 轮当前 ${passed}/${required} 段达标${rankTag}，目标底价 ${target}，奖池 ${pool}（全员 1:1 封顶 5x · 永不爆仓，未达标退 95%/90% 本金）。`,
        `12H Push Live: A9 Round #${roundNum} at ${passed}/${required} slots${rankTag}, target ${target}, pool ${pool} (1:1 up to 5x · no liquidation, 95%/90% refund on fail).`
      )
    },
    {
      key: 'bull',
      label: L('看多派', 'Bullish'),
      text: L(
        `12H 冲刺 8/12 通关线！A9 第 ${roundNum} 轮已拿下 ${passed}/${required} 段，头矿 6H 享 5% 轻止损，奖池 ${pool} 链上透明结算，实时盯盘！`,
        `Pushing for 8/12 slots! A9 Round #${roundNum} holds ${passed}/${required} slots with First 6H 5% Stop-Loss and ${pool} pool.`
      )
    },
    {
      key: 'casual',
      label: L('吃瓜自嘲派', 'Banter'),
      text: L(
        `12H 冲价，是冲关 8/12 分 7 亿还是自动止损烧半池？A9 第 ${roundNum} 轮目前 ${passed}/${required} 段拉满悬念，0 GRAM 免费进 12H 预言擂台先站队！`,
        `12H Push: pass 8/12 to split 700,000,000 A9 or trigger auto stop-loss? A9 Round #${roundNum} sits at ${passed}/${required} slots—pick a side for 0 GRAM in the 12H Prediction Arena.`
      )
    }
  ];
}

/**
 * 方案三：X 动态 OG 战报分享弹层（3 观点切角 + 自由编辑 + 复制 OG 短链）
 */
export function openXShareSheet({ type = 'round', id = '1', context = {} } = {}) {
  A9Haptic.light();
  const ogUrl = buildOgShareUrl(type, id);
  const angles = buildAngles(type, id, context);
  let activeKey = angles[0].key;

  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between">
      <div class="card-title">${icon('xBrand', 15, 'text-green')} ${L('分享到 X（带动态战报卡）', 'Share to X (Live OG Card)')}</div>
      <button class="icon-btn" id="x-share-close" aria-label="Close">${icon('x', 15)}</button>
    </div>
    <div class="num-xs text-muted">${L('选择观点切角，文案可自由编辑，发布时自动附带 1200×630 动态战报大图。', 'Pick an angle and edit freely. Attaches a live 1200x630 OG card automatically.')}</div>

    <div class="seg-tabs" id="x-angle-tabs">
      ${angles.map(a => `<button class="seg-tab ${a.key === activeKey ? 'active' : ''}" data-x-angle="${a.key}" type="button">${a.label}</button>`).join('')}
    </div>

    <textarea id="x-share-textarea" class="share-textarea" rows="4" aria-label="${L('编辑分享文案', 'Edit share copy')}"></textarea>

    <div class="sub-tile">
      <div class="num-xs text-muted" style="margin-bottom:3px;">${L('动态 OG 卡片短链', 'Dynamic OG Card URL')}</div>
      <div class="num-xs mono" style="word-break:break-all;color:var(--text-primary);">${escapeHtml(ogUrl)}</div>
    </div>

    <div class="col-gap" style="gap:10px;">
      <button class="btn btn-primary" id="x-share-post" type="button">${icon('xBrand', 15)} ${L('前往 X 发布', 'Post on X')}</button>
      <button class="btn btn-secondary" id="x-share-copy" type="button">${icon('copy', 15)} ${L('复制 OG 卡片链接', 'Copy OG Card Link')}</button>
    </div>
  `);

  const textarea = document.getElementById('x-share-textarea');
  if (textarea) textarea.value = angles[0].text;

  document.getElementById('x-share-close').onclick = closeModal;

  document.querySelectorAll('[data-x-angle]').forEach(btn => {
    btn.onclick = () => {
      A9Haptic.tick();
      activeKey = btn.dataset.xAngle;
      const found = angles.find(a => a.key === activeKey);
      document.querySelectorAll('[data-x-angle]').forEach(b => b.classList.toggle('active', b.dataset.xAngle === activeKey));
      if (textarea && found) textarea.value = found.text;
    };
  });

  document.getElementById('x-share-post').onclick = () => {
    A9Haptic.success();
    const text = (textarea?.value || angles[0].text).trim();
    const intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(ogUrl)}`;
    A9TMA.openExternalLink(intentUrl);
    closeModal();
  };

  document.getElementById('x-share-copy').onclick = () => {
    copyText(ogUrl, L('已复制 OG 卡片链接', 'Copied OG card link'));
  };
}

/**
 * 方案二：统一触发 TG Story 发布或安全降级闭环
 * - 当未显式传入 mediaUrl 且 apiOrigin 为公网 https:// 时，自动拼装 /c/img/:type/:id.png?ratio=9x16 真 PNG 竖图；
 * - 本地 http:// 或非 TG 环境自动走 9:16 Canvas PNG 下载 + 复制 startapp 深链降级闭环。
 */
export function triggerStoryShare({ canvas, type = 'round', id = '1', text = '', mediaUrl = null, filename = 'A9-Story-9x16.png' } = {}) {
  A9Haptic.light();
  const widgetLink = buildStartAppLink(type, id);
  const apiOrigin = config.apiBase || window.location.origin;
  const resolvedMediaUrl = mediaUrl || (apiOrigin.startsWith('https://')
    ? `${apiOrigin}/c/img/${encodeURIComponent(type)}/${encodeURIComponent(String(id ?? '1'))}.png?ratio=9x16`
    : null);
  const res = A9TMA.shareToStory({
    mediaUrl: resolvedMediaUrl,
    text,
    widgetLink,
    fallbackCanvas: canvas,
    filename
  });
  if (res.mode === 'native') {
    showToast(L('已调起 Telegram Story 编辑器', 'Opened Telegram Story editor'));
  } else {
    copyText(widgetLink, L('已保存 9:16 战报并复制专属链接，可在 Telegram Story 中直接添加链接贴纸发布', 'Saved 9:16 poster & copied link for Telegram Story sticker'));
  }
}
