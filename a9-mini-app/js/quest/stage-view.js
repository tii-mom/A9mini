import { canShowProvisionalPrice, racePriceChart } from './price-chart.js';
/**
 * Tab 1 · 冲关（#/round）— A9 Quest 视图层
 *
 * 完备覆盖 round-state.js 全部 9 种规范阶段（warmup / stake / sealed / charge / settling / passed / failed / aborted / unknown），
 * 严守 serverNowMs() 驱动、倒计时 <= 0 不显 00:00:00、stage !== 'passed' 严禁提前显示「已通关」、
 * 缺值 null 严禁经 Number(null) 伪造为 0、Live 模式零假销毁统计。
 */

import { loadDemoModule, peekDemoModule } from '../demo-loader.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, closeModal } from '../components.js';
import { L } from '../i18n.js';
import { tonConnect, LIVE_READONLY_REASON } from '../tonconnect.js';
import { pendingTxManager } from '../tx-ux.js';
import { deriveRoundUiState } from '../round-state.js';
import {
  PROTOCOL_SPECS,
  serverNowMs,
  rawToA9,
  formatRoundA9,
  formatEstimatedA9,
  parseA9InputToRaw,
  calculateStakePreview,
  fetchUserPortfolio,
  stakeTicketAmount,
  fetchWarmupCurrent,
  registerWarmup,
  cancelWarmup,
  fetchPredictionRound,
  fetchPredictionUser,
  submitPredictionBet,
  getEffectiveUserId,
} from '../data.js';
import {
  qIcon,
  finiteOrNull,
  fmtIntOrDash,
  fmtUsdOrDash,
  fmtStageCountdown,
  openQuestSheet,
} from './quest-ui.js';

let stageViewSeq = 0;
let expandedPredictionKey = null;

function pad2(n) {
  const v = finiteOrNull(n);
  return v === null ? '--' : String(Math.floor(v)).padStart(2, '0');
}

function toMs(ts) {
  const n = finiteOrNull(ts);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

function calcTrackSegments(r, nowMs) {
  const openMs = toMs(r.stakeOpenAt);
  const closeMs = toMs(r.stakeCloseAt);
  const earlySec = finiteOrNull(r.earlyWindowSeconds) ?? (PROTOCOL_SPECS.first6hHours * 3600);
  const earlyEndMs = toMs(r.earlyCloseAt) ?? (openMs !== null ? openMs + earlySec * 1000 : null);
  const obsSec = finiteOrNull(r.protocolConfig?.observationSeconds) ?? (PROTOCOL_SPECS.pushHours * 3600);
  const obsEndMs = toMs(r.observationEndAt) ?? (closeMs !== null ? closeMs + obsSec * 1000 : null);

  if (openMs === null || closeMs === null || earlyEndMs === null || obsEndMs === null) {
    return { s1: 0, s2: 0, s3: 0 };
  }
  const s1 = clamp01((nowMs - openMs) / Math.max(1, earlyEndMs - openMs)) * 100;
  const s2 = clamp01((nowMs - earlyEndMs) / Math.max(1, closeMs - earlyEndMs)) * 100;
  const s3 = clamp01((nowMs - closeMs) / Math.max(1, obsEndMs - closeMs)) * 100;
  return { s1, s2, s3 };
}

/** 派生 12 面旗底部状态条文案（硬规则：stage !== 'passed' 时严禁出现「已通关」）。 */
export function buildChargeFlagStatusText(uiStage, r) {
  const total = PROTOCOL_SPECS.passTotal;
  const minQ = finiteOrNull(r.minQualifiedCandles) ?? PROTOCOL_SPECS.passRequired;
  const q = finiteOrNull(r.qualifiedCandles);
  const candles = Array.isArray(r.candles) ? r.candles : [];
  const failed = candles.filter((c) => c.status === 'closed' && c.bull === false).length;
  const maxMiss = total - minQ;

  if (uiStage === 'warmup' || uiStage === 'stake' || uiStage === 'sealed') {
    return {
      tone: '',
      text: L(`每小时确认一次均价，${minQ} / ${total} 段达标即可分奖`, `One average per hour. Meet ${minQ} of ${total} to share the pool.`),
    };
  }
  if (uiStage === 'passed') {
    return {
      tone: 'win',
      text: L('链上已结算通关', 'Passed and settled on-chain'),
    };
  }
  if (uiStage === 'failed') {
    return {
      tone: 'lose',
      text: L('未达标 · 已结算止损', 'Missed · stop-loss settled'),
    };
  }
  if (uiStage === 'aborted') {
    return {
      tone: '',
      text: L('异常中止 · 金库可退 100% 本金', 'Aborted · 100% principal refundable in Vault'),
    };
  }
  if (uiStage === 'settling') {
    return {
      tone: '',
      text: L('等待链上结算', 'Awaiting on-chain settlement'),
    };
  }
  if (uiStage === 'charge') {
    if (String(r.rawState || '').toUpperCase() === 'ORACLE_PAUSED') {
      return {
        tone: '',
        text: L('等待预言机恢复采样', 'Awaiting oracle samples'),
      };
    }
    if (q !== null && q >= minQ) {
      return {
        tone: 'win',
        text: L(`已达 ${minQ}/${total} 门槛 · 等待链上结算`, `${minQ}/${total} threshold met · awaiting settlement`),
      };
    }
    if (failed > maxMiss) {
      return {
        tone: 'lose',
        text: L(`已失误 ${failed} 段 · 结算后自动止损退本`, `${failed} slots missed · auto stop-loss refunds after settlement`),
      };
    }
    if (q !== null) {
      const need = Math.max(0, minQ - q);
      const remainMiss = Math.max(0, maxMiss - failed);
      return {
        tone: '',
        text: L(`还差 ${need} 段达标 · 可容错 ${remainMiss} 段`, `${need} more needed · ${remainMiss} misses left`),
      };
    }
  }
  return {
    tone: '',
    text: L('等待服务端同步时段判定进度…', 'Syncing hourly slot verification…'),
  };
}

/** 将 BigInt 最小单位精确转为无尾零十进制输入字符串（最多 9 位小数，供「全部」按钮使用） */
export function rawToPlainDecimal(rawVal) {
  if (rawVal === null || rawVal === undefined) return '';
  try {
    const bi = typeof rawVal === 'bigint' ? rawVal : BigInt(String(rawVal));
    if (bi <= 0n) return '0';
    const whole = bi / 1_000_000_000n;
    const frac = (bi % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole.toString()}.${frac}` : whole.toString();
  } catch (_) {
    return '';
  }
}

/** 派生 12 面旗单个时段的紧凑详情文案（时段、判定均价、目标价、状态） */
export function describeCandleSlotDetail(candle, targetPrice) {
  const idx = finiteOrNull(candle?.index) ?? 1;
  const st = String(candle?.status || 'pending').toLowerCase();
  const priceText = st === 'closed' || st === 'active' ? fmtUsdOrDash(candle?.p) : '—';
  const targetText = fmtUsdOrDash(targetPrice);
  if (st === 'closed' && candle?.bull === true) {
    return { index: idx, statusText: L('达标', 'Met'), tone: 'win', priceText, targetText };
  }
  if (st === 'closed' && candle?.bull === false) {
    return { index: idx, statusText: L('未达标', 'Missed'), tone: 'lose', priceText, targetText };
  }
  if (st === 'active') {
    return { index: idx, statusText: L('采集中', 'Sampling'), tone: 'active', priceText, targetText };
  }
  if (st === 'unknown') {
    return { index: idx, statusText: L('缺少确认数据', 'Confirmation missing'), tone: 'missing', priceText, targetText };
  }
  return { index: idx, statusText: L('待同步', 'Pending'), tone: 'idle', priceText, targetText };
}

/** 渲染 Tab 1 · 冲关主视图 */
export function renderStageView(root, navigate, _param = null, query = {}) {
  const seq = ++stageViewSeq;
  const isLive = !config.isDemo;
  const pendingDl = store.state.referral?.pendingDeepLink || null;
  if (pendingDl) store.state.referral.pendingDeepLink = null;
  const rawDlType = String(query?.dl || pendingDl?.type || '').trim().toLowerCase();
  const rawDlRound = query?.round ?? pendingDl?.roundId ?? '';
  const dlRoundId = /^\d{1,6}$/.test(String(rawDlRound)) ? Number(rawDlRound) : null;

  const local = {
    portfolio: null,
    portfolioLoading: false,
    warmup: null,
    warmupLoading: false,
    warmupError: null,
    warmupBusy: false,
    predRound: null,
    predUser: null,
    predBusy: false,
    selectedFlagIdx: null,
    dlType: (rawDlType === 'bet' || rawDlType === 'round' || rawDlType === 'burn') ? rawDlType : '',
    dlRoundId,
    deepLinkApplied: false,
  };

  let auxSeq = 0;

  const certAmountRaw = (c) => {
    if (typeof c?.amountRaw === 'string' && /^\d+$/.test(c.amountRaw)) return BigInt(c.amountRaw);
    const n = finiteOrNull(c?.stakeTon);
    if (n === null || n <= 0) return 0n;
    return parseA9InputToRaw(n.toFixed(9)) ?? 0n;
  };

  const getCurrentRoundTicket = () => {
    const r = store.state.round;
    const rid = finiteOrNull(r.currentRound);
    if (!isLive) {
      const certs = Array.isArray(store.state.certificates) ? store.state.certificates : [];
      const active = certs.filter(c => finiteOrNull(c.round) === rid && c.status === 'observation');
      const hit = active[0];
      let totalRaw = 0n;
      let earlyRaw = 0n;
      for (const c of active) {
        const amt = certAmountRaw(c);
        totalRaw += amt;
        if (c.isFirst6h !== false) earlyRaw += amt;
      }
      const lateRaw = totalRaw > earlyRaw ? (totalRaw - earlyRaw) : 0n;
      if (!hit || totalRaw <= 0n) return null;
      return {
        ticketAddress: hit.id || `demo-ticket-r${rid}`,
        roundId: rid,
        amountRaw: totalRaw.toString(),
        earlyAmountRaw: earlyRaw.toString(),
        lateAmountRaw: lateRaw.toString(),
        canEarlyExit: true,
        exited: false,
      };
    }
    const tickets = Array.isArray(local.portfolio?.tickets) ? local.portfolio.tickets : [];
    return tickets.find((t) => finiteOrNull(t.roundId) === rid && !t.exited) || null;
  };

  const openStakePreviewSheet = (ui, restoredAmount = null) => {
    const r = store.state.round;
    const u = store.state.user;
    if (!u.connected) {
      tonConnect.openConnectModal(() => renderStageView(root, navigate, _param, query));
      return;
    }
    let activeFirst6h = Boolean(ui.inFirst6h);
    const readDemoAvailRaw = () => {
      const demoMod = peekDemoModule();
      if (demoMod?.demoGetAvailableRaw) return demoMod.demoGetAvailableRaw(u);
      if (typeof u.a9AvailableRaw === 'string' && /^\d+$/.test(u.a9AvailableRaw)) return BigInt(u.a9AvailableRaw);
      const n = finiteOrNull(u.a9Available);
      return n !== null && n >= 0 ? (parseA9InputToRaw(n.toFixed(9)) ?? 0n) : null;
    };
    let availRaw = isLive
      ? (/^\d+$/.test(String(local.portfolio?.a9BalanceRaw ?? '')) ? BigInt(local.portfolio.a9BalanceRaw) : null)
      : readDemoAvailRaw();
    const minRaw = BigInt(PROTOCOL_SPECS.minStakeA9) * 1_000_000_000n;
    const availWhole = availRaw !== null ? Number(availRaw / 1_000_000_000n) : null;
    const defaultVal = restoredAmount ?? (availWhole !== null && availWhole >= PROTOCOL_SPECS.minStakeA9
      ? Math.min(10000, Math.floor(availWhole))
      : PROTOCOL_SPECS.minStakeA9);

    const renderBillHtml = (calc) => {
      const hasExisting = BigInt(calc.existing.principalRaw) > 0n;
      const addRaw = BigInt(calc.addition.principalRaw);
      const isReady = calc.status === 'ok';
      const statusNote = calc.status === 'stale'
        ? L('数据待刷新，奖金估算暂不可用', 'Data stale; reward estimate paused')
        : calc.status === 'unready'
          ? L('本轮数据待同步，奖金估算暂不可用', 'Round data syncing; estimate pending')
          : calc.status === 'zero_denominator'
            ? L('当前全轮锁仓为 0，输入金额后显示估算', 'Enter amount to compute pool share')
            : '';
      const activeWinRaw = hasExisting ? calc.combined.winRewardRaw : calc.addition.newShareRewardRaw;
      const activeImmRaw = hasExisting ? calc.combined.winImmediateRaw : calc.addition.winImmediateRaw;
      const activeLinRaw = hasExisting ? calc.combined.winLinearRaw : calc.addition.winLinearRaw;
      const activeFailRefRaw = hasExisting ? calc.combined.failRefundRaw : calc.addition.failRefundRaw;
      const activeFailBurnRaw = hasExisting ? calc.combined.failBurnRaw : calc.addition.failBurnRaw;
      const activeExitRefRaw = hasExisting ? calc.combined.earlyExitRefundRaw : calc.addition.earlyExitRefundRaw;
      const activeExitBurnRaw = hasExisting ? calc.combined.earlyExitBurnRaw : calc.addition.earlyExitBurnRaw;
      const winValText = isReady && activeWinRaw !== null ? formatEstimatedA9(activeWinRaw, { gain: true }) : '—';
      const winSubText = isReady && activeWinRaw !== null
        ? L(
            `20% 秒提 ${formatEstimatedA9(activeImmRaw)} · 80%（${formatEstimatedA9(activeLinRaw)}）14 天解锁`,
            `20% instant (${formatEstimatedA9(activeImmRaw)}) · 80% (${formatEstimatedA9(activeLinRaw)}) 14D vest`
          )
        : (statusNote || L('输入锁仓数量后实时计算', 'Enter amount for live preview'));
      const loseValText = addRaw > 0n || hasExisting ? L(`退 ${formatEstimatedA9(activeFailRefRaw)}`, `Refund ${formatEstimatedA9(activeFailRefRaw)}`) : '—';
      const loseSubText = addRaw > 0n || hasExisting
        ? L(`止损销毁 ${formatEstimatedA9(activeFailBurnRaw)}`, `Stop-loss burn ${formatEstimatedA9(activeFailBurnRaw)}`)
        : '—';

      const summaryRows = `
        <div class="q-kv"><span>${L('本次锁入', 'This Lock')}</span><b class="q-num">${addRaw > 0n ? formatRoundA9(calc.addition.principalRaw) : '—'}</b></div>
        ${hasExisting ? `
          <div class="q-kv"><span>${L('已有仓位 → 追加后总仓', 'Existing → Combined')}</span><b class="q-num">${formatRoundA9(calc.existing.principalRaw)} → ${formatRoundA9(calc.combined.principalRaw)}</b></div>
          <div class="q-kv"><span>${L('本次新增份额奖金', 'New Share Reward')}</span><b class="q-num">${isReady && calc.addition.newShareRewardRaw !== null ? escapeHtml(formatEstimatedA9(calc.addition.newShareRewardRaw, { gain: true })) : '—'}</b></div>
          <div class="q-kv"><span>${L('追加后总奖金（较现有净增）', 'Combined Reward (Net Delta)')}</span><b class="q-num green">${isReady && calc.combined.winRewardRaw !== null ? `${escapeHtml(formatEstimatedA9(calc.combined.winRewardRaw, { gain: true }))}（${calc.combined.netRewardDeltaRaw !== null ? escapeHtml(formatEstimatedA9(calc.combined.netRewardDeltaRaw, { gain: true })) : '—'}）` : '—'}</b></div>
        ` : `
          <div class="q-kv"><span>${L('通关预估奖金', 'Est. Pass Reward')}</span><b class="q-num green">${isReady && calc.addition.newShareRewardRaw !== null ? escapeHtml(formatEstimatedA9(calc.addition.newShareRewardRaw, { gain: true })) : '—'}</b></div>
        `}
        <div class="q-kv"><span>${L('通关退回本金（100%）', 'Pass Principal Return (100%)')}</span><b class="q-num">${formatRoundA9(hasExisting ? calc.combined.principalRaw : calc.addition.principalRaw)}</b></div>
        <div class="q-kv"><span>${hasExisting ? L('未通关总退款 / 总销毁', 'Miss Total Refund / Burn') : L('未通关退款 / 销毁', 'Miss Refund / Burn')}</span><b class="q-num">${escapeHtml(formatEstimatedA9(activeFailRefRaw))} / <span style="color:var(--q-red-ink);">${escapeHtml(formatEstimatedA9(activeFailBurnRaw))}</span></b></div>
        <div class="q-kv"><span>${hasExisting ? L('提前解押总仓退回（85% / 烧 15%）', 'Early Exit Combined (85% / 15% Burn)') : L('提前解押退回（85% / 烧 15%）', 'Early Exit (85% / 15% Burn)')}</span><b class="q-num">${escapeHtml(formatEstimatedA9(activeExitRefRaw))}（${L('烧', 'Burn')} ${escapeHtml(formatEstimatedA9(activeExitBurnRaw))}）</b></div>
        <div class="q-kv"><span>${L('预付网络费', 'Attached Gas')}</span><b class="q-num">${PROTOCOL_SPECS.stakeGasGram.toFixed(2)} GRAM</b></div>
      `;
      return { winValText, winSubText, loseValText, loseSubText, summaryRows, hasExisting, statusNote };
    };

    const initCalc = calculateStakePreview({
      view: r,
      existingTicket: getCurrentRoundTicket(),
      addAmountRaw: parseA9InputToRaw(defaultVal) ?? 0n,
      inFirst6h: activeFirst6h,
    });
    const initBill = renderBillHtml(initCalc);
    const canFunds = store.fundsEnabled;

    openQuestSheet(
      L(`锁仓参赛 · 第 ${r.currentRound ?? '—'} 关`, `Lock A9 · Stage ${r.currentRound ?? '—'}`),
      `
        <div class="q-notice ${activeFirst6h ? 'red' : 'gray'}" id="q-stake-phase-notice" style="margin-bottom:12px;">
          ${qIcon('clock', 16)}
          <span id="q-stake-phase-text">${activeFirst6h
            ? L('头矿 6 小时窗口：本次锁入未达标仅 5% 止损（退 95%），窗口结束后变为 10%', 'First 6H window: 5% stop-loss (95% refund) if missed; 10% after window')
            : L('头矿已结束 · 本次锁入未达标退 90%（10% 止损），封盘后禁进禁出', 'First 6H ended · 90% refund (10% stop-loss) if missed; sealed during 12H push')}</span>
        </div>

        <div class="q-amt-box">
          <input id="q-stake-input" inputmode="decimal" autocomplete="off" value="${escapeHtml(String(defaultVal))}" aria-label="${L('锁仓数量 A9', 'Lock amount A9')}" />
          <span>A9</span>
        </div>

        <div class="q-row q-between q-small q-muted" style="margin:6px 2px 4px;">
          <span>${L('可用余额', 'Available')}: <b id="q-stake-avail" class="q-num" style="color:var(--q-ink);">${availRaw !== null ? formatRoundA9(availRaw.toString()) : '—'}</b></span>
          <span id="q-stake-err" style="color:var(--q-red-ink);font-weight:700;"></span>
        </div>

        <div class="q-qchips">
          ${[100, 1000, 10000, 50000].map((v) => {
            const over = availRaw !== null && (BigInt(v) * 1_000_000_000n > availRaw);
            return `<button type="button" data-q-chip="${v}" ${over ? 'disabled' : ''}>${formatNum(v, 0)}</button>`;
          }).join('')}
          <button type="button" data-q-chip="${availRaw !== null ? escapeHtml(rawToPlainDecimal(availRaw)) : ''}" data-q-chip-max="1" ${availRaw === null || availRaw < minRaw ? 'disabled' : ''}>${L('全部', 'Max')}</button>
        </div>

        <div class="q-ocs" style="margin-top:10px;">
          <div class="q-oc q-oc-win">
            <small>${qIcon('trophy', 14)} ${initBill.hasExisting ? L('追加后若达标（≥ 8/12）', 'Combined If Passed (≥ 8/12)') : L('若达标（≥ 8/12）', 'If Passed (≥ 8/12)')}</small>
            <b id="q-oc-win-val" class="q-num">${escapeHtml(initBill.winValText)}</b>
            <span id="q-oc-win-sub">${escapeHtml(initBill.winSubText)}</span>
          </div>
          <div class="q-oc q-oc-lose">
            <small>${qIcon('shield', 14)} ${initBill.hasExisting ? L('追加后若未达标', 'Combined If Missed') : L('若未达标', 'If Missed')}</small>
            <b id="q-oc-lose-val" class="q-num">${escapeHtml(initBill.loseValText)}</b>
            <span id="q-oc-lose-sub">${escapeHtml(initBill.loseSubText)}</span>
          </div>
        </div>

        <div id="q-stake-summary" style="margin-top:10px;">${initBill.summaryRows}</div>
        <div class="q-foot-note">${L('按当前全轮锁仓量估算，最终以结算为准；最低锁仓 100 A9，单人奖励封顶 5×。', 'Estimated from current round stake; final payout settled on-chain. Min lock 100 A9, 5× cap per wallet.')}</div>
        ${!canFunds ? `<div class="q-notice yellow" style="margin-top:10px;">${qIcon('info', 16)}<span>${escapeHtml(LIVE_READONLY_REASON)}</span></div>` : ''}
      `,
      {
        badgeHtml: `<span class="q-chip ${activeFirst6h ? 'q-chip-red' : ''}" id="q-stake-phase-badge">${activeFirst6h ? L('头矿 5% 止损', 'First 6H · 5%') : L('普通 10% 止损', 'Standard · 10%')}</span>`,
        footHtml: `<button class="q-btn q-btn-red q-btn-block" id="q-stake-submit" type="button" ${!canFunds ? 'disabled' : ''}>${qIcon('lock', 18)} ${canFunds ? L('确认锁仓并前往签名', 'Confirm Lock & Sign') : L('当前只读 · 暂未开放锁仓', 'Read-Only · Locking Disabled')}</button>`,
      }
    );

    const inp = document.getElementById('q-stake-input');
    const errEl = document.getElementById('q-stake-err');
    const submitBtn = document.getElementById('q-stake-submit');
    const winValEl = document.getElementById('q-oc-win-val');
    const winSubEl = document.getElementById('q-oc-win-sub');
    const loseValEl = document.getElementById('q-oc-lose-val');
    const loseSubEl = document.getElementById('q-oc-lose-sub');
    const summaryEl = document.getElementById('q-stake-summary');
    const phaseNoticeEl = document.getElementById('q-stake-phase-notice');
    const phaseTextEl = document.getElementById('q-stake-phase-text');
    const phaseBadgeEl = document.getElementById('q-stake-phase-badge');

    let lastCalc = initCalc;
    const syncPhaseUi = (nowFirst6h) => {
      activeFirst6h = Boolean(nowFirst6h);
      if (phaseNoticeEl) {
        phaseNoticeEl.className = `q-notice ${activeFirst6h ? 'red' : 'gray'}`;
      }
      if (phaseTextEl) {
        phaseTextEl.textContent = activeFirst6h
          ? L('头矿 6 小时窗口：本次锁入未达标仅 5% 止损（退 95%），窗口结束后变为 10%', 'First 6H window: 5% stop-loss (95% refund) if missed; 10% after window')
          : L('头矿已结束 · 本次锁入未达标退 90%（10% 止损），封盘后禁进禁出', 'First 6H ended · 90% refund (10% stop-loss) if missed; sealed during 12H push');
      }
      if (phaseBadgeEl) {
        phaseBadgeEl.className = `q-chip ${activeFirst6h ? 'q-chip-red' : ''}`;
        phaseBadgeEl.textContent = activeFirst6h ? L('头矿 5% 止损', 'First 6H · 5%') : L('普通 10% 止损', 'Standard · 10%');
      }
    };

    const syncPreview = () => {
      const curPhase = deriveRoundUiState({ detail: store.state.round, serverNowMs: serverNowMs() });
      if (curPhase.stage === 'stake' && Boolean(curPhase.inFirst6h) !== activeFirst6h) {
        syncPhaseUi(curPhase.inFirst6h);
      }
      const addRaw = parseA9InputToRaw(inp?.value ?? '');
      lastCalc = calculateStakePreview({
        view: store.state.round,
        existingTicket: getCurrentRoundTicket(),
        addAmountRaw: addRaw ?? 0n,
        inFirst6h: activeFirst6h,
      });
      const bill = renderBillHtml(lastCalc);
      if (winValEl) winValEl.textContent = bill.winValText;
      if (winSubEl) winSubEl.textContent = bill.winSubText;
      if (loseValEl) loseValEl.textContent = bill.loseValText;
      if (loseSubEl) loseSubEl.textContent = bill.loseSubText;
      if (summaryEl) summaryEl.innerHTML = bill.summaryRows;
      let errMsg = '';
      if (addRaw === null && String(inp?.value || '').trim() !== '') {
        errMsg = L('请输入有效 A9 数量（最多 9 位小数）', 'Enter a valid A9 amount (max 9 decimals)');
      } else if (addRaw !== null && addRaw > 0n && addRaw < minRaw) {
        errMsg = L(`最低锁仓 ${PROTOCOL_SPECS.minStakeA9} A9`, `Minimum ${PROTOCOL_SPECS.minStakeA9} A9`);
      } else if (availRaw !== null && addRaw !== null && addRaw > availRaw) {
        errMsg = L('A9 可用余额不足', 'Insufficient A9 balance');
      }
      if (errEl) errEl.textContent = errMsg;
      document.querySelectorAll('[data-q-chip]').forEach((btn) => {
        const isMax = btn.dataset?.qChipMax === '1';
        if (isMax && availRaw !== null) {
          btn.dataset.qChip = rawToPlainDecimal(availRaw);
        }
        const chipRaw = parseA9InputToRaw(btn.dataset?.qChip ?? '');
        const disabled = isMax
          ? (availRaw === null || availRaw < minRaw)
          : (availRaw !== null && chipRaw !== null && chipRaw > availRaw);
        btn.disabled = disabled;
        const active = !disabled && addRaw !== null && chipRaw !== null && addRaw === chipRaw;
        btn.classList?.toggle?.('is-active', active);
        btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
      });
      if (submitBtn) {
        submitBtn.disabled = !canFunds || addRaw === null || addRaw < minRaw || (availRaw !== null && addRaw > availRaw) || pendingTxManager.isLocked('stake');
      }
    };

    if (inp) inp.oninput = syncPreview;
    document.querySelectorAll('[data-q-chip]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.disabled) return;
        if (inp) inp.value = btn.dataset.qChip;
        syncPreview();
      };
    });
    syncPreview();
    if (isLive && availRaw === null && u.connected && u.address) {
      const reqWallet = u.address;
      const reqRound = r.currentRound;
      fetchUserPortfolio(reqWallet, { fromRound: reqRound, toRound: reqRound })
        .then((pf) => {
          if (!inp || !inp.isConnected || reqWallet !== store.state.user.address) return;
          if (pf) local.portfolio = pf;
          const freshStr = String(pf?.a9BalanceRaw ?? '');
          if (/^\d+$/.test(freshStr)) {
            availRaw = BigInt(freshStr);
            const availEl = document.getElementById('q-stake-avail');
            if (availEl) availEl.textContent = formatRoundA9(availRaw.toString());
            syncPreview();
          }
        })
        .catch(() => {});
    }

    if (submitBtn) {
      submitBtn.onclick = async () => {
        const submittedAmount = inp?.value ?? '';
        const addRaw = parseA9InputToRaw(submittedAmount);
        if (addRaw === null || addRaw < minRaw) return;
        const livePhaseBefore = deriveRoundUiState({ detail: store.state.round, serverNowMs: serverNowMs() });
        if (livePhaseBefore.stage !== 'stake') {
          showToast(L('当前已离开锁仓期，无法提交锁仓', 'Locking window has closed'), 'amber');
          paint();
          return;
        }
        if (Boolean(livePhaseBefore.inFirst6h) !== activeFirst6h) {
          syncPhaseUi(livePhaseBefore.inFirst6h);
          syncPreview();
          showToast(L('头矿 6 小时窗口已结束，已更新为 10% 止损账单，请核对后再次确认', 'First 6H ended; updated to 10% stop-loss terms. Please review and confirm again.'), 'amber');
          return;
        }
        const snapshotFirst6h = activeFirst6h;
        const roundController = store.state.round.protocolConfig?.contracts?.roundController || '';
        const wallet = store.state.user.address;
        const roundId = store.state.round.currentRound;
        const range = { fromRound: roundId, toRound: roundId };
        let baseline = null;
        let userJettonWallet = '';
        let freshTicket = getCurrentRoundTicket();
        if (isLive) {
          const origSubmitHtml = submitBtn.innerHTML;
          submitBtn.disabled = true;
          submitBtn.innerHTML = `${qIcon('lock', 18)} ${L('正在核验余额…', 'Checking balance…')}`;
          try {
            const portfolio = await fetchUserPortfolio(wallet, range);
            local.portfolio = portfolio;
            baseline = stakeTicketAmount(portfolio, roundId);
            userJettonWallet = portfolio?.jettonWallet || '';
            freshTicket = Array.isArray(portfolio?.tickets) ? (portfolio.tickets.find((t) => finiteOrNull(t.roundId) === finiteOrNull(roundId) && !t.exited) || null) : null;
            if (baseline === null || !userJettonWallet) throw new Error(L('票据或钱包信息待同步，请重试', 'Ticket or wallet unavailable. Please retry.'));
            const freshAvailStr = String(portfolio?.a9BalanceRaw ?? '');
            const availEl = document.getElementById('q-stake-avail');
            if (!/^\d+$/.test(freshAvailStr)) {
              availRaw = null;
              if (availEl) availEl.textContent = '—';
              throw new Error(L('可用余额待同步，请重试', 'Available balance unavailable. Please retry.'));
            }
            availRaw = BigInt(freshAvailStr);
            if (availEl) availEl.textContent = formatRoundA9(availRaw.toString());
            if (addRaw > availRaw) {
              throw new Error(L(`A9 可用余额不足（当前可用 ${formatRoundA9(availRaw.toString())}）`, `Insufficient A9 balance (${formatRoundA9(availRaw.toString())} available)`));
            }
          } catch (error) {
            showToast(error.message, 'error');
            submitBtn.innerHTML = origSubmitHtml;
            syncPreview();
            return;
          }
          submitBtn.innerHTML = origSubmitHtml;
        }
        const confirmCalc = calculateStakePreview({
          view: store.state.round,
          existingTicket: freshTicket,
          addAmountRaw: addRaw,
          inFirst6h: snapshotFirst6h,
        });
        const hasEx = BigInt(confirmCalc.existing.principalRaw) > 0n;
        const estRewardText = hasEx
          ? (confirmCalc.combined.winRewardRaw !== null ? formatEstimatedA9(confirmCalc.combined.winRewardRaw) : '—')
          : (confirmCalc.addition.newShareRewardRaw !== null ? formatEstimatedA9(confirmCalc.addition.newShareRewardRaw) : '—');
        const failRefText = formatRoundA9(hasEx ? confirmCalc.combined.failRefundRaw : confirmCalc.addition.failRefundRaw);
        const failBurnText = formatRoundA9(hasEx ? confirmCalc.combined.failBurnRaw : confirmCalc.addition.failBurnRaw);
        const exitRefText = formatRoundA9(hasEx ? confirmCalc.combined.earlyExitRefundRaw : confirmCalc.addition.earlyExitRefundRaw);
        let confirmDismissReason = null;
        const accepted = await tonConnect.confirmBeforeSign({
          title: L(`确认锁仓第 ${roundId ?? '—'} 关`, `Confirm Stage ${roundId ?? '—'} Lock`),
          contractLabel: 'RoundController',
          targetAddress: roundController || (isLive ? '' : 'EQD_DEMO_ROUND_CONTROLLER'),
          principalText: formatRoundA9(confirmCalc.addition.principalRaw),
          gasText: `${PROTOCOL_SPECS.stakeGasGram.toFixed(2)} GRAM`,
          totalText: `${formatRoundA9(confirmCalc.addition.principalRaw)} + ${PROTOCOL_SPECS.stakeGasGram.toFixed(2)} GRAM`,
          note: L(
            `${snapshotFirst6h ? '头矿 6 小时（5% 止损）' : '头矿已结束（10% 止损）'} · 通关预估奖金 ${estRewardText}（按当前全轮锁仓量估算，最终以结算为准）· 未通关退 ${failRefText} / 烧 ${failBurnText} · 提前解押退 ${exitRefText}。`,
            `${snapshotFirst6h ? 'First 6H (5% SL)' : 'Standard (10% SL)'} · Est. pass reward ${estRewardText} (subject to final stake) · Miss refund ${failRefText} / burn ${failBurnText} · Early exit ${exitRefText}.`
          ),
          insufficientReason: !store.fundsEnabled
            ? LIVE_READONLY_REASON
            : (isLive && (!roundController || !userJettonWallet)
              ? L('缺少 A9 JettonWallet 或 RoundController 合约地址，请刷新持仓后重试', 'Missing JettonWallet or RoundController address; refresh and retry')
              : ''),
          onDismiss: (reason) => { confirmDismissReason = reason; },
        });
        if (!accepted) {
          const modalRoot = typeof document !== 'undefined' ? document.getElementById('modal-root') : null;
          const modalStillReplaced = Boolean(modalRoot && modalRoot.classList && !modalRoot.classList.contains('hidden'));
          const sameContext = seq === stageViewSeq && root.isConnected && wallet === store.state.user.address && roundId === store.state.round.currentRound;
          if (confirmDismissReason === 'user_cancel' && sameContext && !modalStillReplaced) {
            const cancelPhase = deriveRoundUiState({ detail: store.state.round, serverNowMs: serverNowMs() });
            if (cancelPhase.stage === 'stake') {
              openStakePreviewSheet(cancelPhase, submittedAmount);
              if (Boolean(cancelPhase.inFirst6h) !== snapshotFirst6h) {
                showToast(L('头矿 6 小时窗口已结束，已为你保留输入并更新为 10% 止损账单', 'First 6H ended; kept your input and updated to 10% stop-loss bill'), 'amber');
              }
            }
          } else {
            syncPreview();
          }
          return;
        }

        // 最终确认后，Demo 与 Live 统一按当前服务端时间、钱包、轮次和在途锁重新复核
        if (wallet !== store.state.user.address || roundId !== store.state.round.currentRound || pendingTxManager.isLocked()) {
          showToast(L('钱包、轮次或交易状态已变更，请重新确认', 'Wallet, round, or tx state changed. Please confirm again.'), 'amber');
          syncPreview();
          return;
        }
        const postRound = store.state.round;
        const postPhase = deriveRoundUiState({ detail: postRound, serverNowMs: serverNowMs() });
        if (postPhase.stage !== 'stake') {
          showToast(L('当前已离开锁仓期，操作已取消', 'Locking window has closed; action cancelled.'), 'amber');
          paint();
          return;
        }
        if (Boolean(postPhase.inFirst6h) !== snapshotFirst6h) {
          if (!isLive) store.state.round.inFirst6h = Boolean(postPhase.inFirst6h);
          openStakePreviewSheet(postPhase, submittedAmount);
          showToast(L('头矿 6 小时窗口已结束，已切换为普通仓（10% 止损），请核对新账单后重新确认', 'First 6H ended; switched to Standard (10% stop-loss). Review the updated bill and confirm again.'), 'amber');
          return;
        }

        if (!isLive) {
          const cert = store.stakeTon(rawToPlainDecimal(addRaw), { inFirst6h: snapshotFirst6h, amountRaw: addRaw.toString() });
          if (cert) {
            A9Haptic.success();
            A9Audio.confirm();
            showToast(L(`[演示模式] 已锁仓 ${formatRoundA9(addRaw.toString())}`, `[Demo] Locked ${formatRoundA9(addRaw.toString())}`));
            paint();
          }
          return;
        }

        try {
          const amountA9Raw = addRaw.toString();
          if (!postRound.stakingEnabled || postRound.stale || postRound.detailStale || postRound.detailLoading) {
            throw new Error(L('锁仓条件已更新，请刷新后确认', 'Lock conditions changed. Refresh and confirm again.'));
          }
          await tonConnect.sendV15StakeA9({
            userJettonWallet,
            roundController,
            userAddress: wallet,
            amountA9Raw,
            roundId,
          });
          A9Haptic.success();
          const tx = pendingTxManager.start({
            kind: 'stake',
            title: `第 ${roundId ?? '—'} 关锁仓`,
            titleEn: `Stage ${roundId ?? '—'} Lock`,
            amountText: formatRoundA9(amountA9Raw),
            explorerAddress: roundController,
            targetRoute: '/round',
          });
          pendingTxManager.pollUntilConfirmed({
            txId: tx?.id,
            checkFn: async () => {
              const pf = await fetchUserPortfolio(wallet, range);
              if (stakeTicketAmount(pf, roundId) === baseline + BigInt(amountA9Raw)) {
                local.portfolio = pf;
                return { confirmed: true, detail: '锁仓已链上确认，票据已生效。', detailEn: 'Lock confirmed on-chain.' };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('锁仓已确认上链！', 'Lock confirmed on-chain!'));
              paint();
            },
          });
          showToast(L('锁仓交易已提交，正在核验链上回执…', 'Lock transaction sent, awaiting finality…'));
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起锁仓失败，请重试', 'Lock transaction failed'), 'error');
        }
      };
    }
  };

  function quoteEarlyExit(ticket, r) {
    const calc = calculateStakePreview({ view: r, existingTicket: ticket, addAmountRaw: 0n, inFirst6h: false });
    const principalRaw = calc.existing.principalRaw;
    const refundRaw = /^\d+$/.test(String(ticket.earlyExitRefundRaw ?? '')) && BigInt(ticket.earlyExitRefundRaw) > 0n
      ? String(ticket.earlyExitRefundRaw)
      : calc.existing.earlyExitRefundRaw;
    const burnRaw = /^\d+$/.test(String(ticket.earlyExitBurnRaw ?? '')) && BigInt(ticket.earlyExitBurnRaw) > 0n
      ? String(ticket.earlyExitBurnRaw)
      : calc.existing.earlyExitBurnRaw;
    const consistent = String(ticket.amountRaw) === principalRaw &&
      refundRaw === calc.existing.earlyExitRefundRaw && burnRaw === calc.existing.earlyExitBurnRaw;
    return { calc, principalRaw, refundRaw, burnRaw, consistent };
  }

  const openEarlyExitSheet = (ticket) => {
    if (!ticket?.ticketAddress) return;
    const r = store.state.round;
    const wallet = store.state.user.address;
    const { calc, principalRaw, refundRaw, burnRaw, consistent } = quoteEarlyExit(ticket, r);
    if (!consistent) {
      showToast(L('票据金额尚未同步，请刷新仓位再试', 'Ticket amounts are out of sync. Refresh your position and try again.'), 'amber');
      void loadAuxData();
      return;
    }
    const winRewardRaw = calc.existing.winRewardRaw;
    const missRefundRaw = calc.existing.failRefundRaw;
    const missBurnRaw = calc.existing.failBurnRaw;
    const extraSavedRaw = BigInt(missRefundRaw) > BigInt(refundRaw) ? (BigInt(missRefundRaw) - BigInt(refundRaw)).toString() : '0';
    const hasPrincipal = BigInt(principalRaw) > 0n;
    const canFunds = store.fundsEnabled && ticket.canEarlyExit !== false;

    openQuestSheet(
      L('提前解押（仅限 24 小时锁仓期）', 'Early Exit (24H Lock Window Only)'),
      `
        <div class="q-notice yellow" style="margin-bottom:12px;">
          ${qIcon('info', 16)}
          <span>${L('封盘进入 12 小时冲价后合约自动禁止提前解押；提前解押扣除 15% 永久销毁且不可撤销。', 'Contract blocks early exit once 12H push begins; 15% burn is permanent.')}</span>
        </div>
        <div class="q-kv"><span>${L('当前锁仓本金', 'Locked Principal')}</span><b class="q-num">${escapeHtml(formatRoundA9(principalRaw))}</b></div>
        <div class="q-kv"><span>${L('退回 85% 本金', '85% Refund')}</span><b class="q-num green">${escapeHtml(formatRoundA9(refundRaw))}</b></div>
        <div class="q-kv"><span>${L('扣除 15% 销毁', '15% Burned')}</span><b class="q-num red">${escapeHtml(formatRoundA9(burnRaw))}</b></div>
        <div class="q-kv"><span>${L('预付网络费', 'Attached Gas')}</span><b class="q-num">${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)} GRAM</b></div>
        ${hasPrincipal ? `
          <div class="q-sec-t" style="margin-top:12px;">${L('坚持到结算会怎样', 'If You Hold Until Settlement')}</div>
          <div class="q-ocs" style="margin-top:6px;">
            <div class="q-oc q-oc-win">
              <small>${qIcon('trophy', 14)} ${L('若达标（≥ 8/12）', 'If Passed (≥ 8/12)')}</small>
              <b class="q-num">${winRewardRaw !== null ? escapeHtml(formatEstimatedA9(winRewardRaw, { gain: true })) : '—'}</b>
              <span>${L(`本金 ${formatRoundA9(principalRaw)} 全退（按当前全轮锁仓估算）`, `100% principal (${formatRoundA9(principalRaw)}) back`)}</span>
            </div>
            <div class="q-oc q-oc-lose">
              <small>${qIcon('shield', 14)} ${L('若未达标', 'If Missed')}</small>
              <b class="q-num">${L(`退 ${escapeHtml(formatEstimatedA9(missRefundRaw))}`, `Refund ${escapeHtml(formatEstimatedA9(missRefundRaw))}`)}</b>
              <span>${BigInt(extraSavedRaw) > 0n
                ? L(`仍比提前解押多保 ${escapeHtml(formatEstimatedA9(extraSavedRaw))}（止损烧 ${escapeHtml(formatEstimatedA9(missBurnRaw))}）`, `Preserves ${escapeHtml(formatEstimatedA9(extraSavedRaw))} more than early exit (burn ${escapeHtml(formatEstimatedA9(missBurnRaw))})`)
                : L(`止损 ${escapeHtml(formatEstimatedA9(missBurnRaw))} 销毁`, `Stop-loss ${escapeHtml(formatEstimatedA9(missBurnRaw))} burned`)}</span>
            </div>
          </div>
        ` : ''}
      `,
      {
        footHtml: `
          <div class="q-btn-row">
            <button class="q-btn q-btn-ghost q-grow" id="q-exit-cancel" type="button">${L('再想想', 'Cancel')}</button>
            <button class="q-btn q-btn-outline-red q-grow" id="q-exit-confirm" type="button" ${!canFunds ? 'disabled' : ''}>${L('确认解押', 'Confirm Exit')}</button>
          </div>
        `,
      }
    );

    const cancelBtn = document.getElementById('q-exit-cancel');
    if (cancelBtn) cancelBtn.onclick = () => closeModal();
    let exiting = false;
    const confirmBtn = document.getElementById('q-exit-confirm');
    if (confirmBtn) {
      confirmBtn.onclick = async () => {
        if (exiting || pendingTxManager.isLocked() || ticket.canEarlyExit === false) return;
        exiting = true;
        const origConfirmText = confirmBtn.textContent;
        confirmBtn.disabled = true;
        confirmBtn.textContent = L('正在核验票据…', 'Verifying ticket…');
        const origRoundId = finiteOrNull(ticket.roundId);
        const origTicketAddr = ticket.ticketAddress;
        try {
          const ok = await tonConnect.confirmBeforeSign({
            title: L('确认提前解押', 'Confirm Early Exit'),
            contractLabel: 'Round Ticket',
            targetAddress: origTicketAddr,
            principalText: `${formatRoundA9(refundRaw)}（${L('销毁', 'Burn')} ${formatRoundA9(burnRaw)}）`,
            gasText: `${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)} GRAM`,
            totalText: `${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)} GRAM`,
            insufficientReason: !store.fundsEnabled ? LIVE_READONLY_REASON : '',
          });
          if (!ok || wallet !== store.state.user.address || pendingTxManager.isLocked() ||
              finiteOrNull(store.state.round.currentRound) !== origRoundId ||
              deriveRoundUiState({ detail: store.state.round, serverNowMs: serverNowMs() }).stage !== 'stake') {
            if (ok) showToast(L('轮次、钱包或交易状态已变更，已取消提前解押', 'Round, wallet, or lock state changed; early exit cancelled.'), 'amber');
            return;
          }
          let freshTicket;
          if (isLive) {
            const pf = await fetchUserPortfolio(wallet, { fromRound: origRoundId, toRound: origRoundId });
            freshTicket = pf?.ticketsAvailable === true && Array.isArray(pf.tickets)
              ? pf.tickets.find(t => t.ticketAddress === origTicketAddr && finiteOrNull(t.roundId) === origRoundId)
              : null;
          } else {
            freshTicket = getCurrentRoundTicket();
          }
          if (wallet !== store.state.user.address || pendingTxManager.isLocked() ||
              finiteOrNull(store.state.round.currentRound) !== origRoundId ||
              deriveRoundUiState({ detail: store.state.round, serverNowMs: serverNowMs() }).stage !== 'stake' ||
              !freshTicket || freshTicket.ticketAddress !== origTicketAddr || finiteOrNull(freshTicket.roundId) !== origRoundId ||
              freshTicket.canEarlyExit !== true || freshTicket.pending || freshTicket.exited ||
              !(/^\d+$/.test(String(freshTicket.amountRaw ?? '')) && BigInt(freshTicket.amountRaw) > 0n)) {
            showToast(L('票据权限或轮次状态已变更，已拦截提前解押', 'Ticket permission or round state changed; early exit blocked.'), 'amber');
            void loadAuxData();
            return;
          }
          const updated = quoteEarlyExit(freshTicket, store.state.round);
          if (!updated.consistent || updated.principalRaw !== principalRaw || updated.refundRaw !== refundRaw || updated.burnRaw !== burnRaw) {
            openEarlyExitSheet(freshTicket);
            showToast(L('仓位金额已变化，请核对新的解押账单', 'Position changed. Review the updated early exit amounts.'), 'amber');
            return;
          }
          if (!isLive) {
            const refund = (await loadDemoModule()).demoEarlyExit(store.state, origRoundId);
            if (refund === null) return;
            store.notify();
            showToast(L('[演示模式] 已模拟完成提前解押', '[Demo] Simulated Early Exit completed'));
            paint();
            return;
          }
          await tonConnect.sendV17TicketEarlyExit(origTicketAddr);
          A9Haptic.success();
          const tx = pendingTxManager.start({
            kind: 'early_exit',
            title: `第 ${ticket.roundId ?? '—'} 关提前解押`,
            titleEn: `Stage ${ticket.roundId ?? '—'} Early Exit`,
            amountText: formatRoundA9(refundRaw),
            explorerAddress: ticket.ticketAddress,
            targetRoute: '/round',
          });
          void pendingTxManager.pollUntilConfirmed({
            txId: tx.id,
            checkFn: async () => {
              const pf = await fetchUserPortfolio(wallet, { fromRound: ticket.roundId, toRound: ticket.roundId });
              if (pf?.ticketsAvailable !== true || !Array.isArray(pf.tickets)) return false;
              const after = pf.tickets.find(t => t.ticketAddress === ticket.ticketAddress);
              return after ? after.exited === true && !after.pending : BigInt(ticket.amountRaw) > 0n;
            },
            onConfirmed: () => { if (root.isConnected) void loadAuxData(); },
          });
          showToast(L('提前解押交易已提交，正在核验链上确认…', 'Early Exit sent, awaiting finality…'));
          void loadAuxData();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起提前解押失败', 'Early Exit failed'), 'error');
        } finally {
          exiting = false;
          if (confirmBtn.isConnected) {
            confirmBtn.textContent = origConfirmText;
            confirmBtn.disabled = !store.fundsEnabled || ticket.canEarlyExit === false;
          }
        }
      };
    }
  };

  const paint = () => {
    if (seq !== stageViewSeq || !root.isConnected) return;
    const r = store.state.round;
    const u = store.state.user;
    const nowMs = serverNowMs();
    const ui = deriveRoundUiState({ detail: r, user: u, rewards: local.portfolio, serverNowMs: nowMs });
    const roundId = finiteOrNull(r.currentRound);
    const cdText = fmtStageCountdown(ui.countdownMs, ui.countdownLabel);
    const track = calcTrackSegments(r, nowMs);
    const myTicket = getCurrentRoundTicket();
    const myStakeA9 = myTicket ? rawToA9(myTicket.amountRaw) : null;
    const stakeCloseMs = toMs(r.stakeCloseAt);
    const canEarlyExitNow = Boolean(
      ui.stage === 'stake' &&
      myTicket &&
      !myTicket.exited &&
      !myTicket.pending &&
      (myTicket.canEarlyExit === false
        ? false
        : (myTicket.canEarlyExit === true || (!isLive && stakeCloseMs !== null && nowMs < stakeCloseMs)))
    );
    const ticketVaultHref = myTicket?.ticketAddress
      ? `#/rewards?ticket=${encodeURIComponent(myTicket.ticketAddress)}`
      : '#/rewards';

    const heroThemeByStage = {
      warmup: 'q-hero--amber',
      stake: '',
      sealed: 'q-hero--ink',
      charge: 'q-hero--ink',
      settling: 'q-hero--ink',
      passed: 'q-hero--green',
      failed: 'q-hero--gray',
      aborted: 'q-hero--gray',
      unknown: 'q-hero--gray',
    };
    const heroCls = heroThemeByStage[ui.stage] ?? 'q-hero--gray';
    const isLivePulse = ui.stage === 'stake' || ui.stage === 'charge' || ui.stage === 'warmup';

    // 主卡 CTA 区块（每卡最多 1 个主白按钮）
    let heroCtaHtml = '';
    if (ui.stage === 'unknown') {
      heroCtaHtml = `<div class="q-hero-ctas"><button class="q-btn q-btn-white q-btn-block" id="q-stage-retry" type="button">${qIcon('refresh', 18)} ${L('重试同步', 'Retry Sync')}</button></div>`;
    } else if (ui.stage === 'warmup') {
      const wu = local.warmup;
      const isRes = Boolean(wu?.isReserved);
      heroCtaHtml = `
        <div class="q-hero-ctas">
          <button class="q-btn q-btn-white q-grow" id="q-wu-action" type="button" ${local.warmupBusy || (wu && !wu.open) ? 'disabled' : ''}>
            ${qIcon(isRes ? 'check' : 'bolt', 18)}
            ${isRes ? L('已预约 · 取消预约', 'Reserved · Cancel') : L('零门槛预约下轮', 'Reserve Next Stage')}
          </button>
        </div>
      `;
    } else if (ui.stage === 'stake') {
      if (!u.connected) {
        heroCtaHtml = `<div class="q-hero-ctas"><button class="q-btn q-btn-white q-btn-block" id="q-stage-connect" type="button">${qIcon('wallet', 18)} ${L('连接钱包参赛', 'Connect Wallet to Join')}</button></div>`;
      } else {
        const subTag = ui.inFirst6h ? L('5% 止损', '5% Stop-Loss') : L('10% 止损', '10% Stop-Loss');
        heroCtaHtml = `
          <div class="q-hero-ctas">
            <button class="q-btn q-btn-white q-grow" id="q-open-stake" type="button">
              ${myStakeA9 !== null && myStakeA9 > 0 ? L('追加锁仓', 'Add Lock') : L('锁仓参赛', 'Lock A9')}
              <span class="q-sub">${subTag}</span>
            </button>
            ${canEarlyExitNow ? `<button class="q-btn q-btn-glass" id="q-open-early-exit" type="button">${L('提前解押', 'Early Exit')}</button>` : ''}
          </div>
        `;
      }
    } else if (ui.stage === 'sealed') {
      heroCtaHtml = `<div class="q-hero-note">${qIcon('lock', 17)}<span>${L('锁仓与解押已关闭', 'Entries and exits closed')}</span></div>`;
    } else if (ui.stage === 'charge') {
      heroCtaHtml = `<div class="q-hero-note">${qIcon('chart', 17)}<span>${myTicket && /^\d+$/.test(String(myTicket.amountRaw ?? '')) && BigInt(myTicket.amountRaw) > 0n
        ? L(`我的锁仓 ${formatRoundA9(myTicket.amountRaw)}`, `My lock ${formatRoundA9(myTicket.amountRaw)}`)
        : L('参赛已封盘', 'Entries closed')}</span></div>`;
    } else if (ui.stage === 'passed') {
      heroCtaHtml = myTicket
        ? `<div class="q-hero-ctas"><a class="q-btn q-btn-white is-green q-btn-block" href="${ticketVaultHref}">${qIcon('vault', 18)} ${L('前往金库可领取奖励', 'Claimable in Vault')}</a></div>`
        : `<div class="q-hero-note">${qIcon('trophy', 17)}<span>${L('本轮已结算通关；你未持有本轮票据，可在金库查看历史票据。', 'Stage settled as Passed; you have no ticket for this round.')}</span></div>`;
    } else if (ui.stage === 'failed') {
      heroCtaHtml = myTicket
        ? `<div class="q-hero-ctas"><a class="q-btn q-btn-white q-btn-block" href="${ticketVaultHref}">${qIcon('shield', 18)} ${L('前往金库可领取止损退本', 'Claim Stop-Loss Refund in Vault')}</a></div>`
        : `<div class="q-hero-note">${qIcon('shield', 17)}<span>${L('本轮未达标已按止损结算；你未持有本轮票据。', 'Stage missed target and settled; you have no ticket for this round.')}</span></div>`;
    } else if (ui.stage === 'aborted') {
      heroCtaHtml = myTicket
        ? `<div class="q-hero-ctas"><a class="q-btn q-btn-white q-btn-block" href="${ticketVaultHref}">${qIcon('shield', 18)} ${L('异常中止 · 可领取 100% 无损退本', 'Aborted · 100% Principal Claimable')}</a></div>`
        : `<div class="q-hero-note">${qIcon('info', 17)}<span>${L('本轮已异常中止；你未持有本轮票据。', 'Stage aborted; you have no ticket for this round.')}</span></div>`;
    }

    // 12 面旗（支持点击查看单时段判定均价、目标价与状态）
    const slotCount = PROTOCOL_SPECS.passTotal;
    const threshold = finiteOrNull(r.minQualifiedCandles) ?? PROTOCOL_SPECS.passRequired;
    const qualified = finiteOrNull(r.qualifiedCandles);
    const showProvisional = canShowProvisionalPrice(r);
    const candlesByIndex = new Map((Array.isArray(r.candles) ? r.candles : []).map(c => [Number(c.index), c]));
    const candles = Array.from({ length: slotCount }, (_, idx) => {
      const index = idx + 1;
      const slot = candlesByIndex.get(index);
      if (slot?.status === 'active' && !showProvisional) return { index, status: 'unknown' };
      return slot || { index, status: 'pending' };
    });
    const showSlots = ['charge', 'settling', 'passed', 'failed', 'aborted'].includes(ui.stage) ||
      candles.some(candle => candle.status === 'closed' || candle.status === 'active');
    const pickedCandle = showSlots && local.selectedFlagIdx !== null
      ? (candles.find((c) => Number(c.index) === Number(local.selectedFlagIdx)) || null)
      : null;
    const flagsHtml = candles.map((c) => {
      const isPicked = pickedCandle !== null && Number(c.index) === Number(pickedCandle.index);
      const { tone, statusText } = describeCandleSlotDetail(c);
      const aria = escapeHtml(L(`第 ${c.index} 小时 · ${statusText}`, `Hour ${c.index} · ${statusText}`));
      const stateClass = { win: 'pass', lose: 'fail', active: 'now', missing: 'missing', idle: 'idle' }[tone];
      const marker = tone === 'win' ? qIcon('check', 12, 3) : tone === 'lose' ? qIcon('x', 11, 3) : tone === 'active' ? '<i></i>' : '';
      return `<button type="button" class="q-flag ${stateClass}${isPicked ? ' is-picked' : ''}" data-q-flag-idx="${c.index}" aria-pressed="${isPicked}" aria-label="${aria}"><span>${c.index}</span>${marker}</button>`;
    }).join('');
    const flagDetailHtml = pickedCandle ? (() => {
      const d = describeCandleSlotDetail(pickedCandle, r.targetPrice);
      return `
        <div class="q-flag-detail" id="q-flag-detail" data-flag-index="${d.index}">
          <span>${L(`第 ${d.index} 小时`, `Hour ${d.index}`)} · ${d.tone === 'active' ? L('暂定均价', 'Provisional avg') : L('均价', 'Avg')} <b class="q-num">${escapeHtml(d.priceText)}</b> · ${L('目标', 'Target')} <b class="q-num">${escapeHtml(d.targetText)}</b></span>
          <span class="q-fd-badge ${d.tone}">${escapeHtml(d.statusText)}</span>
        </div>
      `;
    })() : '';
    const flagStatus = buildChargeFlagStatusText(ui.stage, r);

    // 份额比例可以用近似小数，预算与余额展示保留原始精度。
    const totalStakedA9 = rawToA9(r.totalStakedRaw);
    const budgetA9 = rawToA9(r.rewardBudgetRaw);
    const poolRemRaw = r.poolState?.dataAvailable === true ? r.poolState.poolRemainingRaw : null;
    const carryA9 = rawToA9(r.nextRoundCarryRaw);
    const estPer1A9 = (budgetA9 !== null && budgetA9 >= 0 && totalStakedA9 !== null && totalStakedA9 > 0)
      ? Math.min(budgetA9 / totalStakedA9, PROTOCOL_SPECS.maxRewardMultiplier)
      : null;
    const multPct = estPer1A9 !== null ? Math.min(100, (estPer1A9 / PROTOCOL_SPECS.maxRewardMultiplier) * 100) : 0;

    // 预热模块（warmup 阶段或 query.stage === 'warmup' 时展示）
    const showWarmupCard = ui.stage === 'warmup' || query?.stage === 'warmup';
    const wu = local.warmup;
    const warmupCardHtml = showWarmupCard ? `
      <section class="q-card" id="q-warmup-card">
        <div class="q-card-h">
          <h3>${qIcon('gift', 18)} ${L('下轮预热 · 预约宝箱', 'Next-Stage Warm-Up')}</h3>
          <span class="q-chip q-chip-yellow">${wu?.roundId ? L(`目标第 ${wu.roundId} 关`, `Stage ${wu.roundId}`) : L('预热同步中', 'Syncing')}</span>
        </div>
        ${local.warmupError ? `
          <div class="q-notice red">${qIcon('info', 16)}<span>${escapeHtml(local.warmupError)}</span></div>
        ` : `
          <div class="q-grid2">
            <div class="q-stat">
              <small>${L('已预约人数', 'Reserved Players')}</small>
              <b class="q-num">${fmtIntOrDash(wu?.stats?.totalRegistered)}</b>
              <span>${wu?.stats?.targetUsers !== null && wu?.stats?.targetUsers !== undefined ? `${L('目标', 'Target')} ${fmtIntOrDash(wu.stats.targetUsers)}` : L('目标待公布', 'Target TBA')}</span>
            </div>
            <div class="q-stat">
              <small>${L('我的预约状态', 'My Status')}</small>
              <b>${wu?.isReserved ? L('已预约', 'Reserved') : L('未预约', 'Not Reserved')}</b>
              <span>${wu?.myWarmupChest?.totalA9Raw ? escapeHtml(formatRoundA9(wu.myWarmupChest.totalA9Raw)) : L('预约后领预热箱', 'Reserve for chest')}</span>
            </div>
          </div>
        `}
      </section>
    ` : '';

    const curBet = local.predUser?.currentBet;
    const predictionOpen = ui.stage === 'stake' && nowMs < toMs(r.stakeCloseAt);
    const poll = local.predRound;
    const validVotes = finiteOrNull(poll?.total) > 0 &&
      [poll.passPct, poll.burnPct].every(p => Number.isFinite(p) && p >= 0 && p <= 100) &&
      Math.abs(poll.passPct + poll.burnPct - 100) <= 1;
    const voteShareHtml = validVotes ? `
        <div class="q-pred-votes">
          <div class="q-pred-votes-label">
            <span>${L('达标', 'Pass')} <b class="q-num">${poll.passPct}%</b></span>
            <span>${L('未达标', 'Miss')} <b class="q-num">${poll.burnPct}%</b></span>
          </div>
          <div class="q-pred-votes-bar" aria-hidden="true">
            <i style="flex-grow:${poll.passPct}"></i><i style="flex-grow:${poll.burnPct}"></i>
          </div>
        </div>` : `<div class="q-foot-note">${poll?.total === 0 ? L('暂无投票', 'No votes yet') : L('投票数据待同步', 'Vote data pending')}</div>`;
    const winner = poll?.settled && poll.winningSide;
    const isHistoricalDl = Boolean(local.dlType && local.dlRoundId !== null && roundId !== null && local.dlRoundId !== roundId);
    const predictionKey = JSON.stringify([config.isDemo, roundId, u.address, getEffectiveUserId(u)]);
    let pendingScrollSelector = null;
    if (!local.deepLinkApplied && local.dlType) {
      local.deepLinkApplied = true;
      if (isHistoricalDl) {
        pendingScrollSelector = '#q-stage-history-card';
      } else if (local.dlType === 'bet') {
        if (predictionOpen) expandedPredictionKey = predictionKey;
        pendingScrollSelector = '#q-toggle-prediction';
      } else if (local.dlType === 'burn') {
        pendingScrollSelector = '#q-flag-status';
      } else if (local.dlType === 'round') {
        pendingScrollSelector = '#q-race-card';
      }
    }
    const predictionExpanded = expandedPredictionKey === predictionKey;
    const matchedHistRound = isHistoricalDl && Array.isArray(r.rounds)
      ? r.rounds.find((item) => finiteOrNull(item.roundId) === local.dlRoundId)
      : null;
    const histStatusText = matchedHistRound
      ? (String(matchedHistRound.state || '').toUpperCase() === 'SUCCEEDED'
        ? L(`已通关 ${matchedHistRound.qualifiedCandles ?? '—'}/12`, `Passed ${matchedHistRound.qualifiedCandles ?? '—'}/12`)
        : String(matchedHistRound.state || '').toUpperCase() === 'FAILED_PERMANENT'
          ? L(`未达标 ${matchedHistRound.qualifiedCandles ?? '—'}/12`, `Missed ${matchedHistRound.qualifiedCandles ?? '—'}/12`)
          : String(matchedHistRound.state || '').toUpperCase() === 'TECHNICAL_ABORTED'
            ? L('已中止', 'Aborted')
            : L('历史轮次', 'Historical'))
      : L('历史轮次', 'Historical');
    const deepLinkBannerHtml = !local.dlType ? '' : isHistoricalDl ? `
      <div class="q-notice yellow" id="q-deeplink-banner" data-deeplink-type="${escapeHtml(local.dlType)}" data-deeplink-round="${escapeHtml(String(local.dlRoundId))}" data-deeplink-historical="1">
        ${qIcon('clock', 16)}
        <span>${L(`链接指向历史第 ${local.dlRoundId} 关（${histStatusText}），当前展示第 ${roundId ?? '—'} 关；历史链接不会自动展开本轮预测下注。`, `Link targets historical Stage ${local.dlRoundId} (${histStatusText}); showing current Stage ${roundId ?? '—'} without auto-opening betting.`)}</span>
      </div>
    ` : (local.dlType === 'bet' && !predictionOpen) ? `
      <div class="q-notice blue" id="q-deeplink-banner" data-deeplink-type="bet" data-deeplink-round="${escapeHtml(String(local.dlRoundId ?? roundId ?? ''))}" data-deeplink-historical="0">
        ${qIcon('lock', 16)}
        <span>${L(`第 ${roundId ?? '—'} 关预测已封盘，当前展示 12H 冲价与结算进度。`, `Stage ${roundId ?? '—'} prediction is closed; showing 12H push & settlement progress.`)}</span>
      </div>
    ` : (local.dlType === 'burn' && ui.stage !== 'failed') ? `
      <div class="q-notice blue" id="q-deeplink-banner" data-deeplink-type="burn" data-deeplink-round="${escapeHtml(String(local.dlRoundId ?? roundId ?? ''))}" data-deeplink-historical="0">
        ${qIcon('info', 16)}
        <span>${L(`当前第 ${roundId ?? '—'} 关处于「${ui.badgeLabel}」阶段，下方为 12H 冲价与结算进度。`, `Stage ${roundId ?? '—'} is currently in ${ui.badgeLabel}; see 12H push & settlement below.`)}</span>
      </div>
    ` : '';
    const predictionHtml = predictionOpen || curBet ? `
      <button class="q-btn q-btn-ghost q-btn-block q-btn-sm" id="q-toggle-prediction" type="button"
        aria-expanded="${predictionExpanded}" aria-controls="q-prediction-panel">
        ${qIcon('eye', 16)} ${curBet ? L('已预测 · 查看我的选择', 'My prediction') : L('免费预测本轮结果', 'Predict this round for free')}
      </button>
      <div id="q-prediction-panel" ${predictionExpanded ? '' : 'hidden'}>
        ${curBet ? `<p class="q-small">${curBet.side === 'PASS' ? L('我的选择：达标', 'My pick: pass') : L('我的选择：未达标', 'My pick: miss')} ·
          ${winner === 'PASS' || winner === 'BURN' ? (winner === curBet.side ? L('预测正确', 'Correct prediction') : L('未猜中', 'Incorrect prediction')) :
            ui.stage === 'aborted' ? L('本轮已中止', 'Round aborted') : L('等待结算', 'Awaiting settlement')}</p>` : `
          <div class="q-pred">
            <button type="button" class="yes" data-q-pred="PASS" ${local.predBusy ? 'disabled' : ''}><b>${L('能达标', 'Will pass')}</b></button>
            <button type="button" class="no" data-q-pred="BURN" ${local.predBusy ? 'disabled' : ''}><b>${L('未达标', 'Will miss')}</b></button>
          </div>`}
        ${voteShareHtml}
      </div>` : '';

    // 当前关卡已有主卡。历史只展示有结算结果的轮次。
    const settledRounds = (Array.isArray(r.rounds) ? r.rounds : [])
      .filter((item) => Number.isSafeInteger(item?.roundId) && item.roundId > 0 &&
        ['SUCCEEDED', 'FAILED_PERMANENT', 'TECHNICAL_ABORTED'].includes(item.state))
      .sort((a, b) => b.roundId - a.roundId)
      .slice(0, 8);
    const successCount = Number.isSafeInteger(r.successCount) && r.successCount >= 0 ? r.successCount : null;
    const historyOpen = root.querySelector('#q-stage-history-card')?.open === true;
    const historyHtml = settledRounds.length || successCount > 0 ? `
      <details class="q-card q-history" id="q-stage-history-card" ${historyOpen ? 'open' : ''}>
        <summary class="q-history-summary">
          <span class="q-history-title">${qIcon('clock', 18)} ${L('关卡记录', 'Stage History')}</span>
          ${successCount === null ? '' : `<span class="q-chip ${successCount > 0 ? 'q-chip-green' : ''}">${L(`累计通关 ${formatNum(successCount)} 次`, `${formatNum(successCount)} passes total`)}</span>`}
          <span class="q-history-chevron" aria-hidden="true">${qIcon('chevR', 15)}</span>
        </summary>
        ${settledRounds.length ? `
          <ul class="q-history-list">
            ${settledRounds.map((item) => {
              const passed = item.state === 'SUCCEEDED';
              const aborted = item.state === 'TECHNICAL_ABORTED';
              const label = aborted ? L('已中止', 'Aborted') : passed ? L('已通关', 'Passed') : L('未达标', 'Missed');
              const seen = item.qualifiedCandles;
              const hasScore = !aborted && Number.isInteger(seen) && seen >= 0 && seen <= slotCount;
              const id = formatNum(item.roundId);
              return `<li><span>${L(`第 ${id} 关`, `Stage ${id}`)}</span>
                <b class="${passed ? 'is-passed' : ''}">${label}${hasScore ? ` · ${seen} / ${slotCount}` : ''}</b></li>`;
            }).join('')}
          </ul>
        ` : `<p class="q-small q-muted">${L('历史结算明细暂未同步。', 'Past settlement details have not synced yet.')}</p>`}
      </details>
    ` : '';

    const stepClass = (key) => {
      if (key === 'lock' && (ui.stage === 'stake' || ui.stage === 'warmup')) return 'on';
      if (key === 'push' && (ui.stage === 'sealed' || ui.stage === 'charge' || ui.stage === 'settling')) return 'on ink';
      if (key === 'win' && ui.stage === 'passed') return 'on green';
      if (key === 'win' && (ui.stage === 'failed' || ui.stage === 'aborted')) return 'on ink';
      return '';
    };

    const raceCardHtml = `
        <section class="q-card" id="q-race-card">
          <div class="q-card-h">
            <h3>${qIcon('flag', 18)} ${L('12 小时冲价', '12H Price Push')}</h3>
            <span class="q-chip q-num ${qualified !== null && qualified >= threshold ? 'q-chip-green' : ''}">
              ${qualified !== null ? L(`${qualified} / ${slotCount} 段达标`, `${qualified} / ${slotCount} met`) : L(`≥ ${threshold} / ${slotCount} 段达标`, `≥ ${threshold} / ${slotCount} required`)}
            </span>
          </div>
          <div id="q-race-plot">${racePriceChart(r, config.isDemo, pickedCandle ? Number(pickedCandle.index) : null)}</div>
          ${showSlots ? `
            <div class="q-race-slots-heading">
              <strong>${L('时段判定', 'Hourly results')}</strong>
              <small>${L('点选查看均价', 'Tap to inspect')}</small>
            </div>
            <div class="q-flags" role="group" aria-label="${L('选择冲价时段', 'Select an hourly period')}">${flagsHtml}</div>
            ${flagDetailHtml}
          ` : ''}
          <div class="q-flag-status ${flagStatus.tone}" id="q-flag-status">
            ${qIcon(flagStatus.tone === 'win' ? 'trophy' : flagStatus.tone === 'lose' ? 'shield' : 'info', 17)}
            <span>${escapeHtml(flagStatus.text)}</span>
          </div>
          ${predictionHtml}
        </section>
    `;

    const estimateText = estPer1A9 === null ? '—'
      : estPer1A9 > 0 && estPer1A9 < 0.01 ? '&lt; 0.01 A9' : `${formatNum(estPer1A9, 2)} A9`;
    const poolCardHtml = `
        <section class="q-card" id="q-pool-card">
          <div class="q-card-h">
            <h3>${qIcon('trophy', 18)} ${L('本关奖池', 'Stage Pool')}</h3>
            <a class="q-chip" href="#/rules" style="text-decoration:none;">${qIcon('info', 13)} ${L('规则', 'Rules')}</a>
          </div>
          <div class="q-grid2">
            <div class="q-stat">
              <small>${L('奖池预算', 'Pool Budget')} · A9</small>
              <b class="q-num">${escapeHtml(formatRoundA9(r.rewardBudgetRaw).replace(/ A9$/, ''))}</b>
            </div>
            <div class="q-stat">
              <small>${L('总锁仓', 'Total Locked')} · A9</small>
              <b class="q-num">${escapeHtml(formatRoundA9(r.totalStakedRaw).replace(/ A9$/, ''))}</b>
              <span>${finiteOrNull(r.stakerCount) !== null ? `${fmtIntOrDash(r.stakerCount)} ${L('人次', 'entries')}` : L('人数待同步', 'Entries pending')}</span>
            </div>
          </div>
          <div class="q-mult">
            <div class="q-mult-top">
              <div>
                <small>${L('每锁 1 A9 预计奖励', 'Est. Reward per 1 A9')}</small>
                <b class="q-num">${estimateText}</b>
              </div>
              <span class="q-chip q-chip-yellow">${L('单人封顶 5×', '5× Cap')}</span>
            </div>
            ${estPer1A9 !== null ? `<div class="q-bar" aria-hidden="true"><i style="width:${multPct.toFixed(1)}%"></i></div>` : ''}
          </div>
          <div class="q-race-pool-balances">
            <div class="q-kv"><span>${L('主奖池链上余额', 'On-chain Pool Balance')}</span><b class="q-num">${escapeHtml(formatRoundA9(poolRemRaw))}</b></div>
            ${carryA9 !== null && carryA9 > 0 ? `<div class="q-kv"><span>${L('下轮已确认滚存', 'Confirmed Carry-over')}</span><b class="q-num">${escapeHtml(formatRoundA9(r.nextRoundCarryRaw))}</b></div>` : ''}
          </div>
          <div class="q-foot-note">${L('超出封顶的奖励滚存下一关', 'Rewards above the cap carry over')}</div>
        </section>
    `;

    const myPosHtml = myTicket && /^\d+$/.test(String(myTicket.amountRaw ?? '')) && BigInt(myTicket.amountRaw) > 0n ? (() => {
      const posCalc = calculateStakePreview({ view: r, existingTicket: myTicket, addAmountRaw: 0n, inFirst6h: ui.inFirst6h });
      const ex = posCalc.existing;
      const splitNote = ex.splitSource === 'legacy_standard'
        ? L('旧票未记录分仓字段，按合约与服务端规则计入普通仓（10% 止损）。', 'Legacy ticket without split fields; calculated as Standard (10% stop-loss).')
        : ex.splitIncomplete
          ? L('票据分仓字段不完整，已按服务端可用字段保守核算。', 'Incomplete split fields; calculated conservatively from available data.')
          : '';
      return `
        <section class="q-card" id="q-my-pos-card">
          <div class="q-card-h">
            <h3>${qIcon('user', 18)} ${L('我的本关仓位', 'My Stage Position')}</h3>
            <span class="q-chip q-chip-red q-num">${escapeHtml(formatRoundA9(ex.principalRaw))}</span>
          </div>
          <div class="q-grid2">
            <div class="q-stat">
              <small>${L('头矿仓位 · 5% 止损', 'First 6H · 5%')}</small>
              <b class="q-num">${escapeHtml(formatRoundA9(ex.earlyRaw))}</b>
              <span>${L('未达标退 95%', '95% refund if missed')}</span>
            </div>
            <div class="q-stat">
              <small>${L('普通仓位 · 10% 止损', 'Standard · 10%')}</small>
              <b class="q-num">${escapeHtml(formatRoundA9(ex.lateRaw))}</b>
              <span>${L('未达标退 90%', '90% refund if missed')}</span>
            </div>
          </div>
          <div class="q-ocs" style="margin-top:10px;">
            <div class="q-oc q-oc-win">
              <small>${qIcon('trophy', 14)} ${L('已有仓位若达标（≥ 8/12）', 'Existing Position If Passed')}</small>
              <b class="q-num">${ex.winRewardRaw !== null ? escapeHtml(formatEstimatedA9(ex.winRewardRaw, { gain: true })) : '—'}</b>
              <span>${L('按当前全轮锁仓量估算，最终以结算为准；本金全退', 'Est. from current stake; 100% principal back')}</span>
            </div>
            <div class="q-oc q-oc-lose">
              <small>${qIcon('shield', 14)} ${L('已有仓位若未达标', 'Existing Position If Missed')}</small>
              <b class="q-num">${L(`退 ${escapeHtml(formatEstimatedA9(ex.failRefundRaw))}`, `Refund ${escapeHtml(formatEstimatedA9(ex.failRefundRaw))}`)}</b>
              <span>${L(`止损 ${escapeHtml(formatEstimatedA9(ex.failBurnRaw))} 销毁`, `Stop-loss ${escapeHtml(formatEstimatedA9(ex.failBurnRaw))} burned`)}</span>
            </div>
          </div>
          ${splitNote ? `<div class="q-foot-note">${escapeHtml(splitNote)}</div>` : ''}
        </section>
      `;
    })() : '';

    const heroLabelText = ui.stage === 'stake'
      ? (ui.inFirst6h
          ? L('头矿剩余 · 5% 止损', 'First 6H remaining · 5% stop-loss')
          : L('头矿已结束 · 本次锁入未达标退 90%', 'First 6H ended · 90% refund if missed'))
      : (ui.stage === 'charge' && r.rawState !== 'ORACLE_PAUSED'
          ? L('冲价剩余', 'Time left in price push')
          : ui.title);
    const isChargePriority = ui.stage === 'charge' || ui.stage === 'settling';

    root.innerHTML = `
      <div class="q-view" id="quest-stage-view" data-stage="${escapeHtml(ui.stage)}" data-deeplink-type="${escapeHtml(local.dlType)}">
        ${deepLinkBannerHtml}
        <section class="q-hero ${heroCls}" data-lock-phase="${ui.stage === 'stake' ? (ui.inFirst6h ? 'first6h' : 'standard') : ''}">
          <span class="q-wm">${pad2(roundId)}</span>
          <div class="q-hero-top">
            <span class="q-cart-tag">${L(`第 ${pad2(roundId)} 关`, `STAGE ${pad2(roundId)}`)}</span>
            <span class="q-phase-pill">${isLivePulse ? '<i class="q-live-dot"></i>' : ''}${escapeHtml(ui.badgeLabel)}</span>
          </div>
          <div class="q-hero-label">${escapeHtml(heroLabelText)}</div>
          <div class="q-hero-count q-num" id="${ui.inFirst6h ? 'early-window-cd' : 'round-cd'}">${ui.inFirst6h ? fmtStageCountdown(ui.earlyCountdownMs) : escapeHtml(cdText)}</div>
          ${ui.inFirst6h ? `<div class="q-hero-sub">${L('距封盘', 'Lock closes in')} <span id="round-cd">${escapeHtml(cdText)}</span></div>` : ''}
          ${['stake', 'charge'].includes(ui.stage) ? '' : `<div class="q-hero-sub">${escapeHtml(ui.subtitle)}</div>`}
          ${(ui.stage === 'stake' || ui.stage === 'sealed' || ui.stage === 'charge') ? `
            <div class="q-track">
              <div class="q-seg" style="flex:6"><i style="width:${track.s1.toFixed(1)}%"></i></div>
              <div class="q-seg" style="flex:18"><i style="width:${track.s2.toFixed(1)}%"></i></div>
              <div class="q-seg" style="flex:12"><i style="width:${track.s3.toFixed(1)}%"></i></div>
            </div>
            <div class="q-track-labels">
              <span style="flex:6">${L('头矿 6 小时', 'First 6H')}</span>
              <span style="flex:18">${L('锁仓 18 小时', 'Lock 18H')}</span>
              <span style="flex:12">${L('冲价 12 小时', 'Push 12H')}</span>
            </div>
          ` : ''}
          ${heroCtaHtml}
        </section>

        ${isChargePriority ? raceCardHtml : ''}
        ${myPosHtml && !isChargePriority ? myPosHtml : ''}

        <a class="q-steps3" href="#/rules">
          <span class="q-st ${stepClass('lock')}">${qIcon('lock', 17)}${L('锁仓 24 小时', '24H Lock')}<small>${L('头矿止损 5%', 'First 6H 5%')}</small></span>
          <span class="q-arrow">${qIcon('chevR', 15)}</span>
          <span class="q-st ${stepClass('push')}">${qIcon('chart', 17)}${L('冲价 12 小时', '12H Push')}<small>${L('8 / 12 达标', '8 / 12 Met')}</small></span>
          <span class="q-arrow">${qIcon('chevR', 15)}</span>
          <span class="q-st ${stepClass('win')}">${qIcon('trophy', 17)}${L('达标分奖', 'Split Pool')}<small>${L('单人封顶 5×', '5× Cap')}</small></span>
        </a>

        ${warmupCardHtml}
        ${!isChargePriority ? poolCardHtml : ''}
        ${!isChargePriority ? raceCardHtml : poolCardHtml}
        ${myPosHtml && isChargePriority ? myPosHtml : ''}

        ${historyHtml}
      </div>
    `;

    if (pendingScrollSelector) {
      root.querySelector(pendingScrollSelector)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
    const retryBtn = root.querySelector('#q-stage-retry');
    if (retryBtn) retryBtn.onclick = () => window.dispatchEvent(new Event('a9:force-sync'));

    const pickSlot = (idx, selector) => {
      local.selectedFlagIdx = local.selectedFlagIdx === idx ? null : idx;
      paint();
      root.querySelector(`[${selector}="${idx}"]`)?.focus?.({ preventScroll: true });
    };
    root.querySelectorAll('[data-q-flag-idx]').forEach((btn) => {
      btn.onclick = () => pickSlot(Number(btn.dataset.qFlagIdx), 'data-q-flag-idx');
    });
    const racePlot = root.querySelector('#q-race-plot');
    if (racePlot) racePlot.onclick = (event) => {
      const marker = event.target.closest?.('[data-race-point]');
      if (marker) pickSlot(Number(marker.dataset.racePoint), 'data-race-point');
    };

    const connBtn = root.querySelector('#q-stage-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderStageView(root, navigate, _param, query));

    const stakeBtn = root.querySelector('#q-open-stake');
    if (stakeBtn) stakeBtn.onclick = () => openStakePreviewSheet(ui);

    const exitBtn = root.querySelector('#q-open-early-exit');
    if (exitBtn && myTicket) exitBtn.onclick = () => openEarlyExitSheet(myTicket);

    const wuBtn = root.querySelector('#q-wu-action');
    if (wuBtn) {
      wuBtn.onclick = async () => {
        if (local.warmupBusy) return;
        local.warmupBusy = true;
        paint();
        try {
          const uid = getEffectiveUserId(u);
          if (local.warmup?.isReserved) {
            await cancelWarmup({ roundId: local.warmup.roundId, walletAddress: u.address, userId: uid });
            store.update((s) => { s.user.warmupRegistered = false; });
            showToast(L('已取消本轮预约', 'Warm-up reservation cancelled'));
          } else {
            await registerWarmup({ roundId: local.warmup?.roundId, walletAddress: u.address, userId: uid, referrerId: store.state.referral.referrerId });
            store.update((s) => { s.user.warmupRegistered = true; });
            showToast(L('预约成功！开轮后将推送提醒', 'Reserved! You will be notified at launch'));
          }
          local.warmup = await fetchWarmupCurrent(local.warmup?.roundId || null);
        } catch (e) {
          showToast(e?.message || L('预约操作失败，请重试', 'Warm-up action failed'), 'error');
        } finally {
          local.warmupBusy = false;
          paint();
        }
      };
    }

    const togglePrediction = root.querySelector('#q-toggle-prediction');
    if (togglePrediction) togglePrediction.onclick = () => {
      expandedPredictionKey = predictionExpanded ? null : predictionKey;
      paint();
      root.querySelector('#q-toggle-prediction')?.focus();
    };
    root.querySelectorAll('[data-q-pred]').forEach((btn) => {
      btn.onclick = async () => {
        const current = store.state.round;
        const now = serverNowMs();
        if (local.predBusy || curBet || !roundId || Number(current.currentRound) !== roundId ||
            deriveRoundUiState({ detail: current, serverNowMs: now }).stage !== 'stake' || !(now < toMs(current.stakeCloseAt))) {
          paint();
          return;
        }
        const side = btn.dataset.qPred;
        const uid = getEffectiveUserId(u);
        if (!uid) {
          showToast(L('请在 Telegram 小程序内打开后参与预言', 'Open inside Telegram Mini App to predict'), 'amber');
          return;
        }
        local.predBusy = true;
        paint();
        try {
          const result = await submitPredictionBet({
            roundId,
            userId: uid,
            side,
            referrerId: store.state.referral.referrerId,
          });
          A9Haptic.success();
          local.predUser = { ...local.predUser, currentBet: result?.bet || { side } };
          showToast(L('预测已提交', 'Prediction submitted'));
          await loadAuxData();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('提交预言失败', 'Prediction failed'), 'error');
        } finally {
          local.predBusy = false;
          paint();
        }
      };
    });


  };

  const loadAuxData = async () => {
    const reqAuxSeq = ++auxSeq;
    const r = store.state.round;
    const u = store.state.user;
    const reqWallet = u.connected ? u.address : null;
    const reqRound = r.currentRound;
    const uid = getEffectiveUserId(u);
    const ui = deriveRoundUiState({ detail: r, user: u, serverNowMs: serverNowMs() });
    const needWarmup = ui.stage === 'warmup' || query?.stage === 'warmup';

    const tasks = [
      (isLive && reqWallet) ? fetchUserPortfolio(reqWallet) : Promise.resolve(null),
      needWarmup ? fetchWarmupCurrent(null) : Promise.resolve(null),
      reqRound ? fetchPredictionRound(reqRound, ui.stage) : Promise.resolve(null),
      (reqRound && uid) ? fetchPredictionUser(uid, reqRound) : Promise.resolve(null),
    ];
    const [pfRes, wuRes, prRes, puRes] = await Promise.allSettled(tasks);
    const curWallet = store.state.user.connected ? store.state.user.address : null;
    if (seq !== stageViewSeq || reqAuxSeq !== auxSeq || !root.isConnected) return;
    if (isLive && reqWallet !== curWallet) return;
    if (reqRound !== store.state.round.currentRound) return;

    if (pfRes.status === 'fulfilled' && pfRes.value) local.portfolio = pfRes.value;
    if (needWarmup) {
      if (wuRes.status === 'fulfilled') {
        local.warmup = wuRes.value;
        local.warmupError = null;
      } else {
        local.warmupError = wuRes.reason?.message || L('预热数据暂不可用', 'Warm-up data unavailable');
      }
    }
    local.predRound = prRes.status === 'fulfilled' ? prRes.value : null;
    if (puRes.status === 'fulfilled' && puRes.value) local.predUser = puRes.value;
    paint();
  };

  paint();
  void loadAuxData();
}
