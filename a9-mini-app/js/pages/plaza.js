/**
 * 广场首页（#/challenge — 5c 重构定稿）
 *
 * 严格结构（自上而下，零噪音）：
 * 1. 顶栏（由 app.js 提供「规则 ›」轻入口跳 #/rules）
 * 2. 我的状态条（钱包 / 本轮已锁仓 / 可领取，未知显示 —，窄屏折成两行）
 * 3. 本轮主卡（迷你 4 段时间轴 + 一句状态 + 倒计时 + 唯一「下一步」按钮来自 deriveRoundUiState，高度 ≤ 210px，删判定均价灰盒与 12 格印章）
 * 4. 可关闭的三步玩法卡（关闭态仅存于 a9_ui_prefs_v1.settings.hidePlazaHowToPlay）
 * 5. 活动区仅放 1 张宝箱商城卡（带「直发钱包」角标，链向 #/market）
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { L } from '../i18n.js';
import { escapeHtml, formatNum, formatTimer } from '../components.js';
import { icon } from '../icons.js';
import { fetchUserPortfolio, fetchPromoBalance, rawToA9, serverNowMs } from '../data.js';
import { deriveRoundUiState } from '../round-state.js';
import { tonConnect } from '../tonconnect.js';

/** 将 9 种规范 stage 映射至迷你 4 段时间轴索引（0=预热, 1=锁仓, 2=冲价, 3=结算, -1=未知）。 */
function resolveMiniTimelineIndex(stage) {
  if (stage === 'warmup') return 0;
  if (stage === 'stake') return 1;
  if (stage === 'sealed' || stage === 'charge') return 2;
  if (stage === 'settling' || stage === 'passed' || stage === 'failed' || stage === 'aborted') return 3;
  return -1;
}

function renderMiniTimeline(stage) {
  const activeIdx = resolveMiniTimelineIndex(stage);
  const steps = [
    L('预热', 'Warm-Up'),
    L('锁仓', 'Lock'),
    L('冲价', 'Push'),
    L('结算', 'Settle'),
  ];
  return `
    <div class="plaza-mini-timeline" role="list" aria-label="${L('轮次四阶段进度', 'Round 4-stage timeline')}">
      ${steps.map((label, idx) => {
        const cls = activeIdx < 0
          ? ''
          : idx < activeIdx
            ? 'is-done'
            : idx === activeIdx
              ? 'is-active'
              : '';
        return `<span class="plaza-mini-step ${cls}" role="listitem"><i></i><b>${escapeHtml(label)}</b></span>`;
      }).join('')}
    </div>
  `;
}

function fmtStatusA9(val, { loading = false } = {}) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return loading ? L('加载中…', 'Loading…') : '—';
  }
  const n = Number(val);
  const digits = Math.abs(n % 1) < 1e-9 ? 0 : 2;
  return `${formatNum(n, digits)} A9`;
}

export function renderCity(root, navigate) {
  const r = store.state.round;
  const u = store.state.user;
  const isLive = !config.isDemo;
  const hasWallet = Boolean(u.connected && u.address);

  const initialRewards = isLive
    ? null
    : {
        claimableA9: u.profileMode === 'empty' ? 0 : (Number(u.a9Claimable || 0) + Number(u.promoClaimableA9 || 0)),
      };

  const uiState = deriveRoundUiState({
    detail: r,
    user: u,
    rewards: initialRewards,
    serverNowMs: serverNowMs(),
  });

  const countdownSecPos = uiState.countdownMs !== null ? Math.ceil(uiState.countdownMs / 1000) : null;
  const isUrgent = countdownSecPos !== null && countdownSecPos > 0 && countdownSecPos <= 3600;
  const countdownDisplayText = countdownSecPos !== null
    ? formatTimer(countdownSecPos)
    : (r.detailLoading ? L('加载中…', 'Loading…') : uiState.countdownLabel);

  const renderActionHtml = (act) => {
    const cls = act.emphasis === 'primary' ? 'btn btn-primary' : 'btn btn-secondary';
    return act.href
      ? `<a class="${cls} plaza-next-btn" id="plaza-next-action" href="${act.href}">${escapeHtml(act.label)} ›</a>`
      : `<button class="${cls} plaza-next-btn" id="plaza-next-action" type="button" data-action-kind="${escapeHtml(act.kind)}">${escapeHtml(act.label)}</button>`;
  };

  const bindNextAction = () => {
    const nextActionBtn = root.querySelector('#plaza-next-action[data-action-kind]');
    if (!nextActionBtn) return;
    nextActionBtn.onclick = () => {
      const kind = nextActionBtn.dataset.actionKind;
      if (kind === 'connect') {
        tonConnect.openConnectModal(() => renderCity(root, navigate));
      } else if (kind === 'retry') {
        window.dispatchEvent(new Event('a9:force-sync'));
      }
    };
  };

  // 我的状态条初始值（严格防假零：Live 异步拉取前或未连钱包均为 — / 加载中…）
  const walletShort = hasWallet
    ? (u.shortAddress || (u.address.length > 12 ? `${u.address.slice(0, 4)}…${u.address.slice(-4)}` : u.address))
    : L('未连接', 'Disconnected');
  const demoLocked = !isLive
    ? (u.profileMode === 'empty' ? 0 : (Number(r.myStakeTon) || 0))
    : null;
  const demoClaimable = !isLive
    ? (u.profileMode === 'empty' ? 0 : (Number(u.a9Claimable || 0) + Number(u.promoClaimableA9 || 0)))
    : null;

  const hideHowTo = Boolean(store.state.settings?.hidePlazaHowToPlay);

  // 一句状态摘要：简洁直观，不含判定均价灰盒与 12 格印章；奖池金额与 A9 单位严格 nowrap 绝不拆行
  const hasPool = r.rewardBudgetA9 != null && Number.isFinite(Number(r.rewardBudgetA9));
  const oneLineStatusHtml = hasPool && !uiState.isTerminal && uiState.stage !== 'unknown'
    ? `${escapeHtml(uiState.title)} · ${escapeHtml(L('奖池', 'Pool'))} <span class="mono" style="white-space:nowrap;">${escapeHtml(formatNum(r.rewardBudgetA9))} A9</span>`
    : escapeHtml(uiState.title);

  root.innerHTML = `<div class="col-gap anim-page-enter" id="plaza-home-root">
    <section class="plaza-status-strip" id="plaza-my-status" aria-label="${L('我的状态', 'My Status')}">
      <button type="button" class="plaza-status-cell plaza-status-trigger" id="plaza-status-wallet">
        <span class="plaza-status-lbl">${L('钱包', 'Wallet')}</span>
        <strong class="plaza-status-val mono">${escapeHtml(walletShort)}</strong>
      </button>
      <div class="plaza-status-cell">
        <span class="plaza-status-lbl">${L('本轮已锁仓', 'Round Locked')}</span>
        <strong class="plaza-status-val mono" id="plaza-status-locked">${escapeHtml(fmtStatusA9(demoLocked, { loading: isLive && hasWallet }))}</strong>
      </div>
      <a class="plaza-status-cell plaza-status-trigger" href="#/rewards">
        <span class="plaza-status-lbl">${L('可领取', 'Claimable')}</span>
        <strong class="plaza-status-val mono ${Number(demoClaimable) > 0 ? 'text-green' : ''}" id="plaza-status-claimable">${escapeHtml(fmtStatusA9(demoClaimable, { loading: isLive && hasWallet }))}</strong>
      </a>
    </section>

    <section class="card card-hero plaza-round-card" id="plaza-round-card">
      <div class="row-between" style="gap:8px;">
        <div class="row-start" style="gap:6px;min-width:0;">
          <strong class="num-sm" style="white-space:nowrap;">${r.currentRound == null ? L('当前轮次', 'Current Round') : L(`第 ${r.currentRound} 轮`, `Round ${r.currentRound}`)}</strong>
          <span class="chip ${uiState.chipTone}" style="min-height:20px;font-size:11px;padding:0 7px;white-space:nowrap;">${escapeHtml(uiState.badgeLabel)}</span>
        </div>
        <span id="round-cd" class="mono num-sm ${isUrgent ? 'text-red' : 'text-sec'}" style="white-space:nowrap;flex-shrink:0;">${escapeHtml(countdownDisplayText)}</span>
      </div>

      ${renderMiniTimeline(uiState.stage)}

      <p class="plaza-one-line-status" id="plaza-round-status">${oneLineStatusHtml}</p>

      ${renderActionHtml(uiState.primaryAction)}
    </section>

    ${!hideHowTo ? `
      <section class="card plaza-howto-card" id="plaza-howto-card">
        <div class="row-between" style="gap:8px;margin-bottom:4px;">
          <strong class="num-xs" style="color:var(--ink);font-weight:800;">${L('三步玩法', '3-Step Flow')}</strong>
          <button type="button" class="plaza-howto-close" id="btn-close-plaza-howto" aria-label="${L('关闭玩法说明', 'Dismiss guide')}">${icon('x', 13)}</button>
        </div>
        <div class="num-xs text-sec" style="line-height:1.5;">
          ${L('1. 24H 锁仓 A9 → 2. 12H 冲价满 8/12 段 → 3. 达标分奖，未达标自动止损退本。', '1. Lock A9 (24H) → 2. Push 8/12 slots (12H) → 3. Split pool on pass, or auto stop-loss refund.')}
        </div>
      </section>
    ` : ''}

    <section class="plaza-activity-zone" aria-label="${L('精选活动', 'Featured Activity')}">
      <a class="card plaza-mall-card" href="#/market" id="plaza-chest-mall-card">
        <span class="sw-gate-icon is-red" aria-hidden="true">${icon('chest', 22)}</span>
        <div class="plaza-mall-body">
          <div class="row-start" style="gap:6px;flex-wrap:wrap;">
            <strong class="num-sm" style="color:var(--ink);">${L('宝箱商城', 'Chest Mall')}</strong>
            <span class="chip chip-green" style="min-height:18px;font-size:11px;padding:0 6px;">${L('直发钱包', 'Direct Payout')}</span>
          </div>
          <span class="num-xs text-sec">${L('6 档宝箱保底 + 随机加赠，一笔直发钱包', '6 chest tiers with guaranteed base + bonus straight to wallet')}</span>
        </div>
        <span class="sw-menu-arrow" aria-hidden="true">›</span>
      </a>
    </section>
  </div>`;

  bindNextAction();

  const walletStatusBtn = root.querySelector('#plaza-status-wallet');
  if (walletStatusBtn) {
    walletStatusBtn.onclick = () => tonConnect.openConnectModal(() => renderCity(root, navigate));
  }

  const closeHowToBtn = root.querySelector('#btn-close-plaza-howto');
  if (closeHowToBtn) {
    closeHowToBtn.onclick = () => {
      store.update((s) => { s.settings.hidePlazaHowToPlay = true; });
      const card = root.querySelector('#plaza-howto-card');
      if (card) card.remove();
    };
  }

  if (!isLive || !hasWallet) return;

  const addr = u.address;
  const curRoundId = r.currentRound;
  const syncMyStatusAndAction = async () => {
    const [pfRes, promoRes] = await Promise.allSettled([
      fetchUserPortfolio(addr),
      fetchPromoBalance(addr),
    ]);
    if (!root.isConnected || addr !== store.state.user.address) return;

    const pf = pfRes.status === 'fulfilled' ? pfRes.value : null;
    const promo = promoRes.status === 'fulfilled' ? promoRes.value : null;
    const pfReady = Boolean(pf && pf.ticketsAvailable !== false);
    const tickets = pfReady && Array.isArray(pf.tickets) ? pf.tickets : [];

    // 计算本轮已锁仓金额（严格 P0-G：仅当 pfReady 且 curRoundId 明确存在时计算；amountRaw 缺失返回 null 绝不吞成 0）
    let lockedA9 = null;
    if (pfReady && curRoundId != null) {
      const curTicket = tickets.find((t) => Number(t.roundId) === Number(curRoundId) && !t.exited);
      lockedA9 = curTicket ? rawToA9(curTicket.amountRaw) : 0;
    }

    const roundClaimable = pfReady && pf.claimableRaw != null ? rawToA9(pf.claimableRaw) : null;
    const promoClaimable = promo ? (rawToA9(promo.claimableRaw ?? promo.availableRaw) ?? null) : null;
    const totalClaimable = (roundClaimable !== null && promoClaimable !== null)
      ? (roundClaimable + promoClaimable)
      : null;

    const lockedEl = root.querySelector('#plaza-status-locked');
    if (lockedEl) lockedEl.textContent = fmtStatusA9(lockedA9);
    const claimEl = root.querySelector('#plaza-status-claimable');
    if (claimEl) {
      claimEl.textContent = fmtStatusA9(totalClaimable);
      claimEl.classList.toggle('text-green', Number(totalClaimable) > 0);
    }

    // 同步刷新唯一「下一步」按钮（覆盖优先级 3 去领取）
    const nextUi = deriveRoundUiState({
      detail: store.state.round,
      user: store.state.user,
      rewards: {
        claimableRaw: pfReady ? (pf.claimableRaw ?? null) : null,
        tickets,
        promoClaimableRaw: promo?.claimableRaw ?? promo?.availableRaw ?? null,
      },
      serverNowMs: serverNowMs(),
    });
    const curBtn = root.querySelector('#plaza-next-action');
    if (curBtn) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderActionHtml(nextUi.primaryAction).trim();
      if (tmp.firstElementChild) {
        curBtn.replaceWith(tmp.firstElementChild);
        bindNextAction();
      }
    }
  };
  void syncMyStatusAndAction();
}
