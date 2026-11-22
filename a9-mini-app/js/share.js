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
          `A9 第 ${roundNum} 轮链上质押凭证 #${id} 已生成：参与 ${stakeTon} TON，早鸟权重 ${mult}x，当前 24H 达标时段 ${passed}/${required}，目标底价 ${target}。`,
          `A9 Round #${roundNum} Proof #${id}: ${stakeTon} TON staked at ${mult}x early weight. 24H slots ${passed}/${required}, target ${target}.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `已锁定 A9 第 ${roundNum} 轮 ${mult}x 早鸟权重，本轮奖池 ${pool}，24H 观察窗口正在推进中，凭链上质押凭证看最终结算。`,
          `Locked ${mult}x early weight in A9 Round #${roundNum} (${pool} pool). Watching the 24H slot matrix unfold on-chain.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `把 ${stakeTon} TON 押进了 A9 第 ${roundNum} 轮 24H 赛点，目前 ${passed}/${required} 段达标，是吃肉还是看烟花就看接下来几小时了。`,
          `Put ${stakeTon} TON into A9 Round #${roundNum}. Currently ${passed}/${required} slots qualified—either settlement or fireworks next.`
        )
      }
    ];
  }

  if (type === 'burn') {
    return [
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `A9 第 ${roundNum} 轮 24H 观察结束：达标时段 ${passed}/${required}，按 v15 规则执行销毁。见证销毁并分享，下轮内盘享优先通道与额度加成。`,
          `A9 Round #${roundNum} closed at ${passed}/${required} qualified slots and burned per v15 rules. Share for next-round presale priority & quota boost.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `A9 第 ${roundNum} 轮严格按合约执行销毁，通缩逻辑说到做到。见证销毁并分享，下轮 ${pool} 奖池内盘享优先通道与额度加成。`,
          `A9 Round #${roundNum} executed on-chain burn strictly by contract rules. Witness & share for next-round presale priority and quota boost.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `打卡 A9 第 ${roundNum} 轮销毁纪念碑：24H 最终定格 ${passed}/${required} 段，顺手领下轮内盘优先通道与额度加成。`,
          `Checking in at the A9 Round #${roundNum} Burn Monument (${passed}/${required} slots)—grabbing next-round presale priority & quota boost.`
        )
      }
    ];
  }

  if (type === 'bet') {
    const sideLabel = ctx.side === 'BURN' ? L('押销毁 BURN', 'BURN') : L('押达标 PASS', 'PASS');
    const slotNote = (ctx.guessSlots !== null && ctx.guessSlots !== undefined)
      ? L(`，精准预测 ${ctx.guessSlots} 段`, `, exact guess ${ctx.guessSlots} slots`)
      : '';
    return [
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `我在 A9 第 ${roundNum} 轮 24H 生死预言局立下立场：${sideLabel}${slotNote}${rankTag}。当前已达标 ${passed}/${required} 段，目标底价 ${target}，来站队吗？`,
          `My call on A9 Round #${roundNum} 24H Prediction: ${sideLabel}${slotNote}${rankTag}. Live progress ${passed}/${required} slots, target ${target}.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `0 TON 也能参战 A9 第 ${roundNum} 轮 24H 生死预言！我已锁定 ${sideLabel}${slotNote}，本轮奖池 ${pool}，看看谁的判断更准。`,
          `0 TON entry for A9 Round #${roundNum} 24H Prediction. Locked ${sideLabel}${slotNote}—let us see whose read holds up.`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `不花钱先下个判断：A9 第 ${roundNum} 轮我选 ${sideLabel}${slotNote}。现在 ${passed}/${required} 段，欢迎来反向对冲打我脸。`,
          `Zero-cost call on A9 Round #${roundNum}: ${sideLabel}${slotNote}. Currently ${passed}/${required} slots—come counter-bet me.`
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
        `A9 第 ${roundNum} 轮 24H 赛点实况${rankTag}：已达标 ${passed}/${required} 段，目标底价 ${target}，本轮用户奖励池 ${pool}。`,
        `A9 Round #${roundNum} 24H Match Point${rankTag}: ${passed}/${required} qualified slots, target ${target}, pool ${pool}.`
      )
    },
    {
      key: 'bull',
      label: L('看多派', 'Bullish'),
      text: L(
        `A9 第 ${roundNum} 轮正在冲刺 16/24 达标线（当前 ${passed}/${required} 段），早鸟权重最高 2.0x，实时盯盘中。`,
        `A9 Round #${roundNum} pushing toward 16/24 qualified slots (${passed}/${required} now). Watching the 24H corridor live.`
      )
    },
    {
      key: 'casual',
      label: L('吃瓜自嘲派', 'Banter'),
      text: L(
        `A9 第 ${roundNum} 轮 24H 赛点拉满悬念：目前 ${passed}/${required} 段，到底是顺利达标还是原地销毁？0 TON 可以先来预言站队。`,
        `Peak suspense in A9 Round #${roundNum} (${passed}/${required} slots). Pass or burn? Zero-TON prediction is open.`
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
