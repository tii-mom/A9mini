/**
 * A9 Viral Growth Sharing Toolkit (Scheme 3 X Dynamic OG + Scheme 2 TG Story Helper)
 * - Zero Emoji, Zero guaranteed-return claims, full numbers only
 * - apiOrigin strictly falls back to window.location.origin when config.apiBase is empty
 */

import { config } from './config.js';
import { store } from './store.js';
import { getEffectiveUserId, serverNowMs, formatRoundA9 } from './data.js';
import { deriveRoundUiState } from './round-state.js';
import { A9TMA, A9Haptic } from './tma.js';
import { escapeHtml, formatNum, showToast, copyText, openModal, closeModal } from './components.js';
import { icon } from './icons.js';
import { L } from './i18n.js';
import { fmtUsdOrDash } from './quest/quest-ui.js';

export const TEAM_ID_PATTERN = /^(?:G|T|TM|TEAM)-[A-Za-z0-9-]{1,32}$/i;
export const LEGACY_TEAM_ID_PATTERN = /^[A-Za-z0-9-]{1,48}$/;

export function normalizeTeamId(raw) {
  return String(raw || '').trim().replace(/^#+/, '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);
}

export function isValidTeamId(raw) {
  return TEAM_ID_PATTERN.test(normalizeTeamId(raw));
}

export function isTestnetEnv() {
  const net = String(config.network || store.state.round?.protocolConfig?.network || '').trim().toLowerCase();
  return net === 'testnet';
}

export function getBotHandle() {
  const fromServer = store.state.round?.protocolConfig?.botHandle || store.state.round?.protocolConfig?.tgBotHandle;
  const fromGlobal = typeof window !== 'undefined' ? (window.__A9_CONFIG__?.botHandle || window.__A9_CONFIG__?.tgBotHandle) : '';
  const cleaned = String(fromServer || fromGlobal || '').trim().replace(/^@+/, '');
  if (isTestnetEnv()) {
    if (!cleaned || cleaned.toLowerCase() === 'a9_tonbot') return '';
    return cleaned;
  }
  return cleaned || 'A9_TonBot';
}

export function isBotHandleConfigured() {
  return Boolean(getBotHandle());
}

export function buildBotAddGroupUrl() {
  const bot = getBotHandle();
  if (!bot) return '';
  return `https://t.me/${bot}?startgroup=true`;
}

export function buildTeamInviteStartParam(teamId, userRef = getShareRef()) {
  const ref = String(userRef || '');
  if (ref && !/^[A-Za-z0-9_-]+$/.test(ref)) return '';
  const tid = normalizeTeamId(teamId);
  if (tid) {
    if (!TEAM_ID_PATTERN.test(tid)) return '';
    if (!ref) return `invite_${tid}`;
    const combined = `invite_${tid}_${ref}`;
    if (combined.length <= 64) return combined;
    const compact = `i_${tid}_${ref}`;
    return compact.length <= 64 ? compact : '';
  }
  if (!ref) return 'invite';
  return ref.length <= 57 ? `invite_${ref}` : '';
}

/** 生成标准 Telegram Mini App 深链：https://t.me/<bot>?startapp=<param> */
export function buildTmaDeepLink(startParam) {
  const safeParam = String(startParam || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const bot = getBotHandle();
  if (!bot) return '';
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
  const base = `${apiOrigin}/c/${encodeURIComponent(type === 'bet' ? 'round' : type)}/${encodeURIComponent(String(id ?? '1'))}`;
  return userRef ? `${base}?ref=${encodeURIComponent(userRef)}` : base;
}

/** Telegram startapp 归因深链（统一走 TMA 深链，不带 mode 参数） */
export function buildStartAppLink(type, id, userRef = getShareRef()) {
  if (type === 'invite') {
    const param = buildTeamInviteStartParam(id, userRef);
    return param ? buildTmaDeepLink(param) : '';
  }
  const safeType = String(type === 'bet' ? 'round' : type || 'round').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeId = String(id ?? '1').replace(/^A9-STAKE-/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeRef = String(userRef || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const candidate = safeRef ? `${safeType}_${safeId}_${safeRef}` : `${safeType}_${safeId}`;
  const param = candidate.length <= 64 ? candidate : `${safeType}_${safeId}`.slice(0, 64);
  return buildTmaDeepLink(param);
}

export function buildShareAngles(type, id, ctx = {}) {
  const r = store.state.round;
  const ui = deriveRoundUiState({ detail: r, user: store.state.user, serverNowMs: serverNowMs() });
  const demoPrefix = config.isDemo ? L('[演示模式] ', '[Demo] ') : '';
  const rawRound = ctx.roundId ?? r.currentRound;
  const roundNum = rawRound ? rawRound : L('待核验', 'TBD');
  const rawPassed = ctx.qualified ?? r.qualifiedCandles;
  const hasPassed = rawPassed !== null && rawPassed !== undefined && Number.isFinite(Number(rawPassed));
  const passed = hasPassed ? Number(rawPassed) : '—';
  const required = ctx.required ?? r.minQualifiedCandles ?? 8;
  const targetPrice = fmtUsdOrDash(r.targetPrice);
  const target = targetPrice === '—' ? L('待定', 'TBD') : targetPrice;
  const hasPool = r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9)) && Number(r.rewardBudgetA9) > 0;
  const pool = hasPool ? `${Number(r.rewardBudgetA9).toLocaleString('en-US', { maximumFractionDigits: 9 })} A9` : null;
  const poolClause = pool ? L(`，本轮奖池 ${pool}`, `, pool ${pool}`) : '';
  const phaseZh = ui.stage === 'stake'
    ? (ui.inFirst6h ? '头矿 6 小时 5% 止损锁仓开放中' : '24 小时普通锁仓期开放中（10% 止损）')
    : ui.stage === 'charge'
      ? `12 小时冲价推进中（12 段中已确认 ${passed} 段，门槛 ${required} 段）`
      : ui.stage === 'settling'
        ? '12 小时冲价已结束，等待链上结算'
        : ui.stage === 'passed'
          ? `已结算通关（${passed}/12 段）`
          : ui.stage === 'failed'
            ? `已按止损退本结算（${passed}/12 段）`
            : ui.stage === 'aborted'
              ? '本轮已异常中止，开放 100% 无损退本'
              : '轮次状态同步中';
  const phaseEn = ui.stage === 'stake'
    ? (ui.inFirst6h ? 'First 6H 5% stop-loss lock open' : '24H standard lock open (10% stop-loss)')
    : ui.stage === 'charge'
      ? `12H push live (${passed}/12 confirmed, threshold ${required})`
      : ui.stage === 'settling'
        ? '12H push ended, awaiting settlement'
        : ui.stage === 'passed'
          ? `Settled Passed (${passed}/12)`
          : ui.stage === 'failed'
            ? `Settled Stop-Loss (${passed}/12)`
            : ui.stage === 'aborted'
              ? 'Aborted, 100% principal refund open'
              : 'Syncing';
  const tagDemo = (arr) => demoPrefix ? arr.map((a) => ({ ...a, text: `${demoPrefix}${a.text}` })) : arr;

  if (type === 'proof') {
    const stakeTon = formatNum(ctx.stakeTon || 0);
    return tagDemo([
      {
        key: 'data',
        label: L('数据派', 'Data'),
        text: L(
          `A9 第 ${roundNum} 轮涨价解锁凭证 #${id} 已生成：锁仓 ${stakeTon} A9（全员 1:1 分奖 · 封顶 5x），当前${phaseZh}，目标底价 ${target}。`,
          `A9 Round #${roundNum} Price-Unlock Pass #${id}: ${stakeTon} A9 locked (1:1 split · 5x cap). Status: ${phaseEn}, target ${target}.`
        )
      },
      {
        key: 'bull',
        label: L('看多派', 'Bullish'),
        text: L(
          `已参与 A9 第 ${roundNum} 轮涨价解锁池${poolClause}（封顶 5x · 永不爆仓，头矿 6H 仅 5% 止损），当前${phaseZh}！`,
          `Joined A9 Round #${roundNum} Price-Unlock${poolClause} (5x cap, no liquidation, First 6H 5% Stop-Loss). Status: ${phaseEn}!`
        )
      },
      {
        key: 'casual',
        label: L('吃瓜自嘲派', 'Banter'),
        text: L(
          `把 ${stakeTon} A9 锁进了 A9 第 ${roundNum} 轮涨价解锁池，当前${phaseZh}，赢了按份额分奖，没过也退 95%/90% 本金。`,
          `Locked ${stakeTon} A9 into A9 Round #${roundNum}. ${phaseEn}—share the pool if passed, 95%/90% refunded if missed.`
        )
      }
    ]);
  }

  if (type === 'burn') {
    const missGap = Number.isFinite(Number(passed)) ? Math.max(1, Number(required) - Number(passed)) : null;
    const gapText = missGap !== null
      ? L(`就差 ${missGap} 根小时线通关`, `missed by just ${missGap} hourly slot(s)`)
      : L('未满 8/12 达标线', 'missed the 8/12 line');
    const nextPoolZh = pool ? `下轮 ${pool} 奖池即将重开，` : '下轮即将重开，';
    const nextPoolEn = pool ? `Next ${pool} pool opens soon.` : 'Next round opens soon.';
    return tagDemo([
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
          `真通缩不嘴炮：A9 第 ${roundNum} 轮未通关触发自动止损，头矿 6H 退 95% / 普通退 90%，半数奖池链上永久通缩！${nextPoolZh}链上规则铁面无私。`,
          `Real on-chain deflation: A9 Round #${roundNum} triggered Auto Stop-Loss (95% First 6H / 90% refund) + half-pool permanent burn. ${nextPoolEn}`
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
    ]);
  }

  if (type === 'chest') {
    const label = ctx.label || L('宝箱', 'Chest');
    const isBoost = ctx.source === 'SHOP_BOOST';
    const receipt = ctx.receipt;
    const order = ctx.order;
    const paidOrder = ctx.orderId && order?.orderId === ctx.orderId && order.status === 'COMPLETED';
    const openReceipt = receipt?.chest?.chestId === id && receipt?.chest?.status === 'OPENED';
    const walletPayout = paidOrder || (openReceipt && ['WALLET', 'DIRECT_WALLET'].includes(receipt.destination));
    const raw = paidOrder ? order.totalA9Raw : openReceipt ? receipt.rewardA9Raw : null;
    const hasAmount = typeof raw === 'string' && /^\d+$/.test(raw);
    let message = L(`来看看 A9 的【${label}】。`, `Explore [${label}] in A9.`);
    if (hasAmount && walletPayout) {
      message = L(`【${label}】已到账 ${formatRoundA9(raw)}。`, `[${label}] paid ${formatRoundA9(raw)} to my wallet.`);
    } else if (hasAmount && openReceipt && receipt.destination === 'PROMO_BALANCE') {
      message = L(`【${label}】奖励 ${formatRoundA9(raw)} 已记入待领取余额。`, `[${label}] added ${formatRoundA9(raw)} to my claimable balance.`);
    }
    if (hasAmount && openReceipt && !paidOrder && receipt.destination === 'PENDING_VAULT') {
      message = L(`【${label}】奖励 ${formatRoundA9(raw)} 已记入金库，待解锁。`, `[${label}] added ${formatRoundA9(raw)} to my vault, pending unlock.`);
    }
    return tagDemo([
      {
        key: 'gift',
        label: L('分享宝箱', 'Share Chest'),
        text: message,
      },
      {
        key: 'banter',
        label: L('本轮动态', 'Stage Update'),
        text: L(`第 ${roundNum} 轮 · ${phaseZh}。${message}`, `Round ${roundNum} · ${phaseEn}. ${message}`),
      },
      {
        key: 'data',
        label: L('链上规则透明', 'Transparent'),
        text: isBoost
          ? L(
              `A9 宝箱商城透明规则：6 档纯区间随机开箱，保底 + 随机加赠（最高 +275,000 A9）合并一笔直发钱包，只收一次 0.06 GRAM Gas，规则公开可查。`,
              `A9 Chest Mall rules: 6 random-range tiers sending base + random bonus (up to +275,000 A9) directly to your wallet in one tx (0.06 GRAM gas once), transparent on-chain.`
            )
          : L(
              `A9 协议双向开箱礼：仅需连接链上活跃 TON 钱包校验（0 扣款、防女巫公开可查），同行推进【${label}】并立得可秒开的 200 A9 青铜新手箱。`,
              `A9 Protocol Co-Op Gift: active TON wallet check (0 transfer, transparent anti-sybil) advances [${label}] and unlocks an instant 200 A9 Bronze Starter Chest.`
            )
      }
    ]);
  }

  // Default: 'round' / 'invite'
  return tagDemo([
    {
      key: 'data',
      label: L('数据派', 'Data'),
      text: L(
        `A9 第 ${roundNum} 轮实时进度：${phaseZh}，目标底价 ${target}${poolClause}（全员 1:1 封顶 5x · 永不爆仓，未达标退 95%/90% 本金）。`,
        `A9 Round #${roundNum} status: ${phaseEn}, target ${target}${poolClause} (1:1 up to 5x · no liquidation, 95%/90% refund on miss).`
      )
    },
    {
      key: 'bull',
      label: L('看多派', 'Bullish'),
      text: L(
        `A9 第 ${roundNum} 轮（${phaseZh}）${poolClause}，头矿 6H 享 5% 轻止损，链上透明结算！`,
        `A9 Round #${roundNum} (${phaseEn})${poolClause}, First 6H 5% stop-loss, transparent on-chain settlement!`
      )
    },
    {
      key: 'casual',
      label: L('吃瓜自嘲派', 'Banter'),
      text: L(
        `A9 第 ${roundNum} 轮（${phaseZh}）${poolClause}：达标 ≥ 8/12 分奖，未达标自动止损退本。`,
        `A9 Round #${roundNum} (${phaseEn})${poolClause}: pass ≥ 8/12 to split the pool or auto stop-loss refund.`
      )
    }
  ]);
}

/**
 * 方案三：X 动态 OG 战报分享弹层（3 观点切角 + 自由编辑 + 复制 OG 短链）
 */
export function openXShareSheet({ type = 'round', id = '1', context = {} } = {}) {
  A9Haptic.light();
  const ogUrl = buildOgShareUrl(type, id);
  const angles = buildShareAngles(type, id, context);
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

  const closeBtn = document.getElementById('x-share-close');
  if (closeBtn) closeBtn.onclick = closeModal;

  document.querySelectorAll('[data-x-angle]').forEach(btn => {
    btn.onclick = () => {
      A9Haptic.tick();
      activeKey = btn.dataset.xAngle;
      const found = angles.find(a => a.key === activeKey);
      document.querySelectorAll('[data-x-angle]').forEach(b => b.classList.toggle('active', b.dataset.xAngle === activeKey));
      if (textarea && found) textarea.value = found.text;
    };
  });

  const postBtn = document.getElementById('x-share-post');
  if (postBtn) {
    postBtn.onclick = () => {
      A9Haptic.success();
      const text = (textarea?.value || angles[0].text).trim();
      const intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(ogUrl)}`;
      A9TMA.openExternalLink(intentUrl);
      closeModal();
    };
  }

  const copyBtn = document.getElementById('x-share-copy');
  if (copyBtn) {
    copyBtn.onclick = () => {
      copyText(ogUrl, L('已复制 OG 卡片链接', 'Copied OG card link'));
    };
  }
}

/**
 * 方案二：统一触发 TG Story 发布或安全降级闭环
 * - 当未显式传入 mediaUrl 且 apiOrigin 为公网 https:// 时，自动拼装 /c/img/:type/:id.png?ratio=9x16 真 PNG 竖图；
 * - 本地 http:// 或非 TG 环境自动走 9:16 Canvas PNG 下载 + 复制 startapp 深链降级闭环。
 */
export function triggerStoryShare({ canvas, type = 'round', id = '1', text = '', mediaUrl = null, filename = 'A9-Story-9x16.png' } = {}) {
  A9Haptic.light();
  const widgetLink = buildStartAppLink(type, id);
  if (!widgetLink) {
    showToast(L('当前环境未配置官方 Bot 句柄，暂无法生成 Telegram Story 深链', 'Bot handle is not configured for this environment; Story link unavailable'), 'amber');
    return;
  }
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
