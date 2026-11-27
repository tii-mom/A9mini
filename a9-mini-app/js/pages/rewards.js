/**
 * 我的奖励（#/rewards，合并 #/claim 最终形态）
 *
 * 布局与红线：
 * - 资产区：主值「可领取」独占整行（完整数字不缩写、nowrap）；下一行两列「待激活 / 解锁中（14 天）」，旁附服务端激活规则与去向说明。
 * - 统一收口：轮次奖励（14 天逐秒解锁 / 止损退本 / 异常中止退本）与推广奖励（6% 商城 + 8% 通关）均在本页领取。
 * - 首屏零 GRAM 费用行；点击领取后、唤起钱包前弹出 4 项确认层（领取金额 / 需预附 GRAM / 实际网络费 / 退回规则），缺任意一项显示「待确认」并禁用继续。
 * - 3 折急提收进单条记录的二级折叠入口，明确提示「30% 秒提 + 70% 销毁」。
 * - 零奖励时展示清晰引导与「去闯关」「宝箱商城」入口；只读提示仅保留在领取按钮上，无黄色大框；全页 btn-primary <= 1。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, openModal, closeModal } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect, canonicalWalletKey } from '../tonconnect.js';
import {
  fetchUserPortfolio,
  fetchPromoBalance,
  fetchPredictionUser,
  requestPromoClaimIntent,
  fetchPromoClaim,
  getEffectiveUserId,
  rawToA9,
  serverNowMs,
  PROTOCOL_SPECS,
} from '../data.js';
import { deriveRoundUiState } from '../round-state.js';
import { pendingTxManager } from '../tx-ux.js';

let rewardsPageSeq = 0;

function formatExactGramFromNano(nanoVal) {
  try {
    const bi = BigInt(String(nanoVal ?? ''));
    if (bi <= 0n) return null;
    const whole = bi / 1000000000n;
    const frac = (bi % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole.toString()}.${frac}` : whole.toString();
  } catch (_) {
    return null;
  }
}

function safeRawBigInt(val) {
  return typeof val === 'string' && /^\d+$/.test(val.trim()) ? BigInt(val.trim()) : null;
}

function fmtA9Exact(val, { loading = false, unavailable = false } = {}) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    if (loading) return L('加载中…', 'Loading…');
    if (unavailable) return L('暂不可用', 'Unavailable');
    return '—';
  }
  const n = Number(val);
  const digits = Math.abs(n % 1) < 1e-9 ? 0 : 2;
  return `${formatNum(n, digits)} A9`;
}

function isMissingConfirmField(val) {
  if (val === null || val === undefined) return true;
  const s = String(val).trim();
  if (!s) return true;
  return /^(?:待确认|pending|tbd|—|-|null|undefined)$/i.test(s);
}

/**
 * 构造领取前 4 项透明确认模型（纯函数，供单测直接验证缺项禁用守卫）。
 * 必含 4 项：领取金额 / 需预附 GRAM / 实际网络费 / 退回规则。
 * 任意一项缺失则显示「待确认」并禁止继续（canContinue = false）。
 */
export function buildClaimConfirmModel({
  title,
  claimAmountText,
  attachGramLabel = '',
  attachGramText,
  actualNetworkFeeText,
  refundRuleText,
  extraWarning = '',
  confirmText = '',
} = {}) {
  const pendingLabel = L('待确认', 'Pending');
  const rows = [
    {
      key: 'claimAmount',
      label: L('领取金额', 'Claim Amount'),
      value: isMissingConfirmField(claimAmountText) ? pendingLabel : String(claimAmountText).trim(),
      missing: isMissingConfirmField(claimAmountText),
    },
    {
      key: 'attachGram',
      label: attachGramLabel || L('需预附 GRAM（网络手续费，多退）', 'GRAM Attached (Network Fee, Excess Refunded)'),
      value: isMissingConfirmField(attachGramText) ? pendingLabel : String(attachGramText).trim(),
      missing: isMissingConfirmField(attachGramText),
    },
    {
      key: 'actualNetworkFee',
      label: L('实际网络费', 'Estimated Network Fee'),
      value: isMissingConfirmField(actualNetworkFeeText) ? pendingLabel : String(actualNetworkFeeText).trim(),
      missing: isMissingConfirmField(actualNetworkFeeText),
    },
    {
      key: 'refundRule',
      label: L('退回规则', 'Refund Rule'),
      value: isMissingConfirmField(refundRuleText) ? pendingLabel : String(refundRuleText).trim(),
      missing: isMissingConfirmField(refundRuleText),
    },
  ];
  const missingKeys = rows.filter((r) => r.missing).map((r) => r.key);
  const canContinue = missingKeys.length === 0;
  return {
    title: title || L('确认领取明细', 'Confirm Claim Details'),
    rows,
    missingKeys,
    canContinue,
    extraWarning: extraWarning ? String(extraWarning).trim() : '',
    confirmText: confirmText || L('确认并前往钱包签名', 'Confirm & Sign in Wallet'),
    blockedHint: canContinue
      ? ''
      : L('部分费用或金额参数仍待确认，暂不可继续发起签名。', 'Some required details are still pending confirmation; signing is disabled.'),
  };
}

/**
 * 唤起领取前 4 项确认弹层；返回 Promise<boolean>（true=用户确认继续，false=取消或被缺项守卫阻止）。
 */
export function openRewardsClaimConfirmModal(spec = {}) {
  const model = buildClaimConfirmModel(spec);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, { close = true } = {}) => {
      if (settled) return;
      settled = true;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('a9:interaction-idle', onIdle);
      }
      if (close) closeModal();
      resolve(Boolean(ok));
    };
    const onIdle = () => finish(false, { close: false });

    openModal(`
      <div id="rewards-claim-confirm-sheet" class="col-gap" style="gap:10px;">
        <div class="sheet-handle"></div>
        <div class="row-between">
          <div class="card-title">${icon('shieldCheck', 17, 'text-red')} ${escapeHtml(model.title)}</div>
        </div>
        <div class="rewards-confirm-table">
          ${model.rows.map((r) => `
            <div class="rewards-confirm-row">
              <span class="rewards-confirm-label">${escapeHtml(r.label)}</span>
              <span class="rewards-confirm-val ${r.missing ? 'text-red' : 'mono'}">${escapeHtml(r.value)}</span>
            </div>
          `).join('')}
        </div>
        ${model.extraWarning ? `<div class="sub-tile num-xs text-red" style="border-color:var(--red-border, #F3B3B8);line-height:1.5;">${escapeHtml(model.extraWarning)}</div>` : ''}
        ${!model.canContinue ? `<div class="num-xs text-red" id="rewards-confirm-blocked">${escapeHtml(model.blockedHint)}</div>` : ''}
        <div class="col-gap" style="gap:8px;">
          <button class="btn ${model.canContinue ? 'btn-primary' : 'btn-secondary'}" id="rewards-confirm-ok" type="button" ${model.canContinue ? '' : 'disabled'}>
            ${icon(model.canContinue ? 'bolt' : 'lock', 15)} ${escapeHtml(model.canContinue ? model.confirmText : L('信息待确认 · 暂不可继续', 'Pending Details · Cannot Continue'))}
          </button>
          <button class="btn btn-secondary" id="rewards-confirm-cancel" type="button">${L('取消', 'Cancel')}</button>
        </div>
      </div>
    `);

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('a9:interaction-idle', onIdle);
    }

    const okBtn = typeof document !== 'undefined' ? document.getElementById('rewards-confirm-ok') : null;
    const cancelBtn = typeof document !== 'undefined' ? document.getElementById('rewards-confirm-cancel') : null;
    if (cancelBtn) cancelBtn.onclick = () => { A9Haptic.light(); finish(false); };
    if (okBtn && model.canContinue) {
      okBtn.onclick = () => { A9Haptic.medium(); finish(true); };
    }
  });
}

/**
 * 渲染单条奖励记录的状态标签（统一使用 deriveRoundUiState，绝不出现 StakeTicket / AbortRound 等工程词）。
 */
function resolveRecordStatus(t) {
  const stage = deriveRoundUiState({ detail: { rawState: t?.roundState }, user: { connected: true }, serverNowMs: serverNowMs() }).stage;
  const lockedRemA9 = rawToA9(t?.lockedRemainingRaw) ?? 0;
  const canClaim = typeof t?.canClaim === 'boolean' ? t.canClaim : !t?.pending;
  if (t?.pending) return { stage, chip: `<span class="chip chip-gold">${L('链上处理中', 'Pending')}</span>` };
  if (t?.exited) return { stage, chip: `<span class="chip chip-muted">${L('已提前解押', 'Early Exited')}</span>` };
  if (stage === 'failed') {
    return {
      stage,
      chip: canClaim
        ? `<span class="chip chip-green">${L('未达标 · 可领止损退本', 'Stop-Loss Refundable')}</span>`
        : `<span class="chip chip-muted">${L('已领止损退本', 'Stop-Loss Refunded')}</span>`,
    };
  }
  if (stage === 'aborted') {
    return {
      stage,
      chip: canClaim
        ? `<span class="chip chip-green">${L('异常中止 · 全额退本', 'Aborted · Full Refund')}</span>`
        : `<span class="chip chip-muted">${L('已退回本金', 'Refunded')}</span>`,
    };
  }
  if (stage === 'stake') return { stage, chip: `<span class="chip chip-gold">${L('24H 锁仓中', '24H Locking')}</span>` };
  if (stage === 'sealed') return { stage, chip: `<span class="chip chip-gold">${L('已封盘 · 待冲价', 'Sealed · Awaiting Push')}</span>` };
  if (stage === 'charge') return { stage, chip: `<span class="chip chip-gold">${L('12H 冲价中', '12H Pushing')}</span>` };
  if (stage === 'settling') return { stage, chip: `<span class="chip chip-gold">${L('结算中', 'Settling')}</span>` };
  if (canClaim) return { stage, chip: `<span class="chip chip-green">${L('可领取', 'Claimable')}</span>` };
  if (t?.forfeited) return { stage, chip: `<span class="chip chip-muted">${L('已 3 折急提结清', 'Instant Cashed Out')}</span>` };
  if (t?.principalDone) {
    return {
      stage,
      chip: `<span class="chip chip-muted">${lockedRemA9 > 0 ? L('14 天解锁中', '14D Unlocking') : L('已全部领完', 'Fully Claimed')}</span>`,
    };
  }
  return { stage, chip: `<span class="chip chip-cyan">${L('持有中', 'Active')}</span>` };
}

/**
 * 渲染「我的奖励」最终形态（供 #/rewards 与 #/claim 共同调用）。
 */
export function renderMyRewardsPage(root, _navigate, _param, query = {}) {
  const seq = ++rewardsPageSeq;
  const selectedTicket = query?.ticket || null;
  const isLive = !config.isDemo;

  const state = {
    loading: isLive && Boolean(store.state.user.address || getEffectiveUserId(store.state.user)),
    portfolio: null,
    portfolioError: null,
    promo: null,
    promoError: null,
    prediction: null,
    predictionError: null,
    claimingTicketAddr: null,
    promoBusy: false,
    lastPromoClaim: null,
  };

  const computeNumbers = () => {
    const { user, prediction } = store.state;
    if (!isLive) {
      const isEmpty = user.profileMode === 'empty';
      const roundClaimable = isEmpty ? 0 : Number(user.a9Claimable || 0);
      const promoClaimable = isEmpty ? 0 : Number(user.promoClaimableA9 || 0);
      const pendingAct = isEmpty ? 0 : (rawToA9(prediction?.pendingActivationRaw) ?? 0);
      const unlocking = isEmpty ? 0 : Number(user.a9Locked || 0);
      return {
        hasWallet: true,
        roundClaimable,
        promoClaimable,
        totalClaimable: roundClaimable + promoClaimable,
        pendingActivation: pendingAct,
        unlocking14d: unlocking,
        promoClaimed: isEmpty ? 0 : Number(user.promoClaimedA9 || 0),
        tickets: isEmpty ? [] : (store.state.certificates || []).map((c, idx) => ({
          ticketAddress: c.id || `demo-pass-${idx + 1}`,
          roundId: c.round ?? (idx + 1),
          roundState: c.status === 'passed' ? 'SUCCEEDED' : c.status === 'failed' ? 'FAILED_PERMANENT' : 'OBSERVING',
          amountRaw: String(Math.round(Number(c.stakeTon || 0) * 1e9)),
          claimablePrincipalRaw: c.status === 'passed' ? String(Math.round(Number(c.stakeTon || 0) * 1e9)) : '0',
          claimableRewardRaw: idx === 0 ? String(Math.round(roundClaimable * 1e9)) : '0',
          claimableTotalRaw: idx === 0 ? String(Math.round(roundClaimable * 1e9)) : '0',
          lockedRemainingRaw: idx === 0 ? String(Math.round(unlocking * 1e9)) : '0',
          instantCashoutTotalRaw: idx === 0 ? String(Math.round((roundClaimable + unlocking * 0.3) * 1e9)) : '0',
          instantCashoutBurnRaw: idx === 0 ? String(Math.round((unlocking * 0.7) * 1e9)) : '0',
          canClaim: idx === 0 && roundClaimable > 0,
          canInstantCashout: idx === 0 && unlocking > 0,
          canEarlyExit: false,
          principalDone: idx === 0 && roundClaimable === 0 && unlocking > 0,
        })),
        knownAllZero: isEmpty || (roundClaimable === 0 && promoClaimable === 0 && pendingAct === 0 && unlocking === 0),
        dataUnavailable: false,
      };
    }

    const hasWallet = Boolean(user.connected && user.address);
    const hasUid = Boolean(getEffectiveUserId(user));
    const portfolioReady = Boolean(state.portfolio && state.portfolio.ticketsAvailable !== false);
    const tickets = portfolioReady && Array.isArray(state.portfolio?.tickets) ? [...state.portfolio.tickets] : [];
    if (selectedTicket) {
      tickets.sort((a, b) => Number(b.ticketAddress === selectedTicket) - Number(a.ticketAddress === selectedTicket));
    }

    // 严格 P0-G：严禁在 ticketsAvailable=false 或 claimableRaw/lockedRaw 为 null 时用 reduce 伪造 0
    const roundClaimable = portfolioReady && state.portfolio.claimableRaw != null
      ? rawToA9(state.portfolio.claimableRaw)
      : null;
    const unlocking14d = portfolioReady && state.portfolio.lockedRaw != null
      ? rawToA9(state.portfolio.lockedRaw)
      : null;
    const promoClaimable = state.promo && !state.promoError
      ? (rawToA9(state.promo.claimableRaw ?? state.promo.availableRaw) ?? null)
      : null;
    const promoClaimed = state.promo && !state.promoError
      ? (rawToA9(state.promo.totalClaimedRaw) ?? null)
      : null;
    // 未查询 prediction（无 uid）或查询失败时严格保持 null，严禁伪造 0 A9
    const pendingActivation = (hasUid && state.prediction && !state.predictionError && state.prediction.pendingActivationRaw != null)
      ? rawToA9(state.prediction.pendingActivationRaw)
      : null;

    let totalClaimable = null;
    if (roundClaimable !== null && promoClaimable !== null) {
      totalClaimable = roundClaimable + promoClaimable;
    }

    const pendingConfirmedZero = !hasUid || (!state.predictionError && pendingActivation === 0);
    const knownAllZero = Boolean(
      hasWallet &&
      !state.loading &&
      portfolioReady &&
      !state.portfolioError &&
      !state.promoError &&
      totalClaimable === 0 &&
      unlocking14d === 0 &&
      pendingConfirmedZero
    );

    return {
      hasWallet,
      hasUid,
      portfolioReady,
      roundClaimable,
      promoClaimable,
      totalClaimable,
      pendingActivation,
      unlocking14d,
      promoClaimed,
      tickets,
      knownAllZero,
      dataUnavailable: Boolean(state.portfolioError || state.promoError || (state.portfolio && state.portfolio.ticketsAvailable === false)),
    };
  };

  const paint = () => {
    if (seq !== rewardsPageSeq || !root.isConnected) return;
    const data = computeNumbers();
    const canLiveSign = !isLive || store.fundsEnabled;
    const isReadOnlyLive = isLive && !store.fundsEnabled;
    const hasAnyError = Boolean(state.portfolioError || state.promoError || state.predictionError);

    // 严格保证整页 btn-primary <= 1
    let primaryUsed = false;
    const takeBtnClass = (wantPrimary) => {
      if (wantPrimary && !primaryUsed) {
        primaryUsed = true;
        return 'btn-primary';
      }
      return 'btn-secondary';
    };

    const claimableHeroDisplay = fmtA9Exact(data.totalClaimable, {
      loading: state.loading && data.hasWallet,
      unavailable: !state.loading && data.hasWallet && data.dataUnavailable,
    });
    const pendingDisplay = fmtA9Exact(data.pendingActivation, {
      loading: state.loading && data.hasUid,
      unavailable: !state.loading && data.hasUid && Boolean(state.predictionError),
    });
    const unlockingDisplay = fmtA9Exact(data.unlocking14d, {
      loading: state.loading && data.hasWallet,
      unavailable: !state.loading && data.hasWallet && (Boolean(state.portfolioError) || Boolean(state.portfolio && state.portfolio.ticketsAvailable === false)),
    });

    const firstClaimableTicket = data.tickets.find((t) => Boolean(t.canClaim) && !t.pending);
    const hasClaimablePromo = data.promoClaimable !== null && Number(data.promoClaimable) > 0;
    const claimLocked = pendingTxManager.isLocked('claim');
    const promoLocked = pendingTxManager.isLocked('promo');

    // 顶部主按钮逻辑：仅未连接钱包时放「连接钱包」主按钮；只读提示合并在下方领取按钮本身，绝不重复堆砌或放黄色大框
    let topCtaHtml = '';
    if (isLive && !data.hasWallet) {
      topCtaHtml = `<button class="btn ${takeBtnClass(true)}" id="btn-rewards-connect" type="button">${icon('wallet', 16)} ${L('连接钱包查看我的奖励', 'Connect Wallet to View Rewards')}</button>`;
    }

    const zeroGuideHtml = data.knownAllZero ? `
      <section class="card col-gap" id="rewards-zero-guide">
        <div class="card-title">${icon('trophy', 16, 'text-red')} ${L('暂无可领奖励 · 这样获得 A9', 'No Rewards Yet · How to Earn A9')}</div>
        <div class="num-xs text-sec" style="line-height:1.6;">
          ${L(
            '1. 参与闯关锁仓，冲价达标即可按份瓜分本轮奖池（20% 秒提 + 80% 分 14 天逐秒解锁）。<br/>2. 前往宝箱商城购箱，本金与加赠合并直发钱包。<br/>3. 邀请好友参与，可赚取 6% 商城返佣与 8% 通关奖金返佣。',
            '1. Lock A9 in a Quest round to split the pool on pass (20% instant + 80% over 14 days).<br/>2. Open chests in Chest Mall for direct wallet payouts.<br/>3. Invite friends to earn 6% Chest Mall + 8% Quest pass credits.'
          )}
        </div>
        <div class="grid-2" style="gap:8px;">
          <a class="btn ${takeBtnClass(true)}" href="#/round">${icon('bolt', 15)} ${L('去闯关', 'Go to Quest')}</a>
          <a class="btn btn-secondary" href="#/market">${icon('chest', 15)} ${L('宝箱商城', 'Chest Mall')}</a>
        </div>
      </section>
    ` : '';

    let promoBtnDisabled = false;
    let promoBtnLabel = '';
    if (isReadOnlyLive) {
      promoBtnDisabled = true;
      promoBtnLabel = L('当前只读 · 推广领取暂未开放', 'Read-Only · Referral Claim Disabled');
    } else if (!data.hasWallet) {
      promoBtnDisabled = true;
      promoBtnLabel = L('连接钱包后领取推广奖励', 'Connect Wallet to Claim');
    } else if (state.loading) {
      promoBtnDisabled = true;
      promoBtnLabel = L('读取推广余额中…', 'Loading Referral Balance…');
    } else if (state.promoError || data.promoClaimable === null) {
      promoBtnDisabled = true;
      promoBtnLabel = L('推广余额暂不可用', 'Referral Balance Unavailable');
    } else if (promoLocked) {
      promoBtnDisabled = true;
      promoBtnLabel = L('推广发放确认中…', 'Referral Payout Confirming…');
    } else if (state.promoBusy) {
      promoBtnDisabled = true;
      promoBtnLabel = L('准备领取明细中…', 'Preparing Claim Details…');
    } else if (hasClaimablePromo) {
      promoBtnDisabled = false;
      promoBtnLabel = L('领取推广奖励', 'Claim Referral Rewards');
    } else {
      promoBtnDisabled = true;
      promoBtnLabel = L('暂无可领推广奖励', 'No Referral Rewards Claimable');
    }
    const promoBtnCls = takeBtnClass(!isReadOnlyLive && !firstClaimableTicket && hasClaimablePromo && !promoBtnDisabled);

    root.innerHTML = `
      <div class="col-gap anim-page-enter" id="my-rewards-page">
        <section class="card card-hero col-gap">
          <div>
            <div class="num-xs text-muted">${L('可领取', 'Claimable Now')}</div>
            <div class="rewards-hero-amount mono" id="rewards-claimable-hero">${escapeHtml(claimableHeroDisplay)}</div>
          </div>

          <div class="rewards-dual-row">
            <div class="rewards-stat-box">
              <span class="num-xs text-muted">${L('待激活', 'Pending Activation')}</span>
              <strong class="mono rewards-stat-val">${escapeHtml(pendingDisplay)}</strong>
            </div>
            <div class="rewards-stat-box">
              <span class="num-xs text-muted">${L('解锁中（14 天）', 'Unlocking (14D)')}</span>
              <strong class="mono rewards-stat-val">${escapeHtml(unlockingDisplay)}</strong>
            </div>
          </div>

          <div class="rewards-activation-note">
            <div class="num-xs text-sec" style="line-height:1.55;">
              <strong>${L('待激活规则与去向：', 'Activation & Destination: ')}</strong>${L(
                '完成任一条件自动激活——购任意宝箱、参与链上锁仓或邀 1 位好友购箱；激活后进入「可领取」推广余额，48 小时未激活自动作废并回流奖池。',
                'Auto-activates after buying any chest, locking A9 in a round, or inviting 1 friend who buys a chest. Activated rewards move to Claimable; unactivated balance expires after 48h and returns to the pool.'
              )}
            </div>
          </div>

          <div class="num-xs text-muted" style="line-height:1.5;">
            ${L(
              '通关后本金 100% 退回 + 20% 奖金秒提，余下 80% 分 14 天逐秒解锁（每日 +5.71%，永久累计不倒扣）。具体网络手续费（多退）将在点击领取后的确认层完整展示。',
              'On pass: 100% principal + 20% reward instant, remaining 80% unlocks per second over 14 days (+5.71%/day, never forfeited). Exact network fees (excess refunded) appear in the confirmation sheet before signing.'
            )}
          </div>

          ${hasAnyError ? `
            <div class="sw-menu-error" role="alert">
              <span>${escapeHtml(state.portfolioError || state.promoError || state.predictionError || L('读取奖励数据失败', 'Failed to read reward data'))}</span>
              <button type="button" class="sw-retry-link" id="btn-rewards-retry">${L('重试', 'Retry')}</button>
            </div>
          ` : ''}

          ${topCtaHtml}
        </section>

        ${zeroGuideHtml}

        <section class="card col-gap" id="rewards-promo-section">
          <div class="row-between">
            <span class="card-title">${icon('team', 16, 'text-red')} ${L('推广奖励（6% 商城 + 8% 通关）', 'Referral Rewards (6% Mall + 8% Quest)')}</span>
            <span class="mono num-sm ${hasClaimablePromo ? 'text-green' : 'text-muted'}" style="white-space:nowrap;">${escapeHtml(fmtA9Exact(data.promoClaimable, { loading: state.loading && data.hasWallet, unavailable: Boolean(state.promoError) }))}</span>
          </div>
          <div class="num-xs text-sec" style="line-height:1.5;">
            ${L('好友购箱直推返佣 6% 与好友闯关通关奖金返佣 8% 合并在此领取；累计已领：', '6% Chest Mall referrals and 8% friend Quest pass credits combine here. Total claimed: ')}
            <b class="mono" style="white-space:nowrap;">${escapeHtml(fmtA9Exact(data.promoClaimed, { loading: state.loading && data.hasWallet }))}</b>
          </div>
          ${state.lastPromoClaim ? `<div class="num-xs text-green mono">${L('最近发放单', 'Latest payout')}: ${escapeHtml(state.lastPromoClaim.claimId)} · ${escapeHtml(state.lastPromoClaim.status)}</div>` : ''}
          <button class="btn ${promoBtnCls}" id="btn-rewards-claim-promo" type="button" ${promoBtnDisabled ? 'disabled' : ''}>
            ${icon(isReadOnlyLive ? 'lock' : 'wallet', 15)} ${escapeHtml(promoBtnLabel)}
          </button>
        </section>

        <section class="col-gap" style="gap:8px;" id="rewards-records-section">
          <div class="row-between" style="padding:0 2px;">
            <span class="sw-section-label" style="margin:0;">${L('我的奖励记录', 'My Reward Records')}</span>
            ${data.hasWallet ? `<button class="sw-retry-link" id="btn-rewards-refresh" type="button">${L('刷新', 'Refresh')}</button>` : ''}
          </div>

          ${!data.hasWallet ? `
            <div class="card num-xs text-sec">${L('连接钱包后可查看各轮次本金、解锁进度与领取记录。', 'Connect your wallet to inspect per-round principal, unlock progress, and claim records.')}</div>
          ` : state.loading ? `
            <div class="card num-xs text-muted">${L('正在读取我的奖励记录…', 'Loading my reward records…')}</div>
          ` : state.portfolioError ? `
            <div class="card num-xs text-red">${escapeHtml(state.portfolioError)}</div>
          ` : data.tickets.length === 0 ? `
            <div class="card num-xs text-sec">${L('当前暂无轮次奖励记录。', 'No round reward records yet.')}</div>
          ` : data.tickets.map((t) => {
            const { stage, chip } = resolveRecordStatus(t);
            const principalA9 = rawToA9(t.amountRaw);
            const claimableTotalA9 = rawToA9(t.claimableTotalRaw);
            const lockedRemA9 = rawToA9(t.lockedRemainingRaw);
            const cashoutTotalA9 = rawToA9(t.instantCashoutTotalRaw);
            const cashoutBurnA9 = rawToA9(t.instantCashoutBurnRaw);
            const earlyExitRefA9 = rawToA9(t.earlyExitRefundRaw);
            const earlyExitBurnA9 = rawToA9(t.earlyExitBurnRaw);
            const canClaim = Boolean(t.canClaim) && !t.pending && Number(claimableTotalA9 || 0) > 0;
            const canInstant = Boolean(t.canInstantCashout) && !t.pending && Number(lockedRemA9 || 0) > 0;
            const canEarlyExit = Boolean(t.canEarlyExit) && !t.pending;
            const isBusy = state.claimingTicketAddr === t.ticketAddress;
            const claimDisabled = isReadOnlyLive || !canClaim || isBusy || claimLocked;
            const claimBtnCls = takeBtnClass(!isReadOnlyLive && canClaim && !claimDisabled);
            const pctStr = (t.unlockedPctBps !== null && t.unlockedPctBps !== undefined && Number.isFinite(Number(t.unlockedPctBps)))
              ? `${(Number(t.unlockedPctBps) / 100).toFixed(1)}%`
              : null;

            let claimLabel = L('领取', 'Claim');
            if (isReadOnlyLive) claimLabel = L('当前只读 · 暂未开放领取', 'Read-Only · Claim Disabled');
            else if (isBusy) claimLabel = L('等待钱包签名…', 'Awaiting Signature…');
            else if (claimLocked) claimLabel = L('交易确认中…', 'Confirming…');
            else if (!canClaim) {
              if (stage === 'stake') claimLabel = L('24H 锁仓期内，待结算后领取', 'In 24H Lock Window');
              else if (stage === 'sealed' || stage === 'charge') claimLabel = L('12H 冲价进行中，暂不可领', '12H Push Active');
              else if (stage === 'settling') claimLabel = L('结算中，完成后开放领取', 'Settling · Opens Soon');
              else claimLabel = L('当前无可领金额', 'Nothing Claimable');
            } else if (stage === 'failed') {
              claimLabel = L('领取止损退本', 'Claim Stop-Loss Refund');
            } else if (stage === 'aborted') {
              claimLabel = L('取回全部本金', 'Refund Full Principal');
            }

            return `
              <article class="card col-gap" data-reward-record="${escapeHtml(t.ticketAddress)}">
                <div class="row-between">
                  <strong class="num-sm">${L(`第 ${escapeHtml(String(t.roundId ?? '—'))} 轮`, `Round #${escapeHtml(String(t.roundId ?? '—'))}`)}</strong>
                  ${chip}
                </div>
                <div class="check-list">
                  <div class="check-row">
                    <span class="text-sec">${L('锁仓本金', 'Locked Principal')}</span>
                    <b class="mono" style="white-space:nowrap;">${escapeHtml(fmtA9Exact(principalA9))}</b>
                  </div>
                  <div class="check-row">
                    <span class="text-sec">${L('当前可领', 'Claimable Now')}</span>
                    <b class="mono ${Number(claimableTotalA9) > 0 ? 'text-green' : 'text-muted'}" style="white-space:nowrap;">${escapeHtml(fmtA9Exact(claimableTotalA9))}</b>
                  </div>
                  ${Number(lockedRemA9) > 0 ? `
                    <div class="check-row">
                      <span class="text-sec">${pctStr ? L(`解锁中（已解 ${pctStr}）`, `Unlocking (${pctStr} vested)`) : L('解锁中（14 天）', 'Unlocking (14D)')}</span>
                      <b class="mono text-gold" style="white-space:nowrap;">${escapeHtml(fmtA9Exact(lockedRemA9))}</b>
                    </div>
                  ` : ''}
                </div>

                <button class="btn ${claimBtnCls} btn-sm" data-claim-record="${escapeHtml(t.ticketAddress)}" type="button" ${claimDisabled ? 'disabled' : ''}>
                  ${icon(isReadOnlyLive ? 'lock' : 'wallet', 14)} ${escapeHtml(claimLabel)}
                </button>

                ${(canInstant || canEarlyExit) ? `
                  <details class="rewards-secondary-fold">
                    <summary>${canInstant && canEarlyExit
                      ? L('更多操作（3 折急提 / 提前解押）', 'More Actions (Instant Cashout / Early Exit)')
                      : canInstant
                        ? L('更多操作（3 折急提）', 'More Actions (Instant Cashout)')
                        : L('更多操作（提前解押）', 'More Actions (Early Exit)')}</summary>
                    <div class="col-gap" style="gap:8px;margin-top:8px;">
                      ${canInstant ? `
                        <div class="num-xs text-sec" style="line-height:1.5;">
                          <strong class="text-red">${L('3 折急提：30% 秒提 + 70% 销毁。', 'Instant Cashout: 30% instant + 70% burned. ')}</strong>${L(
                            `已解锁部分仍 100% 实发，仅未解锁余额按 30% 秒提（预计实拿 ${fmtA9Exact(cashoutTotalA9)}）、70% 永久销毁（约 ${fmtA9Exact(cashoutBurnA9)}）且不可撤回。`,
                            `Vested rewards pay 100%; unvested split 30% instant (${fmtA9Exact(cashoutTotalA9)}) and 70% permanent burn (${fmtA9Exact(cashoutBurnA9)}).`
                          )}
                        </div>
                        <button class="btn btn-secondary btn-sm" data-instant-record="${escapeHtml(t.ticketAddress)}" type="button" ${(isReadOnlyLive || isBusy || claimLocked) ? 'disabled' : ''}>
                          ${icon('bolt', 13)} ${isReadOnlyLive ? L('当前只读 · 暂未开放 3 折急提', 'Read-Only · Disabled') : L('3 折急提（30% 秒提 + 70% 销毁）', 'Instant Cashout (30% Instant + 70% Burn)')}
                        </button>
                      ` : ''}
                      ${canEarlyExit ? `
                        <div class="num-xs text-sec" style="line-height:1.5;">
                          ${L(
                            `提前解押：退回 85% 本金（${fmtA9Exact(earlyExitRefA9)}），扣除 15%（${fmtA9Exact(earlyExitBurnA9)}）永久销毁，仅限 24H 锁仓期内操作。`,
                            `Early Exit refunds 85% principal (${fmtA9Exact(earlyExitRefA9)}) and burns 15% (${fmtA9Exact(earlyExitBurnA9)}) during the 24H lock window.`
                          )}
                        </div>
                        <button class="btn btn-secondary btn-sm" data-early-exit-record="${escapeHtml(t.ticketAddress)}" type="button" ${(isReadOnlyLive || isBusy || claimLocked) ? 'disabled' : ''}>
                          ${icon('flame', 13)} ${isReadOnlyLive ? L('当前只读 · 暂未开放提前解押', 'Read-Only · Disabled') : L('提前解押（退 85% 本金）', 'Early Exit (85% Refund)')}
                        </button>
                      ` : ''}
                    </div>
                  </details>
                ` : ''}
              </article>
            `;
          }).join('')}
        </section>

        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/rules#audit">
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('查看合约地址', 'View Contract Addresses')}</span>
              <span class="sw-menu-sub">${L('透明可查 · 轮次异常 7 天后可无损取回本金', 'Transparent on-chain · Full principal refund after 7 days if a round aborts')}</span>
            </div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/profile">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回我的', 'Back to Me')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;

    // 绑定基础交互
    const connBtn = root.querySelector('#btn-rewards-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderMyRewardsPage(root, _navigate, _param, query));

    const retryBtn = root.querySelector('#btn-rewards-retry');
    if (retryBtn) retryBtn.onclick = () => loadAll();

    const refBtn = root.querySelector('#btn-rewards-refresh');
    if (refBtn) refBtn.onclick = () => loadAll();

    // 绑定推广奖励领取（6% 商城 + 8% 通关）
    const promoBtn = root.querySelector('#btn-rewards-claim-promo');
    if (promoBtn && !promoBtn.disabled) {
      promoBtn.onclick = async () => {
        if (!canLiveSign) {
          showToast(L('当前只读模式，暂未开放领取签名', 'Read-only mode; claiming is disabled'), 'amber');
          return;
        }
        if (!isLive) {
          const demoAmt = Number(store.state.user.promoClaimableA9 || 0);
          const ok = await openRewardsClaimConfirmModal({
            title: L('确认领取推广奖励（演示）', 'Confirm Referral Claim (Demo)'),
            claimAmountText: demoAmt > 0 ? fmtA9Exact(demoAmt) : null,
            attachGramLabel: L('需预附 GRAM（固定领币费）', 'GRAM Attached (Fixed Claim Fee)'),
            attachGramText: '0.06 GRAM',
            actualNetworkFeeText: L('0.06 GRAM（固定领币费，演示模拟）', '0.06 GRAM (fixed fee, demo)'),
            refundRuleText: L('固定领币费按单收取，发放后不按实际成本退差；异常未发放时奖励余额原样保留', 'Fixed per-order fee; reward balance stays intact if payout fails'),
            confirmText: L('确认领取（演示）', 'Confirm Claim (Demo)'),
          });
          if (!ok) return;
          const res = store.claimPromoDemo();
          if (res?.error) showToast(res.error, 'amber');
          else showToast(L(`[演示模式] 已领取推广奖励 ${formatNum(res.amountA9)} A9`, `[Demo] Claimed ${formatNum(res.amountA9)} A9 referral rewards`));
          paint();
          return;
        }

        const wallet = store.state.user.address;
        if (!store.state.user.connected || !wallet) {
          tonConnect.openConnectModal(() => loadAll());
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }

        state.promoBusy = true;
        paint();
        try {
          const intent = await requestPromoClaimIntent(wallet);
          const expectedPromoHot = store.state.round?.protocolConfig?.promoHotWallet?.address || '';
          if (expectedPromoHot && canonicalWalletKey(intent?.payTo) !== canonicalWalletKey(expectedPromoHot)) {
            throw new Error(L('领奖目标热钱包地址与协议配置不一致，已拦截签名', 'Promo hot wallet mismatch with protocol config; blocked'));
          }
          const feeGram = formatExactGramFromNano(intent?.feeRequiredNano);
          const payoutA9 = rawToA9(intent?.amountRaw ?? state.promo?.claimableRaw);
          const ok = await openRewardsClaimConfirmModal({
            title: L('确认领取推广奖励', 'Confirm Referral Claim'),
            claimAmountText: payoutA9 != null && payoutA9 > 0 ? fmtA9Exact(payoutA9) : null,
            attachGramLabel: L('需预附 GRAM（固定领币费）', 'GRAM Attached (Fixed Claim Fee)'),
            attachGramText: feeGram ? `${feeGram} GRAM` : null,
            actualNetworkFeeText: feeGram
              ? L(`${feeGram} GRAM（固定领币费，钱包发起费另计）`, `${feeGram} GRAM (fixed claim fee; wallet sending fee separate)`)
              : null,
            refundRuleText: L('固定领币费按单收取，发放后不按成本退差；超时未完成则奖励余额保留可重试', 'Fixed per-order fee without cost rebate; reward balance stays safe if expired'),
            confirmText: L('确认并前往钱包签名', 'Confirm & Sign in Wallet'),
          });
          if (!ok) return;

          await tonConnect.sendV15PromoFee(intent);
          A9Haptic.success();
          showToast(L('已发起推广领币转账，正在核验自动发放…', 'Referral claim fee sent, awaiting automatic A9 payout…'));
          const pendingTx = pendingTxManager.start({
            kind: 'promo',
            title: '推广奖励发放',
            titleEn: 'Referral A9 Payout',
            amountText: fmtA9Exact(payoutA9),
            explorerAddress: intent.payTo,
            refId: intent.claimId,
            targetRoute: '/rewards',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const c = await fetchPromoClaim(intent.claimId);
              if (c) {
                state.lastPromoClaim = c;
                paint();
                if (c.status === 'COMPLETED') {
                  return {
                    confirmed: true,
                    detail: '推广奖励已自动发放至钱包。',
                    detailEn: 'Referral A9 rewards credited on-chain.',
                  };
                }
                if (c.status === 'FAILED' || c.status === 'EXPIRED') return { terminal: true, claim: c };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('推广奖励已到账！', 'Referral rewards credited!'));
              loadAll();
            },
            onTimeout: () => {
              showToast(L('发放确认耗时较长，可稍后刷新查看', 'Payout confirming slowly; refresh later'), 'amber');
            },
          });
          await loadAll();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('领取推广奖励失败，请重试', 'Referral claim failed'), 'error');
        } finally {
          state.promoBusy = false;
          paint();
        }
      };
    }

    // 绑定单条轮次奖励领取（含 4 项确认层）
    root.querySelectorAll('[data-claim-record]').forEach((btn) => {
      btn.onclick = async () => {
        const ticketAddr = btn.dataset.claimRecord;
        const ticket = data.tickets.find((item) => item.ticketAddress === ticketAddr);
        if (!ticket || btn.disabled) return;
        const claimableTotalA9 = rawToA9(ticket.claimableTotalRaw);
        const ok = await openRewardsClaimConfirmModal({
          title: L(`确认领取第 ${ticket.roundId ?? '—'} 轮奖励`, `Confirm Round #${ticket.roundId ?? '—'} Claim`),
          claimAmountText: claimableTotalA9 != null && claimableTotalA9 > 0 ? fmtA9Exact(claimableTotalA9) : null,
          attachGramText: '0.22 GRAM',
          actualNetworkFeeText: L('约 0.03–0.06 GRAM（以链上实际消耗为准，钱包发起费另计）', '~0.03–0.06 GRAM actual chain gas (wallet sending fee separate)'),
          refundRuleText: L('扣除实际链上费用与必要留存后，剩余 GRAM 自动原路退回钱包（多退）', 'Excess GRAM after actual gas & reserves automatically refunds to your wallet'),
          confirmText: isLive ? L('确认并前往钱包签名', 'Confirm & Sign in Wallet') : L('确认领取（演示）', 'Confirm Claim (Demo)'),
        });
        if (!ok) return;

        if (!isLive) {
          A9Audio.chestOpen();
          const claimed = store.claimRewards();
          showToast(L(`[演示模式] 已领取 ${formatNum(claimed)} A9`, `[Demo] Claimed ${formatNum(claimed)} A9`));
          paint();
          return;
        }

        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        const prevBalanceRaw = safeRawBigInt(state.portfolio?.a9BalanceRaw);
        state.claimingTicketAddr = ticketAddr;
        paint();
        try {
          await tonConnect.sendV15TicketClaim(ticketAddr);
          A9Haptic.success();
          A9Audio.confirm();
          showToast(L('已提交领取交易，正在核验链上到账…', 'Claim transaction submitted, awaiting finality…'));
          const pendingTx = pendingTxManager.start({
            kind: 'claim',
            title: `第 ${ticket.roundId ?? '—'} 轮奖励领取`,
            titleEn: `Round #${ticket.roundId ?? '—'} Reward Claim`,
            amountText: fmtA9Exact(claimableTotalA9),
            explorerAddress: ticketAddr,
            targetRoute: '/rewards',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const addr = store.state.user.address;
              if (!addr) return false;
              const next = await fetchUserPortfolio(addr);
              const nextBal = safeRawBigInt(next?.a9BalanceRaw);
              if (prevBalanceRaw !== null && nextBal !== null && nextBal > prevBalanceRaw) {
                state.portfolio = next;
                return { confirmed: true, detail: '奖励已确认到账。', detailEn: 'Reward claim confirmed on-chain.' };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('奖励已确认到账！', 'Reward confirmed on-chain!'));
              paint();
            },
          });
          await loadAll();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起领取签名失败，请重试', 'Claim signature failed'), 'error');
        } finally {
          state.claimingTicketAddr = null;
          paint();
        }
      };
    });

    // 绑定单条记录二级入口：3 折急提（30% 秒提 + 70% 销毁）
    root.querySelectorAll('[data-instant-record]').forEach((btn) => {
      btn.onclick = async () => {
        const ticketAddr = btn.dataset.instantRecord;
        const ticket = data.tickets.find((item) => item.ticketAddress === ticketAddr);
        if (!ticket || btn.disabled) return;
        const cashA9 = rawToA9(ticket.instantCashoutTotalRaw);
        const burnA9 = rawToA9(ticket.instantCashoutBurnRaw);
        const ok = await openRewardsClaimConfirmModal({
          title: L('确认 3 折急提（30% 秒提 + 70% 销毁）', 'Confirm Instant Cashout (30% Instant + 70% Burn)'),
          claimAmountText: cashA9 != null && cashA9 > 0 && burnA9 != null
            ? `${fmtA9Exact(cashA9)}（${L('另销毁', 'Burn')} ${fmtA9Exact(burnA9)}）`
            : null,
          attachGramText: '0.34 GRAM',
          actualNetworkFeeText: L('约 0.05–0.09 GRAM（覆盖发币与销毁两笔链上操作，钱包发起费另计）', '~0.05–0.09 GRAM covering payout + burn ops (wallet sending fee separate)'),
          refundRuleText: L('扣除实际链上费用与必要留存后，剩余 GRAM 自动原路退回钱包（多退）', 'Excess GRAM after actual gas & reserves automatically refunds to your wallet'),
          extraWarning: L('30% 秒提 + 70% 销毁：已自然解锁部分仍 100% 实发，仅尚未解锁的未来余额按 30% 实发、70% 永久销毁且不可撤销。', '30% instant + 70% burn: already-vested rewards pay 100%; unvested split 30% instant / 70% permanent burn.'),
          confirmText: isLive ? L('确认并签名 3 折急提', 'Confirm & Sign Instant Cashout') : L('确认 3 折急提（演示）', 'Confirm Instant Cashout (Demo)'),
        });
        if (!ok) return;

        if (!isLive) {
          showToast(L('[演示模式] 已模拟完成 3 折急提', '[Demo] Simulated Instant Cashout completed'));
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        state.claimingTicketAddr = ticketAddr;
        paint();
        try {
          await tonConnect.sendV15TicketClaim(ticketAddr, BigInt(Date.now()), { instantDiscount: true });
          A9Haptic.success();
          showToast(L('已提交 3 折急提交易，正在核验链上到账…', 'Instant Cashout submitted, awaiting finality…'));
          await loadAll();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起 3 折急提失败，请重试', 'Instant Cashout failed'), 'error');
        } finally {
          state.claimingTicketAddr = null;
          paint();
        }
      };
    });

    // 绑定单条记录二级入口：24H 锁仓期提前解押
    root.querySelectorAll('[data-early-exit-record]').forEach((btn) => {
      btn.onclick = async () => {
        const ticketAddr = btn.dataset.earlyExitRecord;
        const ticket = data.tickets.find((item) => item.ticketAddress === ticketAddr);
        if (!ticket || btn.disabled) return;
        const refA9 = rawToA9(ticket.earlyExitRefundRaw);
        const burnA9 = rawToA9(ticket.earlyExitBurnRaw);
        const ok = await openRewardsClaimConfirmModal({
          title: L('确认提前解押（退 85% 本金 / 扣 15% 销毁）', 'Confirm Early Exit (85% Refund / 15% Burn)'),
          claimAmountText: refA9 != null && refA9 > 0 && burnA9 != null ? `${fmtA9Exact(refA9)}（${L('扣销毁', 'Burn')} ${fmtA9Exact(burnA9)}）` : null,
          attachGramText: '0.34 GRAM',
          actualNetworkFeeText: L('约 0.05–0.09 GRAM（覆盖退本与销毁操作，钱包发起费另计）', '~0.05–0.09 GRAM covering refund + burn ops (wallet sending fee separate)'),
          refundRuleText: L('扣除实际链上费用与必要留存后，剩余 GRAM 自动原路退回钱包（多退）', 'Excess GRAM after actual gas & reserves automatically refunds to your wallet'),
          extraWarning: L('仅限 24H 锁仓期内操作，扣除 15% 本金永久销毁且不可撤销。', 'Only open during 24H lock window; 15% principal is permanently burned.'),
          confirmText: L('确认并签名提前解押', 'Confirm & Sign Early Exit'),
        });
        if (!ok) return;

        if (!isLive) {
          showToast(L('[演示模式] 已模拟完成提前解押', '[Demo] Simulated Early Exit completed'));
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        state.claimingTicketAddr = ticketAddr;
        paint();
        try {
          await tonConnect.sendV17TicketEarlyExit(ticketAddr);
          A9Haptic.success();
          showToast(L('已提交提前解押交易，正在核验链上到账…', 'Early Exit submitted, awaiting finality…'));
          await loadAll();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('提前解押失败，请重试', 'Early Exit failed'), 'error');
        } finally {
          state.claimingTicketAddr = null;
          paint();
        }
      };
    });
  };

  const loadAll = async () => {
    if (!isLive) {
      paint();
      return;
    }
    const addr = store.state.user.address || null;
    const uid = getEffectiveUserId(store.state.user);
    if (!addr && !uid) {
      state.loading = false;
      paint();
      return;
    }
    state.loading = true;
    state.portfolioError = null;
    state.promoError = null;
    state.predictionError = null;
    paint();

    const [pfRes, promoRes, predRes] = await Promise.allSettled([
      addr ? fetchUserPortfolio(addr) : Promise.resolve(null),
      addr ? fetchPromoBalance(addr) : Promise.resolve(null),
      uid ? fetchPredictionUser(uid, store.state.round.currentRound) : Promise.resolve(null),
    ]);
    if (seq !== rewardsPageSeq || !root.isConnected) return;

    if (pfRes.status === 'fulfilled') {
      state.portfolio = pfRes.value;
      if (pfRes.value && pfRes.value.ticketsAvailable === false) {
        state.portfolioError = L('链上奖励数据暂不可用，请重试', 'On-chain reward data unavailable; please retry');
      }
    } else {
      state.portfolioError = pfRes.reason?.message || L('读取奖励记录失败，请重试', 'Failed to read reward records');
    }

    if (promoRes.status === 'fulfilled') state.promo = promoRes.value;
    else state.promoError = promoRes.reason?.message || L('读取推广奖励失败，请重试', 'Failed to read referral rewards');

    if (uid) {
      if (predRes.status === 'fulfilled') state.prediction = predRes.value;
      else state.predictionError = predRes.reason?.message || L('读取待激活余额失败，请重试', 'Failed to read pending activation balance');
    }

    state.loading = false;
    paint();
  };

  paint();
  void loadAll();
}

export { PROTOCOL_SPECS };
