/**
 * Tab 2 · 金库（#/rewards 及别名 #/claim）— A9 Quest 视图层
 *
 * 硬性约束：
 * - 顶部蓝色主卡汇总所有未结清票据可领取总额与每秒解锁增速（本地平滑插值仅作视觉跳动）；
 * - 发起链上「领取」或「3 折急提」严格按单张票据逐张签名（tonConnect.sendV15TicketClaim(ticketAddress, queryId, { instantDiscount })），
 *   严禁自行拼装多票据批量消息；
 * - 打开确认弹层与发起签名前，必须以服务端 fetchUserPortfolio 返回的真实字段核对展示；
 * - 急提价值曲线明确区分「本金 100% 不打折」、「80% 线性锁定奖金（30% → 100%）」与「整笔总奖金（44% → 100%）」口径；
 * - 支持未通关止损退本、aborted 100% 退本，以及推广余额 0.06 GRAM 一键领币。
 */

import { loadDemoModule } from '../demo-loader.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, closeModal } from '../components.js';
import { L } from '../i18n.js';
import { tonConnect, canonicalWalletKey, LIVE_READONLY_REASON } from '../tonconnect.js';
import { pendingTxManager } from '../tx-ux.js';
import { deriveRoundUiState } from '../round-state.js';
import {
  PROTOCOL_SPECS,
  serverNowMs,
  rawToA9,
  formatRoundA9,
  fetchUserPortfolio,
  fetchPromoBalance,
  requestPromoClaimIntent,
  fetchPromoClaim,
} from '../data.js';
import {
  qIcon,
  finiteOrNull,
  fmtExactA9,
  fmtIntOrDash,
  openQuestSheet,
} from './quest-ui.js';

let vaultViewSeq = 0;

function formatExactGramFromNano(nanoVal) {
  try {
    const bi = BigInt(String(nanoVal ?? ''));
    if (bi <= 0n) return null;
    const whole = bi / 1_000_000_000n;
    const frac = (bi % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch (_) {
    return null;
  }
}

// Advance each ticket using its own settlement date and integer contract units.
export function vestingDeltaRaw(ticket, nowSec) {
  const { vestingStartAt, vestingSeconds, vestingPrincipalRaw, lockedRemainingRaw } = ticket;
  if (!Number.isSafeInteger(vestingStartAt) || vestingStartAt <= 0 ||
      !Number.isSafeInteger(vestingSeconds) || vestingSeconds <= 0 ||
      !/^\d+$/.test(vestingPrincipalRaw) || !/^\d+$/.test(lockedRemainingRaw)) return 0n;
  const total = BigInt(vestingPrincipalRaw);
  const remaining = BigInt(lockedRemainingRaw);
  if (remaining > total || remaining === 0n) return 0n;
  const elapsed = Math.max(0, Math.min(vestingSeconds, Math.floor(nowSec) - vestingStartAt));
  const delta = total * BigInt(elapsed) / BigInt(vestingSeconds) - (total - remaining);
  return delta > 0n ? delta : 0n;
}

function buildInstantCurveSvg(progressRatio = 0) {
  const W = 340;
  const H = 122;
  const px = 10;
  const py = 16;
  const p = Math.min(1, Math.max(0, Number.isFinite(progressRatio) ? progressRatio : 0));
  const day = p * PROTOCOL_SPECS.linearVestingDays;
  const lockedPct = 30 + 70 * p;
  const totalRewardPct = 44 + 56 * p;
  const x = (d) => px + (d / 14) * (W - 2 * px);
  const y = (v) => H - py - ((v - 20) / 85) * (H - 2 * py);
  const grid = [0, 7, 14].map((g) => `
    <line x1="${x(g).toFixed(1)}" x2="${x(g).toFixed(1)}" y1="${py - 4}" y2="${H - py}" stroke="var(--q-line)" stroke-dasharray="2 3"/>
    <text class="q-ch-lbl" x="${x(g).toFixed(1)}" y="${H - 2}" text-anchor="${g === 0 ? 'start' : g === 14 ? 'end' : 'middle'}">${L(`第 ${g} 天`, `Day ${g}`)}</text>
  `).join('');

  return `<svg viewBox="0 0 ${W} ${H}" aria-label="${L('急提价值曲线', 'Instant Cashout Value Curve')}">
    ${grid}
    <path d="M${x(0).toFixed(1)} ${y(30).toFixed(1)} L${x(14).toFixed(1)} ${y(100).toFixed(1)} L${x(14).toFixed(1)} ${H - py} L${x(0).toFixed(1)} ${H - py} Z" fill="var(--q-yellow)" opacity="0.16"/>
    <path d="M${x(0).toFixed(1)} ${y(30).toFixed(1)} L${x(14).toFixed(1)} ${y(100).toFixed(1)}" stroke="var(--q-yellow)" stroke-width="3" stroke-linecap="round"/>
    <path d="M${x(0).toFixed(1)} ${y(44).toFixed(1)} L${x(14).toFixed(1)} ${y(100).toFixed(1)}" stroke="var(--q-blue)" stroke-width="2" stroke-dasharray="4 3" stroke-linecap="round"/>
    <text class="q-ch-lbl" x="${x(0) + 4}" y="${(y(30) - 5).toFixed(1)}">30%</text>
    <text class="q-ch-lbl" x="${x(0) + 4}" y="${(y(44) - 5).toFixed(1)}" style="fill:var(--q-blue-ink);">44%</text>
    <text class="q-ch-lbl" x="${x(14) - 4}" y="${(y(100) - 5).toFixed(1)}" text-anchor="end">100%</text>
    <line x1="${x(day).toFixed(1)}" x2="${x(day).toFixed(1)}" y1="${y(lockedPct).toFixed(1)}" y2="${H - py}" stroke="var(--q-ink)" stroke-width="1.5"/>
    <circle cx="${x(day).toFixed(1)}" cy="${y(lockedPct).toFixed(1)}" r="5.5" fill="var(--q-ink)" stroke="var(--q-surface)" stroke-width="2"/>
    <text class="q-ch-lbl" style="fill:var(--q-ink);" x="${Math.min(W - 56, Math.max(56, x(day))).toFixed(1)}" y="${Math.max(12, y(lockedPct) - 10).toFixed(1)}" text-anchor="middle">${lockedPct.toFixed(1)}% (${L('总奖', 'All')} ${totalRewardPct.toFixed(1)}%)</text>
  </svg>`;
}

/** 渲染 Tab 2 · 金库主视图 */
export function renderVaultView(root, _navigate, _param = null, query = {}) {
  const seq = ++vaultViewSeq;
  const isLive = !config.isDemo;
  const selectedTicket = query?.ticket || null;

  const state = {
    loading: isLive && Boolean(store.state.user.connected && store.state.user.address),
    portfolio: null,
    portfolioError: null,
    promo: null,
    promoError: null,
    busyTicket: null,
    promoBusy: false,
    fetchedAtMs: serverNowMs(),
  };

  let tickerTimer = null;

  const getTicketsAndTotals = () => {
    const u = store.state.user;
    if (!isLive) {
      const isEmpty = u.profileMode === 'empty';
      const roundClaimable = isEmpty ? 0 : (finiteOrNull(u.a9Claimable) ?? 0);
      const locked = isEmpty ? 0 : (finiteOrNull(u.a9Locked) ?? 0);
      const promoClaimable = isEmpty ? 0 : (finiteOrNull(u.promoClaimableA9) ?? 0);
      const settled = (store.state.certificates || []).filter(c => c.status === 'settled' || c.status === 'passed');
      const tickets = isEmpty ? [] : settled.map((c, idx) => ({
        ticketAddress: c.id || `demo-ticket-${idx + 1}`,
        roundId: c.round ?? (idx + 1),
        roundState: c.status === 'passed' ? 'SUCCEEDED' : c.status === 'failed' ? 'FAILED_PERMANENT' : 'SUCCEEDED',
        amountRaw: String(Math.round(Number(c.stakeTon || 0) * 1e9)),
        claimablePrincipalRaw: '0',
        claimableRewardRaw: idx === 0 ? String(Math.round(roundClaimable * 1e9)) : '0',
        claimableTotalRaw: idx === 0 ? String(Math.round(roundClaimable * 1e9)) : '0',
        lockedRemainingRaw: idx === 0 ? String(Math.round(locked * 1e9)) : '0',
        instantCashoutTotalRaw: idx === 0 ? String(Math.round((roundClaimable + locked * 0.3) * 1e9)) : '0',
        instantCashoutBurnRaw: idx === 0 ? String(Math.round(locked * 0.7 * 1e9)) : '0',
        canClaim: idx === 0 && roundClaimable > 0,
        canInstantCashout: idx === 0 && locked > 0,
        canEarlyExit: false,
        unlockedPctBps: 3600,
        vestingSeconds: PROTOCOL_SPECS.linearVestingDays * 86400,
      }));
      const perSec = locked > 0 ? locked / (PROTOCOL_SPECS.linearVestingDays * 86400) : 0;
      return {
        hasWallet: true,
        tickets,
        roundClaimable,
        locked,
        promoClaimable,
        perSec,
        avgProgress: locked > 0 ? 0.36 : 0,
      };
    }

    const hasWallet = Boolean(u.connected && u.address);
    const ready = Boolean(!state.portfolioError && state.portfolio?.ticketsAvailable === true);
    const tickets = ready && Array.isArray(state.portfolio?.tickets) ? [...state.portfolio.tickets] : [];
    if (selectedTicket) {
      tickets.sort((a, b) => Number(b.ticketAddress === selectedTicket) - Number(a.ticketAddress === selectedTicket));
    }
    const roundClaimable = ready && state.portfolio.claimableRaw != null ? rawToA9(state.portfolio.claimableRaw) : null;
    const locked = ready && state.portfolio.lockedRaw != null ? rawToA9(state.portfolio.lockedRaw) : null;
    const promoClaimable = state.promo && !state.promoError ? rawToA9(state.promo.claimableRaw ?? state.promo.availableRaw) : null;

    let perSec = 0;
    let totalLinear = 0n;
    let vestedLinear = 0n;
    for (const ticket of tickets) {
      if (ticket.forfeited || !/^\d+$/.test(ticket.vestingPrincipalRaw) ||
          !/^\d+$/.test(ticket.lockedRemainingRaw) || !(ticket.vestingSeconds > 0)) continue;
      const total = BigInt(ticket.vestingPrincipalRaw);
      const remaining = BigInt(ticket.lockedRemainingRaw);
      if (remaining > total) continue;
      totalLinear += total;
      vestedLinear += total - remaining;
      if (remaining > 0n) perSec += rawToA9(total.toString()) / ticket.vestingSeconds;
    }

    return {
      hasWallet,
      tickets,
      roundClaimable,
      locked,
      promoClaimable,
      perSec,
      avgProgress: totalLinear > 0n ? Number(vestedLinear * 10000n / totalLinear) / 10000 : null,
    };
  };

  const executeTicket = async (selected, instantDiscount = false) => {
    if (!selected?.ticketAddress || state.busyTicket || pendingTxManager.isLocked() || !store.fundsEnabled) return;
    const wallet = store.state.user.address;
    const range = { fromRound: selected.roundId, toRound: selected.roundId };
    const readTicket = async () => {
      const portfolio = await fetchUserPortfolio(wallet, range);
      return portfolio?.ticketsAvailable === true
        ? portfolio.tickets?.find(t => t.ticketAddress === selected.ticketAddress) : null;
    };
    state.busyTicket = selected.ticketAddress;
    try {
      const ticket = isLive ? await readTicket() : selected;
      if (wallet !== store.state.user.address || !ticket || ticket.pending ||
          !(instantDiscount ? ticket.canInstantCashout : ticket.canClaim)) {
        throw new Error(L('票据状态已更新，请刷新后重试', 'Ticket changed. Refresh and try again.'));
      }
      const payout = formatRoundA9(instantDiscount ? ticket.instantCashoutTotalRaw : ticket.claimableTotalRaw);
      const gas = instantDiscount ? PROTOCOL_SPECS.dualClaimGasGram : PROTOCOL_SPECS.claimGasGram;
      const action = instantDiscount ? L('3 折急提', 'Instant cashout') : L('领取', 'Claim');
      const accepted = await tonConnect.confirmBeforeSign({
        title: L(`第 ${ticket.roundId} 关 · ${action}`, `Stage ${ticket.roundId} · ${action}`),
        contractLabel: 'Round Ticket', targetAddress: ticket.ticketAddress, principalText: payout,
        gasText: `${gas.toFixed(2)} GRAM`, totalText: `${gas.toFixed(2)} GRAM Gas`,
        note: instantDiscount
          ? L(`本金不打折；未解锁奖金中将永久销毁 ${formatRoundA9(ticket.instantCashoutBurnRaw)}。`, `Principal stays whole. Unvested reward burned: ${formatRoundA9(ticket.instantCashoutBurnRaw)}.`)
          : L(`可领本金 ${formatRoundA9(ticket.claimablePrincipalRaw)}，奖金 ${formatRoundA9(ticket.claimableRewardRaw)}。`, `Principal ${formatRoundA9(ticket.claimablePrincipalRaw)}, reward ${formatRoundA9(ticket.claimableRewardRaw)}.`),
      });
      if (!accepted || wallet !== store.state.user.address || pendingTxManager.isLocked()) return;
      if (!isLive) {
        const paid = instantDiscount ? (await loadDemoModule()).demoInstantClaim(store.state) : store.claimRewards();
        if (paid != null && paid > 0) {
          if (instantDiscount) store.notify();
          showToast(L(`演示到账 ${fmtExactA9(paid)}`, `Demo credited ${fmtExactA9(paid)}`));
        }
        return;
      }
      await tonConnect.sendV15TicketClaim(ticket.ticketAddress, BigInt(Date.now()), { instantDiscount });
      const tx = pendingTxManager.start({ kind: instantDiscount ? 'claim_instant' : 'claim',
        title: `第 ${ticket.roundId} 关 · ${action}`, titleEn: `Stage ${ticket.roundId} claim`,
        amountText: payout, explorerAddress: ticket.ticketAddress, targetRoute: '/rewards' });
      void pendingTxManager.pollUntilConfirmed({
        txId: tx.id,
        checkFn: async () => {
          const next = await readTicket();
          if (!next || next.pending) return false;
          if (instantDiscount) return next.forfeited === true;
          return (!ticket.principalDone && next.principalDone) || (!ticket.immediateClaimed && next.immediateClaimed) ||
            BigInt(next.lockedClaimedRaw ?? 0) > BigInt(ticket.lockedClaimedRaw ?? 0);
        },
        onConfirmed: () => { if (root.isConnected) void loadAll(); },
      });
      showToast(L('交易已提交，等待链上确认', 'Transaction submitted. Awaiting confirmation.'));
    } catch (error) {
      showToast(error.message || L('读取或签名失败，请重试', 'Read or signing failed. Please retry.'), 'error');
    } finally {
      state.busyTicket = null;
      paint();
    }
  };

  /** 多票据时打开单票据选择器（绝不拼装多票据批量消息） */
  const openTicketPicker = (tickets, mode) => {
    const isInstant = mode === 'instant';
    openQuestSheet(
      isInstant ? L('选择单张票据发起 3 折急提', 'Select One Ticket for Instant Cashout') : L('选择单张票据发起领取', 'Select One Ticket to Claim'),
      `
        <div class="q-notice blue" style="margin-bottom:10px;">
          ${qIcon('shield', 16)}
          <span>${L('为保障合约签名安全，每次交易严格按单张票据逐张签名。', 'For contract safety, each signature executes one ticket at a time.')}</span>
        </div>
        ${tickets.map((t) => {
          const val = isInstant ? rawToA9(t.instantCashoutTotalRaw) : rawToA9(t.claimableTotalRaw);
          return `
            <div class="q-tk" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
              <div>
                <b>${L(`第 ${t.roundId ?? '—'} 关`, `Stage ${t.roundId ?? '—'}`)}</b>
                <div class="q-small q-muted">${isInstant ? L('预计秒到', 'Est. Instant') : L('当前可领', 'Claimable')}: <b style="color:var(--q-ink);">${escapeHtml(fmtExactA9(val))}</b></div>
              </div>
              <button type="button" class="q-btn q-btn-red q-btn-sm" data-pick-ticket="${escapeHtml(t.ticketAddress)}">${isInstant ? L('急提此张', 'Cashout') : L('领取此张', 'Claim')}</button>
            </div>
          `;
        }).join('')}
      `
    );
    document.querySelectorAll('[data-pick-ticket]').forEach((btn) => {
      btn.onclick = () => {
        const hit = tickets.find((item) => item.ticketAddress === btn.dataset.pickTicket);
        closeModal();
        if (hit) {
          if (isInstant) void executeTicket(hit, true);
          else void executeTicket(hit);
        }
      };
    });
  };

  const paint = () => {
    if (seq !== vaultViewSeq || !root.isConnected) return;
    if (tickerTimer) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }

    const d = getTicketsAndTotals();
    const claimableTickets = d.tickets.filter((t) => Boolean(t.canClaim) && !t.pending && (rawToA9(t.claimableTotalRaw) ?? 0) > 0);
    const instantTickets = d.tickets.filter((t) => Boolean(t.canInstantCashout) && !t.pending && (rawToA9(t.lockedRemainingRaw) ?? 0) > 0);
    const isReadOnlyLive = isLive && !store.fundsEnabled;

    const intPart = d.roundClaimable !== null ? formatNum(Math.floor(d.roundClaimable), 0) : (state.loading ? L('加载中…', 'Loading…') : '—');
    const decPart = d.roundClaimable !== null ? `.${String(Math.floor((d.roundClaimable % 1) * 10000)).padStart(4, '0')}` : '';
    const ringOffset = (327 * (1 - d.avgProgress)).toFixed(1);

    root.innerHTML = `
      <div class="q-view" id="quest-vault-view">
        <section class="q-hero q-hero--blue">
          <span class="q-wm" style="font-size:92px;">${qIcon('vault', 100, 1.4)}</span>
          <div class="q-hero-top">
            <span class="q-cart-tag">VAULT</span>
            <span class="q-phase-pill">${d.perSec > 0 ? `<i class="q-live-dot"></i>${L('14 天逐秒解锁中', '14D Vesting Live')}` : L('链上票据金库', 'On-Chain Vault')}</span>
          </div>
          <div class="q-hero-label">${L('当前可领取总额（轮次票据）', 'Total Claimable (Round Tickets)')}</div>
          <div class="q-ticker">
            <b id="q-vault-int">${escapeHtml(intPart)}</b>
            <span id="q-vault-dec">${escapeHtml(decPart)}</span>
            <em>A9</em>
          </div>
          <div class="q-v-rate">+<span id="q-vault-rate">${d.roundClaimable === null || (isLive && d.locked > 0 && !d.perSec) ? '—' : d.perSec.toFixed(4)}</span> A9 / ${L('秒', 's')}</div>
          <div class="q-hero-ctas">
            ${!d.hasWallet ? `
              <button class="q-btn q-btn-white is-blue q-btn-block" id="q-vault-connect" type="button">${qIcon('wallet', 18)} ${L('连接钱包查看金库', 'Connect Wallet')}</button>
            ` : `
              <button class="q-btn q-btn-white is-blue q-grow" id="q-vault-claim-hero" type="button" ${isReadOnlyLive || claimableTickets.length === 0 ? 'disabled' : ''}>
                ${qIcon('unlock', 18)} ${isReadOnlyLive ? L('只读 · 暂不可领', 'Read-Only') : L('领取', 'Claim')}
              </button>
              <button class="q-btn q-btn-glass" id="q-vault-instant-hero" type="button" ${isReadOnlyLive || instantTickets.length === 0 ? 'disabled' : ''}>
                ${qIcon('bolt', 17)} ${L('3 折急提', 'Instant 30%')}
              </button>
            `}
          </div>
        </section>

        ${state.portfolioError ? `
          <div class="q-notice red">
            ${qIcon('info', 16)}
            <span class="q-grow">${escapeHtml(state.portfolioError)}</span>
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-vault-retry">${L('重试', 'Retry')}</button>
          </div>
        ` : ''}

        <section class="q-card">
          <div class="q-card-h">
            <h3>${qIcon('unlock', 18)} ${L('14 天逐秒解锁', '14-Day Per-Second Vesting')}</h3>
            <span class="q-chip q-chip-blue">${L('本金 100% 不打折', '100% Principal Intact')}</span>
          </div>
          <div class="q-ring-wrap">
            <div class="q-ring">
              <svg viewBox="0 0 120 120">
                <circle class="q-ring-bg" cx="60" cy="60" r="52"/>
                <circle class="q-ring-fg" cx="60" cy="60" r="52" stroke-dasharray="327" stroke-dashoffset="${ringOffset}"/>
              </svg>
              <div class="q-rt">
                <b>${d.avgProgress !== null ? `${(d.avgProgress * 100).toFixed(1)}%` : '—'}</b>
                <small>${L('已解锁', 'Vested')}</small>
              </div>
            </div>
            <div class="q-legend">
              <div><span><i style="background:var(--q-blue);"></i>${L('当前可领', 'Claimable')}</span><b>${escapeHtml(fmtExactA9(d.roundClaimable))}</b></div>
              <div><span><i style="background:var(--q-surface-3);"></i>${L('14 天待解锁', 'Vesting (14D)')}</span><b>${escapeHtml(fmtExactA9(d.locked))}</b></div>
              <div><span><i style="background:var(--q-green);"></i>${L('推广余额', 'Referral Bal.')}</span><b>${escapeHtml(fmtExactA9(d.promoClaimable))}</b></div>
            </div>
          </div>
        </section>

        <section class="q-card" id="q-instant-curve-card">
          <div class="q-card-h">
            <h3>${qIcon('bolt', 18)} ${L('急提价值曲线', 'Instant Cashout Value Curve')}</h3>
            <span class="q-chip q-chip-yellow">${L('每天 +5%', '+5% / Day')}</span>
          </div>
          <div class="q-notice blue" style="margin-bottom:8px;">
            ${qIcon('shield', 16)}
            <span>${L('通关本金 100% 全退、绝不打折；3 折急提仅作用于尚未解锁的 80% 线性奖金部分。', '100% principal is always refunded without discount; 30% cashout applies only to unvested 80% linear rewards.')}</span>
          </div>
          <div class="q-chart">${buildInstantCurveSvg(d.avgProgress ?? 0)}</div>
          <div class="q-foot-note">
            ${L(
              '黄实线（80% 锁定奖金口径）：第 0 天急提折算 30% → 第 14 天 100%；蓝虚线（整笔总奖金 = 20% 秒提 + 80% 锁定口径）：结算当下立即可拿 44% → 第 14 天 100%。',
              'Yellow line (80% locked reward basis): Day 0 = 30% → Day 14 = 100%. Blue dashed (total reward = 20% instant + 80% locked): Day 0 = 44% → Day 14 = 100%.'
            )}
          </div>
        </section>

        <section class="q-card" id="q-promo-vault-card">
          <div class="q-card-h">
            <h3>${qIcon('gift', 18)} ${L('站内推广余额（0.06 GRAM 一键领币）', 'Promo Balance (0.06 GRAM Claim)')}</h3>
            <span class="q-chip q-chip-green q-num">${escapeHtml(fmtExactA9(d.promoClaimable))}</span>
          </div>
          <div class="q-small q-muted" style="line-height:1.5;margin-bottom:10px;">
            ${L('包含好友购箱 6% 返佣、好友通关 8% 返佣及已激活的预言/任务宝箱奖励；支付 0.06 GRAM 手续费由热钱包自动发放。', 'Includes 6% chest referrals, 8% friend pass credits, and activated rewards. Send 0.06 GRAM fee for auto payout.')}
          </div>
          <button class="q-btn q-btn-blue q-btn-block q-btn-sm" id="q-claim-promo-btn" type="button"
            ${isReadOnlyLive || !d.hasWallet || state.promoBusy || !(finiteOrNull(d.promoClaimable) > 0) ? 'disabled' : ''}>
            ${qIcon('wallet', 16)} ${isReadOnlyLive
              ? L('当前只读 · 推广领币暂未开放', 'Read-Only · Promo Claim Disabled')
              : state.promoBusy
                ? L('准备支付单中…', 'Preparing Claim…')
                : L('0.06 GRAM 一键领币', 'Claim via 0.06 GRAM')}
          </button>
        </section>

        <section class="q-card" id="q-tickets-card">
          <div class="q-card-h">
            <h3>${qIcon('book', 18)} ${L('逐张关卡票据', 'Per-Round Tickets')}</h3>
            <span class="q-chip">${d.tickets.length} ${L('张', 'Tickets')}</span>
          </div>
          ${!d.hasWallet ? `
            <div class="q-small q-muted">${L('连接钱包后查看并逐张操作你的链上关卡票据。', 'Connect wallet to view and sign individual round tickets.')}</div>
          ` : d.tickets.length === 0 ? `
            <div class="q-small q-muted">${state.loading ? L('正在读取链上票据…', 'Loading on-chain tickets…') : L('暂无轮次票据，前往冲关锁仓即可生成。', 'No round tickets yet. Lock A9 in Quest to participate.')}</div>
          ` : d.tickets.map((t) => {
            const st = deriveRoundUiState({ detail: { rawState: t.roundState }, user: { connected: true }, serverNowMs: serverNowMs() }).stage;
            const principalA9 = rawToA9(t.amountRaw);
            const claimA9 = rawToA9(t.claimableTotalRaw);
            const lockedA9 = rawToA9(t.lockedRemainingRaw);
            const canClaim = Boolean(t.canClaim) && !t.pending && (claimA9 ?? 0) > 0;
            const canInstant = Boolean(t.canInstantCashout) && !t.pending && (lockedA9 ?? 0) > 0;
            const isBusy = state.busyTicket === t.ticketAddress;
            const statusChip = st === 'passed'
              ? `<span class="q-chip q-chip-green">${L('已通关', 'Passed')}</span>`
              : st === 'failed'
                ? `<span class="q-chip">${L('未达标 · 止损退本', 'Missed · Stop-Loss')}</span>`
                : st === 'aborted'
                  ? `<span class="q-chip q-chip-yellow">${L('异常中止 · 100% 退本', 'Aborted · 100% Refund')}</span>`
                  : `<span class="q-chip q-chip-blue">${L('进行中', 'Active')}</span>`;
            const claimLabel = st === 'failed'
              ? L('领止损退本', 'Claim Stop-Loss')
              : st === 'aborted'
                ? L('取回 100% 本金', 'Refund 100%')
                : L('领取', 'Claim');

            return `
              <div class="q-tk" data-ticket-addr="${escapeHtml(t.ticketAddress)}">
                <div class="q-tk-h">
                  <b>${L(`第 ${t.roundId ?? '—'} 关`, `Stage ${t.roundId ?? '—'}`)}</b>
                  ${statusChip}
                </div>
                <div class="q-tk-g">
                  <div>${L('本金', 'Principal')}<b>${fmtIntOrDash(principalA9)}</b></div>
                  <div>${L('当前可领', 'Claimable')}<b>${fmtIntOrDash(claimA9)}</b></div>
                  <div>${L('待解锁', 'Vesting')}<b>${fmtIntOrDash(lockedA9)}</b></div>
                </div>
                <div class="q-tk-actions">
                  <button type="button" class="q-btn q-btn-red q-btn-sm q-grow" data-q-tk-claim="${escapeHtml(t.ticketAddress)}" ${isReadOnlyLive || !canClaim || isBusy ? 'disabled' : ''}>
                    ${isBusy ? L('签名中…', 'Signing…') : claimLabel}
                  </button>
                  ${canInstant ? `
                    <button type="button" class="q-btn q-btn-ghost q-btn-sm" data-q-tk-instant="${escapeHtml(t.ticketAddress)}" ${isReadOnlyLive || isBusy ? 'disabled' : ''}>
                      ${L('3 折急提', 'Instant 30%')}
                    </button>
                  ` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </section>
      </div>
    `;

    // 视觉逐秒插值（仅用于展示跳动；签名弹窗始终使用服务端原始字段）
    if (d.roundClaimable !== null && d.perSec > 0) {
      const baseVal = d.roundClaimable;
      const baseTs = state.fetchedAtMs;
      tickerTimer = setInterval(() => {
        if (!root.isConnected) {
          clearInterval(tickerTimer);
          return;
        }
        const elapsed = Math.max(0, (serverNowMs() - baseTs) / 1000);
        const now = Math.floor(serverNowMs() / 1000);
        const cur = baseVal + Math.min(d.locked || 0, elapsed * d.perSec);
        const intEl = root.querySelector('#q-vault-int');
        const decEl = root.querySelector('#q-vault-dec');
        if (isLive) {
          const raw = d.tickets.reduce((sum, t) => sum + vestingDeltaRaw(t, now), BigInt(state.portfolio.claimableRaw));
          if (intEl) intEl.textContent = (raw / 1000000000n).toLocaleString('en-US');
          if (decEl) decEl.textContent = '.' + String(raw % 1000000000n).padStart(9, '0').slice(0, 4);
          return;
        }
        if (intEl) intEl.textContent = formatNum(Math.floor(cur), 0);
        if (decEl) decEl.textContent = `.${String(Math.floor((cur % 1) * 10000)).padStart(4, '0')}`;
      }, 1000);
    }

    const connBtn = root.querySelector('#q-vault-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderVaultView(root, _navigate, _param, query));

    const retryBtn = root.querySelector('#q-vault-retry');
    if (retryBtn) retryBtn.onclick = () => loadAll();

    const heroClaimBtn = root.querySelector('#q-vault-claim-hero');
    if (heroClaimBtn) {
      heroClaimBtn.onclick = () => {
        if (claimableTickets.length === 1) void executeTicket(claimableTickets[0]);
        else if (claimableTickets.length > 1) openTicketPicker(claimableTickets, 'claim');
      };
    }

    const heroInstantBtn = root.querySelector('#q-vault-instant-hero');
    if (heroInstantBtn) {
      heroInstantBtn.onclick = () => {
        if (instantTickets.length === 1) void executeTicket(instantTickets[0], true);
        else if (instantTickets.length > 1) openTicketPicker(instantTickets, 'instant');
      };
    }

    root.querySelectorAll('[data-q-tk-claim]').forEach((btn) => {
      btn.onclick = () => {
        const hit = d.tickets.find((t) => t.ticketAddress === btn.dataset.qTkClaim);
        if (hit) void executeTicket(hit);
      };
    });

    root.querySelectorAll('[data-q-tk-instant]').forEach((btn) => {
      btn.onclick = () => {
        const hit = d.tickets.find((t) => t.ticketAddress === btn.dataset.qTkInstant);
        if (hit) void executeTicket(hit, true);
      };
    });

    const promoBtn = root.querySelector('#q-claim-promo-btn');
    if (promoBtn) {
      promoBtn.onclick = async () => {
        if (!store.fundsEnabled) {
          showToast(LIVE_READONLY_REASON, 'amber');
          return;
        }
        if (!isLive) {
          const res = store.claimPromoDemo();
          if (res?.error) showToast(res.error, 'amber');
          else showToast(L(`[演示模式] 已领取推广奖励 ${formatNum(res.amountA9)} A9`, `[Demo] Claimed ${formatNum(res.amountA9)} A9`));
          paint();
          return;
        }
        const wallet = store.state.user.address;
        if (!wallet) return;
        state.promoBusy = true;
        paint();
        try {
          const intent = await requestPromoClaimIntent(wallet);
          const expectedHot = store.state.round?.protocolConfig?.promoHotWallet?.address || '';
          if (expectedHot && canonicalWalletKey(intent?.payTo) !== canonicalWalletKey(expectedHot)) {
            throw new Error(L('领奖目标热钱包地址与协议配置不一致，已拦截签名', 'Promo hot wallet mismatch; blocked'));
          }
          const feeGram = formatExactGramFromNano(intent?.feeRequiredNano) || PROTOCOL_SPECS.deliveryFeeGram.toFixed(2);
          const payoutA9 = rawToA9(intent?.amountRaw ?? state.promo?.claimableRaw);
          const ok = await tonConnect.confirmBeforeSign({
            title: L('确认领取站内推广余额', 'Confirm Promo Balance Claim'),
            contractLabel: 'Promo Hot Wallet',
            targetAddress: intent.payTo,
            principalText: fmtExactA9(payoutA9),
            gasText: `${feeGram} GRAM`,
            totalText: `${feeGram} GRAM`,
            memo: intent.memo || '',
          });
          if (!ok) return;
          await tonConnect.sendV15PromoFee(intent);
          A9Haptic.success();
          const tx = pendingTxManager.start({
            kind: 'promo',
            title: '推广奖励发放',
            titleEn: 'Promo A9 Payout',
            amountText: fmtExactA9(payoutA9),
            explorerAddress: intent.payTo,
            refId: intent.claimId,
            targetRoute: '/rewards',
          });
          pendingTxManager.pollUntilConfirmed({
            txId: tx?.id,
            checkFn: async () => {
              const c = await fetchPromoClaim(intent.claimId);
              if (c?.status === 'COMPLETED') return { confirmed: true, detail: '推广奖励已到账。', detailEn: 'Promo A9 credited.' };
              if (c?.status === 'FAILED' || c?.status === 'EXPIRED') return { terminal: true };
              return false;
            },
            onConfirmed: () => {
              showToast(L('推广奖励已到账钱包！', 'Promo rewards credited!'));
              void loadAll();
            },
          });
          showToast(L('已发起 0.06 GRAM 领币转账，正在核验自动发币…', 'Fee sent, awaiting automatic A9 payout…'));
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('推广领币失败', 'Promo claim failed'), 'error');
        } finally {
          state.promoBusy = false;
          paint();
        }
      };
    }
  };

  const loadAll = async () => {
    if (!isLive) {
      paint();
      return;
    }
    const addr = store.state.user.address;
    if (!store.state.user.connected || !addr) {
      state.loading = false;
      paint();
      return;
    }
    state.loading = true;
    state.portfolioError = null;
    state.promoError = null;
    paint();

    const [pfRes, prRes] = await Promise.allSettled([
      fetchUserPortfolio(addr),
      fetchPromoBalance(addr),
    ]);
    if (seq !== vaultViewSeq || !root.isConnected || addr !== store.state.user.address) return;

    state.fetchedAtMs = serverNowMs();
    if (pfRes.status === 'fulfilled') {
      state.portfolio = pfRes.value;
      if (pfRes.value?.ticketsAvailable === false) {
        state.portfolioError = L('链上票据数据暂不可用，请重试', 'On-chain ticket data unavailable');
      }
    } else {
      state.portfolioError = pfRes.reason?.message || L('读取票据失败', 'Failed to load tickets');
    }
    if (prRes.status === 'fulfilled') state.promo = prRes.value;
    else state.promoError = prRes.reason?.message || L('读取推广余额失败', 'Failed to load promo balance');

    state.loading = false;
    paint();
  };

  paint();
  void loadAll();
}
