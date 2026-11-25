import { liveRound } from './wealthverse.js';
import { store } from '../store.js';
import { config } from '../config.js';
import {
  estimateRewardA9,
  fetchPredictionRound,
  fetchPredictionUser,
  submitPredictionBet,
  activatePredictionReward,
  fetchUserPortfolio,
  getEffectiveUserId,
  rawToA9,
  serverNowMs,
} from '../data.js';

function formatExactA9FromRaw(raw) {
  const v = BigInt(String(raw || '0'));
  const whole = v / 1_000_000_000n;
  const frac = String(v % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${wholeStr}.${frac}` : wholeStr;
}
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, copyText, mountSlider, burstParticles, openChoiceSheet, openModal, closeModal, bindCorridorRadarEvents } from '../components.js';
import { characterArt, getBoxheadItem } from '../wealth-art.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { pendingTxManager } from '../tx-ux.js';
import { openXShareSheet, buildOgShareUrl } from '../share.js';
import {
  renderWarmupStage,
  renderParticipation,
  renderObservation,
  renderSettlementSuccess,
  renderSettlementFailed,
  renderTechnicalHalt,
  renderPredictionCard,
  renderPendingVaultBanner,
  renderEarlyBirdBanner
} from './round_stages.js';

export function renderChallengeHome(root, navigate) {
  const { round, user } = store.state;
  const stage = round.stage;
  if (!stage) {
    root.textContent = L('轮次状态等待核验','Round state awaits verification');
    return;
  }

  if (!config.isDemo) {
    root.innerHTML = `<div class="col-gap anim-page-enter">${renderPendingVaultBanner(store.state.prediction, round)}${renderEarlyBirdBanner(round)}${liveRound(round)}${renderPredictionCard(round, store.state.prediction, user)}</div>`;
    bindPredictionCardEvents(root, navigate);
    syncPredictionState(root, navigate);
    handlePendingDeepLinkScroll(root);
    return;
  }
  const body = stage === 'warmup'
    ? renderWarmupStage(round, user)
    : stage === 'participation'
      ? renderParticipation(round)
      : stage === 'observation'
        ? renderObservation(round)
        : stage === 'settlement_success'
          ? renderSettlementSuccess(round, user)
          : stage === 'halted'
            ? renderTechnicalHalt(round)
            : renderSettlementFailed(round);

  root.innerHTML = `<div class="col-gap anim-page-enter">${body}</div>`;

  const stageBtn = config.isDemo ? root.querySelector('#btn-stage-sheet') : null;
  if (stageBtn) {
    stageBtn.onclick = () => openChoiceSheet({
      title: L('切换轮次阶段 (演示)', 'Switch Round Stage (Demo)'),
      selected: round.stage,
      options: [
        { value: 'warmup',             label: L('1. 开局倒计时', '1. Pre-Round'), sub: L('开局预热池报名', 'Pre-round registration') },
        { value: 'participation',      label: L('2. 火热入场', '2. Entry Open'), sub: L('早鸟权重份额与即时入场', 'Early weight & instant entry') },
        { value: 'observation',        label: L('3. 24H 闯关中', '3. 24H Quest'), sub: L('24 个时段 ≥16 达标', '24 slots · 16+ to pass') },
        { value: 'settlement_success', label: L('4. 通关派奖', '4. Passed'), sub: L('20% 秒领与 40 天线性释放', '20% instant & 40d linear') },
        { value: 'settlement_burn',    label: L('5. 未通关 · 销毁 BURN', '5. Failed · BURN'), sub: L('本金按规则销毁 BURN', 'Principal burned') },
        { value: 'halted',             label: L('6. 异常中止 · 退回本金', '6. Aborted · Refund'), sub: L('本金原路退回', 'Principal refunded') }
      ],
      onSelect: (val) => {
        store.update(s => { s.round.stage = val; });
        renderChallengeHome(root, navigate);
      }
    });
  }

  root.querySelectorAll('[data-hero-amt]').forEach(btn => {
    btn.onclick = () => {
      A9Haptic.light();
      const amt = Number(btn.dataset.heroAmt);
      store.update(s => { s.round.quickStakeA9 = amt; s.round.quickStakeTon = amt; });
      root.querySelectorAll('[data-hero-amt]').forEach(b => b.classList.toggle('active', Number(b.dataset.heroAmt) === amt));
      const est = estimateRewardA9(amt);
      const selEl = root.querySelector('#hero-sel-stake');
      const estEl = root.querySelector('#hero-est-a9');
      const ctaEl = root.querySelector('#hero-stake-cta');
      if (selEl) selEl.textContent = `${formatNum(amt)} A9`;
      if (estEl) estEl.textContent = est === null ? L('—', '—') : `~${formatNum(Math.round(est))} A9`;
      if (ctaEl) ctaEl.innerHTML = `${icon('bolt', 16)} ${L(`立即参与 ${formatNum(amt)} A9`, `Participate ${formatNum(amt)} A9`)}`;
    };
  });

  root.querySelectorAll('[data-step-stage]').forEach(step => {
    step.onclick = () => {
      const targetStage = step.dataset.stepStage;
      if (config.isDemo && targetStage && targetStage !== store.state.round.stage) {
        store.update(s => { s.round.stage = targetStage; });
        renderChallengeHome(root, navigate);
      }
    };
  });

  bindCorridorRadarEvents(root);
  bindXShareTriggers(root);
  bindPredictionCardEvents(root, navigate);
  syncPredictionState(root, navigate);
  handlePendingDeepLinkScroll(root);
}

function bindXShareTriggers(root) {
  const { round, certificates } = store.state;
  root.querySelectorAll('[data-x-share]').forEach(btn => {
    btn.onclick = () => {
      const shareType = btn.dataset.xShare;
      if (shareType === 'proof') {
        const cert = certificates[0] || {};
        openXShareSheet({
          type: 'proof',
          id: cert.id || `R${round.currentRound || 1}`,
          context: {
            roundId: cert.round || round.currentRound,
            stakeTon: cert.stakeTon || round.myStakeTon || 0,
            multiplier: cert.multiplier || round.myEarlyTier || 1,
            qualified: round.qualifiedCandles,
            required: round.minQualifiedCandles
          }
        });
        return;
      }
      openXShareSheet({
        type: shareType,
        id: round.currentRound || 1,
        context: { roundId: round.currentRound, qualified: round.qualifiedCandles, required: round.minQualifiedCandles }
      });
    };
  });
}

function repaintPredictionCard(root, navigate) {
  const cardEl = root.querySelector('#a9-prediction-card');
  if (!cardEl) return;
  const { round, prediction, user } = store.state;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderPredictionCard(round, prediction, user).trim();
  const nextEl = wrapper.firstElementChild;
  if (nextEl) {
    cardEl.replaceWith(nextEl);
    bindPredictionCardEvents(root, navigate);
  }
}

async function syncPredictionState(root, navigate) {
  const requestedCard = root.querySelector('#a9-prediction-card');
  if (!requestedCard) return;
  const { round, user } = store.state;
  const roundId = config.isDemo ? (round.currentRound || 1) : round.currentRound;
  if (!roundId) {
    requestedCard.textContent = L('轮次数据待核验，暂无法读取预言状态', 'Round data pending verification');
    return;
  }
  const uid = getEffectiveUserId(user);
  try {
    const [rData, uData] = await Promise.all([
      fetchPredictionRound(roundId, round.stage),
      fetchPredictionUser(uid, roundId)
    ]);
    if (!requestedCard.isConnected || store.state.round.currentRound !== roundId) return;
    store.update(s => {
      Object.assign(s.prediction, {
        roundId,
        passCount: Number(rData?.passCount) || 0,
        burnCount: Number(rData?.burnCount) || 0,
        total: Number(rData?.total) || 0,
        passPct: Number.isFinite(Number(rData?.passPct)) ? Number(rData.passPct) : 50,
        burnPct: Number.isFinite(Number(rData?.burnPct)) ? Number(rData.burnPct) : 50,
        settled: Boolean(rData?.settled),
        winningSide: rData?.winningSide || null,
        pendingActivationRaw: String(uData?.pendingActivationRaw || '0'),
        activatedRaw: String(uData?.activatedRaw || '0'),
        currentBet: uData?.currentBet || null,
        streak: Number(uData?.streak) || 0,
        winRate: uData?.winRate !== null && uData?.winRate !== undefined && Number.isFinite(Number(uData.winRate)) ? Number(uData.winRate) : null,
        inviteBoostCount: Number(uData?.inviteBoostCount ?? uData?.inviteBoost) || 0,
        pendingExpiresAt: uData?.pendingExpiresAt ?? uData?.expiresAt ?? null,
        loaded: true
      });
    });
    const badge = document.getElementById('profile-tab-badge');
    if (badge) {
      const hasPending = (Number(store.state.user.a9Claimable) || 0) > 0 || (rawToA9(store.state.prediction.pendingActivationRaw) || 0) > 0;
      badge.classList.toggle('hidden', !hasPending);
    }
    repaintPredictionCard(root, navigate);
  } catch (_) {
    if (!config.isDemo && requestedCard.isConnected) {
      requestedCard.textContent=L('预言数据暂不可读取','Prediction data unavailable');
      const retry=document.createElement('button');retry.className='btn btn-secondary';retry.textContent=L('重试','Retry');
      retry.onclick=()=>syncPredictionState(root,navigate);requestedCard.append(retry);
    }
  }
}

function bindPredictionCardEvents(root, navigate) {
  const card = root.querySelector('#a9-prediction-card');
  if (!card) return;
  const { round, prediction, user } = store.state;
  const roundId = round.currentRound || 1;
  let selectedSide = 'PASS';

  const toggleHead = card.querySelector('#pred-toggle-head');
  if (toggleHead) {
    const doToggle = () => {
      A9Haptic.light();
      const cur = toggleHead.getAttribute('aria-expanded') === 'true';
      store.state.prediction.expanded = !cur;
      repaintPredictionCard(root, navigate);
    };
    toggleHead.onclick = doToggle;
    toggleHead.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doToggle(); } };
  }

  const sideBtns = card.querySelectorAll('[data-pred-side]');
  if (sideBtns.length) {
    sideBtns.forEach(b => {
      b.classList.toggle('selected', b.dataset.predSide === selectedSide);
      b.onclick = () => {
        A9Haptic.tick();
        selectedSide = b.dataset.predSide;
        sideBtns.forEach(x => x.classList.toggle('selected', x.dataset.predSide === selectedSide));
      };
    });
  }

  const slotInputEl = card.querySelector('#pred-guess-slots');
  const weightEl = card.querySelector('#pred-cur-weight');
  if (slotInputEl && weightEl) {
    const inviteBonus = Math.min(0.5, Math.max(0, Number(prediction.inviteBoostCount) || 0) * 0.1);
    slotInputEl.oninput = () => {
      const hasSlot = slotInputEl.value.trim() !== '';
      const nextW = Math.min(2.0, 1.0 + (hasSlot ? 0.5 : 0) + inviteBonus);
      weightEl.textContent = `${nextW.toFixed(1)}x`;
    };
  }

  const submitBtn = card.querySelector('#btn-pred-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const uid = getEffectiveUserId(user);
      if (!uid) {
        showToast(L('请在 Telegram 内打开或先连接 TON 钱包', 'Open in Telegram or connect TON wallet first'), 'amber');
        return;
      }
      const slotInput = card.querySelector('#pred-guess-slots');
      const rawVal = slotInput ? slotInput.value.trim() : '';
      let guessSlots = null;
      if (rawVal !== '') {
        const n = Number(rawVal);
        if (!Number.isInteger(n) || n < 0 || n > 24) {
          showToast(L('精准格数须为 0 至 24 的整数', 'Exact slots must be an integer between 0 and 24'), 'error');
          return;
        }
        guessSlots = n;
      }
      submitBtn.disabled = true;
      try {
        await submitPredictionBet({
          roundId,
          userId: uid,
          side: selectedSide,
          guessSlots,
          referrerId: store.state.referral.referrerId
        });
        A9Haptic.success();
        A9Audio.confirm();
        showToast(L(`已锁定本轮预言：${selectedSide === 'BURN' ? '押销毁 BURN' : '押达标 PASS'}`, `Prediction locked: ${selectedSide}`));
        await syncPredictionState(root, navigate);
      } catch (e) {
        A9Haptic.error();
        showToast(e?.message || L('提交预言失败，请重试', 'Prediction submit failed'), 'error');
        submitBtn.disabled = false;
      }
    };
  }

  const connBtn = card.querySelector('#btn-pred-connect');
  if (connBtn) {
    connBtn.onclick = () => tonConnect.openConnectModal(() => {
      repaintPredictionCard(root, navigate);
      syncPredictionState(root, navigate);
    });
  }

  const tgShareBtn = card.querySelector('#btn-pred-tg-share');
  if (tgShareBtn && prediction.currentBet) {
    tgShareBtn.onclick = () => {
      const bet = prediction.currentBet;
      const ogUrl = buildOgShareUrl('bet', roundId);
      const sideText = bet.side === 'BURN' ? L('销毁 BURN', 'BURN') : L('通关 PASS', 'PASS');
      const oppText = bet.side === 'BURN' ? L('通关 PASS', 'PASS') : L('销毁 BURN', 'BURN');
      const text = L(
        `这轮 A9 第 ${roundId} 轮 24H 我押了【${sideText}】${bet.guessSlots !== null && bet.guessSlots !== undefined ? `（精准 ${bet.guessSlots} 段）` : ''}，不服的来押【${oppText}】对赌！0 GRAM 进场，新人首轮猜错还保底领 500 A9：`,
        `I locked [${sideText}] on A9 Round #${roundId} 24H! Think it's [${oppText}]? 0 GRAM entry with a 500 A9 rookie floor:`
      );
      A9TMA.shareInvite(ogUrl, text);
      showToast(L('已调起 Telegram 群分享', 'Opened Telegram group share'));
    };
  }

  const xShareBtn = card.querySelector('#btn-pred-x-share');
  if (xShareBtn && prediction.currentBet) {
    xShareBtn.onclick = () => {
      openXShareSheet({
        type: 'bet',
        id: roundId,
        context: {
          roundId,
          side: prediction.currentBet.side,
          guessSlots: prediction.currentBet.guessSlots,
          qualified: round.qualifiedCandles,
          required: round.minQualifiedCandles
        }
      });
    };
  }

  const actBtn = card.querySelector('#btn-pred-activate');
  if (actBtn) {
    actBtn.onclick = async () => {
      if (!store.fundsEnabled) {
        showToast(L('当前真实模式处于只读验收阶段，奖励激活入账暂未开放', 'Live mode is read-only; reward activation is currently disabled'), 'amber');
        return;
      }
      if (!user.connected || !user.address) {
        showToast(L('请先连接 TON 钱包以激活奖励', 'Connect TON wallet first to activate'), 'amber');
        tonConnect.openConnectModal(() => {
          repaintPredictionCard(root, navigate);
          syncPredictionState(root, navigate);
        });
        return;
      }
      const uid = getEffectiveUserId(user);
      actBtn.disabled = true;
      try {
        const res = await activatePredictionReward(uid, user.address);
        A9Haptic.success();
        A9Audio.confirm();
        const deltaA9 = rawToA9(res?.activatedRaw ?? res?.activatedDeltaRaw ?? prediction.pendingActivationRaw) || 0;
        showToast(L(`已激活 ${formatNum(deltaA9)} A9 至邀友奖励账户，可走 0.06 GRAM 提现`, `Activated ${formatNum(deltaA9)} A9 to invite reward balance`));
        await syncPredictionState(root, navigate);
      } catch (e) {
        A9Haptic.error();
        if (e?.code === 'ACTIVATION_REQUIREMENT_UNMET') {
          showToast(L('请先在宝箱商城购任意宝箱（0.99 GRAM 起）、链上参与，或直邀 1 位好友购箱后再激活', 'Buy any chest (0.99+ GRAM), stake on-chain, or invite 1 paid friend before activating'), 'amber');
          actBtn.disabled = false;
        } else if (e?.code === 'VOUCHER_EXPIRED') {
          showToast(L('待激活预言券已过期并回流奖池', 'Pending prediction voucher has expired and returned to the pool'), 'amber');
          await syncPredictionState(root, navigate);
        } else {
          showToast(e?.message || L('激活失败，请先购任意宝箱（0.99 GRAM 起）、链上参与或直邀 1 位好友购箱', 'Activation failed; buy any chest (0.99+ GRAM), stake, or invite 1 paid friend first'), 'error');
          actBtn.disabled = false;
        }
      }
    };
  }
}

function handlePendingDeepLinkScroll(root) {
  const targetKey = store.state.referral.pendingScrollTarget;
  if (!targetKey) return;
  store.state.referral.pendingScrollTarget = null;
  if (targetKey === 'prediction') {
    store.state.prediction.expanded = true;
  }
  const elId = targetKey === 'burn' ? '#burn-monument-card' : '#a9-prediction-card';
  requestAnimationFrame(() => {
    const targetEl = root.querySelector(elId);
    if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

/** 三态交易弹层：等待签名 → 确认中 → 最终结果；允许关闭并回「我的」继续查看。 */
function openTransactionSheet(amount, view, { assetSymbol = 'GRAM', gasNote = '' } = {}) {
  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between" style="padding:2px 0 8px;">
      <div class="card-title">${icon('wallet', 16, 'text-green')} ${L('交易进度', 'Transaction Progress')}</div>
      <button class="icon-btn" id="tx-close" aria-label="Close">${icon('x', 15)}</button>
    </div>
    <div class="empty-state" style="padding:12px 8px;">
      <div class="icon-badge orange" id="tx-stage-badge" style="width:48px;height:48px;border-radius:14px;">${icon('wallet', 22)}</div>
      <div id="tx-stage-title" style="font-size:16px;font-weight:700;margin-top:6px;">${L('1/3 等待钱包签名…', '1/3 Awaiting wallet signature…')}</div>
      <div id="tx-stage-sub" class="num-xs text-muted">${L(`正在唤起 TON Connect 确认 ${formatNum(amount)} ${assetSymbol}${gasNote}`, `Confirm ${formatNum(amount)} ${assetSymbol}${gasNote} in wallet`)}</div>
    </div>
    <div class="col-gap">
      <button class="btn btn-secondary" id="tx-go-profile">${L('关闭并返回「我的」查看', 'Close & view in Me')}</button>
    </div>
  `);
  const closeAndGo = () => { closeModal(); if (view) view(); };
  document.getElementById('tx-close').onclick = closeModal;
  document.getElementById('tx-go-profile').onclick = closeAndGo;
  return {
    stage(n, title, sub) {
      const t = document.getElementById('tx-stage-title');
      const s = document.getElementById('tx-stage-sub');
      if (t) t.textContent = `${n}/3 ${title}`;
      if (s) s.textContent = sub;
    },
    done(title, sub, type = 'success') {
      const t = document.getElementById('tx-stage-title');
      const s = document.getElementById('tx-stage-sub');
      const b = document.getElementById('tx-stage-badge');
      if (t) t.textContent = title;
      if (s) s.textContent = sub;
      if (b) {
        b.className = `icon-badge ${type === 'error' ? 'red' : 'emerald'}`;
        b.innerHTML = icon(type === 'error' ? 'shieldAlert' : 'checkCircle', 22);
      }
      const btn = document.getElementById('tx-go-profile');
      if (btn) {
        btn.textContent = type === 'error' ? L('关闭并重试', 'Close & Retry') : L('完成 · 返回「我的」', 'Done · Back to Me');
        btn.onclick = type === 'error' ? closeModal : closeAndGo;
      }
      showToast(sub, type);
    }
  };
}

/** P1-4：合并精简版质押与回本推演卡（v16.2：PASS/BURN 对称风险、15× 稀释提示、40 天按秒线性释放曲线与细粒度 DOM 更新） */
function computeStakeSummaryMetrics({ amountA9, round, weightMultiplier = 2.0 }) {
  const amt = Math.max(0, Number(amountA9) || 0);
  const mult = [2.0, 1.4, 1.0].includes(Number(weightMultiplier)) ? Number(weightMultiplier) : 2.0;
  const estTotalRaw = amt > 0 ? estimateRewardA9(amt, round, { weightMultiplier: mult }) : null;
  const estTotal = estTotalRaw !== null && Number.isFinite(estTotalRaw) ? Math.round(estTotalRaw) : null;
  const successes = Number.isInteger(round?.successCount) ? round.successCount : 0;
  const curTierPct = 20;
  const curInstantReward = estTotal !== null ? Math.round(estTotal * 0.2) : null;
  const curLockedReward = (estTotal !== null && curInstantReward !== null) ? Math.max(0, estTotal - curInstantReward) : null;
  const dailyUnlockReward = estTotal !== null ? Math.round(estTotal * 0.02) : null;
  const passCashIn = (curInstantReward !== null && amt > 0) ? Math.round(amt + curInstantReward) : null;
  const instantRoiPct = (curInstantReward !== null && amt > 0) ? ((curInstantReward / amt) * 100) : null;
  const capA9 = amt > 0 ? Math.round(amt * 15) : 0;
  const hitCap = estTotal !== null && amt > 0 && estTotal >= capA9;

  return {
    amt,
    mult,
    estTotal,
    successes,
    curTierPct,
    curInstantReward,
    curLockedReward,
    dailyUnlockReward,
    passCashIn,
    instantRoiPct,
    capA9,
    hitCap,
    curve: [
      { key: 'd0', pct: 20, amt: estTotal !== null ? Math.round(estTotal * 0.2) : null },
      { key: 'd10', pct: 40, amt: estTotal !== null ? Math.round(estTotal * 0.4) : null },
      { key: 'd20', pct: 60, amt: estTotal !== null ? Math.round(estTotal * 0.6) : null },
      { key: 'd40', pct: 100, amt: estTotal !== null ? estTotal : null },
    ],
  };
}

function renderStakeSummaryCardHtml({ amountA9, round, weightMultiplier = 2.0, prefix = 'demo', minStakeA9 = 1000, roundController = null }) {
  const m = computeStakeSummaryMetrics({ amountA9, round, weightMultiplier });
  const hasEst = m.estTotal !== null;
  const fmtOrPending = (v, suffix = ' A9') =>
    v === null || v === undefined ? L('待链上奖池同步', 'Awaiting pool') : `${formatNum(v)}${suffix}`;

  return `
    <section class="card payback-calc-card" id="${prefix}-stake-summary-card">
      <div class="row-between" style="margin-bottom:8px;">
        <div class="card-title">${icon('radar', 15, 'text-gold')} ${L('收益回本推演 · 入场核对', 'Payback & Entry Summary')}</div>
        <a class="chip chip-green" href="#/risk/audit" style="text-decoration:none;">${icon('shieldCheck', 11)} ${L('v16.2 已弃权', 'v16.2 Renounced')}</a>
      </div>

      <div class="payback-weight-tabs" role="group" aria-label="${L('模拟早鸟权重', 'Simulate early weight')}">
        ${[
          [2.0, L('2.0× 首段', '2.0× Early')],
          [1.4, L('1.4× 中段', '1.4× Mid')],
          [1.0, L('1.0× 末段', '1.0× Late')],
        ].map(([w, lbl]) => `
          <button type="button" class="payback-w-btn ${m.mult === w ? 'active' : ''}" data-calc-weight="${w}" aria-pressed="${m.mult === w}">${lbl}</button>
        `).join('')}
      </div>

      <div class="payback-outcome-grid">
        <div class="payback-outcome-box is-pass">
          <div class="row-between">
            <small class="text-green" style="font-weight:800;">${L('通关 PASS（≥ 16/24 格）', 'PASS (≥ 16/24 Slots)')}</small>
            <span class="mono num-xs text-green" data-field="instant-roi">${m.instantRoiPct !== null ? `+${m.instantRoiPct.toFixed(1)}%` : '—'}</span>
          </div>
          <div class="payback-outcome-main mono text-green" data-field="pass-cashin">${fmtOrPending(m.passCashIn)}</div>
          <div class="num-xs text-sec" data-field="pass-breakdown">
            ${hasEst
              ? L(`100% 本金退回 ${formatNum(m.amt)} + 即时 20% 奖励 ${formatNum(m.curInstantReward)} A9`, `100% principal ${formatNum(m.amt)} + 20% instant ${formatNum(m.curInstantReward)} A9`)
              : L(`100% 本金退回 ${formatNum(m.amt)} A9 + 即时 20% 奖励`, `100% principal ${formatNum(m.amt)} A9 + 20% instant reward`)}
          </div>
        </div>

        <div class="payback-outcome-box is-burn">
          <div class="row-between">
            <small class="text-red" style="font-weight:800;">${L('未通关 BURN（< 16/24 格）', 'BURN (< 16/24 Slots)')}</small>
            <span class="mono num-xs text-red">-100%</span>
          </div>
          <div class="payback-outcome-main mono text-red" data-field="burn-loss">-${formatNum(m.amt)} A9</div>
          <div class="num-xs text-sec">${L('当轮质押本金按合约销毁；0.30 GRAM Gas 余量原路退回', 'Staked principal burned on-chain; unused 0.30 GRAM gas refunded')}</div>
        </div>
      </div>

      <div class="check-list" style="margin-top:8px;">
        <div class="check-row">
          <span class="text-sec">${L('质押本金 / 最低门槛', 'Stake / Minimum')}</span>
          <span class="mono" style="font-weight:700;" data-field="chk-amt">${formatNum(m.amt)} A9 (≥ ${formatNum(minStakeA9)} A9)</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('预估总奖励（含 40 天线性释放）', 'Est. Total Reward (incl. 40d vesting)')}</span>
          <span class="mono text-green" style="font-weight:700;" data-field="est-total">${hasEst ? `~${formatNum(m.estTotal)} A9` : L('待链上奖池同步', 'Awaiting pool')}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('通关即时 (20%) / 40 天线性 (80%)', 'Instant (20%) / 40d Linear (80%)')}</span>
          <span class="mono num-xs"><span data-field="est-instant">${hasEst ? `${formatNum(m.curInstantReward)} A9` : '—'}</span> / <span data-field="est-locked">${hasEst ? `${formatNum(m.curLockedReward)} A9` : '—'}</span></span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('附带 Gas / 目标底价 / 上限', 'Gas / Target / Cap')}</span>
          <span class="mono num-xs">0.30 GRAM · ${round.targetPrice === null ? L('待定', 'TBD') : '$' + round.targetPrice.toFixed(4)} · 15×</span>
        </div>
        ${roundController ? `
          <div class="check-row">
            <span class="text-sec">${L('合约 RoundController', 'RoundController')}</span>
            <span class="mono num-xs">${escapeHtml(`${roundController.slice(0, 6)}…${roundController.slice(-6)}`)}</span>
          </div>
        ` : ''}
      </div>

      <div class="payback-dilution-note num-xs text-muted" data-field="dilution-note" style="margin-top:8px;line-height:1.45;">
        ${m.hitCap
          ? L(`已达 15× 硬顶（${formatNum(m.capA9)} A9），随参与增加动态稀释，以链上结算为准。`, `Hits 15× cap (${formatNum(m.capA9)} A9); diluted as entries grow, settled on-chain.`)
          : L('动态推演随参与增加稀释，非收益承诺，以链上结算为准。', 'Dynamic estimate diluted by new entries; final payout settles on-chain.')}
      </div>

      <details class="payback-details" data-field="vesting-details" ${hasEst ? '' : 'hidden'}>
        <summary>
          <span>${L('查看 40 天线性释放进度（通关 20% + 每日 2%）', 'View 40-Day Linear Vesting (20% Instant + 2%/day)')}</span>
          <span class="faq-arrow">${icon('chevronDown', 13)}</span>
        </summary>
        <div class="payback-curve-box" style="margin-top:8px;">
          <div class="num-xs text-sec" style="margin-bottom:6px;line-height:1.45;">
            ${L('通关即退 100% 本金 + 秒领 20% 奖励；余下 80% 分 40 天按秒线性释放（每日 2%），永久累计不倒扣、随时合并一次领完。', 'Pass refunds 100% principal + 20% instant reward; remaining 80% vests per second over 40 days (2%/day), never forfeited and claimable anytime.')}
          </div>
          <div class="payback-curve-list">
            ${[
              ['d0', L('通关当日', 'Day 0'), 20],
              ['d10', L('第 10 天', 'Day 10'), 40],
              ['d20', L('第 20 天', 'Day 20'), 60],
              ['d40', L('满 40 天', 'Day 40'), 100],
            ].map(([key, label, pct], idx) => `
              <div class="payback-curve-row">
                <span class="payback-curve-lbl">${label}</span>
                <div class="payback-curve-track"><div class="payback-curve-bar" data-curve-bar="${key}" style="width:${pct}%;"></div></div>
                <span class="payback-curve-val mono" data-curve-val="${key}">${m.curve[idx].amt === null ? `${pct}%` : `${formatNum(m.curve[idx].amt)} A9`}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </details>
    </section>
  `;
}

function updateStakeSummaryCardDom(cardEl, { amountA9, round, weightMultiplier = 2.0, minStakeA9 = 1000 }) {
  if (!cardEl) return;
  const m = computeStakeSummaryMetrics({ amountA9, round, weightMultiplier });
  const hasEst = m.estTotal !== null;
  const setText = (sel, text) => { const el = cardEl.querySelector(sel); if (el) el.textContent = text; };

  cardEl.querySelectorAll('[data-calc-weight]').forEach((b) => {
    const active = Number(b.dataset.calcWeight) === m.mult;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });

  setText('[data-field="instant-roi"]', m.instantRoiPct !== null ? `+${m.instantRoiPct.toFixed(1)}%` : '—');
  setText('[data-field="pass-cashin"]', m.passCashIn !== null ? `${formatNum(m.passCashIn)} A9` : L('待链上奖池同步', 'Awaiting pool'));
  setText('[data-field="pass-breakdown"]', hasEst
    ? L(`100% 本金退回 ${formatNum(m.amt)} + 即时 ${m.curTierPct}% 奖励 ${formatNum(m.curInstantReward)} A9`, `100% principal ${formatNum(m.amt)} + ${m.curTierPct}% instant ${formatNum(m.curInstantReward)} A9`)
    : L(`100% 本金退回 ${formatNum(m.amt)} A9 + 当轮即时奖励`, `100% principal ${formatNum(m.amt)} A9 + instant reward`));
  setText('[data-field="burn-loss"]', `-${formatNum(m.amt)} A9`);
  setText('[data-field="chk-amt"]', `${formatNum(m.amt)} A9 (≥ ${formatNum(minStakeA9)} A9)`);
  setText('[data-field="est-total"]', hasEst ? `~${formatNum(m.estTotal)} A9` : L('待链上奖池同步', 'Awaiting pool'));
  setText('[data-field="est-instant"]', hasEst ? `${formatNum(m.curInstantReward)} A9` : '—');
  setText('[data-field="est-locked"]', hasEst ? `${formatNum(m.curLockedReward)} A9` : '—');
  setText('[data-field="dilution-note"]', m.hitCap
    ? L(`已达 15× 硬顶（${formatNum(m.capA9)} A9），随参与增加动态稀释，以链上结算为准。`, `Hits 15× cap (${formatNum(m.capA9)} A9); diluted as entries grow, settled on-chain.`)
    : L('动态推演随参与增加稀释，非收益承诺，以链上结算为准。', 'Dynamic estimate diluted by new entries; final payout settles on-chain.'));

  const detailsEl = cardEl.querySelector('[data-field="vesting-details"]');
  if (detailsEl) detailsEl.hidden = !hasEst;

  m.curve.forEach((step) => {
    const bar = cardEl.querySelector(`[data-curve-bar="${step.key}"]`);
    if (bar) bar.style.width = `${step.pct}%`;
    setText(`[data-curve-val="${step.key}"]`, step.amt === null ? `${step.pct}%` : `${formatNum(step.amt)} A9`);
  });
}

export function renderParticipateConfirm(root, navigate) {
  const { user } = store.state;
  const round = store.state.round;
  if (!config.isDemo && !store.fundsEnabled) {
    root.innerHTML = liveRound(round);
    return;
  }
  if (!config.isDemo) {
    renderLiveStakeConfirm(root, navigate);
    return;
  }
  let amount = round.quickStakeA9 || 5000;
  let calcWeight = [2.0, 1.4, 1.0].includes(Number(round.myEarlyTier)) ? Number(round.myEarlyTier) : 2.0;
  let riskAgreed = false;
  let submitting = false;

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between" style="margin-bottom:10px;">
          <span class="chip chip-gold">${L(`第 ${round.currentRound} 轮`, `Round ${round.currentRound}`)}</span>
          <span class="num-xs text-sec">${L('可用 A9 余额', 'Available A9')}: ${user.a9Available === null || user.a9Available === undefined ? L('未获取', 'Unavailable') : `${formatNum(user.a9Available, 2)} A9`}</span>
        </div>
        <div class="input-box">
          <input id="stake-input" type="number" min="1000" step="100" value="${amount}" aria-label="${L('参与 A9 数量', 'Stake A9 amount')}" />
          <span class="caps text-sec">A9</span>
        </div>
        <div class="grid-4" style="margin-top:8px;">
          <button class="quick-btn ${amount === 1000 ? 'active' : ''}" data-amt="1000" type="button">1,000</button>
          <button class="quick-btn ${amount === 5000 ? 'active' : ''}" data-amt="5000" type="button">5,000</button>
          <button class="quick-btn ${amount === 10000 ? 'active' : ''}" data-amt="10000" type="button">10,000</button>
          <button class="quick-btn" data-amt="max" type="button">MAX</button>
        </div>
      </div>

      ${user.a9Available !== null && user.a9Available !== undefined && Number(user.a9Available) < 1000 ? `
        <div class="sub-tile row-between" style="border-color:var(--gold-border);gap:8px;">
          <span class="num-xs text-sec">${L(`当前可用 A9 不足 1,000（还差 ${formatNum(Math.ceil(1000 - Number(user.a9Available)))} A9）`, `Need ${formatNum(Math.ceil(1000 - Number(user.a9Available)))} more A9 to reach 1,000 minimum`)}</span>
          <a class="btn btn-primary btn-sm" href="#/internal/market" style="white-space:nowrap;">${L('宝箱补足', 'Get A9')} ›</a>
        </div>
      ` : ''}

      ${renderStakeSummaryCardHtml({ amountA9: amount, round, weightMultiplier: calcWeight, prefix: 'demo', minStakeA9: 1000 })}

      <div class="risk-check" id="risk-consent-row" role="checkbox" aria-checked="false" tabindex="0">
        <span class="risk-box" id="risk-box-ic"></span>
        <span>${L('已知晓：未达 16/24 时段本金销毁 BURN，单轮奖励上限 15×。', 'I understand: < 16/24 slots burns principal; reward capped at 15×.')}</span>
      </div>

      ${store.fundsEnabled
        ? `<div id="stake-slider-mount"></div>
           <button class="accessible-confirm-link" id="btn-confirm-accessible" type="button"><span id="acc-confirm-lbl">${L(`无法滑动？点此无障碍确认质押 ${formatNum(amount)} A9`, `Can’t slide? Tap to confirm ${formatNum(amount)} A9`)}</span></button>`
        : `<button class="btn btn-secondary" id="btn-confirm-accessible" type="button">${icon('lock', 15)} <span id="acc-confirm-lbl">${L('真实模式只读 · 暂未开放质押', 'Read-Only Mode · Staking Disabled')}</span></button>`
      }
    </div>
  `;

  const input = root.querySelector('#stake-input');
  const summaryCard = root.querySelector('#demo-stake-summary-card');
  const sliderMount = root.querySelector('#stake-slider-mount');
  const accBtn = root.querySelector('#btn-confirm-accessible');
  const accLbl = root.querySelector('#acc-confirm-lbl');
  const riskRow = root.querySelector('#risk-consent-row');
  const riskBox = root.querySelector('#risk-box-ic');

  summaryCard?.querySelectorAll('[data-calc-weight]').forEach((b) => {
    b.onclick = () => {
      A9Haptic.tick();
      calcWeight = Number(b.dataset.calcWeight) || 2.0;
      updateStakeSummaryCardDom(summaryCard, { amountA9: amount, round, weightMultiplier: calcWeight, minStakeA9: 1000 });
    };
  });

  const toggleRisk = () => {
    A9Haptic.tick();
    riskAgreed = !riskAgreed;
    riskRow.classList.toggle('checked', riskAgreed);
    riskRow.setAttribute('aria-checked', String(riskAgreed));
    riskBox.innerHTML = riskAgreed ? icon('check', 12) : '';
  };
  riskRow.onclick = toggleRisk;
  riskRow.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRisk(); } };

  const syncAll = (val) => {
    amount = Math.max(0, Number(val) || 0);
    updateStakeSummaryCardDom(summaryCard, { amountA9: amount, round, weightMultiplier: calcWeight, minStakeA9: 1000 });
    if (accLbl && store.fundsEnabled) accLbl.textContent = L(`无法滑动？点此无障碍确认质押 ${formatNum(amount)} A9`, `Can’t slide? Tap to confirm ${formatNum(amount)} A9`);
    const maxBal = user.a9Available !== null && user.a9Available !== undefined ? Math.floor(Number(user.a9Available) || 0) : 0;
    root.querySelectorAll('[data-amt]').forEach(b => {
      b.classList.toggle('active', b.dataset.amt === 'max' ? (maxBal > 0 && amount === maxBal) : Number(b.dataset.amt) === amount);
    });
    const sliderTxt = sliderMount?.querySelector('.slider-text');
    if (sliderTxt) {
      const next = L(`右滑确认质押 ${formatNum(amount)} A9`, `Slide to Stake ${formatNum(amount)} A9`);
      sliderTxt.textContent = next;
      sliderTxt.dataset.orig = next;
    }
  };

  input.oninput = (e) => syncAll(e.target.value);
  root.querySelectorAll('[data-amt]').forEach(btn => {
    btn.onclick = () => {
      A9Haptic.light();
      const maxBal = user.a9Available !== null && user.a9Available !== undefined ? Math.floor(Number(user.a9Available) || 0) : 0;
      const val = btn.dataset.amt === 'max' ? maxBal : Number(btn.dataset.amt);
      input.value = val;
      syncAll(val);
    };
  });

  const handleConfirmSubmit = async () => {
    if (submitting) return;
    if (!config.isDemo || !store.fundsEnabled) {
      A9Haptic.warning();
      showToast(L('真实模式当前为只读验收阶段，暂未开放质押签名与资金转出', 'Live mode is read-only; staking and wallet signing are disabled'), 'amber');
      initSlider();
      return;
    }
    if (!riskAgreed) {
      A9Haptic.error();
      A9Audio.error();
      riskRow.classList.remove('anim-shake');
      void riskRow.offsetWidth;
      riskRow.classList.add('anim-shake');
      showToast(L('请先勾选风险提示确认', 'Confirm the risk notice first'), 'amber');
      initSlider();
      return;
    }
    if (!user.connected) {
      showToast(L('请先连接 TON 钱包', 'Connect TON wallet first'), 'error');
      tonConnect.openConnectModal(initSlider);
      return;
    }
    if (amount < 1000) {
      showToast(L('最低参与 1,000 A9', 'Minimum 1,000 A9'), 'error');
      initSlider();
      return;
    }
    if (user.a9Available !== null && user.a9Available !== undefined && amount > Number(user.a9Available)) {
      showToast(L('可用 A9 余额不足', 'Insufficient A9 balance'), 'error');
      initSlider();
      return;
    }

    submitting = true;
    if (accBtn) { accBtn.disabled = true; accLbl.textContent = L('确认中…', 'Confirming…'); }
    const sheet = openTransactionSheet(amount, () => navigate('/profile'), { assetSymbol: 'A9', gasNote: ' (+ 0.30 GRAM Gas)' });
    try {
      // 演示模式仅走 demo-data.js 模拟回执，绝不触碰已连接的真实钱包 SDK
      await tonConnect.sendStakeTransaction(amount, 'EQD_DEMO_A9_POOL');
      sheet.stage(2, L('演示确认中…', 'Demo confirming…'),
        L('演示模式已生成本地模拟回执，未触发真实钱包签名', 'Simulated receipt generated locally; no real wallet signature'));

      setTimeout(() => {
        const cert = store.stakeTon(amount);
        if (!cert) {
          sheet.done(L('入场失败 · 资金未扣款', 'Failed · No funds deducted'), L('未生成闯关凭证，可关闭后重试', 'No quest pass created, close and retry'), 'error');
          submitting = false;
          if (accBtn) { accBtn.disabled = false; syncAll(amount); }
          initSlider();
          return;
        }
        A9Audio.confirm();
        sheet.done(L('演示结果 · 已确认', 'Demo · Confirmed'),
          `${cert.id} · ${formatNum(cert.stakeTon)} A9`);
        setTimeout(() => {
          closeModal();
          navigate(`/challenge/success/${cert.id}`);
        }, 700);
      }, 650);
    } catch (e) {
      A9Audio.error();
      sheet.done(L('签名取消或失败 · 资金未扣款', 'Cancelled or Failed · No funds deducted'), e?.message || L('可关闭后重新发起确认', 'Close and retry anytime'), 'error');
      submitting = false;
      if (accBtn) { accBtn.disabled = false; syncAll(amount); }
      initSlider();
    }
  };

  const initSlider = () => {
    if (!sliderMount || !store.fundsEnabled) return;
    mountSlider(sliderMount, {
      label: L(`右滑确认质押 ${formatNum(amount)} A9`, `Slide to Stake ${formatNum(amount)} A9`),
      onConfirm: handleConfirmSubmit
    });
  };

  if (accBtn) accBtn.onclick = handleConfirmSubmit;
  initSlider();
}

/**
 * Live 实盘 A9 Jetton 质押确认页（仅在 config.liveFundsEnabled === true 时激活）。
 * 严格按 v15/v16.2 合约口径质押 A9 Jetton（附 0.30 GRAM Gas），绝不把 GRAM 当质押本金。
 */
function renderLiveStakeConfirm(root, navigate) {
  const round = store.state.round;
  const cfg = round.protocolConfig || {};
  const roundController = cfg.contracts?.roundController || null;
  const minStakeRaw = BigInt(String(cfg.minStakeRaw || '1000000000000'));
  const minStakeA9 = Number(minStakeRaw / 1_000_000_000n) || 1000;
  const protocolVer = cfg.stakeProtocolVersion || (cfg.protocolVersion === 'v16' ? 'v16' : config.stakeProtocolVersion);
  const protocolBadge = protocolVer === 'v16' ? 'V16.2' : String(protocolVer || 'v16').toUpperCase();

  let portfolio = null;
  let loadError = null;
  let amountA9 = minStakeA9;
  let calcWeight = 2.0;
  let riskAgreed = false;
  let submitting = false;

  const parseA9InputToRaw = (val) => {
    const s = String(val ?? '').trim();
    if (!/^\d+(?:\.\d{1,9})?$/.test(s)) return null;
    const [whole, frac = ''] = s.split('.');
    return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0'));
  };

  const paint = () => {
    const { user } = store.state;
    const balA9 = portfolio?.balanceAvailable && portfolio?.a9BalanceRaw !== null
      ? rawToA9(portfolio.a9BalanceRaw)
      : null;
    const jw = portfolio?.jettonWallet || null;
    const txLocked = pendingTxManager.isLocked('stake');
    const canSubmit = Boolean(
      user.connected && user.address && roundController && round.currentRound && round.stage === 'participation' && !submitting && !txLocked,
    );

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:10px;">
            <span class="chip chip-gold">${L(`第 ${round.currentRound ?? '—'} 轮 · ${protocolBadge}`, `Round ${round.currentRound ?? '—'} · ${protocolBadge}`)}</span>
            <span class="num-xs text-sec">${L('可用 A9 余额', 'Available A9')}: ${balA9 === null ? L('未获取', 'Unavailable') : `${formatNum(balA9, 2)} A9`}</span>
          </div>
          <div class="input-box">
            <input id="live-stake-a9-input" type="number" min="${minStakeA9}" step="1" value="${amountA9}" aria-label="${L('质押 A9 数量', 'Stake A9 amount')}" />
            <span class="caps text-sec">A9</span>
          </div>
          <div class="grid-4" style="margin-top:8px;">
            <button class="quick-btn" data-live-amt="${minStakeA9}" type="button">${formatNum(minStakeA9)}</button>
            <button class="quick-btn" data-live-amt="5000" type="button">5,000</button>
            <button class="quick-btn" data-live-amt="20000" type="button">20,000</button>
            <button class="quick-btn" data-live-amt="max" type="button">MAX</button>
          </div>
          ${loadError ? `<div class="num-xs text-red" style="margin-top:8px;">${escapeHtml(loadError)}</div>` : ''}
        </div>

        ${balA9 !== null && balA9 < minStakeA9 ? `
          <div class="sub-tile row-between" style="border-color:var(--gold-border);gap:8px;">
            <span class="num-xs text-sec">${L(`当前可用 A9 不足 ${formatNum(minStakeA9)}（还差 ${formatNum(Math.ceil(minStakeA9 - balA9))} A9）`, `Need ${formatNum(Math.ceil(minStakeA9 - balA9))} more A9 for ${formatNum(minStakeA9)} minimum`)}</span>
            <a class="btn btn-primary btn-sm" href="#/internal/market" style="white-space:nowrap;">${L('宝箱补足', 'Get A9')} ›</a>
          </div>
        ` : ''}

        ${renderStakeSummaryCardHtml({ amountA9, round, weightMultiplier: calcWeight, prefix: 'live', minStakeA9, roundController })}

        ${!store.fundsEnabled ? `
          <div class="card" id="live-readonly-stake-notice" style="border-color:var(--gold-border);">
            <div class="row-start" style="font-weight:600;margin-bottom:4px;">${icon('shieldAlert', 15, 'text-gold')} ${L('真实只读模式 · 暂未开放质押签名', 'Live Read-Only · Staking Disabled')}</div>
            <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:8px;">${L('真实只读模式 · 暂不发起签名或扣款。你可以先参与 0 GRAM 24H 预言擂台。', 'Live read-only · no signature or transfer. Try the 0 GRAM 24H Prediction Arena meantime.')}</div>
            <a class="btn btn-secondary btn-sm" href="#/round" style="width:100%;">${icon('radar', 13)} ${L('先去 0 GRAM 预言擂台参与本轮', 'Join 0 GRAM Prediction Arena')} ›</a>
          </div>
        ` : ''}

        <div class="risk-check ${riskAgreed ? 'checked' : ''}" id="live-risk-row" role="checkbox" aria-checked="${riskAgreed}" tabindex="0">
          <span class="risk-box" id="live-risk-box">${riskAgreed ? icon('check', 12) : ''}</span>
          <span>${L('已知晓：质押附带 0.30 GRAM Gas；未达 16/24 时段本金销毁 BURN。', 'I understand: +0.30 GRAM gas; < 16/24 slots burns staked principal.')}</span>
        </div>

        ${!store.fundsEnabled
          ? `<button class="btn btn-secondary" id="btn-live-stake-readonly" type="button" disabled>${icon('lock', 15)} ${L('真实模式只读 · 暂未开放质押', 'Read-Only Mode · Staking Disabled')}</button>`
          : !user.connected
            ? `<button class="btn btn-primary" id="btn-live-connect" type="button">${icon('wallet', 15)} ${L('先连接非托管 TON 钱包', 'Connect TON Wallet First')}</button>`
            : `<button class="btn btn-primary" id="btn-live-stake-submit" type="button" ${!canSubmit ? 'disabled' : ''}>${icon(txLocked ? 'clock' : 'bolt', 16)} ${submitting ? L('等待钱包签名…', 'Awaiting Signature…') : txLocked ? L('质押确认中（防重锁）', 'Stake Confirming…') : L(`签名质押 ${formatNum(amountA9)} A9（+ 0.30 GRAM Gas）`, `Sign & Stake ${formatNum(amountA9)} A9 (+ 0.30 GRAM Gas)`)}</button>`}
        <button class="btn btn-secondary" data-nav="/round" type="button">${icon('arrowLeft', 15)} ${L('返回轮次详情', 'Back to Round')}</button>
      </div>
    `;

    const summaryCard = root.querySelector('#live-stake-summary-card');
    summaryCard?.querySelectorAll('[data-calc-weight]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.tick();
        calcWeight = Number(b.dataset.calcWeight) || 2.0;
        updateStakeSummaryCardDom(summaryCard, { amountA9, round, weightMultiplier: calcWeight, minStakeA9 });
      };
    });

    const inputEl = root.querySelector('#live-stake-a9-input');
    if (inputEl) {
      inputEl.oninput = (e) => {
        amountA9 = Math.max(0, Number(e.target.value) || 0);
        updateStakeSummaryCardDom(summaryCard, { amountA9, round, weightMultiplier: calcWeight, minStakeA9 });
        const btn = root.querySelector('#btn-live-stake-submit');
        if (btn && !submitting && !pendingTxManager.isLocked('stake')) {
          btn.innerHTML = `${icon('bolt', 16)} ${L(`签名质押 ${formatNum(amountA9)} A9（+ 0.30 GRAM Gas）`, `Sign & Stake ${formatNum(amountA9)} A9 (+ 0.30 GRAM Gas)`)}`;
        }
      };
    }
    root.querySelectorAll('[data-live-amt]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.light();
        const v = b.dataset.liveAmt === 'max'
          ? (balA9 !== null ? Math.floor(balA9) : minStakeA9)
          : Number(b.dataset.liveAmt);
        amountA9 = Math.max(minStakeA9, v);
        if (inputEl) inputEl.value = amountA9;
        updateStakeSummaryCardDom(summaryCard, { amountA9, round, weightMultiplier: calcWeight, minStakeA9 });
        const btn = root.querySelector('#btn-live-stake-submit');
        if (btn && !submitting && !pendingTxManager.isLocked('stake')) {
          btn.innerHTML = `${icon('bolt', 16)} ${L(`签名质押 ${formatNum(amountA9)} A9（+ 0.30 GRAM Gas）`, `Sign & Stake ${formatNum(amountA9)} A9 (+ 0.30 GRAM Gas)`)}`;
        }
      };
    });
    const rRow = root.querySelector('#live-risk-row');
    if (rRow) {
      rRow.onclick = () => { A9Haptic.tick(); riskAgreed = !riskAgreed; paint(); };
    }
    const connBtn = root.querySelector('#btn-live-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => loadPortfolio());

    const submitBtn = root.querySelector('#btn-live-stake-submit');
    if (submitBtn) {
      submitBtn.onclick = async () => {
        if (submitting || pendingTxManager.isLocked('stake')) {
          showToast(L('已有质押交易在链上确认中，请勿重复提交', 'Stake transaction already confirming'), 'amber');
          return;
        }
        A9Haptic.light();
        if (!riskAgreed) {
          showToast(L('请先勾选链上风险提示确认', 'Confirm on-chain risk notice first'), 'amber');
          return;
        }
        const rawAmt = parseA9InputToRaw(inputEl?.value ?? amountA9);
        if (!rawAmt || rawAmt < minStakeRaw) {
          showToast(L(`质押数量不得低于 ${formatNum(minStakeA9)} A9`, `Minimum stake is ${formatNum(minStakeA9)} A9`), 'error');
          return;
        }
        const nowSec = Math.floor(serverNowMs() / 1000);
        if (round.stakingEnabled === false || (Number(round.stakeCloseAt || 0) > 0 && nowSec >= Number(round.stakeCloseAt))) {
          showToast(L('本轮质押入场窗口已截止，已拦截签名以防白耗 Gas', 'Staking window closed; signature blocked to save gas'), 'amber');
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        const exactAmtText = formatExactA9FromRaw(rawAmt);
        let insufficientReason = '';
        if (!jw) {
          insufficientReason = L('尚未检测到你的 A9 JettonWallet（需先持有 A9）', 'A9 JettonWallet not found (hold A9 first)');
        } else if (portfolio?.balanceAvailable && portfolio?.a9BalanceRaw !== null && rawAmt > BigInt(portfolio.a9BalanceRaw)) {
          insufficientReason = L(`链上 A9 余额不足（可用 ${formatExactA9FromRaw(portfolio.a9BalanceRaw)} A9，需 ${exactAmtText} A9）`, `Insufficient on-chain A9 (${formatExactA9FromRaw(portfolio.a9BalanceRaw)} available, ${exactAmtText} needed)`);
        }

        const confirmed = await tonConnect.confirmBeforeSign({
          title: L('确认质押交易（签名前核验）', 'Confirm On-Chain Stake'),
          contractLabel: L('目标合约 RoundController', 'Target RoundController'),
          targetAddress: roundController,
          principalText: `${exactAmtText} A9`,
          gasText: `0.30 GRAM (${L('余量原路退回', 'excess refunded')})`,
          totalText: `${exactAmtText} A9 + 0.30 GRAM`,
          note: L(`第 ${round.currentRound} 轮 · 观察期未达 16/24 时段时本轮质押本金将按规则销毁。`, `Round #${round.currentRound} · Staked A9 is burned if fewer than 16/24 slots qualify.`),
          insufficientReason,
          confirmText: L('确认并唤起钱包签名', 'Confirm & Sign in Wallet'),
        });
        if (!confirmed) return;

        const prevTicket = portfolio?.tickets?.find((t) => Number(t.roundId) === Number(round.currentRound));
        const prevTicketAmtRaw = BigInt(prevTicket?.amountRaw || '0');

        submitting = true;
        paint();
        const sheet = openTransactionSheet(amountA9, () => navigate('/profile'), { assetSymbol: 'A9', gasNote: ' (+ 0.30 GRAM Gas)' });
        try {
          await tonConnect.sendV15StakeA9({
            userJettonWallet: jw,
            roundController,
            userAddress: user.address,
            amountA9Raw: rawAmt.toString(),
            roundId: Number(round.currentRound),
            protocolVersion: protocolVer,
          });
          A9Audio.confirm();
          A9Haptic.success();
          sheet.done(
            L('质押交易已提交链上', 'Stake Transaction Broadcast'),
            L('请等待区块确认后在「我的 → 闯关凭证」核对 StakeTicket', 'Check your StakeTicket in Me after block confirmation'),
          );
          const pendingTx = pendingTxManager.start({
            kind: 'stake',
            title: `第 ${round.currentRound} 轮质押`,
            titleEn: `Round #${round.currentRound} Stake`,
            amountText: `${exactAmtText} A9`,
            explorerAddress: roundController,
            targetRoute: '/claim',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const next = await fetchUserPortfolio(user.address);
              if (!next) return false;
              const nextTicket = next.tickets?.find((t) => Number(t.roundId) === Number(round.currentRound));
              const nextTicketAmtRaw = BigInt(nextTicket?.amountRaw || '0');
              if (nextTicketAmtRaw > prevTicketAmtRaw) {
                portfolio = next;
                return {
                  confirmed: true,
                  detail: '质押凭证 StakeTicket 已更新到账，可在「金库领奖」核验。',
                  detailEn: 'StakeTicket updated on-chain; check Claim center.',
                };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('质押已上链确认！StakeTicket 凭证已更新', 'Stake confirmed on-chain! StakeTicket updated.'));
              if (root.isConnected) paint();
            },
            onTimeout: () => {
              showToast(L('区块确认耗时较长，可点击顶部状态条 Tonviewer 核验', 'Taking longer; verify finality on Tonviewer'), 'amber');
              if (root.isConnected) paint();
            },
          });
        } catch (e) {
          A9Audio.error();
          sheet.done(L('签名取消或失败 · 未扣款', 'Cancelled or Failed · No Funds Spent'), e?.message || L('请稍后重试', 'Please retry'), 'error');
        } finally {
          submitting = false;
          if (root.isConnected) paint();
        }
      };
    }
  };

  const loadPortfolio = async () => {
    const addr = store.state.user.address;
    if (!addr) { paint(); return; }
    try {
      portfolio = await fetchUserPortfolio(addr);
      loadError = !portfolio?.jettonWallet ? L('尚未检测到你的 A9 JettonWallet（需先持有 A9）', 'A9 JettonWallet not found (hold A9 first)') : null;
    } catch (e) {
      loadError = e?.message || L('读取链上 A9 余额失败，请重试', 'Failed to load on-chain A9 balance');
    }
    if (root.isConnected) paint();
  };

  paint();
  loadPortfolio();
}

export function renderParticipateSuccess(root, navigate, certId) {
  const cert = store.state.certificates.find(c => c.id === certId) || store.state.certificates[0];
  if (!cert) {
    root.innerHTML = `<div class="col-gap"><div class="card empty-state"><div class="num-sm text-sec">${L('暂无可展示的闯关凭证', 'No quest pass to show')}</div></div><button class="btn btn-secondary" data-nav="/profile">${L('返回我的', 'Back to Me')}</button></div>`;
    return;
  }
  const shareUrl = `${window.location.origin}${window.location.pathname}?startapp=proof_${cert.id.replace('A9-STAKE-', '')}`;
  const tier = config.isDemo ? (store.state.user.previewTier || 1) : 1;
  const series = config.isDemo ? (store.state.user.previewSeries || 'activity') : 'activity';
  const boxhead = getBoxheadItem(tier, series);
  const seriesCode = series === 'wealth' ? 'WLT' : 'ACT';

  const bars = [2, 1, 3, 1, 2, 2, 1, 3, 1, 2];
  const miniBarcode = `<span class="receipt-barcode" aria-hidden="true">${bars.map((w) => `<i style="width:${w}px;"></i>`).join('')}</span>`;
  const estReward = Number(cert.estRewardA9) || Math.round((Number(cert.stakeTon) || 0) * (Number(cert.multiplier) || 1) * 7.5);

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="cert-pass is-settled cert-detail-card success-cert-stage anim-cert-drop anim-card-thump" id="success-cert-card">
        <div class="cert-top-bar">
          <span class="row-start" style="gap:7px;">
            <span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="cert-serial">QUEST ENTRY · R${String(cert.round).padStart(2, '0')}</span>
          </span>
          <span class="cert-status-pill">${icon('shieldCheck', 11)} ${config.isDemo ? 'DEMO' : L('已上链', 'ON-CHAIN')}</span>
        </div>

        <div class="cert-body" style="position:relative;">
          <span class="success-stamp-seal tone-green anim-seal-slam" id="success-stamp-seal" aria-hidden="true">
            <b>${L('已出征', 'SEALED')}</b>
            <span>ROUND ${cert.round}</span>
          </span>

          <div style="text-align:center;padding:4px 0 2px;">
            <div class="icon-badge neon" style="width:44px;height:44px;margin:0 auto 8px;border-radius:13px;">${icon('checkCircle', 22)}</div>
            <div style="font-size:17.5px;font-weight:900;color:var(--ink);">${L('入场成功 · 凭证已盖章出征', 'Quest Entry Sealed')}</div>
            <div class="num-lg text-green mono" style="margin:5px 0 6px;font-weight:900;">${formatNum(cert.stakeTon)} A9 · ${(Number(cert.multiplier) || 1).toFixed(1)}×</div>
            <button type="button" class="cert-hash-copy-btn" id="copy-tx" style="margin:0 auto;">
              <span class="mono">#${escapeHtml(cert.id)}</span>
              ${icon('copy', 11)}
            </button>
          </div>

          <div class="cert-perf" aria-hidden="true"><span class="cert-perf-line"></span></div>

          <div class="cert-metrics-grid">
            <div class="cert-metric-tile is-green">
              <small>${L('预计奖励', 'Est. Reward')}</small>
              <strong class="text-green">+${formatNum(estReward)}<span class="cert-unit">A9</span></strong>
            </div>
            <div class="cert-metric-tile">
              <small>${L('达标门槛', 'Pass Goal')}</small>
              <strong>16 / 24</strong>
            </div>
            <div class="cert-metric-tile is-gold">
              <small>${L('24H 观测', '24H Board')}</small>
              <strong class="text-gold">${L('已启动', 'LIVE')}</strong>
            </div>
          </div>
        </div>

        <div class="cert-foot">
          <span class="num-xs text-muted">${config.isDemo ? L('演示模式 · 模拟凭证', 'DEMO · simulated pass') : L('链上确认后可公开核验', 'On-chain verifiable')}</span>
          ${miniBarcode}
        </div>
      </div>

      <section class="success-cheer-card">
        <div class="success-cheer-standee">
          <img class="wv-person" id="success-cheer-img" src="${characterArt(tier, series)}" alt="${seriesCode} 0${tier}" width="88" height="88" loading="lazy" decoding="async">
        </div>
        <div class="success-cheer-copy">
          <span class="diorama-kicker">${seriesCode} 0${tier} · ${L(boxhead.nameZh, boxhead.nameEn)}</span>
          <strong>${L('纸箱伙伴已就位 · 盯紧 24H 观测盘！', 'Boxhead Ready for the 24H Board!')}</strong>
          <p>“${L(boxhead.voiceZh, boxhead.voiceEn)}”</p>
        </div>
      </section>

      <button class="btn btn-nt-green" id="share-cert-btn">${icon('send', 15)} ${L('分享战绩 · 邀友奖励 6%', 'Share · 6% Invite')}</button>
      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="${cert?.id ? `/proof/${escapeHtml(cert.id)}` : '/proof'}">${icon('shieldCheck', 15)} ${L('闯关凭证', 'Quest Pass')}</button>
        <button class="btn btn-secondary" data-nav="/round">${icon('radar', 15)} ${L('查看观测盘', '24H Board')}</button>
      </div>
    </div>
  `;

  // 750ms 三拍出征演出：落位(0~260ms) -> 钢印砸落 + 纸屑(280ms) -> 伙伴立牌 360° 翻身欢呼(480ms)
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const sealEl = root.querySelector('#success-stamp-seal');
  const cheerImg = root.querySelector('#success-cheer-img');
  if (!reduced) {
    setTimeout(() => {
      if (!root.isConnected) return;
      A9Audio.sealSlam();
      A9Haptic.heavy();
      if (sealEl) burstParticles(sealEl);
    }, 280);
    setTimeout(() => {
      if (!root.isConnected || !cheerImg) return;
      cheerImg.classList.add('paper-flipping');
      setTimeout(() => cheerImg.classList.remove('paper-flipping'), 600);
    }, 480);
  }

  if (cheerImg) {
    cheerImg.onclick = () => {
      A9Haptic.light();
      A9Audio.flip();
      burstParticles(cheerImg);
      cheerImg.classList.remove('paper-flipping');
      void cheerImg.offsetWidth;
      cheerImg.classList.add('paper-flipping');
    };
  }

  root.querySelector('#copy-tx').onclick = () => copyText(cert.txHash, L('已复制哈希', 'Copied Hash'));
  root.querySelector('#share-cert-btn').onclick = () => {
    A9TMA.shareInvite(shareUrl, `A9 #${cert.id}`);
    showToast(L('已生成分享链接', 'Share link ready'));
  };
}
