/**
 * Tab 1 · 冲关（#/round）— A9 Quest 视图层
 *
 * 完备覆盖 round-state.js 全部 9 种规范阶段（warmup / stake / sealed / charge / settling / passed / failed / aborted / unknown），
 * 严守 serverNowMs() 驱动、倒计时 <= 0 不显 00:00:00、stage !== 'passed' 严禁提前显示「已通关」、
 * 缺值 null 严禁经 Number(null) 伪造为 0、Live 模式零假销毁统计。
 */

import { loadDemoModule } from '../demo-loader.js';
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
  estimateRewardA9,
  fetchUserPortfolio,
  stakeTicketAmount,
  fetchWarmupCurrent,
  registerWarmup,
  cancelWarmup,
  fetchPredictionRound,
  fetchPredictionUser,
  submitPredictionBet,
  activatePredictionReward,
  getEffectiveUserId,
} from '../data.js';
import {
  qIcon,
  finiteOrNull,
  fmtExactA9,
  fmtIntOrDash,
  fmtUsdOrDash,
  fmtStageCountdown,
  openQuestSheet,
} from './quest-ui.js';

let stageViewSeq = 0;

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

function buildMiniPriceChartSvg(r) {
  const W = 340;
  const H = 112;
  const px = 6;
  const py = 14;
  const target = finiteOrNull(r.targetPrice);
  const live = finiteOrNull(r.livePrice);
  const base = finiteOrNull(r.twap24h);
  const candles = Array.isArray(r.candles) ? r.candles : [];
  const points = [];
  candles.forEach((c, idx) => {
    const p = finiteOrNull(c?.p);
    if (p !== null && p > 0) points.push({ xIdx: idx, p, confirmed: c.status === 'closed', bull: c.bull });
  });
  if (points.length === 0 && live !== null && live > 0) {
    points.push({ xIdx: 0, p: live, confirmed: false, bull: target !== null ? live >= target : null });
  }
  if (points.length === 0 && target === null) {
    return `<div class="q-small q-muted" style="padding:18px 0;text-align:center;">${L('等待服务端同步价格曲线…', 'Awaiting server price feed…')}</div>`;
  }
  const vals = points.map((pt) => pt.p);
  if (target !== null) vals.push(target);
  if (base !== null) vals.push(base);
  const lo = Math.min(...vals) * 0.96;
  const hi = Math.max(...vals) * 1.04;
  const span = Math.max(1e-9, hi - lo);
  const xAt = (idx) => px + (idx / 11) * (W - 2 * px);
  const yAt = (val) => H - py - ((val - lo) / span) * (H - 2 * py);

  const lineD = points.length >= 2
    ? points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${xAt(pt.xIdx).toFixed(1)} ${yAt(pt.p).toFixed(1)}`).join(' ')
    : '';
  const dots = points.map((pt) => {
    const fill = pt.bull === true ? 'var(--q-green)' : pt.bull === false ? 'var(--q-red)' : 'var(--q-blue)';
    return `<circle cx="${xAt(pt.xIdx).toFixed(1)}" cy="${yAt(pt.p).toFixed(1)}" r="3.5" fill="${fill}" stroke="var(--q-surface)" stroke-width="1.5"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${L('12H 冲价参考曲线', '12H price push chart')}">
    ${base !== null ? `<line class="q-ch-base" x1="${px}" x2="${W - px}" y1="${yAt(base).toFixed(1)}" y2="${yAt(base).toFixed(1)}"/>` : ''}
    ${target !== null ? `<line class="q-ch-target" x1="${px}" x2="${W - px}" y1="${yAt(target).toFixed(1)}" y2="${yAt(target).toFixed(1)}"/>` : ''}
    ${lineD ? `<path class="q-ch-line" d="${lineD}"/>` : ''}
    ${dots}
    ${target !== null ? `<text class="q-ch-lbl red" x="${W - px - 2}" y="${Math.max(12, yAt(target) - 4).toFixed(1)}" text-anchor="end">${L('目标', 'Target')} ${fmtUsdOrDash(target, 4)}</text>` : ''}
    ${base !== null ? `<text class="q-ch-lbl" x="${W - px - 2}" y="${Math.min(H - 2, yAt(base) + 12).toFixed(1)}" text-anchor="end">${L('均价', 'TWAP')} ${fmtUsdOrDash(base, 4)}</text>` : ''}
  </svg>`;
}

/** 派生 12 面旗底部状态条文案（硬规则：stage !== 'passed' 时严禁出现「已通关」）。 */
export function buildChargeFlagStatusText(uiStage, r) {
  const minQ = finiteOrNull(r.minQualifiedCandles) ?? PROTOCOL_SPECS.passRequired;
  const q = finiteOrNull(r.qualifiedCandles);
  const candles = Array.isArray(r.candles) ? r.candles : [];
  const failed = candles.filter((c) => c.status === 'closed' && c.bull === false).length;
  const maxMiss = PROTOCOL_SPECS.passTotal - minQ;

  if (uiStage === 'warmup' || uiStage === 'stake' || uiStage === 'sealed') {
    return {
      tone: '',
      text: L(
        `封盘后进入 12H 冲价：12 个 1H 时段满足任意 ${minQ} 段即可分奖`,
        `After lock closes, 12H push begins: any ${minQ} of 12 hourly slots meeting target qualifies`
      ),
    };
  }
  if (uiStage === 'passed') {
    return {
      tone: 'win',
      text: L(`最终 ${q ?? '—'} / 12 · 链上已结算通关`, `Final ${q ?? '—'} / 12 · Settled on-chain as Passed`),
    };
  }
  if (uiStage === 'failed') {
    return {
      tone: 'lose',
      text: L(`最终 ${q ?? '—'} / 12 · 未达标，已按止损退本`, `Final ${q ?? '—'} / 12 · Target missed, auto stop-loss active`),
    };
  }
  if (uiStage === 'aborted') {
    return {
      tone: '',
      text: L('本轮已异常中止，可在金库 100% 无损退回本金', 'Round aborted; claim 100% principal refund in Vault'),
    };
  }
  if (uiStage === 'settling') {
    return {
      tone: '',
      text: L('12H 冲价已结束 · 等待链上 SettleRound 结算确认', '12H push ended · awaiting on-chain SettleRound confirmation'),
    };
  }
  if (uiStage === 'charge') {
    if (String(r.rawState || '').toUpperCase() === 'ORACLE_PAUSED') {
      return {
        tone: '',
        text: L('价格判定暂时挂起 · 等待预言机恢复采样', 'Price check temporarily paused · awaiting oracle resume'),
      };
    }
    if (q !== null && q >= minQ) {
      return {
        tone: 'win',
        text: L('已达 8/12 门槛 · 等待链上结算', 'Reached 8/12 threshold · awaiting on-chain settlement'),
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
        text: L(`已达标 ${q}/${minQ} 段 · 还需 ${need} 段，还可容错 ${remainMiss} 段`, `${q}/${minQ} slots met · need ${need} more (${remainMiss} misses allowed)`),
      };
    }
  }
  return {
    tone: '',
    text: L('等待服务端同步时段判定进度…', 'Syncing hourly slot verification…'),
  };
}

/** 渲染 Tab 1 · 冲关主视图 */
export function renderStageView(root, navigate, _param = null, query = {}) {
  const seq = ++stageViewSeq;
  const isLive = !config.isDemo;

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
  };

  const getCurrentRoundTicket = () => {
    const r = store.state.round;
    const rid = finiteOrNull(r.currentRound);
    if (!isLive) {
      const certs = Array.isArray(store.state.certificates) ? store.state.certificates : [];
      const active = certs.filter(c => finiteOrNull(c.round) === rid && c.status === 'observation');
      const hit = active[0];
      const amount = active.reduce((sum, c) => sum + c.stakeTon, 0);
      if (!hit) return null;
      return {
        ticketAddress: hit.id || `demo-ticket-r${rid}`,
        roundId: rid,
        amountRaw: String(Math.round(amount * 1e9)),
        earlyAmountRaw: String(Math.round(amount * 1e9)),
        lateAmountRaw: '0',
        canEarlyExit: true,
        exited: false,
      };
    }
    const tickets = Array.isArray(local.portfolio?.tickets) ? local.portfolio.tickets : [];
    return tickets.find((t) => finiteOrNull(t.roundId) === rid && !t.exited) || null;
  };

  const openStakePreviewSheet = (ui) => {
    const r = store.state.round;
    const u = store.state.user;
    if (!u.connected) {
      tonConnect.openConnectModal(() => renderStageView(root, navigate, _param, query));
      return;
    }
    const inFirst6h = Boolean(ui.inFirst6h);
    const stopLossPct = inFirst6h ? PROTOCOL_SPECS.failEarlyStopLossPct : PROTOCOL_SPECS.failLateStopLossPct;
    const refundPct = 100 - stopLossPct;
    const availA9 = isLive
      ? rawToA9(local.portfolio?.a9BalanceRaw)
      : finiteOrNull(u.a9Available);
    const defaultVal = availA9 !== null && availA9 >= PROTOCOL_SPECS.minStakeA9
      ? Math.min(10000, Math.floor(availA9))
      : PROTOCOL_SPECS.minStakeA9;

    const buildPreviewHtml = (amt) => {
      const est = estimateRewardA9(amt, r);
      const estNum = finiteOrNull(est);
      const winText = estNum !== null ? `+${fmtIntOrDash(estNum)} A9` : '—';
      const immText = estNum !== null ? fmtIntOrDash(estNum * (PROTOCOL_SPECS.immediateUnlockPct / 100)) : '—';
      const linText = estNum !== null ? fmtIntOrDash(estNum * (1 - PROTOCOL_SPECS.immediateUnlockPct / 100)) : '—';
      const refundAmt = amt > 0 ? Math.floor(amt * (refundPct / 100)) : 0;
      const lossAmt = amt > 0 ? Math.ceil(amt * (stopLossPct / 100)) : 0;
      return {
        winText,
        winSub: L(
          `本金 ${fmtIntOrDash(amt)} 全退 · 20% 秒提 ${immText} · 80%（${linText}）14 天逐秒解锁`,
          `100% principal (${fmtIntOrDash(amt)}) + 20% instant (${immText}) + 80% (${linText}) over 14D`
        ),
        loseText: L(`退 ${fmtIntOrDash(refundAmt)} A9`, `Refund ${fmtIntOrDash(refundAmt)} A9`),
        loseSub: L(`仅止损 ${fmtIntOrDash(lossAmt)} A9（${stopLossPct}%）销毁`, `${stopLossPct}% stop-loss (${fmtIntOrDash(lossAmt)} A9 burned)`),
      };
    };

    const initPrev = buildPreviewHtml(defaultVal);
    const canFunds = store.fundsEnabled;

    openQuestSheet(
      L(`锁仓参赛 · 第 ${r.currentRound ?? '—'} 关`, `Lock A9 · Stage ${r.currentRound ?? '—'}`),
      `
        <div class="q-notice ${inFirst6h ? 'red' : 'gray'}" style="margin-bottom:12px;">
          ${qIcon('clock', 16)}
          <span>${inFirst6h
            ? L(`头矿 6H 窗口：未达标仅 ${stopLossPct}% 止损，窗口结束后变为 10%`, `First 6H window: ${stopLossPct}% stop-loss if missed (10% after window)`)
            : L('24H 普通锁仓期：未达标 10% 自动止损，封盘后禁进禁出', '24H standard lock: 10% auto stop-loss if missed; sealed during 12H push')}</span>
        </div>

        <div class="q-amt-box">
          <input id="q-stake-input" inputmode="numeric" autocomplete="off" value="${defaultVal}" aria-label="${L('锁仓数量 A9', 'Lock amount A9')}" />
          <span>A9</span>
        </div>

        <div class="q-row q-between q-small q-muted" style="margin:6px 2px 4px;">
          <span>${L('可用余额', 'Available')}: <b class="q-num" style="color:var(--q-ink);">${fmtExactA9(availA9)}</b></span>
          <span id="q-stake-err" style="color:var(--q-red-ink);font-weight:700;"></span>
        </div>

        <div class="q-qchips">
          ${[100, 1000, 10000, 50000].map((v) => `<button type="button" data-q-chip="${v}">${formatNum(v, 0)}</button>`).join('')}
          ${availA9 !== null && availA9 >= PROTOCOL_SPECS.minStakeA9 ? `<button type="button" data-q-chip="${Math.floor(availA9)}">${L('全部', 'Max')}</button>` : ''}
        </div>

        <div class="q-ocs" style="margin-top:10px;">
          <div class="q-oc q-oc-win">
            <small>${qIcon('trophy', 14)} ${L('若达标（≥ 8/12）', 'If Passed (≥ 8/12)')}</small>
            <b id="q-oc-win-val">${escapeHtml(initPrev.winText)}</b>
            <span id="q-oc-win-sub">${escapeHtml(initPrev.winSub)}</span>
          </div>
          <div class="q-oc q-oc-lose">
            <small>${qIcon('shield', 14)} ${L('若未达标', 'If Missed')}</small>
            <b id="q-oc-lose-val">${escapeHtml(initPrev.loseText)}</b>
            <span id="q-oc-lose-sub">${escapeHtml(initPrev.loseSub)}</span>
          </div>
        </div>

        <div style="margin-top:10px;">
          <div class="q-kv"><span>${L('最低锁仓门槛', 'Min Lock')}</span><b>${formatNum(PROTOCOL_SPECS.minStakeA9, 0)} A9</b></div>
          <div class="q-kv"><span>${L('封盘前提前解押', 'Early Exit (24H)')}</span><b>${L('退 85% / 销毁 15%', '85% refund / 15% burn')}</b></div>
          <div class="q-kv"><span>${L('预附网络 Gas', 'Attached Gas')}</span><b>${PROTOCOL_SPECS.stakeGasGram.toFixed(2)} GRAM</b></div>
        </div>
        ${!canFunds ? `<div class="q-notice yellow" style="margin-top:10px;">${qIcon('info', 16)}<span>${escapeHtml(LIVE_READONLY_REASON)}</span></div>` : ''}
      `,
      {
        badgeHtml: `<span class="q-chip ${inFirst6h ? 'q-chip-red' : ''}">${inFirst6h ? L('头矿 5% 止损', 'First 6H · 5%') : L('普通 10% 止损', 'Standard · 10%')}</span>`,
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

    const parseAmt = () => {
      const raw = String(inp?.value || '').trim();
      return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 0;
    };

    const syncPreview = () => {
      const amt = parseAmt();
      const prev = buildPreviewHtml(amt);
      if (winValEl) winValEl.textContent = prev.winText;
      if (winSubEl) winSubEl.textContent = prev.winSub;
      if (loseValEl) loseValEl.textContent = prev.loseText;
      if (loseSubEl) loseSubEl.textContent = prev.loseSub;
      let errMsg = '';
      if (amt > 0 && amt < PROTOCOL_SPECS.minStakeA9) {
        errMsg = L(`最低锁仓 ${PROTOCOL_SPECS.minStakeA9} A9`, `Minimum ${PROTOCOL_SPECS.minStakeA9} A9`);
      } else if (availA9 !== null && amt > availA9) {
        errMsg = L('A9 可用余额不足', 'Insufficient A9 balance');
      }
      if (errEl) errEl.textContent = errMsg;
      if (submitBtn) {
        submitBtn.disabled = !canFunds || amt < PROTOCOL_SPECS.minStakeA9 || (availA9 !== null && amt > availA9) || pendingTxManager.isLocked('stake');
      }
    };

    if (inp) inp.oninput = syncPreview;
    document.querySelectorAll('[data-q-chip]').forEach((btn) => {
      btn.onclick = () => {
        if (inp) inp.value = btn.dataset.qChip;
        syncPreview();
      };
    });
    syncPreview();

    if (submitBtn) {
      submitBtn.onclick = async () => {
        const amt = parseAmt();
        if (amt < PROTOCOL_SPECS.minStakeA9) return;
        const roundController = r.protocolConfig?.contracts?.roundController || '';
        const wallet = u.address;
        const roundId = r.currentRound;
        const range = { fromRound: roundId, toRound: roundId };
        let baseline = null;
        let userJettonWallet = '';
        if (isLive) {
          submitBtn.disabled = true;
          try {
            const portfolio = await fetchUserPortfolio(wallet, range);
            baseline = stakeTicketAmount(portfolio, roundId);
            userJettonWallet = portfolio?.jettonWallet || '';
            if (baseline === null || !userJettonWallet) throw new Error(L('票据或钱包信息待同步，请重试', 'Ticket or wallet unavailable. Please retry.'));
          } catch (error) {
            showToast(error.message, 'error');
            syncPreview();
            return;
          }
        }
        const accepted = await tonConnect.confirmBeforeSign({
          title: L(`确认锁仓第 ${r.currentRound ?? '—'} 关`, `Confirm Stage ${r.currentRound ?? '—'} Lock`),
          contractLabel: 'RoundController',
          targetAddress: roundController || (isLive ? '' : 'EQD_DEMO_ROUND_CONTROLLER'),
          principalText: `${formatNum(amt, 0)} A9`,
          gasText: `${PROTOCOL_SPECS.stakeGasGram.toFixed(2)} GRAM`,
          totalText: `${formatNum(amt, 0)} A9 + ${PROTOCOL_SPECS.stakeGasGram.toFixed(2)} GRAM`,
          note: L(
            `当前为${inFirst6h ? '头矿 6H（未达标 5% 止损）' : '普通时段（未达标 10% 止损）'}；24H 锁仓期内可提前解押（退 85%）。`,
            `${inFirst6h ? 'First 6H (5% stop-loss if missed)' : 'Standard (10% stop-loss if missed)'}; 85% early exit available during 24H lock.`
          ),
          insufficientReason: !store.fundsEnabled
            ? LIVE_READONLY_REASON
            : (isLive && (!roundController || !userJettonWallet)
              ? L('缺少 A9 JettonWallet 或 RoundController 合约地址，请刷新持仓后重试', 'Missing JettonWallet or RoundController address; refresh and retry')
              : ''),
        });
        if (!accepted) { syncPreview(); return; }

        if (!isLive) {
          const cert = store.stakeTon(amt);
          if (cert) {
            A9Haptic.success();
            A9Audio.confirm();
            showToast(L(`[演示模式] 已锁仓 ${formatNum(amt, 0)} A9`, `[Demo] Locked ${formatNum(amt, 0)} A9`));
            paint();
          }
          return;
        }

        try {
          const amountA9Raw = (BigInt(amt) * 1_000_000_000n).toString();
          if (wallet !== store.state.user.address || roundId !== store.state.round.currentRound) {
            throw new Error(L('钱包或轮次已切换，请重新确认', 'Wallet or round changed. Please confirm again.'));
          }
          const current = store.state.round;
          const currentPhase = deriveRoundUiState({ detail: current, serverNowMs: serverNowMs() });
          if (!current.stakingEnabled || current.stale || current.detailStale || current.detailLoading ||
              currentPhase.stage !== 'stake' || currentPhase.inFirst6h !== inFirst6h || pendingTxManager.isLocked()) {
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
            title: `第 ${r.currentRound ?? '—'} 关锁仓`,
            titleEn: `Stage ${r.currentRound ?? '—'} Lock`,
            amountText: `${formatNum(amt, 0)} A9`,
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

  const openEarlyExitSheet = (ticket) => {
    if (!ticket?.ticketAddress) return;
    const principalA9 = rawToA9(ticket.amountRaw);
    const refundA9 = rawToA9(ticket.earlyExitRefundRaw) ?? (principalA9 !== null ? principalA9 * 0.85 : null);
    const burnA9 = rawToA9(ticket.earlyExitBurnRaw) ?? (principalA9 !== null ? principalA9 * 0.15 : null);
    const canFunds = store.fundsEnabled;

    openQuestSheet(
      L('提前解押（仅限 24H 锁仓期）', 'Early Exit (24H Lock Window Only)'),
      `
        <div class="q-notice yellow" style="margin-bottom:12px;">
          ${qIcon('info', 16)}
          <span>${L('封盘进入 12H 冲价后合约自动禁止提前解押；提前解押扣除 15% 永久销毁且不可撤销。', 'Contract blocks early exit once 12H push begins; 15% burn is permanent.')}</span>
        </div>
        <div class="q-kv"><span>${L('当前锁仓本金', 'Locked Principal')}</span><b>${escapeHtml(fmtExactA9(principalA9))}</b></div>
        <div class="q-kv"><span>${L('退回 85% 本金', '85% Refund')}</span><b class="green">${escapeHtml(fmtExactA9(refundA9))}</b></div>
        <div class="q-kv"><span>${L('扣除 15% 销毁', '15% Burned')}</span><b class="red">${escapeHtml(fmtExactA9(burnA9))}</b></div>
        <div class="q-kv"><span>${L('预附网络 Gas', 'Attached Gas')}</span><b>${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)} GRAM</b></div>
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
    const confirmBtn = document.getElementById('q-exit-confirm');
    if (confirmBtn) {
      confirmBtn.onclick = async () => {
        if (pendingTxManager.isLocked()) return;
        const wallet = store.state.user.address;
        const ok = await tonConnect.confirmBeforeSign({
          title: L('确认提前解押', 'Confirm Early Exit'),
          contractLabel: 'Round Ticket',
          targetAddress: ticket.ticketAddress,
          principalText: `${fmtExactA9(refundA9)}（${L('销毁', 'Burn')} ${fmtExactA9(burnA9)}）`,
          gasText: `${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)} GRAM`,
          totalText: `${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)} GRAM Gas`,
          insufficientReason: !store.fundsEnabled ? LIVE_READONLY_REASON : '',
        });
        if (!ok || wallet !== store.state.user.address || pendingTxManager.isLocked() ||
            deriveRoundUiState({ detail: store.state.round, serverNowMs: serverNowMs() }).stage !== 'stake') return;
        if (!isLive) {
          const refund = (await loadDemoModule()).demoEarlyExit(store.state, ticket.roundId);
          if (refund === null) return;
          store.notify();
          showToast(L('[演示模式] 已模拟完成提前解押', '[Demo] Simulated Early Exit completed'));
          paint();
          return;
        }
        try {
          await tonConnect.sendV17TicketEarlyExit(ticket.ticketAddress);
          A9Haptic.success();
          const tx = pendingTxManager.start({
            kind: 'early_exit',
            title: `第 ${ticket.roundId ?? '—'} 关提前解押`,
            titleEn: `Stage ${ticket.roundId ?? '—'} Early Exit`,
            amountText: fmtExactA9(refundA9),
            explorerAddress: ticket.ticketAddress,
            targetRoute: '/round',
          });
          void pendingTxManager.pollUntilConfirmed({
            txId: tx.id,
            checkFn: async () => {
              const pf = await fetchUserPortfolio(wallet, { fromRound: ticket.roundId, toRound: ticket.roundId });
              if (pf?.ticketsAvailable !== true || !Array.isArray(pf.tickets)) return false;
              const after = pf.tickets.find(t => t.ticketAddress === ticket.ticketAddress);
              // The portfolio reader omits deployed tickets once their amount is zero.
              return after ? after.exited === true && !after.pending : BigInt(ticket.amountRaw) > 0n;
            },
            onConfirmed: () => { if (root.isConnected) void loadAuxData(); },
          });
          showToast(L('提前解押交易已提交，正在核验链上确认…', 'Early Exit sent, awaiting finality…'));
          void loadAuxData();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起提前解押失败', 'Early Exit failed'), 'error');
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
      (myTicket.canEarlyExit === true || (stakeCloseMs !== null && nowMs < stakeCloseMs))
    );

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
      heroCtaHtml = `<div class="q-hero-note">${qIcon('lock', 17)}<span>${L('已封盘禁进禁出 · 即将进入 12H 价格判定', 'Sealed · entering 12H price push shortly')}</span></div>`;
    } else if (ui.stage === 'charge') {
      heroCtaHtml = `<div class="q-hero-note">${qIcon('chart', 17)}<span>${myStakeA9 !== null && myStakeA9 > 0
        ? L(`我的本轮锁仓 ${fmtExactA9(myStakeA9)} 正在冲价中`, `My locked ${fmtExactA9(myStakeA9)} is in 12H push`)
        : L('本轮已封盘冲价中，可在下方参与 12H 预言擂台', '12H push live; join the Prediction Arena below')}</span></div>`;
    } else if (ui.stage === 'settling') {
      heroCtaHtml = `<div class="q-hero-note">${qIcon('clock', 17)}<span>${L('12H 冲价结束 · 等待链上 SettleRound 确认最终结果', '12H push ended · awaiting on-chain SettleRound finality')}</span></div>`;
    } else if (ui.stage === 'passed') {
      heroCtaHtml = `<div class="q-hero-ctas"><a class="q-btn q-btn-white is-green q-btn-block" href="#/rewards">${qIcon('vault', 18)} ${L('前往金库领取奖励', 'Claim in Vault')}</a></div>`;
    } else if (ui.stage === 'failed') {
      heroCtaHtml = `<div class="q-hero-ctas"><a class="q-btn q-btn-white q-btn-block" href="#/rewards">${qIcon('shield', 18)} ${L('前往金库领回止损退本', 'Claim Stop-Loss Refund')}</a></div>`;
    } else if (ui.stage === 'aborted') {
      heroCtaHtml = `<div class="q-hero-ctas"><a class="q-btn q-btn-white q-btn-block" href="#/rewards">${qIcon('shield', 18)} ${L('异常中止 · 100% 无损退本', 'Aborted · Claim 100% Principal')}</a></div>`;
    }

    // 12 面旗
    const candles = Array.isArray(r.candles) && r.candles.length === 12
      ? r.candles
      : Array.from({ length: 12 }, (_, idx) => ({ index: idx + 1, status: 'pending', bull: null }));
    const flagsHtml = candles.map((c) => {
      if (c.status === 'closed' && c.bull === true) return `<div class="q-flag pass">${qIcon('check', 13, 3)}</div>`;
      if (c.status === 'closed' && c.bull === false) return `<div class="q-flag fail">${qIcon('x', 11, 3)}</div>`;
      if (c.status === 'active') {
        const dirCls = c.bull === true ? 'above' : c.bull === false ? 'below' : '';
        return `<div class="q-flag now ${dirCls}">${c.index}</div>`;
      }
      return `<div class="q-flag idle">${c.index}</div>`;
    }).join('');
    const flagStatus = buildChargeFlagStatusText(ui.stage, r);

    // 奖池与倍率（严格 null 防护 + P2 诚实策略：Live 不伪造全网累计销毁）
    const totalStakedA9 = rawToA9(r.totalStakedRaw);
    const budgetA9 = finiteOrNull(r.rewardBudgetA9);
    const poolRemA9 = r.poolState?.dataAvailable === true ? rawToA9(r.poolState?.poolRemainingRaw) : null;
    const carryA9 = rawToA9(r.nextRoundCarryRaw);
    const estPer1A9 = (budgetA9 !== null && totalStakedA9 !== null && totalStakedA9 > 0)
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
              <span>${wu?.myWarmupChest?.totalA9Raw ? fmtExactA9(rawToA9(wu.myWarmupChest.totalA9Raw)) : L('预约后领预热箱', 'Reserve for chest')}</span>
            </div>
          </div>
        `}
      </section>
    ` : '';

    // 12H 预言擂台
    const predRound = local.predRound;
    const predUser = local.predUser;
    const curBet = predUser?.currentBet || null;
    const pendingActA9 = rawToA9(predUser?.pendingActivationRaw);
    const passPct = finiteOrNull(predRound?.passPct) ?? 50;
    const burnPct = finiteOrNull(predRound?.burnPct) ?? 50;
    const canBetNow = (ui.stage === 'stake' || ui.stage === 'charge') && !curBet && !local.predBusy;

    const predictionHtml = `
      <section class="q-card" id="q-prediction-card">
        <div class="q-card-h">
          <h3>${qIcon('eye', 18)} ${L('观众席 · 12H 预言擂台', 'Arena · 12H Prediction')}</h3>
          <span class="q-chip q-chip-blue">${curBet ? L('已提交预言', 'Predicted') : L('0 GRAM 参战', '0 GRAM Entry')}</span>
        </div>
        <div class="q-pred">
          <button type="button" class="yes ${curBet?.side === 'PASS' ? 'picked' : ''}" data-q-pred="PASS" ${canBetNow ? '' : 'disabled'}>
            <b>${L('能达标分奖', 'Will Pass')}</b>
            <span>${passPct}% ${L('看多', 'Pass')}</span>
          </button>
          <button type="button" class="no ${curBet?.side === 'BURN' ? 'picked' : ''}" data-q-pred="BURN" ${canBetNow ? '' : 'disabled'}>
            <b>${L('未达标止损', 'Will Miss')}</b>
            <span>${burnPct}% ${L('看空', 'Miss')}</span>
          </button>
        </div>
        ${pendingActA9 !== null && pendingActA9 > 0 ? `
          <div class="q-row q-between" style="margin-top:10px;padding:10px 12px;border-radius:12px;background:var(--q-blue-soft);">
            <span class="q-small" style="color:var(--q-blue-ink);font-weight:700;">${L('待激活预言奖励', 'Pending Prediction Reward')}: ${escapeHtml(fmtExactA9(pendingActA9))}</span>
            <button type="button" class="q-btn q-btn-blue q-btn-sm" id="q-pred-activate" ${!store.fundsEnabled || local.predBusy ? 'disabled' : ''}>${L('激活', 'Activate')}</button>
          </div>
        ` : ''}
        <div class="q-foot-note">
          ${curBet
            ? L(`你已选择「${curBet.side === 'PASS' ? '能达标分奖' : '未达标止损'}」，结算后按同侧份额结算奖励。`, `You picked "${curBet.side === 'PASS' ? 'Pass' : 'Miss'}". Settled after round close.`)
            : L('免锁仓也可参与预测本轮结果；猜中奖励进入待激活余额，激活后统一在金库领取。', 'Predict free with 0 GRAM; winnings enter Pending Activation and claim in Vault.')}
        </div>
      </section>
    `;

    // 历史轮次
    const roundsList = Array.isArray(r.rounds) ? r.rounds : [];
    const historyHtml = roundsList.length > 0 ? `
      <section class="q-card">
        <div class="q-card-h">
          <h3>${qIcon('clock', 18)} ${L('关卡记录', 'Stage History')}</h3>
          <span class="q-chip q-chip-green">${r.successCount !== null ? L(`通关 ${r.successCount} 次`, `${r.successCount} Passed`) : `${roundsList.length} ${L('关', 'Stages')}`}</span>
        </div>
        <div class="q-hist">
          ${roundsList.slice(-8).reverse().map((item) => {
            const st = String(item.state || '').toUpperCase();
            const cls = st === 'SUCCEEDED' ? 'success' : (item.roundId === roundId ? 'live' : '');
            const lbl = st === 'SUCCEEDED'
              ? L(`通关 ${item.qualifiedCandles ?? '—'}/12`, `Passed ${item.qualifiedCandles ?? '—'}/12`)
              : st === 'FAILED_PERMANENT'
                ? L(`未达标 ${item.qualifiedCandles ?? '—'}/12`, `Missed ${item.qualifiedCandles ?? '—'}/12`)
                : st === 'TECHNICAL_ABORTED'
                  ? L('已中止', 'Aborted')
                  : L('进行中', 'Live');
            return `<div class="q-hist-i ${cls}"><small>${L(`第 ${item.roundId} 关`, `Stage ${item.roundId}`)}</small><b>${lbl}</b></div>`;
          }).join('')}
        </div>
      </section>
    ` : '';

    const stepClass = (key) => {
      if (key === 'lock' && (ui.stage === 'stake' || ui.stage === 'warmup')) return 'on';
      if (key === 'push' && (ui.stage === 'sealed' || ui.stage === 'charge' || ui.stage === 'settling')) return 'on ink';
      if (key === 'win' && ui.stage === 'passed') return 'on green';
      if (key === 'win' && (ui.stage === 'failed' || ui.stage === 'aborted')) return 'on ink';
      return '';
    };

    root.innerHTML = `
      <div class="q-view" id="quest-stage-view" data-stage="${escapeHtml(ui.stage)}">
        <section class="q-hero ${heroCls}" data-lock-phase="${ui.stage === 'stake' ? (ui.inFirst6h ? 'first6h' : 'standard') : ''}">
          <span class="q-wm">${pad2(roundId)}</span>
          <div class="q-hero-top">
            <span class="q-cart-tag">STAGE ${pad2(roundId)}</span>
            <span class="q-phase-pill">${isLivePulse ? '<i class="q-live-dot"></i>' : ''}${escapeHtml(ui.badgeLabel)}</span>
          </div>
          <div class="q-hero-label">${ui.inFirst6h ? L('头矿窗口剩余 · 此时锁仓仅 5% 止损', 'First 6H remaining · 5% stop-loss') : escapeHtml(ui.title)}</div>
          <div class="q-hero-count q-num" id="${ui.inFirst6h ? 'early-window-cd' : 'round-cd'}">${ui.inFirst6h ? fmtStageCountdown(ui.earlyCountdownMs) : escapeHtml(cdText)}</div>
          ${ui.inFirst6h ? `<div class="q-hero-sub">${L('距封盘', 'Lock closes in')} <span id="round-cd">${escapeHtml(cdText)}</span></div>` : ''}
          <div class="q-hero-sub">${escapeHtml(ui.subtitle)}</div>
          ${(ui.stage === 'stake' || ui.stage === 'sealed' || ui.stage === 'charge') ? `
            <div class="q-track">
              <div class="q-seg" style="flex:6"><i style="width:${track.s1.toFixed(1)}%"></i></div>
              <div class="q-seg" style="flex:18"><i style="width:${track.s2.toFixed(1)}%"></i></div>
              <div class="q-seg" style="flex:12"><i style="width:${track.s3.toFixed(1)}%"></i></div>
            </div>
            <div class="q-track-labels">
              <span style="flex:6">${L('头矿 6H', 'First 6H')}</span>
              <span style="flex:18">${L('锁仓 18H', 'Lock 18H')}</span>
              <span style="flex:12">${L('冲价 12H', 'Push 12H')}</span>
            </div>
          ` : ''}
          ${heroCtaHtml}
        </section>

        <a class="q-steps3" href="#/rules">
          <span class="q-st ${stepClass('lock')}">${qIcon('lock', 17)}${L('锁仓 24H', '24H Lock')}<small>${L('头矿 6H 5% 止损', 'First 6H 5%')}</small></span>
          <span class="q-arrow">${qIcon('chevR', 15)}</span>
          <span class="q-st ${stepClass('push')}">${qIcon('chart', 17)}${L('冲价 12H', '12H Push')}<small>${L('8 / 12 达标', '8 / 12 Met')}</small></span>
          <span class="q-arrow">${qIcon('chevR', 15)}</span>
          <span class="q-st ${stepClass('win')}">${qIcon('trophy', 17)}${L('达标分奖', 'Split Pool')}<small>${L('单人封顶 5×', '5× Cap')}</small></span>
        </a>

        ${warmupCardHtml}

        <section class="q-card" id="q-race-card">
          <div class="q-card-h">
            <h3>${qIcon('flag', 18)} ${L('12H 冲价赛程', '12H Price Push')}</h3>
            <span class="q-chip ${(finiteOrNull(r.qualifiedCandles) ?? 0) >= PROTOCOL_SPECS.passRequired ? 'q-chip-green' : ''}">
              ${r.qualifiedCandles !== null ? `${r.qualifiedCandles} / 12 ${L('达标', 'Met')}` : L('≥ 8 / 12 达标', '≥ 8 / 12 Required')}
            </span>
          </div>
          <div class="q-price-row">
            <div>
              <small>${L('实时参考价', 'Live Price')}</small>
              <b class="q-num" id="round-live-price">${fmtUsdOrDash(r.priceValid === false ? null : r.livePrice, 4)}</b>
            </div>
            <div class="q-ta-r">
              <small>${L('本关目标价', 'Target Price')}</small>
              <b class="q-num" style="color:var(--q-red-ink);">${fmtUsdOrDash(r.targetPrice, 4)}</b>
            </div>
          </div>
          <div class="q-chart">${buildMiniPriceChartSvg(r)}</div>
          <div class="q-flags">${flagsHtml}</div>
          <div class="q-flag-status ${flagStatus.tone}" id="q-flag-status">
            ${qIcon(flagStatus.tone === 'win' ? 'trophy' : flagStatus.tone === 'lose' ? 'shield' : 'info', 17)}
            <span>${escapeHtml(flagStatus.text)}</span>
          </div>
        </section>

        <section class="q-card" id="q-pool-card">
          <div class="q-card-h">
            <h3>${qIcon('trophy', 18)} ${L('本关奖池', 'Stage Pool')}</h3>
            <a class="q-chip" href="#/rules" style="text-decoration:none;">${qIcon('info', 13)} ${L('规则', 'Rules')}</a>
          </div>
          <div class="q-grid2">
            <div class="q-stat">
              <small>${L('本关奖池预算', 'Stage Budget')}</small>
              <b class="q-num">${fmtIntOrDash(budgetA9)}</b>
              <span>A9${carryA9 !== null && carryA9 > 0 ? ` · ${L('含滚存', 'incl. carry')} ${fmtIntOrDash(carryA9)}` : ''}</span>
            </div>
            <div class="q-stat">
              <small>${L('本关总锁仓', 'Total Locked')}</small>
              <b class="q-num">${fmtIntOrDash(totalStakedA9)}</b>
              <span>A9 · ${r.stakerCount !== null ? `${fmtIntOrDash(r.stakerCount)} ${L('人次', 'entries')}` : L('人数待同步', 'entries pending')}</span>
            </div>
          </div>
          <div class="q-mult">
            <div class="q-mult-top">
              <div>
                <small>${L('当前每锁 1 A9 预计可分', 'Est. Reward per 1 A9')}</small>
                <b class="q-num">${estPer1A9 !== null ? `${formatNum(estPer1A9, 2)} A9` : '—'}</b>
              </div>
              <span class="q-chip q-chip-yellow">${L('单人封顶 5×', '5× Cap')}</span>
            </div>
            <div class="q-bar"><i style="width:${multPct.toFixed(1)}%"></i></div>
          </div>
          <div class="q-foot-note">
            ${poolRemA9 !== null
              ? L(`主奖池合约剩余 ${fmtExactA9(poolRemA9)}；单人奖励封顶 5×，超额 100% 滚存下一关。`, `Main pool contract remaining: ${fmtExactA9(poolRemA9)}; capped at 5× per wallet with 100% carry-over.`)
              : L('主奖池余额以链上合约为准；单人奖励封顶 5×，超额 100% 滚存下一关。', 'Main pool balance verified on-chain; capped at 5× per wallet with 100% carry-over.')}
          </div>
        </section>

        ${myStakeA9 !== null && myStakeA9 > 0 ? `
          <section class="q-card" id="q-my-pos-card">
            <div class="q-card-h">
              <h3>${qIcon('user', 18)} ${L('我的本关仓位', 'My Stage Position')}</h3>
              <span class="q-chip q-chip-red q-num">${escapeHtml(fmtExactA9(myStakeA9))}</span>
            </div>
            <div class="q-grid2">
              <div class="q-stat">
                <small>${L('头矿仓位 · 5% 止损', 'First 6H · 5%')}</small>
                <b class="q-num">${fmtIntOrDash(rawToA9(myTicket.earlyAmountRaw ?? myTicket.amountRaw))}</b>
                <span>A9</span>
              </div>
              <div class="q-stat">
                <small>${L('普通仓位 · 10% 止损', 'Standard · 10%')}</small>
                <b class="q-num">${fmtIntOrDash(rawToA9(myTicket.lateAmountRaw ?? '0'))}</b>
                <span>A9</span>
              </div>
            </div>
          </section>
        ` : ''}

        ${predictionHtml}
        ${historyHtml}
      </div>
    `;

    const retryBtn = root.querySelector('#q-stage-retry');
    if (retryBtn) retryBtn.onclick = () => window.dispatchEvent(new Event('a9:force-sync'));

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

    root.querySelectorAll('[data-q-pred]').forEach((btn) => {
      btn.onclick = async () => {
        const side = btn.dataset.qPred;
        const uid = getEffectiveUserId(u);
        if (!uid) {
          showToast(L('请在 Telegram 小程序内打开后参与预言', 'Open inside Telegram Mini App to predict'), 'amber');
          return;
        }
        local.predBusy = true;
        paint();
        try {
          await submitPredictionBet({
            roundId: r.currentRound || 1,
            userId: uid,
            side,
            referrerId: store.state.referral.referrerId,
          });
          A9Haptic.success();
          showToast(L('预言已提交，结算后自动派发奖励', 'Prediction submitted!'));
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

    const actBtn = root.querySelector('#q-pred-activate');
    if (actBtn) {
      actBtn.onclick = async () => {
        const uid = getEffectiveUserId(u);
        if (!u.connected || !u.address) {
          tonConnect.openConnectModal(() => loadAuxData());
          return;
        }
        local.predBusy = true;
        paint();
        try {
          await activatePredictionReward(uid, u.address);
          A9Haptic.success();
          showToast(L('预言奖励已激活至金库可领取余额', 'Prediction reward activated to Vault!'));
          await loadAuxData();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('激活失败', 'Activation failed'), 'error');
        } finally {
          local.predBusy = false;
          paint();
        }
      };
    }
  };

  const loadAuxData = async () => {
    const r = store.state.round;
    const u = store.state.user;
    const uid = getEffectiveUserId(u);
    const ui = deriveRoundUiState({ detail: r, user: u, serverNowMs: serverNowMs() });
    const needWarmup = ui.stage === 'warmup' || query?.stage === 'warmup';

    const tasks = [
      (isLive && u.connected && u.address) ? fetchUserPortfolio(u.address) : Promise.resolve(null),
      needWarmup ? fetchWarmupCurrent(null) : Promise.resolve(null),
      r.currentRound ? fetchPredictionRound(r.currentRound, r.stage || 'observation') : Promise.resolve(null),
      (r.currentRound && uid) ? fetchPredictionUser(uid, r.currentRound) : Promise.resolve(null),
    ];
    const [pfRes, wuRes, prRes, puRes] = await Promise.allSettled(tasks);
    if (seq !== stageViewSeq || !root.isConnected) return;

    if (pfRes.status === 'fulfilled' && pfRes.value) local.portfolio = pfRes.value;
    if (needWarmup) {
      if (wuRes.status === 'fulfilled') {
        local.warmup = wuRes.value;
        local.warmupError = null;
      } else {
        local.warmupError = wuRes.reason?.message || L('预热数据暂不可用', 'Warm-up data unavailable');
      }
    }
    if (prRes.status === 'fulfilled' && prRes.value) local.predRound = prRes.value;
    if (puRes.status === 'fulfilled' && puRes.value) local.predUser = puRes.value;
    paint();
  };

  paint();
  void loadAuxData();
}
