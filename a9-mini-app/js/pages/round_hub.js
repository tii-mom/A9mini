import { liveRound } from './wealthverse.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { estimateRewardA9, fetchPredictionRound, fetchPredictionUser, submitPredictionBet, activatePredictionReward, getEffectiveUserId, rawToA9 } from '../data.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { formatNum, showToast, copyText, mountSlider, openChoiceSheet, openModal, closeModal, bindCorridorRadarEvents } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { openXShareSheet, buildOgShareUrl } from '../share.js';
import {
  renderWarmupStage,
  renderParticipation,
  renderObservation,
  renderSettlementSuccess,
  renderSettlementFailed,
  renderTechnicalHalt,
  renderPredictionCard
} from './round_stages.js';

export function renderChallengeHome(root, navigate) {
  const { round, user } = store.state;
  const stage = round.stage;
  if (!stage) {
    root.textContent = L('轮次状态等待核验','Round state awaits verification');
    return;
  }

  if (!config.isDemo) {
    root.innerHTML = liveRound(round) + renderPredictionCard(round,store.state.prediction,user);
    bindPredictionCardEvents(root,navigate);
    syncPredictionState(root,navigate);
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
        { value: 'warmup',             label: L('1. 预热阶段', '1. Warm-Up'), sub: L('预热奖励池报名', 'Warm-Up registration') },
        { value: 'participation',      label: L('2. 参与阶段', '2. Entry'), sub: L('本轮奖励池入场', 'Round entry') },
        { value: 'observation',        label: L('3. 观察阶段 (24H)', '3. Observation (24H)'), sub: L('24 个时段 ≥16 达标', '24 slots · 16+ to pass') },
        { value: 'settlement_success', label: L('4. 结算 · 达标', '4. Passed'), sub: L('20% 即时 / 80% 待解锁', '20% instant / 80% vesting') },
        { value: 'settlement_burn',    label: L('5. 结算 · 未达标', '5. Missed'), sub: L('本金按规则销毁', 'Principal burned') },
        { value: 'halted',             label: L('6. 技术中止 · 退款', '6. Halt · Refund'), sub: L('本金原路退回', 'Principal refunded') }
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
      store.update(s => { s.round.quickStakeTon = amt; });
      root.querySelectorAll('[data-hero-amt]').forEach(b => b.classList.toggle('active', Number(b.dataset.heroAmt) === amt));
      const est = estimateRewardA9(amt);
      const selEl = root.querySelector('#hero-sel-stake');
      const estEl = root.querySelector('#hero-est-a9');
      const ctaEl = root.querySelector('#hero-stake-cta');
      if (selEl) selEl.textContent = `${formatNum(amt)} GRAM`;
      if (estEl) estEl.textContent = est === null ? L('—', '—') : `~${formatNum(Math.round(est))} A9`;
      if (ctaEl) ctaEl.innerHTML = `${icon('bolt', 16)} ${L(`立即参与 ${formatNum(amt)} GRAM`, `Participate ${formatNum(amt)} GRAM`)}`;
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
  const { round } = store.state;
  root.querySelectorAll('[data-x-share]').forEach(btn => {
    btn.onclick = () => {
      const shareType = btn.dataset.xShare;
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
      const sideText = bet.side === 'BURN' ? L('押销毁 BURN', 'BURN') : L('押达标 PASS', 'PASS');
      const text = L(
        `我在 A9 第 ${roundId} 轮 24H 生死预言局押了「${sideText}」${bet.guessSlots !== null && bet.guessSlots !== undefined ? `（精准 ${bet.guessSlots} 段）` : ''}，0 GRAM 也能参战，来群里对赌站队：`,
        `I locked ${sideText} on A9 Round #${roundId} 24H Prediction (0 GRAM entry). Join the showdown:`
      );
      A9TMA.shareInvite(ogUrl, text);
      showToast(L('已调起 Telegram 群约战分享', 'Opened Telegram group challenge share'));
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
      if (!config.isDemo) {
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
        showToast(L(`已激活 ${formatNum(deltaA9)} A9 至推广奖励账户，可走 0.06 GRAM 提现`, `Activated ${formatNum(deltaA9)} A9 to promo balance`));
        await syncPredictionState(root, navigate);
      } catch (e) {
        A9Haptic.error();
        if (e?.code === 'ACTIVATION_REQUIREMENT_UNMET') {
          showToast(L('请先完成 1 笔内盘买币（5 GRAM 起）或链上质押后再激活', 'Complete 1 presale buy (from 5 GRAM) or on-chain stake before activating'), 'amber');
          actBtn.disabled = false;
        } else if (e?.code === 'VOUCHER_EXPIRED') {
          showToast(L('待激活预言券已过期并回流奖池', 'Pending prediction voucher has expired and returned to the pool'), 'amber');
          await syncPredictionState(root, navigate);
        } else {
          showToast(e?.message || L('激活失败，请先完成 1 笔内盘买币或链上质押', 'Activation failed; complete 1 presale buy or stake first'), 'error');
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
function openTransactionSheet(amount, view) {
  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between" style="padding:2px 0 8px;">
      <div class="card-title">${icon('wallet', 16, 'text-green')} ${L('交易进度', 'Transaction Progress')}</div>
      <button class="icon-btn" id="tx-close" aria-label="Close">${icon('x', 15)}</button>
    </div>
    <div class="empty-state" style="padding:12px 8px;">
      <div class="icon-badge orange" id="tx-stage-badge" style="width:48px;height:48px;border-radius:14px;">${icon('wallet', 22)}</div>
      <div id="tx-stage-title" style="font-size:16px;font-weight:700;margin-top:6px;">${L('1/3 等待钱包签名…', '1/3 Awaiting wallet signature…')}</div>
      <div id="tx-stage-sub" class="num-xs text-muted">${L(`正在唤起 TON Connect 确认 ${formatNum(amount)} GRAM`, `Confirm ${formatNum(amount)} GRAM in wallet`)}</div>
    </div>
    <div class="col-gap">
      <button class="btn btn-secondary" id="tx-go-profile">${L('关闭并返回「我的」查看', 'Close & view in Vault')}</button>
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
        btn.textContent = type === 'error' ? L('关闭并重试', 'Close & Retry') : L('完成 · 返回「我的」', 'Done · Back to Vault');
        btn.onclick = type === 'error' ? closeModal : closeAndGo;
      }
      showToast(sub, type);
    }
  };
}

export function renderParticipateConfirm(root, navigate) {
  const { user } = store.state;
  const round = store.state.round;
  if (!config.isDemo) {
    root.innerHTML=liveRound(round);
    return;
  }
  let amount = round.quickStakeTon || 100;
  let riskAgreed = false;
  let submitting = false;

  const paintEstimate = () => {
    const est = estimateRewardA9(amount);
    const successes = round.successCount;
    const fraction = successes === null ? null : successes < 5 ? 0.2 : successes < 10 ? 0.4 : 1;
    const inst = est === null || fraction === null ? null : Math.round(est * fraction);
    const lock = inst === null ? null : Math.round(est) - inst;
    const set = (id, val) => { const el = root.querySelector(id); if (el) el.textContent = val; };
    set('#est-instant', inst === null ? '—' : `${formatNum(inst)} A9`);
    set('#est-locked', lock === null ? '—' : `${formatNum(lock)} A9`);
    set('#est-total', est === null ? '—' : `~${formatNum(Math.round(est))} A9`);
  };

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between" style="margin-bottom:10px;">
          <span class="chip chip-gold">${L(`第 ${round.currentRound} 轮`, `Round ${round.currentRound}`)}</span>
          <span class="num-xs text-sec">${L('可用余额', 'Available')}: ${user.tonBalance === null || user.tonBalance === undefined ? L('未获取', 'Unavailable') : `${formatNum(user.tonBalance, 2)} GRAM`}</span>
        </div>
        <div class="input-box">
          <input id="stake-input" type="number" min="10" value="${amount}" aria-label="${L('参与金额', 'Stake amount')}" />
          <span class="caps text-sec">GRAM</span>
        </div>
        <div class="grid-4" style="margin-top:8px;">
          <button class="quick-btn ${amount === 100 ? 'active' : ''}" data-amt="100" type="button">100</button>
          <button class="quick-btn ${amount === 500 ? 'active' : ''}" data-amt="500" type="button">500</button>
          <button class="quick-btn ${amount === 1000 ? 'active' : ''}" data-amt="1000" type="button">1,000</button>
          <button class="quick-btn" data-amt="max" type="button">MAX</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:6px;">${icon('receipt', 15, 'text-green')} ${L('核对参与清单', 'Participation Checklist')}</div>
        <div class="check-list">
          <div class="check-row"><span class="text-sec">${L('参与金额 / 币种', 'Amount / Asset')}</span><span class="mono" id="chk-amt" style="font-weight:700;">${formatNum(amount)} GRAM</span></div>
          <div class="check-row"><span class="text-sec">${L('预计网络费用', 'Est. Network Fee')}</span><span class="mono text-sec">~0.06 GRAM</span></div>
          <div class="check-row"><span class="text-sec">${L('预计总奖励（估算）', 'Est. Total (est.)')}</span><span class="mono text-green" id="est-total" style="font-weight:700;">—</span></div>
          <div class="check-row"><span class="text-sec">${L('预计即时 / 待解锁', 'Est. immediate / locked')}</span><span class="mono num-xs"><span id="est-instant">—</span> / <span id="est-locked">—</span></span></div>
          <div class="check-row"><span class="text-sec">${L('目标底价 / 奖励上限', 'Target / Cap')}</span><span class="mono num-xs">${round.targetPrice === null ? L('待定', 'TBD') : '$' + round.targetPrice.toFixed(4)} · 15x</span></div>
        </div>
        <div class="num-xs text-muted" style="margin-top:8px;">${L('以上奖励为当前参与量估算，结算后以实际到账为准。', 'Estimated from current pool; settled on-chain at round close.')}</div>
      </div>

      ${!config.isDemo ? `
        <div class="card" id="live-readonly-stake-notice" style="border-color:var(--gold-border);">
          <div class="row-start" style="font-weight:600;margin-bottom:4px;">${icon('shieldAlert', 15, 'text-gold')} ${L('真实只读模式 · 暂未开放质押签名', 'Live Read-Only · Staking Disabled')}</div>
          <div class="num-xs text-sec" style="line-height:1.5;">${L('当前真实模式仅用于只读核验与钱包连接测试，主网合约与资金入口未开放，点击不会发起钱包签名或扣款。', 'Live mode is currently read-only for verification and wallet connection only. No signature or transfer will be triggered.')}</div>
        </div>
      ` : ''}

      <div class="risk-check" id="risk-consent-row" role="checkbox" aria-checked="false" tabindex="0">
        <span class="risk-box" id="risk-box-ic"></span>
        <span>${L('我已知晓：观察期 24 个时段需至少 16 个达标，未达标则本金按合约规则销毁；单轮奖励上限为实缴本金 15 倍。', 'I understand: 16 of 24 slots must qualify; otherwise principal is burned. Single-round reward is capped at 15x principal.')}</span>
      </div>

      ${store.fundsEnabled
        ? `<div id="stake-slider-mount"></div>
           <button class="btn btn-secondary" id="btn-confirm-accessible" type="button">${icon('check', 15)} <span id="acc-confirm-lbl">${L(`点击确认参与 ${formatNum(amount)} GRAM`, `Confirm ${formatNum(amount)} GRAM`)}</span></button>`
        : `<button class="btn btn-secondary" id="btn-confirm-accessible" type="button">${icon('lock', 15)} <span id="acc-confirm-lbl">${L('真实模式只读 · 暂未开放质押', 'Read-Only Mode · Staking Disabled')}</span></button>`
      }
    </div>
  `;

  const input = root.querySelector('#stake-input');
  const sliderMount = root.querySelector('#stake-slider-mount');
  const accBtn = root.querySelector('#btn-confirm-accessible');
  const accLbl = root.querySelector('#acc-confirm-lbl');
  const chkAmt = root.querySelector('#chk-amt');
  const riskRow = root.querySelector('#risk-consent-row');
  const riskBox = root.querySelector('#risk-box-ic');
  paintEstimate();

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
    paintEstimate();
    if (chkAmt) chkAmt.textContent = `${formatNum(amount)} GRAM`;
    if (accLbl && store.fundsEnabled) accLbl.textContent = L(`点击确认参与 ${formatNum(amount)} GRAM`, `Confirm ${formatNum(amount)} GRAM`);
    const maxBal = user.tonBalance !== null && user.tonBalance !== undefined ? Math.floor(Number(user.tonBalance) || 0) : 0;
    root.querySelectorAll('[data-amt]').forEach(b => {
      b.classList.toggle('active', b.dataset.amt === 'max' ? (maxBal > 0 && amount === maxBal) : Number(b.dataset.amt) === amount);
    });
    const sliderTxt = sliderMount?.querySelector('.slider-text');
    if (sliderTxt) {
      const next = L(`右滑确认参与 ${formatNum(amount)} GRAM`, `Slide to Stake ${formatNum(amount)} GRAM`);
      sliderTxt.textContent = next;
      sliderTxt.dataset.orig = next;
    }
  };

  input.oninput = (e) => syncAll(e.target.value);
  root.querySelectorAll('[data-amt]').forEach(btn => {
    btn.onclick = () => {
      A9Haptic.light();
      const maxBal = user.tonBalance !== null && user.tonBalance !== undefined ? Math.floor(Number(user.tonBalance) || 0) : 0;
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
    if (amount < 10) {
      showToast(L('最低参与 10 GRAM', 'Minimum 10 GRAM'), 'error');
      initSlider();
      return;
    }
    if (user.tonBalance !== null && user.tonBalance !== undefined && amount > Number(user.tonBalance)) {
      showToast(L('GRAM 余额不足', 'Insufficient GRAM balance'), 'error');
      initSlider();
      return;
    }

    submitting = true;
    if (accBtn) { accBtn.disabled = true; accLbl.textContent = L('确认中…', 'Confirming…'); }
    const sheet = openTransactionSheet(amount, () => navigate('/profile'));
    try {
      // 演示模式仅走 demo-data.js 模拟回执，绝不触碰已连接的真实钱包 SDK
      await tonConnect.sendStakeTransaction(amount, 'EQD_DEMO_A9_POOL');
      sheet.stage(2, L('演示确认中…', 'Demo confirming…'),
        L('演示模式已生成本地模拟回执，未触发真实钱包签名', 'Simulated receipt generated locally; no real wallet signature'));

      setTimeout(() => {
        const cert = store.stakeTon(amount);
        if (!cert) {
          sheet.done(L('参与失败 · 资金未扣款', 'Failed · No funds deducted'), L('未生成质押凭证，可关闭后重试', 'No certificate created, close and retry'), 'error');
          submitting = false;
          if (accBtn) { accBtn.disabled = false; syncAll(amount); }
          initSlider();
          return;
        }
        A9Audio.confirm();
        sheet.done(L('演示结果 · 已确认', 'Demo · Confirmed'),
          `${cert.id} · ${formatNum(cert.stakeTon, 2)} GRAM`);
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
      label: L(`右滑确认参与 ${formatNum(amount)} GRAM`, `Slide to Stake ${formatNum(amount)} GRAM`),
      onConfirm: handleConfirmSubmit
    });
  };

  if (accBtn) accBtn.onclick = handleConfirmSubmit;
  initSlider();
}

export function renderParticipateSuccess(root, navigate, certId) {
  const cert = store.state.certificates.find(c => c.id === certId) || store.state.certificates[0];
  if (!cert) {
    root.innerHTML = `<div class="col-gap"><div class="card empty-state"><div class="num-sm text-sec">${L('暂无可展示的质押凭证', 'No certificate to show')}</div></div><button class="btn btn-secondary" data-nav="/profile">${L('返回我的', 'Back to Vault')}</button></div>`;
    return;
  }
  const shareUrl = `${window.location.origin}${window.location.pathname}?startapp=proof_${cert.id.replace('A9-STAKE-', '')}`;

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="cert-pass cert-detail-card" style="text-align:center;">
        <span class="cert-corner tl"></span><span class="cert-corner tr"></span>
        <span class="cert-corner bl"></span><span class="cert-corner br"></span>
        <div class="icon-badge neon" style="width:50px;height:50px;margin:0 auto 10px;border-radius:14px;">${icon('checkCircle', 26)}</div>
        <div style="font-size:18px;font-weight:700;">${L('参与成功 · 质押凭证已生成', 'Participation Confirmed')}</div>
        <div class="num-lg text-green" style="margin:6px 0;">${formatNum(cert.stakeTon, 2)} GRAM · ${cert.multiplier.toFixed(1)}x</div>
        <div class="num-xs text-sec clickable" id="copy-tx">#${cert.id} ${icon('copy', 12)}</div>
        <div class="num-xs text-muted" style="margin-top:4px;">${config.isDemo ? L('演示模式 · 凭证与哈希为模拟数据', 'DEMO · certificate and hash are simulated') : L('等待链上确认后开放凭证分享', 'Proof sharing opens after on-chain confirmation')}</div>
      </div>

      <button class="btn btn-primary" id="share-cert-btn">${icon('send', 15)} ${L('分享战绩 · 邀请奖励 12%', 'Share · 12% Referral')}</button>
      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/proof/${cert.id}">${icon('shieldCheck', 15)} ${L('质押凭证', 'View Proof')}</button>
        <button class="btn btn-secondary" data-nav="/profile">${icon('wallet', 15)} ${L('返回我的', 'Vault')}</button>
      </div>
    </div>
  `;

  root.querySelector('#copy-tx').onclick = () => copyText(cert.txHash, L('已复制哈希', 'Copied Hash'));
  root.querySelector('#share-cert-btn').onclick = () => {
    A9TMA.shareInvite(shareUrl, `A9 #${cert.id}`);
    showToast(L('已生成分享链接', 'Share link ready'));
  };
}
