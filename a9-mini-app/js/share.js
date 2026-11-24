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
  return String(fromServer || fromGlobal || 'A9ProtocolBot').replace(/^@+/, '');
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
  const required = ctx.required ?? r.minQualifiedCandles ?? 16;
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
          `A9 第 ${roundNum} 轮链上闯关凭证 #${id} 已生成：质押 ${stakeTon} A9，早鸟权重 ${mult}x，当前 24H 达标时段 ${passed}/${required}，目标底价 ${target}。`,
          `A9 Round #${roundNum} Proof #${id}: ${stakeTon} A9 staked at ${mult}x early weight. 24H slots ${passed}/${required}, target ${target}.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `已锁定 A9 第 ${roundNum} 轮 ${mult}x 早鸟权重，本轮奖池 ${pool}，24H 观察窗口正在推进中，凭链上闯关凭证看最终结算。`,
          `Locked ${mult}x early weight in A9 Round #${roundNum} (${pool} pool). Watching the 24H slot matrix unfold on-chain.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `把 ${stakeTon} A9 押进了 A9 第 ${roundNum} 轮 24H 赛点，目前 ${passed}/${required} 段达标，是吃肉还是看烟花就看接下来几小时了。`,
          `Put ${stakeTon} A9 into A9 Round #${roundNum}. Currently ${passed}/${required} slots qualified—either settlement or fireworks next.`
        )
      }
    ];
  }

  if (type === 'burn') {
    const missGap = Number.isFinite(Number(passed)) ? Math.max(1, Number(required) - Number(passed)) : null;
    const gapText = missGap !== null
      ? L(`就差 ${missGap} 根小时线过关`, `missed by just ${missGap} hourly slot(s)`)
      : L('未满 16/24 达标线', 'missed the 16/24 line');
    return [
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `A9 第 ${roundNum} 轮 ${gapText}（定格 ${passed}/${required} 段）——合约已链上执行 100% 销毁 BURN，Tx 全网可查。见证销毁并分享，解锁下轮 A9 兑换屋优先通道。`,
          `A9 Round #${roundNum} ${gapText} (${passed}/${required} slots)—100% on-chain BURN executed per v15 contract. Share to unlock next-round A9 Exchange priority.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `真烧币不嘴炮：A9 第 ${roundNum} 轮未达标，合约直接链上永久销毁 BURN，半数奖池通缩减量！下轮 ${pool} 奖池即将重开，链上规则铁面无私。`,
          `Zero talk, real on-chain BURN: A9 Round #${roundNum} executed permanent contract burn. Next ${pool} pool resets soon—100% on-chain rules.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `现场目击 A9 第 ${roundNum} 轮烟花秀：24 小时最终 ${passed}/${required} 段，${gapText}原地执行销毁 BURN。先领下轮 A9 兑换屋额度，下局再战。`,
          `Witnessed A9 Round #${roundNum} fireworks: ended at ${passed}/${required} slots (${gapText}) and triggered on-chain BURN. Grabbing next-round A9 Exchange quota.`
        )
      }
    ];
  }

  if (type === 'chest') {
    const label = ctx.label || L('青铜宝箱 #1', 'Bronze Chest #1');
    const isBoost = ctx.source === 'SHOP_BOOST';
    const need = Math.max(0, Number(ctx.requiredAssists || 2) - Number(ctx.currentAssists || 0));
    const rewardText = ctx.rewardText || '300 A9';
    return [
      {
        key: 'gift',
        label: L('顺手送福利', 'Free Gift'),
        text: isBoost
          ? L(
              `我在 A9 宝箱商城刚开了一个【${label}】，帮我点一下连接钱包助力膨胀（还差 ${need} 人），你顺手也能 0 成本领 1 个青铜宝箱 #1！`,
              `I just opened a [${label}] in A9 Chest Mall! Connect your TON wallet to boost it (${need} left) and auto-claim your free Bronze Chest #1.`
            )
          : L(
              `TON 上发现个 0 成本宝箱玩法：帮我点一下开启【${label}】（${rewardText}，还差 ${need} 人助力），你点完直接顺手白领 1 个青铜宝箱 #1！`,
              `Free TON chest drop: help me open [${label}] (${rewardText}, ${need} assist(s) left) and auto-claim your own Bronze Chest #1.`
            )
      },
      {
        key: 'banter',
        label: L('群聊互动型', 'Group Banter'),
        text: isBoost
          ? L(
              `兄弟们救个场！我的 A9【${label}】正在 24H 膨胀中，点一下帮我拉满额外 A9 暴涨，顺手白拿你的专属青铜宝箱，不花一分钱！`,
              `Need a quick hand! My A9 [${label}] is in a 24H boost window—tap to help inflate the bonus and grab your free Bronze Chest.`
            )
          : L(
              `谁有空顺手点一下？差 ${need} 个活跃 TON 钱包帮我开 A9【${label}】，点完系统直接送你 1 个同款青铜宝箱！`,
              `Anyone with an active TON wallet? Need ${need} more assist(s) on my A9 [${label}]—you get a free Bronze Chest #1 right after.`
            )
      },
      {
        key: 'data',
        label: L('规则透明型', 'Transparent'),
        text: L(
          `A9 协议宝箱助力：需连接链上活跃 TON 钱包助力（防刷且 0 扣款），帮我推进【${label}】进度并自动领取青铜宝箱 #1。`,
          `A9 Protocol Chest Assist: connect an active TON wallet (0 transfer, anti-sybil verified) to help [${label}] and unlock Bronze Chest #1.`
        )
      }
    ];
  }

  if (type === 'bet') {
    const sideLabel = ctx.side === 'BURN' ? L('销毁空军 BURN', 'BURN') : L('通关多军 PASS', 'PASS');
    const slotNote = (ctx.guessSlots !== null && ctx.guessSlots !== undefined)
      ? L(`，精准卡位 ${ctx.guessSlots}/24 段`, `, exact call ${ctx.guessSlots}/24`)
      : '';
    return [
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `24 小时，达标派奖还是 100% 销毁 BURN？我在 A9 第 ${roundNum} 轮 24H 预言擂台押了【${sideLabel}】${slotNote}${rankTag}。当前 ${passed}/${required} 段，目标底价 ${target}。`,
          `24H verdict—pass or 100% BURN? I locked [${sideLabel}]${slotNote}${rankTag} in A9 Round #${roundNum} 24H Prediction Arena (${passed}/${required} slots, target ${target}).`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `0 GRAM 免费上车 A9 第 ${roundNum} 轮 24H 预言擂台！我已锁定【${sideLabel}】${slotNote}，新人首轮参与即保底 500 A9 待解锁体验金，敢不敢来对赌判断？`,
          `0 GRAM free entry in A9 Round #${roundNum} 24H Prediction Arena! Locked [${sideLabel}]${slotNote}. First-round rookies get a 500 A9 vault floor—come test your call.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `一分钱不花先站个队：A9 第 ${roundNum} 轮我选【${sideLabel}】${slotNote}。现在 ${passed}/${required} 段，猜对瓜分奖池、首轮猜错也保底 500 A9，白嫖看戏不亏。`,
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
        `24 小时生死线：A9 第 ${roundNum} 轮当前 ${passed}/${required} 段达标${rankTag}，目标底价 ${target}，奖池 ${pool}（上限 15x 或未达标 100% 销毁 BURN，链上规则公开可查）。`,
        `24H line in the sand: A9 Round #${roundNum} at ${passed}/${required} slots${rankTag}, target ${target}, pool ${pool} (up to 15x cap or 100% on-chain BURN).`
      )
    },
    {
      key: 'bull',
      label: L('看多派', 'Bullish'),
      text: L(
        `24 小时冲刺 16/24 达标线！A9 第 ${roundNum} 轮已拿下 ${passed}/${required} 段，早鸟权重最高 2.0x，奖池 ${pool} 链上透明结算，实时盯盘。`,
        `Sprinting for 16/24 slots! A9 Round #${roundNum} holds ${passed}/${required} qualified slots with up to 2.0x early weight and ${pool} pool.`
      )
    },
    {
      key: 'casual',
      label: L('吃瓜自嘲派', 'Banter'),
      text: L(
        `24 小时，是冲关吃肉还是原地销毁 BURN？A9 第 ${roundNum} 轮目前 ${passed}/${required} 段拉满悬念，0 GRAM 免费进 24H 预言擂台先站队！`,
        `24 hours: pass for payout or trigger on-chain BURN? A9 Round #${roundNum} sits at ${passed}/${required} slots—pick a side for 0 GRAM in the Prediction Arena.`
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
