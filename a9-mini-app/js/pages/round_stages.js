import { tower } from './wealthverse.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { formatNum, formatTimer, renderCorridorRadar, renderViralStrip, renderLiveSparkline } from '../components.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { estimateRewardA9, rawToA9, getEffectiveUserId } from '../data.js';

function stagePillTrigger(stage, roundNum) {
  const labels = {
    warmup: L(`第 ${roundNum} 轮 · 预热阶段`, `Round ${roundNum} · Warm-Up`),
    participation: L(`第 ${roundNum} 轮 · 参与阶段`, `Round ${roundNum} · Entry`),
    observation: L(`第 ${roundNum} 轮 · 观察阶段`, `Round ${roundNum} · Observing`),
    settlement_success: L(`第 ${roundNum} 轮 · 结算达标`, `Round ${roundNum} · Passed`),
    settlement_burn: L(`第 ${roundNum} 轮 · 未达标`, `Round ${roundNum} · Missed`),
    halted: L(`第 ${roundNum} 轮 · 技术中止`, `Round ${roundNum} · Halted`)
  };
  const text = labels[stage] || labels.participation;
  if (!config.isDemo) return `<span class="pill-trigger neutral">${text}</span>`;
  return `<button class="pill-trigger" id="btn-stage-sheet" type="button">${text} ${icon('chevronDown', 12)}</button>`;
}

/** 展示口径：目标价未锁定 / 价格无效时不得显示 0 或伪造数值。 */
function priceOrDash(v) {
  return (v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0) ? '—' : `$${Number(v).toFixed(4)}`;
}

/**
 * 方案一：24H 生死预言局嵌入式卡片（0 TON 参战 + 防薅激活闭环）
 * - 未质押用户默认展开操作区；已质押用户默认折叠为紧凑单行状态条（点击可展开）
 * - 完整覆盖 4 种状态：未下注 / 已下注锁定 / 已结算 / 待激活补贴
 */
export function renderPredictionCard(round, pred, user) {
  if (!config.isDemo && (!pred?.loaded || pred.roundId !== round.currentRound)) {
    return `<div class="card" id="a9-prediction-card"><h3>${L('24 小时预言','24H prediction')}</h3><p>${L('正在读取预言数据','Reading prediction data')}</p></div>`;
  }
  const p = pred || {};
  const roundNum = round?.currentRound || 1;
  const hasStaked = Number(round?.myStakeTon) > 0 || store.state.certificates.some(c => Number(c.round) === Number(roundNum));
  const isExpanded = p.expanded !== null && p.expanded !== undefined ? Boolean(p.expanded) : !hasStaked;
  const passPct = Number.isFinite(Number(p.passPct)) ? Number(p.passPct) : 50;
  const burnPct = Number.isFinite(Number(p.burnPct)) ? Number(p.burnPct) : 50;
  const total = Number(p.total) || 0;
  const bet = p.currentBet || null;
  const settled = Boolean(p.settled || round?.stage === 'settlement_success' || round?.stage === 'settlement_burn');
  const winningSide = p.winningSide || (round?.stage === 'settlement_success' ? 'PASS' : round?.stage === 'settlement_burn' ? 'BURN' : null);
  const pendingA9 = rawToA9(p.pendingActivationRaw) || 0;
  const effectiveUid = getEffectiveUserId(user);
  const needsIdentity = !effectiveUid;

  // 1. Live USD valuation (strictly hidden when price invalid or <= 0; NEVER show $0.00)
  const refPrice = (round?.priceValid !== false) ? Number(round?.livePrice || round?.twap24h || 0) : 0;
  const usdEst = (pendingA9 > 0 && refPrice > 0) ? pendingA9 * refPrice : null;
  const expAt = Number(p.pendingExpiresAt);
  const expRemSec = (Number.isFinite(expAt) && expAt > Date.now()) ? Math.floor((expAt - Date.now()) / 1000) : null;

  // 2. Prediction weight leverage (base 1.0x + exact slots +0.5x + 0.1x/invite, cap 2.0x)
  const inviteCnt = Math.max(0, Number(p.inviteBoostCount) || 0);
  const inviteBonus = Math.min(0.5, inviteCnt * 0.1);
  const hasExactSlot = bet && bet.guessSlots !== null && bet.guessSlots !== undefined;
  const curWeight = Math.min(2.0, 1.0 + (hasExactSlot ? 0.5 : 0) + inviteBonus);
  const streak = Number(p.streak) || 0;
  const winRate = p.winRate !== null && p.winRate !== undefined && Number.isFinite(Number(p.winRate)) ? Number(p.winRate) : null;
  const rankMeta = streak >= 2
    ? `${L(`${streak} 连胜`, `${streak}W`)}${winRate !== null ? ` · ${L(`胜率 ${winRate}%`, `${winRate}% WR`)}` : ''}`
    : (winRate !== null ? L(`预言胜率 ${winRate}%`, `${winRate}% WR`) : '');

  const weightHintHtml = `
    <div class="row-between num-xs" style="margin-top:8px;padding:7px 10px;border-radius:10px;background:var(--bg-subtile);border:1px solid var(--border-subtle);">
      <span class="text-sec">${L('分配权重', 'Weight')} <b id="pred-cur-weight" class="mono text-green">${curWeight.toFixed(1)}x</b>${rankMeta ? ` <span class="text-muted">· ${rankMeta}</span>` : ''}</span>
      <span class="text-muted">${L('邀友 +0.1x · 顶 2.0x', '+0.1x/inv · 2.0x cap')}</span>
    </div>
  `;

  // 3. Single high-signal header tag (zero sticker pile-up)
  const isSprint4h = round?.stage === 'observation' && Number(round?.countdownSec) > 0 && Number(round?.countdownSec) <= 14400;
  const headerTag = isSprint4h
    ? `<span class="chip chip-red">${L('最后 4H 冲刺', 'Last 4H')}</span>`
    : settled
      ? `<span class="chip chip-muted">${L('已结算', 'Settled')}</span>`
      : bet
        ? `<span class="chip ${bet.side === 'BURN' ? 'chip-red' : 'chip-green'}">${bet.side === 'BURN' ? L('已押 BURN', 'BURN') : L('已押 PASS', 'PASS')}</span>`
        : `<span class="chip chip-green">${L('0 GRAM 参战', '0 GRAM')}</span>`;

  const pendingBlock = pendingA9 > 0 ? `
    <div class="sub-tile" style="border-color:var(--green-border);margin-top:12px;">
      <div class="row-between" style="margin-bottom:4px;">
        <span class="num-xs text-green" style="font-weight:700;">${L('预言胜者加成券', 'Winner Voucher')}</span>
        <span class="num-md text-green mono">${formatNum(pendingA9)} A9${usdEst !== null ? ` <span class="num-xs text-sec">(${L('约', '~')} $${formatNum(usdEst, 2)})</span>` : ''}</span>
      </div>
      <div class="num-xs text-muted" style="margin-bottom:6px;">${expRemSec !== null ? `<span id="pred-exp-cd" class="mono text-red">${L('距过期', 'Expires')} ${formatTimer(expRemSec)}</span>` : L('2 轮内未激活将自动过期回流奖池', 'Expires after 2 rounds if unactivated')}</div>
      <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:10px;">${L('完成 1 笔内盘买币（5 GRAM 起）或链上质押即可激活，走 0.06 GRAM 提现。', 'Complete 1 presale buy (5 GRAM+) or on-chain stake to activate via 0.06 GRAM.')}</div>
      <div class="col-gap" style="gap:8px;">
        <button class="btn btn-primary btn-sm" id="btn-pred-activate" type="button" style="width:100%;min-height:40px;">${icon('bolt', 14)} ${L('立即激活奖励', 'Activate Reward')}</button>
        <div class="grid-2">
          <button class="btn btn-secondary btn-sm" data-nav="/internal/market" type="button" style="width:100%;">${icon('swap', 13)} ${L('去内盘 (5 GRAM 起)', 'Presale (5 GRAM+)')}</button>
          <button class="btn btn-secondary btn-sm" data-nav="/challenge/confirm" type="button" style="width:100%;">${icon('shieldCheck', 13)} ${L('链上质押', 'Stake')}</button>
        </div>
      </div>
    </div>
  ` : '';

  let bodyHtml = '';
  if (settled) {
    const won = bet && winningSide && bet.side === winningSide;
    const outcomeText = winningSide === 'BURN' ? L('本轮结果：销毁 (BURN)', 'Outcome: BURN') : L('本轮结果：达标 (PASS)', 'Outcome: PASS');
    bodyHtml = `
      <div class="sub-tile" style="margin-top:12px;">
        <div class="row-between">
          <span class="num-sm" style="font-weight:700;">${outcomeText}</span>
          ${bet ? `<span class="chip ${won ? 'chip-green' : 'chip-red'}">${won ? L('预言命中', 'Won') : L('未命中', 'Missed')}</span>` : `<span class="chip chip-muted">${L('未参战', 'No Entry')}</span>`}
        </div>
        ${bet ? `<div class="num-xs text-sec" style="margin-top:6px;">${L('我的立场', 'My Call')}: <b>${bet.side === 'BURN' ? 'BURN' : 'PASS'}</b>${bet.guessSlots !== null && bet.guessSlots !== undefined ? ` · ${L(`精准 ${bet.guessSlots} 段`, `${bet.guessSlots} slots`)}` : ''}</div>` : ''}
      </div>
    `;
  } else if (bet) {
    bodyHtml = `
      <div class="sub-tile" style="margin-top:12px;border-color:${bet.side === 'BURN' ? 'var(--red-border)' : 'var(--emerald-border)'};">
        <div class="row-between">
          <div class="num-sm" style="font-weight:700;">
            <span class="${bet.side === 'BURN' ? 'text-red' : 'text-green'}">${bet.side === 'BURN' ? L('已押销毁 BURN', 'BURN') : L('已押达标 PASS', 'PASS')}</span>
            ${bet.guessSlots !== null && bet.guessSlots !== undefined ? `<span class="text-sec"> · ${L(`精准 ${bet.guessSlots}/24`, `${bet.guessSlots}/24`)}</span>` : ''}
          </div>
          <span class="num-xs text-muted">${icon('lock', 11)} ${L('每轮限 1 次', 'Locked')}</span>
        </div>
        ${weightHintHtml}
        <div class="grid-2" style="margin-top:10px;">
          <button class="btn btn-primary btn-sm" id="btn-pred-tg-share" type="button" style="width:100%;min-height:40px;">${icon('send', 13)} ${L('甩进 TG 群约战', 'Challenge TG')}</button>
          <button class="btn btn-secondary btn-sm" id="btn-pred-x-share" type="button" style="width:100%;min-height:40px;">${icon('xBrand', 13)} ${L('发 X 晒立场', 'Post on X')}</button>
        </div>
      </div>
    `;
  } else if (needsIdentity) {
    bodyHtml = `
      <div class="sub-tile" style="margin-top:12px;border-color:var(--gold-border);">
        <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:10px;">${L('请在 Telegram 内打开或先连接 TON 钱包，即可 0 GRAM 参战 24H 生死预言局。', 'Open in Telegram or connect a TON wallet to join the 0 GRAM prediction.')}</div>
        <button class="btn btn-primary btn-sm" id="btn-pred-connect" type="button" style="width:100%;min-height:40px;">${icon('wallet', 14)} ${L('连接 TON 钱包参战', 'Connect Wallet')}</button>
      </div>
    `;
  } else {
    bodyHtml = `
      <div class="grid-2" style="margin-top:12px;">
        <button class="pred-side-btn pass" data-pred-side="PASS" type="button">${icon('checkCircle', 15)} ${L('押达标 PASS', 'Bet PASS')}</button>
        <button class="pred-side-btn burn" data-pred-side="BURN" type="button">${icon('flame', 15)} ${L('押销毁 BURN', 'Bet BURN')}</button>
      </div>
      <div class="row-between" style="margin-top:10px;">
        <div>
          <div class="num-xs" style="font-weight:600;">${L('精准格数（选填 0–24）', 'Exact Slots (0-24)')}</div>
          <div class="num-xs text-muted">${L('猜中达标时段数享 +0.5x 权重', 'Exact match adds +0.5x weight')}</div>
        </div>
        <input id="pred-guess-slots" class="pred-slot-input" type="number" min="0" max="24" placeholder="0-24" aria-label="${L('精准达标格数', 'Exact qualified slots')}" />
      </div>
      ${weightHintHtml}
      <button class="btn btn-primary" id="btn-pred-submit" type="button" style="margin-top:12px;min-height:46px;">${icon('bolt', 15)} ${L('0 GRAM 锁定本轮预言', 'Lock 0 GRAM Prediction')}</button>
    `;
  }

  return `
    <div class="card" id="a9-prediction-card">
      <div class="pred-card-head" id="pred-toggle-head" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="row-start" style="gap:8px;">
          <span class="card-title">${icon('radar', 15, 'text-green')} ${L('24H 预言星盘', '24H prediction')}</span>
          ${headerTag}
        </div>
        <div class="row-start num-xs text-muted">
          ${!isExpanded ? `<span class="mono">${passPct}% / ${burnPct}%</span>` : ''}
          ${icon(isExpanded ? 'chevronDown' : 'chevronRight', 14)}
        </div>
      </div>
      <div class="pred-expand-wrap ${isExpanded ? 'open' : ''}">
        <div class="pred-expand-inner">
          <div style="margin-top:12px;">
            <div class="row-between num-xs" style="margin-bottom:6px;">
              <span style="color:var(--emerald);font-weight:600;">${L('押达标 PASS', 'PASS')} ${passPct}%</span>
              <span class="text-muted mono">${L(`共 ${formatNum(total)} 人参战`, `${formatNum(total)} entries`)}</span>
              <span class="text-red" style="font-weight:600;">${L('押销毁 BURN', 'BURN')} ${burnPct}%</span>
            </div>
            <div class="pred-split-bar">
              <div class="pred-split-pass" style="width:${passPct}%;"></div>
              <div class="pred-split-burn" style="width:${burnPct}%;"></div>
            </div>
            ${bodyHtml}
            ${pendingBlock}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderWarmupStage(round, user) {
  return `
    <div class="card card-hero">
      <div class="row-between" style="margin-bottom:14px;">
        ${stagePillTrigger('warmup', round.currentRound)}
        <span class="row-start num-sm text-sec">${icon('clock', 13)} <span id="early-cd" class="mono">${round.earlyBirdSec === null ? '—' : formatTimer(round.earlyBirdSec)}</span></span>
      </div>
      <div class="num-xs text-muted">${L('本轮预热奖励池', 'Warm-Up Pool')}</div>
      <div class="num-hero" style="margin-top:4px;">8,000,000 <span class="num-md text-green">A9</span></div>
      <div class="metric-strip cols-3">
        <div class="metric-cell"><span class="num-xs text-muted">${L('预热总额度', 'Total Budget')}</span><span class="num-sm">80,000,000 A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('我的直邀', 'Invites')}</span><span class="num-sm text-gold">${user.warmupInvites}</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('有效邀请门槛', 'Min Invites')}</span><span class="num-sm">20</span></div>
      </div>
      <button class="btn btn-primary" data-nav="/warmup">${icon('flame', 16)} ${user.warmupRegistered ? L('已报名 · 去预热榜', 'Joined · View Board') : L('立即预热报名 (免费)', 'Join Warm-Up Free')}</button>
    </div>

    <div class="grid-4">
      <button class="cmd-tile" data-nav="/warmup/rank"><span class="icon-badge amber">${icon('trophy', 16)}</span><span>${L('预热榜', 'Board')}</span></button>
      <button class="cmd-tile" data-nav="/internal/market"><span class="icon-badge sky">${icon('swap', 16)}</span><span>${L('内盘', 'Market')}</span></button>
      <button class="cmd-tile" data-nav="/rules"><span class="icon-badge">${icon('book', 16)}</span><span>${L('规则', 'Rules')}</span></button>
      <button class="cmd-tile" data-nav="/team/invite"><span class="icon-badge orange">${icon('qr', 16)}</span><span>${L('邀请海报', 'Poster')}</span></button>
    </div>

    ${renderViralStrip()}
  `;
}

export function renderParticipation(round) {
  const qAmt = round.quickStakeTon || 100;
  const est = estimateRewardA9(qAmt);
  const history = Array.isArray(round.priceHistory) && round.priceHistory.length > 1
    ? round.priceHistory : [];

  return `
    <div class="card card-hero">
      <div class="row-between" style="margin-bottom:14px;">
        ${stagePillTrigger('participation', round.currentRound)}
        <span class="row-start num-sm text-sec">${icon('clock', 13)} <span id="round-cd" class="mono">${round.countdownSec === null ? '—' : formatTimer(round.countdownSec)}</span></span>
      </div>

      <div class="row-between" style="align-items:flex-end;">
        <div>
          <div class="num-xs text-muted">${L('本轮用户奖励池', 'Round Reward Pool')}</div>
          <div class="num-hero" style="margin-top:4px;">${round.rewardBudgetA9 === null || round.rewardBudgetA9 === undefined ? L('待核验', 'Pending') : formatNum(round.rewardBudgetA9)} <span class="num-md text-green">A9</span></div>
        </div>
        ${history.length > 1 ? renderLiveSparkline(history) : ''}
      </div>

      <div class="metric-strip">
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('目标价', 'Target')}</span>
          <span class="num-md">${priceOrDash(round.targetPrice)}</span>
        </div>
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('判定均价', 'Judge TWAP')}</span>
          <span class="num-md text-green">${priceOrDash(round.twap24h)}</span>
        </div>
      </div>

      <div class="hero-amt-pills">
        ${[100, 500, 1000].map(v => `
          <button class="hero-amt-pill ${qAmt === v ? 'active' : ''}" data-hero-amt="${v}" type="button">${formatNum(v)} GRAM</button>
        `).join('')}
      </div>

      <button class="btn btn-primary" id="hero-stake-cta" data-nav="/challenge/confirm">${icon('bolt', 16)} ${L(`立即参与 ${formatNum(qAmt)} GRAM`, `Participate ${formatNum(qAmt)} GRAM`)}</button>
      <div class="num-xs text-muted" style="margin-top:8px;">
        ${est === null
          ? L('预计奖励：等待服务端参与数据', 'Estimate: awaiting participation data')
          : `${L('预计奖励约', 'Est.')} <b id="hero-est-a9" style="color:var(--text-primary);">~${formatNum(Math.round(est))} A9</b> · ${L('按当前参与量估算，非承诺', 'based on current participation, not guaranteed')}`}
      </div>
    </div>

    <div class="step-rail">
      <div class="step-item current" ${config.isDemo ? 'data-step-stage="participation"' : ''}><span class="step-num">1</span><span>${L('参与', 'Enter')}</span></div>
      <div class="step-item" ${config.isDemo ? 'data-step-stage="observation"' : ''}><span class="step-num">2</span><span>${L('观察 24H', '24H Observe')}</span></div>
      <div class="step-item" ${config.isDemo ? 'data-step-stage="settlement_success"' : ''}><span class="step-num">3</span><span>${L('领取 A9', 'Claim A9')}</span></div>
    </div>

    ${renderPredictionCard(round, store.state.prediction, store.state.user)}

    <div class="grid-4">
      <button class="cmd-tile" data-nav="/warmup"><span class="icon-badge orange">${icon('flame', 16)}</span><span>${L('预热', 'Warm-Up')}</span></button>
      <button class="cmd-tile" data-nav="/leaderboard"><span class="icon-badge amber">${icon('trophy', 16)}</span><span>${L('榜单', 'Ranks')}</span></button>
      <button class="cmd-tile" data-nav="/proof"><span class="icon-badge sky">${icon('shieldCheck', 16)}</span><span>${L('凭证', 'Proof')}</span></button>
      <button class="cmd-tile" data-nav="/rules"><span class="icon-badge">${icon('book', 16)}</span><span>${L('规则', 'Rules')}</span></button>
    </div>

    ${renderViralStrip()}
  `;
}

/**
 * 观察页四层首屏：
 * 1. 轮次与阶段（一行）
 * 2. 主结果进度：8 / 16 个达标时段 + 细进度轨 + 一句「还差 N 个」
 * 3. 单次等宽倒计时 + 估算状态（仅可靠时展示）
 * 4. 24H 时段记录图直接露出首屏，下方衔接 24H 生死预言局与快捷入口
 */
export function renderObservation(round) {
  const passed = round.qualifiedCandles || 0;
  const required = round.minQualifiedCandles || 16;
  const need = Number.isFinite(round.needMore) ? round.needMore : Math.max(0, required - passed);
  const pct = required ? Math.round(Math.min(100, (passed / required) * 100)) : 0;
  const est = round.myWeight > 0 ? estimateRewardA9(round.myStakeTon) : null;

  return `
    <section class="observatory-stage">
      <div class="observatory-hud">${stagePillTrigger('observation', round.currentRound)}
        <span>${L('距结束','Time left')} <b id="round-cd">${round.countdownSec == null ? '—' : formatTimer(round.countdownSec)}</b></span>
      </div>
      <div class="observatory-status">
        <h1>${L('星塔观测','Star Observatory')}</h1>
        <div class="obs-hero-ratio"><span id="obs-passed-num" data-val="${passed}"><span class="ratio-cur">${passed}</span><span class="ratio-sep">/</span><span class="ratio-req">${required}</span></span> ${L('达标时段','qualified slots')}</div>
        <div class="progress-track"><div class="progress-fill" id="obs-progress-fill" style="width:${pct}%"></div></div>
        <span id="obs-need-text">${need === 0 ? L('已达门槛，等待结算','Awaiting settlement') : L(`还差 ${need} 个达标时段`,`${need} more qualifying slots needed`)}</span>
        ${est !== null ? `<span> · ${L('估算','Est.')} ~${formatNum(est)} A9</span>` : ''}
      </div>
    </section>
    ${renderCorridorRadar(round.candles || [], round.targetPrice, round.activeCandleSec || 0, round.livePrice, {
      qualified: passed,
      minQualified: required,
      seen: round.candlesSeen || 0,
      stale: round.stale,
      sprint4h: Number(round.countdownSec) > 0 && Number(round.countdownSec) <= 14400
    })}

    ${renderPredictionCard(round, store.state.prediction, store.state.user)}

    <div class="grid-2 realm-actions">
      <button class="btn btn-secondary" data-nav="/proof"><img src="./assets/paper-craft/ticket.svg" alt=""> ${L('质押凭证', 'Certificate')}</button>
      <button class="btn btn-secondary" data-nav="/team/invite"><img src="./assets/paper-craft/guild.svg" alt=""> ${L('邀请海报', 'Poster')}</button>
    </div>
  `;
}

/** 24H 时段记录：逐段列出已确认 / 进行中 / 未开始，直接复用服务端 candles。 */
export function renderObservationRecords(root) {
  const round = store.state.round;
  const candles = round.candles || [];
  const states = {
    pass: L('已确认达标','Confirmed · met'), miss: L('已确认未达标','Confirmed · missed'),
    active: L('观察中，尚未确认','Observing · unconfirmed'), pending: L('尚未开始','Upcoming'),
    unknown: L('数据暂缺','Unavailable')
  };
  const slots = Array.from({length:24}, (_,i) => {
    const candle = candles.find(c=>c.index===i+1);
    const state = candle?.confirmed ? (candle.bull?'pass':'miss') :
      ['active','pending'].includes(candle?.status) ? candle.status : 'unknown';
    return {number:i+1, state, price:candle?.p};
  });
  const prior = root.querySelector('.star-journal')?.dataset;
  const active = slots.find(slot=>slot.state==='active');
  let selected = prior?.round===String(round.currentRound) ? Number(prior.slot) : active?.number || 1;
  root.innerHTML = `<section class="star-journal wv-tower" data-round="${round.currentRound}">
    <header><small>${L('第','Round')} ${round.currentRound} · 24H</small><h1>${L('星轨观测志','Celestial log')}</h1></header>
    <div class="star-dial wv-windows" role="group" aria-label="${L('选择观测时段','Select observation slot')}">
      <div class="dial-core"><i class="dial-pointer" aria-hidden="true"></i><img src="./assets/paper-craft/tower.svg" alt=""><b>${round.qualifiedCandles ?? '—'} / ${round.minQualifiedCandles || 16}</b><small>${L('达标时段','Qualified')}</small></div>
      ${slots.map(({number,state},i)=>{
        const angle=(i%12)*Math.PI/6-Math.PI/2;
        const radius=i<12?43:28;
        return `<button type="button" style="left:${50+radius*Math.cos(angle)}%;top:${50+radius*Math.sin(angle)}%" data-slot="${number}" data-state="${state}" aria-label="${L('第','Slot')} ${number} · ${states[state]}"><span>${String(number).padStart(2,'0')}</span></button>`;
      }).join('')}
    </div>
    <div class="star-key">${Object.entries(states).map(([key,label])=>`<i class="key-${key}"></i>${label.split('，')[0]}`).join(' ')}</div>
    ${round.stage==='observation' && round.qualifiedCandles >= (round.minQualifiedCandles||16) ? `<p>${L('已达门槛，等待结算','Threshold met · awaiting settlement')}</p>`:''}
    </section><section class="star-reading" aria-live="polite"></section>
    <a class="btn btn-secondary" href="#/round">${L('返回轮次挑战','Back to round')}</a>`;
  const journal=root.querySelector('.star-journal');
  function select(number) {
    selected=number; journal.dataset.slot=String(number);
    const slot=slots[number-1];
    journal.style.setProperty('--slot-angle', ((number-1)%12)*30+'deg');
    journal.querySelector('.dial-pointer').classList.toggle('inner', number>12);
    journal.querySelectorAll('[data-slot]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.slot)===number)));
    root.querySelector('.star-reading').innerHTML=`<header><img src="./assets/paper-craft/ticket.svg" alt=""><div><small>${L('时段记录','Slot record')}</small><h2>${L('第','Slot')} ${number} ${L('时段','')}</h2></div><b>${states[slot.state]}</b></header>
      <dl>${[[L('时段均价','Slot TWAP'),slot.price],[L('目标底价','Target'),round.targetPrice],[L('轮次判定均价','Round TWAP'),round.twap24h]].map(([label,v])=>`<div><dt>${label}</dt><dd>${v>0?'$'+Number(v).toLocaleString('en-US',{maximumFractionDigits:12}):'—'}</dd></div>`).join('')}</dl>`;
  }
  journal.addEventListener('click',event=>{
    const button=event.target.closest('[data-slot]');
    if(button){
      A9Haptic.light();
      A9Audio.tick();
      select(Number(button.dataset.slot));
    }
  });
  select(selected);
}

export function renderSettlementSuccess(round, user) {
  return `
    <div class="card card-hero">
      <div class="row-between" style="margin-bottom:12px;">
        ${stagePillTrigger('settlement_success', round.currentRound)}
        <span class="chip chip-green">${icon('checkCircle', 11)} ${round.qualifiedCandles}/${round.minQualifiedCandles || 16}</span>
      </div>
      <div class="num-xs text-muted">${L('实际可领奖励（已结算）', 'Actual claimable (settled)')}</div>
      <div class="num-hero" style="margin-top:4px;">${formatNum(user.a9Claimable)} <span class="num-md text-green">A9</span></div>
      <div class="metric-strip">
        <div class="metric-cell"><span class="num-xs text-muted">${L('达标时段', 'Qualified slots')}</span><span class="num-md">${round.qualifiedCandles}/${round.minQualifiedCandles || 16}</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('待解锁奖励', 'Locked')}</span><span class="num-md text-sec">${formatNum(user.a9Locked)} A9</span></div>
      </div>
      <button class="btn btn-primary" data-nav="/claim">${icon('bolt', 16)} ${L('立即领取奖励', 'Claim Rewards')}</button>
    </div>
    ${renderPredictionCard(round, store.state.prediction, user)}
    <div class="grid-2">
      <button class="btn btn-secondary" data-nav="/records">${icon('clock', 15)} ${L('参与记录', 'History')}</button>
      <button class="btn btn-secondary" data-nav="/team/invite">${icon('qr', 15)} ${L('邀请海报', 'Poster')}</button>
    </div>
    ${renderViralStrip()}
  `;
}

export function renderSettlementFailed(round) {
  return `
    <div class="card card-glow-red" id="burn-monument-card">
      <div class="row-between" style="margin-bottom:10px;">
        ${stagePillTrigger('settlement_burn', round?.currentRound || 1)}
        <span class="chip chip-red">${round.qualifiedCandles || 0}/${round.minQualifiedCandles || 16}</span>
      </div>
      <div class="progress-track" style="margin-bottom:10px;"><div class="progress-fill red no-anim" style="width:${Math.round((round.qualifiedCandles || 0) / (round.minQualifiedCandles || 16) * 100)}%"></div></div>
      <div class="col-gap">
        <div class="list-row"><span class="text-sec">${L('本轮参与本金处理', 'Principal')}</span><span class="num-xs text-red">${L('按 v15 规则销毁', 'Burned per v15')}</span></div>
        <div class="list-row"><span class="text-sec">${L('团队额度', 'Team quota')}</span><span class="num-xs text-gold">${L('120,000,000 A9 销毁 / 结转', '120,000,000 A9 burned / carried')}</span></div>
      </div>
      <div class="sub-tile" style="margin-top:10px;border-color:var(--green-border);">
        <div class="num-xs text-sec" style="line-height:1.5;">${L('见证销毁并分享，下轮内盘享优先通道与额度加成。', 'Witness and share this burn monument for next-round presale priority and quota boost.')}</div>
      </div>
      <button class="btn btn-secondary" data-x-share="burn" type="button" style="margin-top:10px;">${icon('xBrand', 15)} ${L('晒销毁纪念碑', 'Share Burn Monument on X')}</button>
    </div>
    ${renderPredictionCard(round, store.state.prediction, store.state.user)}
    <div class="grid-2">
      <button class="btn btn-primary" data-nav="/internal/market">${icon('swap', 15)} ${L('前往内盘', 'Presale Market')}</button>
      <button class="btn btn-secondary" data-nav="/warmup">${icon('flame', 15)} ${L('下轮预热', 'Next Warm-Up')}</button>
    </div>
  `;
}

export function renderTechnicalHalt(round) {
  return `
    <div class="card card-hero" style="border-color:var(--gold-border);">
      <div class="row-between" style="margin-bottom:12px;">
        ${stagePillTrigger('halted', round?.currentRound || 1)}
        <span class="chip chip-green">${icon('shieldCheck', 11)} ${L('本金安全', 'Principal safe')}</span>
      </div>
      <div style="font-size:18px;font-weight:700;margin-bottom:6px;">${L('本轮触发技术中止保护', 'Technical Halt Triggered')}</div>
      <div class="text-sec" style="font-size:12px;margin-bottom:14px;">${L('预言机或网络异常触发合约安全中止，参与本金按规则原路退回。', 'Oracle/network anomaly triggered a contract halt; principal is refunded.')}</div>
      <button class="btn btn-primary" data-nav="/risk/audit">${icon('shieldCheck', 16)} ${L('查看链上退款存证', 'View Refund Proof')}</button>
    </div>
  `;
}
