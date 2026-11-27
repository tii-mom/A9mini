import { store } from '../store.js';
import { config } from '../config.js';
import { peekDemoModule } from '../demo-loader.js';
import {
  estimateRewardA9,
  fetchPredictionRound,
  fetchPredictionUser,
  submitPredictionBet,
  activatePredictionReward,
  fetchUserPortfolio,
  fetchRoundAirdropDraws,
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
import { A9Haptic, A9TMA, isReducedMotion } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, copyText, openChoiceSheet, openModal, closeModal } from '../components.js';
import { mountSlider, burstParticles, bindCorridorRadarEvents } from '../components-heavy.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { deriveRoundUiState } from '../round-state.js';
import { pendingTxManager } from '../tx-ux.js';
import { openXShareSheet, buildOgShareUrl, buildTmaDeepLink, getShareRef } from '../share.js';
import {
  renderWarmupStage,
  renderParticipation,
  renderLowBalanceChestCtaHtml,
  renderObservation,
  renderInlineStampBoard,
  bindInlineStampBoard,
  renderSettlementSuccess,
  renderSettlementFailed,
  renderTechnicalHalt,
  renderSettlementBreakdownRows,
  renderPredictionCard,
  renderEarlyBirdBanner,
  renderSafetyCushionCard,
  renderMyRoundPositionCard,
  renderAirdropDrawsCard,
  renderRoundRallyCard,
  buildBattleRallyCopy
} from './round_stages.js';

let activeRoundDeckTab = 'pred';

function renderRoundInteractDeck(round, prediction, user) {
  return `
    <section class="round-interact-deck" id="a9-round-interact-deck">
      <div class="seg-tabs" id="round-deck-tabs">
        <button type="button" class="seg-tab ${activeRoundDeckTab === 'pred' ? 'active' : ''}" data-round-tab="pred">${L('12H 预言擂台', '12H Arena')}</button>
        <button type="button" class="seg-tab ${activeRoundDeckTab === 'airdrop' ? 'active' : ''}" data-round-tab="airdrop">${L('每轮 100,000 A9 空投', '100,000 A9 Airdrop')}</button>
      </div>
      <div id="round-pane-pred" ${activeRoundDeckTab === 'pred' ? '' : 'hidden'}>
        ${renderPredictionCard(round, prediction, user)}
      </div>
      <div id="round-pane-airdrop" ${activeRoundDeckTab === 'airdrop' ? '' : 'hidden'}>
        <div id="a9-airdrop-draws-mount">${renderAirdropDrawsCard({ loading: true })}</div>
      </div>
    </section>
  `;
}

function bindRoundDeckTabs(root) {
  root.querySelectorAll('[data-round-tab]').forEach((btn) => {
    btn.onclick = () => {
      const next = btn.dataset.roundTab === 'airdrop' ? 'airdrop' : 'pred';
      if (next === activeRoundDeckTab) return;
      A9Haptic.light();
      A9Audio.tick();
      activeRoundDeckTab = next;
      root.querySelectorAll('[data-round-tab]').forEach((b) => b.classList.toggle('active', b.dataset.roundTab === activeRoundDeckTab));
      const predPane = root.querySelector('#round-pane-pred');
      const airPane = root.querySelector('#round-pane-airdrop');
      if (predPane) predPane.hidden = activeRoundDeckTab !== 'pred';
      if (airPane) airPane.hidden = activeRoundDeckTab !== 'airdrop';
    };
  });
}

async function syncMyRoundPositionCard(root, onQualifiedChange = null) {
  const mount = root.querySelector('#a9-my-round-position-mount');
  if (!mount) return;
  const { round, user, certificates } = store.state;
  const curRoundId = round?.currentRound;
  if (curRoundId === null || curRoundId === undefined) {
    mount.innerHTML = '';
    if (onQualifiedChange) onQualifiedChange(null);
    return;
  }
  if (config.isDemo) {
    const cert = (certificates || []).find((c) => Number(c.round) === Number(curRoundId)) || null;
    mount.innerHTML = cert ? renderMyRoundPositionCard(round, { ...cert, isFirst6h: Boolean(round?.inFirst6h) }) : '';
    if (onQualifiedChange) onQualifiedChange(Boolean(cert && Number(cert.stakeTon) >= 100));
    return;
  }
  const buySlot = root.querySelector('#hero-buy-chest-slot');
  const setBuyChestVisibility = (visible) => {
    if (!buySlot) return;
    buySlot.hidden = !visible;
    buySlot.innerHTML = visible ? renderLowBalanceChestCtaHtml() : '';
  };
  if (!user?.address) {
    mount.innerHTML = '';
    setBuyChestVisibility(false);
    if (onQualifiedChange) onQualifiedChange(false);
    return;
  }
  try {
    const port = await fetchUserPortfolio(user.address);
    if (!mount.isConnected || store.state.user.address !== user.address) return;
    // Live 锁仓期余额不足 100 A9 时显示「去宝箱商城」次按钮；balanceAvailable 非 true 或 raw 缺失绝不误判
    const hasConfirmedBal = port?.balanceAvailable === true && port?.a9BalanceRaw !== null && port?.a9BalanceRaw !== undefined;
    const liveBalA9 = hasConfirmedBal ? rawToA9(port.a9BalanceRaw) : null;
    setBuyChestVisibility(liveBalA9 !== null && liveBalA9 < 100);
    const ticket = Array.isArray(port?.tickets)
      ? port.tickets.find((t) => Number(t.roundId) === Number(curRoundId))
      : null;
    mount.innerHTML = ticket ? renderMyRoundPositionCard(round, ticket) : '';
    const totalA9 = ticket ? (rawToA9(ticket.amountRaw) ?? 0) : 0;
    if (onQualifiedChange) onQualifiedChange(Boolean(ticket && !ticket.exited && totalA9 >= 100));
    const settleEl = root.querySelector('#round-settlement-personal');
    if (settleEl && ticket) {
      const wrap = document.createElement('div');
      wrap.innerHTML = renderSettlementBreakdownRows({
        principalA9: rawToA9(ticket.claimablePrincipalRaw ?? ticket.amountRaw),
        rewardA9: rawToA9(ticket.claimableRewardRaw),
        lockedA9: rawToA9(ticket.lockedRemainingRaw),
      }).trim();
      if (wrap.firstElementChild) settleEl.replaceWith(wrap.firstElementChild);
    }
    const settleCta = root.querySelector('#round-settlement-cta');
    if (settleCta && ticket?.ticketAddress) {
      settleCta.setAttribute('href', `#/rewards?ticket=${encodeURIComponent(ticket.ticketAddress)}`);
    }
  } catch (_) {
    if (mount.isConnected) mount.innerHTML = '';
    setBuyChestVisibility(false);
    if (onQualifiedChange) onQualifiedChange(null);
  }
}

/** 将 9 种规范 stage 归一化到闯关顶部 4 段时间轴键（warmup / stake / charge / settle）。 */
function mapStageToTimelineKey(stage) {
  if (stage === 'warmup') return 'warmup';
  if (stage === 'stake') return 'stake';
  if (stage === 'sealed' || stage === 'charge') return 'charge';
  if (stage === 'settling' || stage === 'passed' || stage === 'failed' || stage === 'aborted') return 'settle';
  return 'settle';
}

function renderStageExplainerCard(viewKey, liveKey, round) {
  const stageMeta = {
    stake: {
      title: L('24H 锁仓阶段说明', '24H Lock Stage Guide'),
      body: L(
        '本阶段开放 24 小时 A9 锁仓（最低 100 A9，全员 1 A9 = 1 份公平分奖，封顶 5×）。前 6 小时为「头矿 6H · 5% 止损」，之后为「10% 止损」；24H 锁仓期内随时可提前解押（退 85% 本金 / 扣 15% 销毁）。',
        'Open for 24 hours (min 100 A9, 1 A9 = 1 equal share, 5× cap). First 6H carries 5% stop-loss (95% refund if missed); 6H–24H carries 10% stop-loss. Early exit (85% refund / 15% burn) is open during the 24H lock window.'
      ),
    },
    charge: {
      title: L('12H 冲价阶段说明', '12H Push Stage Guide'),
      body: L(
        '封盘禁进禁出后进入 12 小时冲价期，共 12 个 1H 判定时段。任意 ≥ 8 个时段 1H 均价达到目标价即通关分奖；下方可随时查阅本轮 12 格达标进度。',
        'Locked for 12 hourly TWAP slots after staking closes. Any 8+ qualified slots pass the round and unlock the pool. Inspect the 12-slot qualification board below.'
      ),
    },
    settle: {
      title: L('结算与领取阶段说明', 'Settlement & Claim Stage Guide'),
      body: L(
        '通关后 100% 退本 + 20% 奖金秒提，余下 80% 分 14 天逐秒解锁（支持对未解锁余额走 3 折急提：30% 秒提 + 70% 销毁）；未达标按头矿 95% / 普通 90% 自动止损退本，永不爆仓。',
        'On pass: 100% principal + 20% instant reward, remaining 80% unlocks per second over 14 days (optional 30% instant / 70% burn cashout on unvested balance). If missed, 95% (First 6H) or 90% principal refunds automatically.'
      ),
    },
  };
  const info = stageMeta[viewKey] || stageMeta.settle;
  const isAlreadyCharge = viewKey === 'charge';
  return `
    <section class="card col-gap" id="round-stage-guide-card">
      <div class="row-between">
        <strong class="num-sm">${escapeHtml(info.title)}</strong>
        <button type="button" class="sw-retry-link" data-round-timeline="${escapeHtml(liveKey)}">${L('回到当前阶段', 'Back to Live Stage')} ›</button>
      </div>
      <div class="num-xs text-sec" style="line-height:1.6;">${escapeHtml(info.body)}</div>
    </section>
    ${isAlreadyCharge ? renderInlineStampBoard(round) : ''}
  `;
}

function renderBottomFoldsHtml(round, activeViewKey = 'settle') {
  const historyList = Array.isArray(round?.rounds)
    ? [...round.rounds]
        .sort((a, b) => (Number(b?.roundId) || 0) - (Number(a?.roundId) || 0))
        .slice(0, 8)
    : [];
  const isWarmupView = activeViewKey === 'warmup';
  return `
    <section class="card col-gap" style="gap:8px;" id="round-bottom-folds">
      ${!isWarmupView ? `
      <details class="rewards-secondary-fold" id="round-rules-fold">
        <summary>${L('本轮规则与安全垫', 'Round Rules & Safety Cushions')}</summary>
        <div class="col-gap" style="gap:8px;margin-top:8px;">
          <div class="num-xs text-sec" style="line-height:1.6;">
            ${L(
              '• 锁仓节奏：24H 锁仓（最低 100 A9，前 6H 为头矿 5% 止损、6H–24H 为 10% 止损，锁仓期内可提前解押退 85% / 烧 15%）。<br/>• 冲价判定：封盘后 12H 共 12 个 1H 均价时段，任意 ≥ 8 格达到目标价即通关。<br/>• 派奖解锁：通关退 100% 本金 + 20% 秒提，余下 80% 按 14 天逐秒解锁进度释放（随时支持 3 折急提）；未达标永不爆仓，自动止损退本。',
              '• 24H Lock: min 100 A9 (First 6H 5% SL, 6H–24H 10% SL; 85% Early Exit open during lock).<br/>• 12H Push: 12 hourly TWAP slots, any 8+ meeting target pass.<br/>• Payout: 100% principal + 20% instant + 80% 14-day per-second unlock (optional 30% instant cashout); auto stop-loss refund if missed.'
            )}
          </div>
          <a class="sw-retry-link" href="#/rules" style="align-self:flex-start;">${L('查看完整规则与透明合约', 'Full Rules & Transparency')} ›</a>
        </div>
      </details>

      <details class="rewards-secondary-fold" id="round-intent-fold">
        <summary>${L('下轮意向档位（免锁仓）', 'Next-Round Pledge Tiers (No Lock)')}</summary>
        <div class="col-gap" style="gap:8px;margin-top:8px;">
          <div class="num-xs text-sec" style="line-height:1.6;">
            ${L(
              '预热报名可登记意向档位（100 / 1,000 / 5,000 / 20,000 A9），仅作开盘提醒与意愿统计，不扣费、不锁仓。',
              'Choose an optional pledge tier (100 / 1,000 / 5,000 / 20,000 A9) during Warm-Up for opening reminders only — zero cost, no lock.'
            )}
          </div>
          <button type="button" class="sw-retry-link" data-round-timeline="warmup" style="align-self:flex-start;">${L('前往预热设置意向档位', 'Set Pledge Tier in Warm-Up')} ›</button>
        </div>
      </details>
      ` : ''}

      <details class="rewards-secondary-fold" id="round-history-fold">
        <summary>${L('往期轮次', 'Past Rounds')}</summary>
        <div class="col-gap" style="gap:6px;margin-top:8px;">
          ${historyList.length === 0
            ? `<div class="num-xs text-muted">${L('暂无往期轮次记录。', 'No past rounds available yet.')}</div>`
            : historyList.map((item) => {
                const stUi = deriveRoundUiState({ detail: item, user: { connected: true }, serverNowMs: serverNowMs() });
                const qual = Number.isInteger(item?.qualifiedCandles) ? `${item.qualifiedCandles}/${item?.minQualifiedCandles || 8}` : '—';
                const ridText = item?.roundId !== null && item?.roundId !== undefined ? String(item.roundId) : '—';
                return `
                  <div class="list-row" style="padding:7px 10px;">
                    <span class="num-xs" style="font-weight:700;">${L(`第 ${ridText} 轮`, `Round #${ridText}`)}</span>
                    <span class="row-start" style="gap:6px;">
                      <span class="mono num-xs text-sec">${escapeHtml(qual)}</span>
                      <span class="chip ${stUi.chipTone}" style="min-height:18px;font-size:11px;padding:0 6px;">${escapeHtml(stUi.badgeLabel)}</span>
                    </span>
                  </div>
                `;
              }).join('')}
          <a class="sw-retry-link" href="#/records" style="align-self:flex-start;">${L('前往全部记录', 'View All Records')} ›</a>
        </div>
      </details>
    </section>
  `;
}

export function renderChallengeHome(root, navigate, _param, query = {}) {
  const { round, user } = store.state;
  const uiState = deriveRoundUiState({
    detail: round,
    user,
    rewards: { claimableA9: user?.a9Claimable },
    serverNowMs: serverNowMs(),
  });
  const stage = uiState.stage;
  const liveTimelineKey = mapStageToTimelineKey(stage);

  // 支持深链定位对应阶段：/round?stage=warmup（原 /warmup）、/round?stage=charge（原 /observation/records）
  // /round?panel=prediction 落到当前阶段并忽略预言面板
  const requestedRaw = String(query?.stage || '').toLowerCase();
  const initialViewKey = ['warmup', 'stake', 'charge', 'settle'].includes(requestedRaw)
    ? requestedRaw
    : liveTimelineKey;
  let activeViewKey = initialViewKey;

  const paintQuest = () => {
    if (!root.isConnected) return;
    const timelineItems = [
      { key: 'warmup', label: L('预热', 'Warm-Up') },
      { key: 'stake',  label: L('锁仓', 'Lock') },
      { key: 'charge', label: L('冲价', 'Push') },
      { key: 'settle', label: L('结算', 'Settle') },
    ];

    const timelineBarHtml = `
      <div class="round-timeline-bar" id="round-timeline-bar">
        <div class="round-timeline-tabs" role="tablist" aria-label="${L('闯关四阶段时间轴', 'Quest 4-stage timeline')}">
          ${timelineItems.map((item) => {
            const isSelected = activeViewKey === item.key;
            const isLiveNow = stage !== 'unknown' && liveTimelineKey === item.key;
            return `
              <button type="button" role="tab" aria-selected="${isSelected ? 'true' : 'false'}" class="round-timeline-tab ${isSelected ? 'is-selected' : ''} ${isLiveNow ? 'is-live' : ''}" data-round-timeline="${item.key}">
                ${isLiveNow ? '<i class="round-live-dot" aria-hidden="true"></i>' : ''}
                <span>${escapeHtml(item.label)}</span>
              </button>
            `;
          }).join('')}
        </div>
        <button type="button" class="icon-btn round-share-icon-btn" id="btn-round-share-icon" aria-label="${L('分享本轮战况', 'Share round update')}" title="${L('分享本轮', 'Share')}">${icon('share', 15)}</button>
      </div>
    `;

    let bodyHtml = '';
    let inlineStampHtml = '';
    let shouldMountWarmup = false;
    let shouldBindInlineStamps = false;
    let showPositionAfterHero = false;

    if (activeViewKey === 'warmup') {
      // 预热阶段直接挂载独立组件 mountWarmupSection（替换旧 renderWarmupStage 渲染）
      bodyHtml = `<div id="round-warmup-mount"><section class="card num-xs text-muted">${L('加载预热信息中…', 'Loading warm-up…')}</section></div>`;
      shouldMountWarmup = true;
    } else if (stage === 'unknown') {
      bodyHtml = `<section class="card empty-state"><div class="num-sm text-sec">${escapeHtml(uiState.title)}</div><button class="btn btn-secondary btn-sm" id="btn-round-retry-sync" type="button" style="margin-top:8px;">${escapeHtml(uiState.primaryAction.label)}</button></section>`;
    } else if (activeViewKey !== liveTimelineKey) {
      bodyHtml = renderStageExplainerCard(activeViewKey, liveTimelineKey, round);
      shouldBindInlineStamps = activeViewKey === 'charge';
    } else if (stage === 'stake') {
      bodyHtml = renderParticipation(round);
      showPositionAfterHero = true;
    } else if (stage === 'sealed' || stage === 'charge') {
      bodyHtml = renderObservation(round);
      inlineStampHtml = renderInlineStampBoard(round);
      shouldBindInlineStamps = true;
      showPositionAfterHero = true;
    } else if (stage === 'settling') {
      bodyHtml = renderObservation(round);
      inlineStampHtml = renderInlineStampBoard(round);
      shouldBindInlineStamps = true;
      showPositionAfterHero = true;
    } else if (stage === 'passed') {
      bodyHtml = renderSettlementSuccess(round, user);
      showPositionAfterHero = true;
    } else if (stage === 'aborted') {
      bodyHtml = renderTechnicalHalt(round);
      showPositionAfterHero = true;
    } else {
      bodyHtml = renderSettlementFailed(round);
      showPositionAfterHero = true;
    }

    // 5d 极简闯关结构：顶部固定 4 段时间轴 + 分享图标 → 主卡 → 我的本轮仓位（紧贴主卡）→ 12 格达标板（冲价/待结算）→ 底部折叠区
    // 不渲染预言、空投面板与中间插入的喊单卡
    root.innerHTML = `
      <div class="col-gap anim-page-enter" id="round-quest-root">
        ${timelineBarHtml}
        ${bodyHtml}
        ${showPositionAfterHero ? '<div id="a9-my-round-position-mount"></div>' : ''}
        ${inlineStampHtml}
        ${renderBottomFoldsHtml(round, activeViewKey)}
      </div>
    `;

    // 绑定时间轴切换
    root.querySelectorAll('[data-round-timeline]').forEach((btn) => {
      btn.onclick = () => {
        const nextKey = btn.dataset.roundTimeline;
        if (!nextKey || nextKey === activeViewKey) return;
        A9Haptic.light();
        activeViewKey = nextKey;
        paintQuest();
      };
    });

    // 绑定右上角分享图标（替代页面中间插入的喊单卡）
    const shareIconBtn = root.querySelector('#btn-round-share-icon');
    if (shareIconBtn) {
      shareIconBtn.onclick = () => {
        A9Haptic.light();
        const shareRef = getShareRef();
        const inviteLink = config.isDemo
          ? `${window.location.origin}${window.location.pathname}?mode=${config.mode}&startapp=invite_${encodeURIComponent(shareRef)}`
          : buildTmaDeepLink(`invite_${shareRef}`);
        const copyTextStr = buildBattleRallyCopy(store.state.round, inviteLink, 'push');
        openChoiceSheet({
          title: L('分享本轮战况', 'Share Round Update'),
          options: [
            { value: 'copy', label: L('复制战况话术', 'Copy Battle Copy'), sub: L('含本轮实时进度与专属邀请链接', 'Includes round status & invite link') },
            { value: 'tg',   label: L('转发至 Telegram', 'Share via Telegram'), sub: L('直接发给好友或群聊', 'Send to friends or group') },
          ],
          onSelect: (val) => {
            if (val === 'copy') copyText(copyTextStr, L('已复制战况话术', 'Copied battle copy'));
            else if (val === 'tg') {
              A9TMA.shareInvite(inviteLink, copyTextStr);
              showToast(L('已调起 Telegram 分享', 'Share opened'));
            }
          },
        });
      };
    }

    const rBtn = root.querySelector('#btn-round-retry-sync');
    if (rBtn) rBtn.onclick = () => window.dispatchEvent(new Event('a9:force-sync'));

    if (shouldMountWarmup) {
      const wMount = root.querySelector('#round-warmup-mount');
      if (wMount) {
        import('./warmup_market.js')
          .then((m) => {
            if (wMount.isConnected && typeof m.mountWarmupSection === 'function') {
              m.mountWarmupSection(wMount, { navigate, param: _param, query, embedded: true });
            }
          })
          .catch(() => {
            if (wMount.isConnected) {
              wMount.innerHTML = `<section class="card num-xs text-red">${L('预热模块加载失败，请重试', 'Warm-up failed to load')}</section>`;
            }
          });
      }
    }

    if (shouldBindInlineStamps) {
      bindInlineStampBoard(root, round);
    }

    const stageBtn = config.isDemo ? root.querySelector('#btn-stage-sheet') : null;
    if (stageBtn) {
      stageBtn.onclick = () => openChoiceSheet({
        title: L('切换轮次阶段 (演示)', 'Switch Round Stage (Demo)'),
        selected: round.stage,
        options: [
          { value: 'warmup',             label: L('1. 开局倒计时', '1. Pre-Round'), sub: L('开局预热池报名', 'Pre-round registration') },
          { value: 'participation',      label: L('2. 24H 锁仓', '2. 24H Lock'), sub: L('头矿 6H · 5% 止损 · 100 A9 起锁仓', 'First 6H · 5% Stop-Loss · 100 A9+') },
          { value: 'observation',        label: L('3. 12H 冲价', '3. 12H Push'), sub: L('12 个时段 ≥ 8/12 通关 · 封盘禁出', '12 slots · ≥ 8/12 pass · locked') },
          { value: 'settlement_success', label: L('4. 通关派奖', '4. Passed'), sub: L('20% 秒提 + 14 天逐秒解锁 / 3 折急提（7 折销毁）', '20% Instant + 14D Per-Second Unlock / Instant Cashout (30% Now / 70% Burn)') },
          { value: 'settlement_burn',    label: L('5. 未达标 · 自动止损', '5. No Liquidation · Auto Stop-Loss'), sub: L('永不爆仓 · 头矿 6H 退 95% / 普通退 90%', 'No Liquidation · 95% First 6H / 90% refund') },
          { value: 'halted',             label: L('6. 异常中止 · 退回本金', '6. Aborted · Refund'), sub: L('本金原路退回', 'Principal refunded') }
        ],
        onSelect: (val) => {
          store.update(s => { peekDemoModule()?.setDemoRoundStage(s.round, val); });
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
        const estEl = root.querySelector('#hero-est-a9');
        const ctaEl = root.querySelector('#hero-stake-cta');
        if (estEl) estEl.textContent = est === null ? '—' : `~${formatNum(Math.round(est))} A9`;
        if (ctaEl) ctaEl.innerHTML = `${icon('bolt', 16)} ${L(`立即锁仓 ${formatNum(amt)} A9`, `Lock ${formatNum(amt)} A9`)}`;
      };
    });

    if (showPositionAfterHero) {
      void syncMyRoundPositionCard(root, null);
    }
  };

  paintQuest();
}

async function syncAirdropDrawsCard(root, state, paint) {
  const mount = root.querySelector('#a9-airdrop-draws-mount');
  if (!mount) return;
  state.loading = true;
  state.error = null;
  paint();
  try {
    const data = await fetchRoundAirdropDraws({ limit: 5 });
    if (!mount.isConnected) return;
    state.loading = false;
    state.error = null;
    state.items = Array.isArray(data?.items) ? data.items : [];
    state.bucketRemainingRaw = data?.bucketRemainingRaw ?? null;
    paint();
  } catch (e) {
    if (!mount.isConnected) return;
    state.loading = false;
    state.error = e?.message || L('每轮空投公示暂不可读取', 'Airdrop draws unavailable');
    paint();
  }
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
  const uiStage = deriveRoundUiState({ detail: round, user, serverNowMs: serverNowMs() }).stage;
  if (uiStage === 'unknown' || uiStage === 'warmup' || uiStage === 'aborted') return;
  const roundId = config.isDemo ? (round.currentRound || 1) : round.currentRound;
  if (!roundId) {
    requestedCard.textContent = L('轮次数据待核验，暂无法读取预言状态', 'Round data pending verification');
    return;
  }
  const uid = getEffectiveUserId(user);
  try {
    const [rData, uData] = await Promise.all([
      fetchPredictionRound(roundId, uiStage),
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
      root.querySelector('#pred-toggle-head')?.focus({ preventScroll: true });
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
        if (!Number.isInteger(n) || n < 0 || n > 12) {
          showToast(L('精准格数须为 0 至 12 的整数', 'Exact slots must be an integer between 0 and 12'), 'error');
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
        showToast(L(`已锁定本轮预言：${selectedSide === 'BURN' ? '押未通关 FAIL' : '押通关 PASS'}`, `Prediction locked: ${selectedSide === 'BURN' ? 'FAIL' : 'PASS'}`));
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
      const sideText = bet.side === 'BURN' ? L('未通关 FAIL', 'FAIL') : L('通关 PASS', 'PASS');
      const oppText = bet.side === 'BURN' ? L('通关 PASS', 'PASS') : L('未通关 FAIL', 'FAIL');
      const text = L(
        `这轮 A9 第 ${roundId} 轮 12H 冲价我押了【${sideText}】${bet.guessSlots !== null && bet.guessSlots !== undefined ? `（精准 ${bet.guessSlots}/12 段）` : ''}，不服的来押【${oppText}】对赌！0 GRAM 进场，新人首轮猜错还保底领 500 A9：`,
        `I locked [${sideText}] on A9 Round #${roundId} 12H Push! Think it's [${oppText}]? 0 GRAM entry with a 500 A9 rookie floor:`
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
        const deltaA9 = rawToA9(res?.activatedDeltaRaw ?? res?.activatedRaw ?? prediction.pendingActivationRaw) || 0;
        if (config.isDemo) user.promoClaimableA9 += deltaA9;
        showToast(L(`已激活 ${formatNum(deltaA9)} A9 至邀友奖励账户，可走 0.06 GRAM 提现`, `Activated ${formatNum(deltaA9)} A9 to invite reward balance`));
        await syncPredictionState(root, navigate);
      } catch (e) {
        A9Haptic.error();
        if (e?.code === 'ACTIVATION_REQUIREMENT_UNMET') {
          showToast(L('请先在宝箱商城购任意宝箱（0.99 GRAM 起）、链上锁仓，或直邀 1 位好友购箱后再激活', 'Buy any chest (0.99+ GRAM), lock A9 on-chain, or invite 1 paid friend before activating'), 'amber');
          actBtn.disabled = false;
        } else if (e?.code === 'VOUCHER_EXPIRED') {
          showToast(L('待激活预言券已过期并回流奖池', 'Pending prediction voucher has expired and returned to the pool'), 'amber');
          await syncPredictionState(root, navigate);
        } else {
          showToast(e?.message || L('激活失败，请先购任意宝箱（0.99 GRAM 起）、链上锁仓或直邀 1 位好友购箱', 'Activation failed; buy any chest (0.99+ GRAM), lock A9, or invite 1 paid friend first'), 'error');
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

/** v17.0 涨价解锁极简回本推演卡（全员 1:1 平分、5× 封顶、头矿 6H 5% 止损 / 普通 10% 止损、14 天逐秒解锁 + 3 折急提） */
function computeStakeSummaryMetrics({ amountA9, round }) {
  const amt = Math.max(0, Number(amountA9) || 0);
  const inFirst6h = Boolean(round?.inFirst6h);
  const stopLossPct = inFirst6h ? 5 : 10;
  const failRefundA9 = Math.floor(amt * (100 - stopLossPct) / 100);
  const failBurnA9 = Math.max(0, amt - failRefundA9);
  const estTotalRaw = amt > 0 ? estimateRewardA9(amt, round) : null;
  const estTotal = estTotalRaw !== null && Number.isFinite(estTotalRaw) ? Math.round(estTotalRaw) : null;
  const curInstantReward = estTotal !== null ? Math.round(estTotal * 0.2) : null;
  const curLockedReward = (estTotal !== null && curInstantReward !== null) ? Math.max(0, estTotal - curInstantReward) : null;
  const day0CashoutReward = (curInstantReward !== null && curLockedReward !== null)
    ? Math.round(curInstantReward + curLockedReward * 0.3)
    : null;
  const passCashIn = (curInstantReward !== null && amt > 0) ? Math.round(amt + curInstantReward) : null;
  const instantRoiPct = (curInstantReward !== null && amt > 0) ? ((curInstantReward / amt) * 100) : null;
  const capA9 = amt > 0 ? Math.round(amt * 5) : 0;
  const hitCap = estTotal !== null && amt > 0 && estTotal >= capA9;

  return {
    amt,
    inFirst6h,
    stopLossPct,
    failRefundA9,
    failBurnA9,
    estTotal,
    curInstantReward,
    curLockedReward,
    day0CashoutReward,
    passCashIn,
    instantRoiPct,
    capA9,
    hitCap,
    curve: [
      { key: 'd0', pct: 20, amt: estTotal !== null ? Math.round(estTotal * 0.2) : null },
      { key: 'd4', pct: 43, amt: estTotal !== null ? Math.round(estTotal * (0.2 + 0.8 * 4 / 14)) : null },
      { key: 'd7', pct: 60, amt: estTotal !== null ? Math.round(estTotal * 0.6) : null },
      { key: 'd14', pct: 100, amt: estTotal !== null ? estTotal : null },
    ],
  };
}

function renderStakeSummaryCardHtml({ amountA9, round, prefix = 'demo', minStakeA9 = 100, roundController = null }) {
  const m = computeStakeSummaryMetrics({ amountA9, round });
  const hasEst = m.estTotal !== null;
  const fmtOrPending = (v, suffix = ' A9') =>
    v === null || v === undefined ? L('待链上奖池同步', 'Awaiting pool') : `${formatNum(v)}${suffix}`;

  return `
    <section class="card payback-calc-card" id="${prefix}-stake-summary-card">
      <div class="row-between" style="margin-bottom:8px;">
        <div class="card-title">${icon('radar', 15, 'text-gold')} ${L('涨价解锁 · 收益与止损核对', 'Price-Unlock · Payout & Stop-Loss')}</div>
        <a class="chip chip-green" href="#/risk/audit" style="text-decoration:none;">${icon('shieldCheck', 11)} ${L('v17 涨价解锁', 'v17 Price-Unlock')}</a>
      </div>

      <div class="sub-tile row-between" style="margin-bottom:8px;padding:8px 10px;border-color:${m.inFirst6h ? 'var(--red-border, #F3B3B8)' : 'var(--border)'};">
        <span class="num-xs" style="font-weight:800;color:${m.inFirst6h ? 'var(--red)' : 'var(--ink)'};">
          ${m.inFirst6h
            ? L('头矿 6H 特权窗口：全员 1:1 分奖 · 未通关仅止损 5%（退 95%）', 'First 6H Window: 1:1 Fair Split · 5% Stop-Loss (95% Refund)')
            : L('全员 1:1 公平分奖 · 永不爆仓（未通关自动退 90%，止损 10%）', '1:1 Fair Split · No Liquidation (90% Auto Refund, 10% Stop-Loss)')}
        </span>
      </div>

      <div class="payback-outcome-grid">
        <div class="payback-outcome-box is-pass">
          <div class="row-between">
            <small class="text-green" style="font-weight:800;">${L('通关 PASS（≥ 8/12 格）', 'PASS (≥ 8/12 Slots)')}</small>
            <span class="mono num-xs text-green" data-field="instant-roi">${m.instantRoiPct !== null ? `+${m.instantRoiPct.toFixed(1)}%` : '—'}</span>
          </div>
          <div class="payback-outcome-main mono text-green" data-field="pass-cashin">${fmtOrPending(m.passCashIn)}</div>
          <div class="num-xs text-sec" data-field="pass-breakdown">
            ${hasEst
              ? L(`100% 退本 ${formatNum(m.amt)} + 20% 秒提 ${formatNum(m.curInstantReward)} A9（余 80% 14 天解锁）`, `100% principal ${formatNum(m.amt)} + 20% instant ${formatNum(m.curInstantReward)} A9 (80% over 14d)`)
              : L(`100% 退本 ${formatNum(m.amt)} A9 + 20% 秒提奖金`, `100% principal ${formatNum(m.amt)} A9 + 20% instant reward`)}
          </div>
        </div>

        <div class="payback-outcome-box is-burn">
          <div class="row-between">
            <small class="text-red" style="font-weight:800;">${L('未通关 · 自动止损（< 8/12 格）', 'FAIL · Auto Stop-Loss (< 8/12)')}</small>
            <span class="mono num-xs text-red">-${m.stopLossPct}%</span>
          </div>
          <div class="payback-outcome-main mono text-green" data-field="fail-refund">${L(`退回 ${formatNum(m.failRefundA9)} A9`, `Refund ${formatNum(m.failRefundA9)} A9`)}</div>
          <div class="num-xs text-sec" data-field="fail-burn-desc">${L(`永不爆仓：仅扣 ${m.stopLossPct}%（${formatNum(m.failBurnA9)} A9）销毁；锁仓期提前解押退 85%`, `No liquidation: only ${m.stopLossPct}% (${formatNum(m.failBurnA9)} A9) burned; lock-window Early Exit refunds 85%`)}</div>
        </div>
      </div>

      <div class="check-list" style="margin-top:8px;">
        <div class="check-row">
          <span class="text-sec">${L('锁仓本金 / 最低门槛', 'Lock Amount / Minimum')}</span>
          <span class="mono" style="font-weight:700;" data-field="chk-amt">${formatNum(m.amt)} A9 (≥ ${formatNum(minStakeA9)} A9)</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('预估总奖金（全员 1:1 · 封顶 5×）', 'Est. Total Reward (1:1 · 5× Cap)')}</span>
          <span class="mono text-green" style="font-weight:700;" data-field="est-total">${hasEst ? `~${formatNum(m.estTotal)} A9` : L('待链上奖池同步', 'Awaiting pool')}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('20% 秒提 / 14 天逐秒解锁 (80%)', '20% Instant / 14D Unlock (80%)')}</span>
          <span class="mono num-xs"><span data-field="est-instant">${hasEst ? `${formatNum(m.curInstantReward)} A9` : '—'}</span> / <span data-field="est-locked">${hasEst ? `${formatNum(m.curLockedReward)} A9` : '—'}</span></span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('3 折急提（第 0 天最高秒拿 44%）', 'Instant Cashout (Day-0 44% Now)')}</span>
          <span class="mono num-xs" data-field="est-cashout">${hasEst ? `~${formatNum(m.day0CashoutReward)} A9 + ${L('本金', 'Principal')}` : '—'}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('附带 Gas / 目标底价 / 冲价线', 'Gas / Target / Push Line')}</span>
          <span class="mono num-xs">0.30 GRAM · ${round.targetPrice === null ? L('待定', 'TBD') : '$' + round.targetPrice.toFixed(4)} · 8/12 (5×)</span>
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
          ? L(`已达 5× 单轮封顶（${formatNum(m.capA9)} A9），余量 100% 滚存下一轮，以链上结算为准。`, `Hits 5× round cap (${formatNum(m.capA9)} A9); surplus rolls 100% into next round.`)
          : L('全员 1 A9 = 1 份公平平分，动态推演非收益承诺，以链上结算为准。', '1 A9 = 1 equal share; dynamic estimate settled on-chain.')}
      </div>

      <details class="payback-details" data-field="vesting-details" ${hasEst ? '' : 'hidden'}>
        <summary>
          <span>${L('查看 14 天逐秒解锁进度（20% 秒提 + 每日 5.71% · 支持 3 折急提，7 折销毁）', 'View 14D Per-Second Unlock (20% Instant + 5.71%/day · Instant Cashout 30% Now / 70% Burn)')}</span>
          <span class="faq-arrow">${icon('chevronDown', 13)}</span>
        </summary>
        <div class="payback-curve-box" style="margin-top:8px;">
          <div class="num-xs text-sec" style="margin-bottom:6px;line-height:1.45;">
            ${L('通关即退 100% 本金 + 20% 秒提；余下 80% 分 14 天逐秒解锁，永久累计不倒扣。急用钱可随时走 3 折急提通道（未解锁余额 30% 秒提、70% 直接销毁）。', 'Pass refunds 100% principal + 20% instant; remaining 80% unlocks per second over 14 days. Instant Cashout lets you take 30% of unvested rewards now (70% burned).')}
          </div>
          <div class="payback-curve-list">
            ${[
              ['d0', L('通关当日', 'Day 0'), 20],
              ['d4', L('第 4 天', 'Day 4'), 43],
              ['d7', L('第 7 天', 'Day 7'), 60],
              ['d14', L('满 14 天', 'Day 14'), 100],
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

function updateStakeSummaryCardDom(cardEl, { amountA9, round, minStakeA9 = 100 }) {
  if (!cardEl) return;
  const m = computeStakeSummaryMetrics({ amountA9, round });
  const hasEst = m.estTotal !== null;
  const setText = (sel, text) => { const el = cardEl.querySelector(sel); if (el) el.textContent = text; };

  setText('[data-field="instant-roi"]', m.instantRoiPct !== null ? `+${m.instantRoiPct.toFixed(1)}%` : '—');
  setText('[data-field="pass-cashin"]', m.passCashIn !== null ? `${formatNum(m.passCashIn)} A9` : L('待链上奖池同步', 'Awaiting pool'));
  setText('[data-field="pass-breakdown"]', hasEst
    ? L(`100% 退本 ${formatNum(m.amt)} + 20% 秒提 ${formatNum(m.curInstantReward)} A9（余 80% 14 天解锁）`, `100% principal ${formatNum(m.amt)} + 20% instant ${formatNum(m.curInstantReward)} A9 (80% over 14d)`)
    : L(`100% 退本 ${formatNum(m.amt)} A9 + 20% 秒提奖金`, `100% principal ${formatNum(m.amt)} A9 + 20% instant reward`));
  setText('[data-field="fail-refund"]', L(`退回 ${formatNum(m.failRefundA9)} A9`, `Refund ${formatNum(m.failRefundA9)} A9`));
  setText('[data-field="fail-burn-desc"]', L(`永不爆仓：仅扣 ${m.stopLossPct}%（${formatNum(m.failBurnA9)} A9）销毁；锁仓期提前解押退 85%`, `No liquidation: only ${m.stopLossPct}% (${formatNum(m.failBurnA9)} A9) burned; lock-window Early Exit refunds 85%`));
  setText('[data-field="chk-amt"]', `${formatNum(m.amt)} A9 (≥ ${formatNum(minStakeA9)} A9)`);
  setText('[data-field="est-total"]', hasEst ? `~${formatNum(m.estTotal)} A9` : L('待链上奖池同步', 'Awaiting pool'));
  setText('[data-field="est-instant"]', hasEst ? `${formatNum(m.curInstantReward)} A9` : '—');
  setText('[data-field="est-locked"]', hasEst ? `${formatNum(m.curLockedReward)} A9` : '—');
  setText('[data-field="est-cashout"]', hasEst ? `~${formatNum(m.day0CashoutReward)} A9 + ${L('本金', 'Principal')}` : '—');
  setText('[data-field="dilution-note"]', m.hitCap
    ? L(`已达 5× 单轮封顶（${formatNum(m.capA9)} A9），余量 100% 滚存下一轮，以链上结算为准。`, `Hits 5× round cap (${formatNum(m.capA9)} A9); surplus rolls 100% into next round.`)
    : L('全员 1 A9 = 1 份公平平分，动态推演非收益承诺，以链上结算为准。', '1 A9 = 1 equal share; dynamic estimate settled on-chain.'));

  const detailsEl = cardEl.querySelector('[data-field="vesting-details"]');
  if (detailsEl) detailsEl.hidden = !hasEst;

  m.curve.forEach((step) => {
    const bar = cardEl.querySelector(`[data-curve-bar="${step.key}"]`);
    if (bar) bar.style.width = `${step.pct}%`;
    setText(`[data-curve-val="${step.key}"]`, step.amt === null ? `${step.pct}%` : `${formatNum(step.amt)} A9`);
  });
}

function parseConfirmAmtParam() {
  try {
    const rawHash = String(window.location.hash || '');
    const qIdx = rawHash.indexOf('?');
    if (qIdx < 0) return null;
    const raw = new URLSearchParams(rawHash.slice(qIdx + 1)).get('amt');
    if (raw === null || !/^[1-9]\d*$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

export function renderParticipateConfirm(root, navigate) {
  const { user } = store.state;
  const round = store.state.round;
  if (!config.isDemo && !store.fundsEnabled) {
    const inFirst6h = Boolean(round?.inFirst6h);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero col-gap">
          <div class="row-between">
            <span class="card-title">${icon('bolt', 15, 'text-gold')} ${L(`第 ${round.currentRound ?? '—'} 轮锁仓条件`, `Round #${round.currentRound ?? '—'} Lock Terms`)}</span>
            <span class="chip ${inFirst6h ? 'chip-green' : 'chip-gold'}">${inFirst6h ? L('头矿 6H · 5% 止损', 'First 6H · 5% SL') : L('普通 · 10% 止损', 'Std · 10% SL')}</span>
          </div>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('最低锁仓门槛', 'Minimum Lock')}</span>
                <span class="sw-menu-sub">${L('全员 1 A9 = 1 份公平分奖 · 5× 单轮封顶', '1:1 fair split · 5× single-round cap')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount">100 A9</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('未通关自动止损', 'Auto Stop-Loss')}</span>
                <span class="sw-menu-sub">${L('头矿 6H 退 95%（烧 5%）· 普通退 90%（烧 10%）', 'First 6H refunds 95% (5% burn) · Std 90% (10% burn)')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount is-green">5% / 10%</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('24H 锁仓期提前解押', '24H Early Exit')}</span>
                <span class="sw-menu-sub">${L('退回 85% 本金 / 销毁 15% · 进入 12H 冲价封盘禁出', '85% refund / 15% burn · locked during 12H Push')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount">85% / 15%</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('链上预附', 'Attached GRAM')}</span>
                <span class="sw-menu-sub">${L('扣除链上费用和必要留存后退回可退余量', 'Refundable excess returns after fees and reserves')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount">0.30 GRAM</span></div>
            </div>
          </div>
        </section>
        <section class="card" id="live-readonly-stake-notice" style="border-color:var(--gold-border);">
          <div class="row-start" style="font-weight:700;margin-bottom:4px;">${icon('shieldAlert', 15, 'text-gold')} ${L('真实只读模式 · 暂未开放锁仓签名', 'Live Read-Only · Locking Disabled')}</div>
          <div class="num-xs text-sec" style="line-height:1.5;">${L('当前真实模式仅支持只读核验，不唤起钱包签名或扣款。你可以先返回闯关页参与 0 GRAM 12H 预言擂台。', 'Live mode is read-only; no wallet signature or transfer will be triggered. Join the 0 GRAM 12H Prediction Arena on the Quest page.')}</div>
        </section>
        <button class="btn btn-secondary" type="button" disabled>${icon('lock', 15)} ${L('当前只读 · 暂未开放锁仓签名', 'Read-Only · Lock Signing Disabled')}</button>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/risk/audit">
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('v17.0 链上验真', 'v17.0 On-Chain Audit')}</span>
              <span class="sw-menu-sub">${L('查看合约地址、安全参数与 7 天 AbortRound 逃生舱', 'Inspect contracts, security specs & 7d AbortRound')}</span>
            </div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/round">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回闯关', 'Back to Quest')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;
    return;
  }
  if (!config.isDemo) {
    renderLiveStakeConfirm(root, navigate);
    return;
  }
  const amtParam = parseConfirmAmtParam();
  const availFloor = user.a9Available !== null && user.a9Available !== undefined ? Math.floor(Number(user.a9Available) || 0) : null;
  let amount = round.quickStakeA9 || 5000;
  if (amtParam !== null) {
    amount = availFloor !== null && availFloor >= 100
      ? Math.max(100, Math.min(amtParam, availFloor))
      : Math.max(100, amtParam);
  }
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
          <input id="stake-input" type="number" min="100" step="100" value="${amount}" aria-label="${L('锁仓 A9 数量', 'Lock A9 amount')}" />
          <span class="caps text-sec">A9</span>
        </div>
        <div class="grid-4" style="margin-top:8px;">
          <button class="quick-btn ${amount === 100 ? 'active' : ''}" data-amt="100" type="button">100</button>
          <button class="quick-btn ${amount === 1000 ? 'active' : ''}" data-amt="1000" type="button">1,000</button>
          <button class="quick-btn ${amount === 5000 ? 'active' : ''}" data-amt="5000" type="button">5,000</button>
          <button class="quick-btn" data-amt="max" type="button">MAX</button>
        </div>
      </div>

      ${user.a9Available !== null && user.a9Available !== undefined && Number(user.a9Available) < 100 ? `
        <div class="sub-tile row-between" style="border-color:var(--gold-border);gap:8px;">
          <span class="num-xs text-sec">${L(`当前可用 A9 不足 100（还差 ${formatNum(Math.ceil(100 - Number(user.a9Available)))} A9）`, `Need ${formatNum(Math.ceil(100 - Number(user.a9Available)))} more A9 to reach 100 minimum`)}</span>
          <a class="btn btn-primary btn-sm" href="#/internal/market" style="white-space:nowrap;">${L('开箱补足', 'Get A9')} ›</a>
        </div>
      ` : ''}

      ${renderStakeSummaryCardHtml({ amountA9: amount, round, prefix: 'demo', minStakeA9: 100 })}

      <div class="risk-check" id="risk-consent-row" role="checkbox" aria-checked="false" tabindex="0">
        <span class="risk-box" id="risk-box-ic"></span>
        <span>${L('已知晓：永不爆仓，未达 8/12 时段头矿 6H 退 95%（止损 5%）/ 普通退 90%（止损 10%）；单轮封顶 5×。', 'I understand: No liquidation; < 8/12 slots refunds 95% (First 6H) / 90% (late); 5× round cap.')}</span>
      </div>

      ${store.fundsEnabled
        ? `<div id="stake-slider-mount"></div>
           <button class="accessible-confirm-link" id="btn-confirm-accessible" type="button"><span id="acc-confirm-lbl">${L(`无法滑动？点此无障碍确认锁仓 ${formatNum(amount)} A9`, `Can’t slide? Tap to confirm lock ${formatNum(amount)} A9`)}</span></button>`
        : `<button class="btn btn-secondary" id="btn-confirm-accessible" type="button">${icon('lock', 15)} <span id="acc-confirm-lbl">${L('真实模式只读 · 暂未开放锁仓', 'Read-Only Mode · Locking Disabled')}</span></button>`
      }
      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#/risk/audit">
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('v17.0 链上验真', 'v17.0 On-Chain Audit')}</span>
            <span class="sw-menu-sub">${L('查看合约地址、安全参数与 7 天 AbortRound 逃生舱', 'Inspect contracts, security specs & 7d AbortRound')}</span>
          </div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
      </div>
    </div>
  `;

  const input = root.querySelector('#stake-input');
  const summaryCard = root.querySelector('#demo-stake-summary-card');
  const sliderMount = root.querySelector('#stake-slider-mount');
  const accBtn = root.querySelector('#btn-confirm-accessible');
  const accLbl = root.querySelector('#acc-confirm-lbl');
  const riskRow = root.querySelector('#risk-consent-row');
  const riskBox = root.querySelector('#risk-box-ic');

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
    updateStakeSummaryCardDom(summaryCard, { amountA9: amount, round, minStakeA9: 100 });
    if (accLbl && store.fundsEnabled) accLbl.textContent = L(`无法滑动？点此无障碍确认锁仓 ${formatNum(amount)} A9`, `Can’t slide? Tap to confirm lock ${formatNum(amount)} A9`);
    const maxBal = user.a9Available !== null && user.a9Available !== undefined ? Math.floor(Number(user.a9Available) || 0) : 0;
    root.querySelectorAll('[data-amt]').forEach(b => {
      b.classList.toggle('active', b.dataset.amt === 'max' ? (maxBal > 0 && amount === maxBal) : Number(b.dataset.amt) === amount);
    });
    const sliderTxt = sliderMount?.querySelector('.slider-text');
    if (sliderTxt) {
      const next = L(`右滑确认锁仓 ${formatNum(amount)} A9`, `Slide to Lock ${formatNum(amount)} A9`);
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
      showToast(L('真实模式当前为只读验收阶段，暂未开放锁仓签名与资金转出', 'Live mode is read-only; locking and wallet signing are disabled'), 'amber');
      initSlider();
      return;
    }
    if (deriveRoundUiState({ detail: store.state.round, user, serverNowMs: serverNowMs() }).stage !== 'stake') {
      showToast(L('本轮锁仓已关闭', 'Locking is closed for this round'), 'amber');
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
    if (amount < 100) {
      showToast(L('最低锁仓 100 A9', 'Minimum 100 A9'), 'error');
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
      label: L(`右滑确认锁仓 ${formatNum(amount)} A9`, `Slide to Lock ${formatNum(amount)} A9`),
      onConfirm: handleConfirmSubmit
    });
  };

  if (accBtn) accBtn.onclick = handleConfirmSubmit;
  initSlider();
}

/**
 * Live 实盘 A9 Jetton 锁仓确认页（仅在 config.liveFundsEnabled === true 时激活）。
 * 严格按 v17.0 合约口径锁仓 A9 Jetton（附 0.30 GRAM Gas），绝不把 GRAM 当锁仓本金。
 */
function renderLiveStakeConfirm(root, navigate) {
  const round = store.state.round;
  const cfg = round.protocolConfig || {};
  const roundController = cfg.contracts?.roundController || null;
  const minStakeRaw = BigInt(String(cfg.minStakeRaw || '100000000000'));
  const minStakeA9 = Number(minStakeRaw / 1_000_000_000n) || 100;
  const protocolVer = cfg.stakeProtocolVersion || (cfg.protocolVersion === 'v17' ? 'v17' : config.stakeProtocolVersion || 'v17');
  const protocolBadge = protocolVer === 'v17' ? 'V17.0' : String(protocolVer || 'v17').toUpperCase();

  const amtParam = parseConfirmAmtParam();
  let portfolio = null;
  let loadError = null;
  let amountA9 = amtParam !== null ? Math.max(minStakeA9, amtParam) : minStakeA9;
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
    const isStakeOpen = deriveRoundUiState({ detail: round, user, serverNowMs: serverNowMs() }).stage === 'stake';
    const canSubmit = Boolean(
      user.connected && user.address && roundController && round.currentRound && isStakeOpen && !submitting && !txLocked,
    );

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:10px;">
            <span class="chip chip-gold">${L(`第 ${round.currentRound ?? '—'} 轮 · ${protocolBadge}`, `Round ${round.currentRound ?? '—'} · ${protocolBadge}`)}</span>
            <span class="num-xs text-sec">${L('可用 A9 余额', 'Available A9')}: ${balA9 === null ? L('未获取', 'Unavailable') : `${formatNum(balA9, 2)} A9`}</span>
          </div>
          <div class="input-box">
            <input id="live-stake-a9-input" type="number" min="${minStakeA9}" step="1" value="${amountA9}" aria-label="${L('锁仓 A9 数量', 'Lock A9 amount')}" />
            <span class="caps text-sec">A9</span>
          </div>
          <div class="grid-4" style="margin-top:8px;">
            <button class="quick-btn" data-live-amt="${minStakeA9}" type="button">${formatNum(minStakeA9)}</button>
            <button class="quick-btn" data-live-amt="1000" type="button">1,000</button>
            <button class="quick-btn" data-live-amt="5000" type="button">5,000</button>
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

        ${renderStakeSummaryCardHtml({ amountA9, round, prefix: 'live', minStakeA9, roundController })}

        ${!store.fundsEnabled ? `
          <div class="card" id="live-readonly-stake-notice" style="border-color:var(--gold-border);">
            <div class="row-start" style="font-weight:600;margin-bottom:4px;">${icon('shieldAlert', 15, 'text-gold')} ${L('真实只读模式 · 暂未开放锁仓签名', 'Live Read-Only · Locking Disabled')}</div>
            <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:8px;">${L('真实只读模式 · 暂不发起签名或扣款。你可以先参与 0 GRAM 12H 预言擂台。', 'Live read-only · no signature or transfer. Try the 0 GRAM 12H Prediction Arena meantime.')}</div>
            <a class="btn btn-secondary btn-sm" href="#/round" style="width:100%;">${icon('radar', 13)} ${L('先去 0 GRAM 12H 预言擂台参与本轮', 'Join 0 GRAM 12H Prediction Arena')} ›</a>
          </div>
        ` : ''}

        <div class="risk-check ${riskAgreed ? 'checked' : ''}" id="live-risk-row" role="checkbox" aria-checked="${riskAgreed}" tabindex="0">
          <span class="risk-box" id="live-risk-box">${riskAgreed ? icon('check', 12) : ''}</span>
          <span>${L('已知晓：锁仓附带 0.30 GRAM Gas；未达 8/12 时段永不爆仓 · 自动止损（头矿 6H 退 95% / 普通退 90%）。', 'I understand: +0.30 GRAM gas; < 8/12 uses No Liquidation · Auto Stop-Loss (95% First 6H / 90% late).')}</span>
        </div>

        ${!store.fundsEnabled
          ? `<button class="btn btn-secondary" id="btn-live-stake-readonly" type="button" disabled>${icon('lock', 15)} ${L('真实模式只读 · 暂未开放锁仓', 'Read-Only Mode · Locking Disabled')}</button>`
          : !user.connected
            ? `<button class="btn btn-primary" id="btn-live-connect" type="button">${icon('wallet', 15)} ${L('先连接非托管 TON 钱包', 'Connect TON Wallet First')}</button>`
            : `<button class="btn btn-primary" id="btn-live-stake-submit" type="button" ${!canSubmit ? 'disabled' : ''}>${icon(txLocked ? 'clock' : 'bolt', 16)} ${submitting ? L('等待钱包签名…', 'Awaiting Signature…') : txLocked ? L('锁仓确认中（防重锁）', 'Lock Confirming…') : L(`签名锁仓 ${formatNum(amountA9)} A9（+ 0.30 GRAM Gas）`, `Sign & Lock ${formatNum(amountA9)} A9 (+ 0.30 GRAM Gas)`)}</button>`}
        <button class="btn btn-secondary" data-nav="/round" type="button">${icon('arrowLeft', 15)} ${L('返回轮次详情', 'Back to Round')}</button>
      </div>
    `;

    const summaryCard = root.querySelector('#live-stake-summary-card');
    const inputEl = root.querySelector('#live-stake-a9-input');
    if (inputEl) {
      inputEl.oninput = (e) => {
        amountA9 = Math.max(0, Number(e.target.value) || 0);
        updateStakeSummaryCardDom(summaryCard, { amountA9, round, minStakeA9 });
        const btn = root.querySelector('#btn-live-stake-submit');
        if (btn && !submitting && !pendingTxManager.isLocked('stake')) {
          btn.innerHTML = `${icon('bolt', 16)} ${L(`签名锁仓 ${formatNum(amountA9)} A9（+ 0.30 GRAM Gas）`, `Sign & Lock ${formatNum(amountA9)} A9 (+ 0.30 GRAM Gas)`)}`;
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
        updateStakeSummaryCardDom(summaryCard, { amountA9, round, minStakeA9 });
        const btn = root.querySelector('#btn-live-stake-submit');
        if (btn && !submitting && !pendingTxManager.isLocked('stake')) {
          btn.innerHTML = `${icon('bolt', 16)} ${L(`签名锁仓 ${formatNum(amountA9)} A9（+ 0.30 GRAM Gas）`, `Sign & Lock ${formatNum(amountA9)} A9 (+ 0.30 GRAM Gas)`)}`;
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
          showToast(L('已有锁仓交易在链上确认中，请勿重复提交', 'Lock transaction already confirming'), 'amber');
          return;
        }
        A9Haptic.light();
        if (!riskAgreed) {
          showToast(L('请先勾选链上风险提示确认', 'Confirm on-chain risk notice first'), 'amber');
          return;
        }
        const rawAmt = parseA9InputToRaw(inputEl?.value ?? amountA9);
        if (!rawAmt || rawAmt < minStakeRaw) {
          showToast(L(`锁仓数量不得低于 ${formatNum(minStakeA9)} A9`, `Minimum lock is ${formatNum(minStakeA9)} A9`), 'error');
          return;
        }
        const nowSec = Math.floor(serverNowMs() / 1000);
        if (round.stakingEnabled === false || (Number(round.stakeCloseAt || 0) > 0 && nowSec >= Number(round.stakeCloseAt))) {
          showToast(L('本轮 24H 锁仓窗口已封盘，已拦截签名以防白耗 Gas', '24H Lock window closed; signature blocked to save gas'), 'amber');
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
          title: L('确认锁仓交易（签名前核验）', 'Confirm On-Chain Lock'),
          contractLabel: L('目标合约 RoundController', 'Target RoundController'),
          targetAddress: roundController,
          principalText: `${exactAmtText} A9`,
          gasText: `0.30 GRAM (${L('预附 · 钱包发起费另计', 'attached · wallet sending fee separate')})`,
          totalText: `${exactAmtText} A9 + 0.30 GRAM`,
          note: L(`第 ${round.currentRound} 轮 · 24H 锁仓期可提前解押（扣 15% 销毁）；12H 冲价未达 8/12 时段永不爆仓 · 自动止损（头矿 6H 退 95% / 普通退 90%）。`, `Round #${round.currentRound} · 24H Lock allows Early Exit (-15% Burn); < 8/12 in 12H Push uses No Liquidation · Auto Stop-Loss (95% First 6H / 90% late).`),
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
            L('锁仓交易已提交链上', 'Lock Transaction Broadcast'),
            L('请等待区块确认后在「我的 → 闯关凭证」核对 StakeTicket', 'Check your StakeTicket in Me after block confirmation'),
          );
          const pendingTx = pendingTxManager.start({
            kind: 'stake',
            title: `第 ${round.currentRound} 轮锁仓`,
            titleEn: `Round #${round.currentRound} Lock`,
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
                  detail: '锁仓凭证已更新到账，可在「我的奖励」核验。',
                  detailEn: 'StakeTicket updated on-chain; check Claim center.',
                };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('锁仓已上链确认！StakeTicket 凭证已更新', 'Lock confirmed on-chain! StakeTicket updated.'));
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
      const balA9 = portfolio?.balanceAvailable && portfolio?.a9BalanceRaw !== null ? rawToA9(portfolio.a9BalanceRaw) : null;
      if (amtParam !== null && balA9 !== null && Number.isFinite(balA9)) {
        const maxWhole = Math.floor(balA9);
        amountA9 = maxWhole >= minStakeA9 ? Math.min(amountA9, maxWhole) : minStakeA9;
      }
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
  const cert = config.isDemo && store.state.certificates.find(c => c.id === certId && c.demoEntryConfirmed === true);
  if (!cert) {
    root.innerHTML = `<div class="col-gap"><div class="card empty-state"><div class="num-sm text-sec">${L('找不到本次入场凭证', 'Entry ticket not found')}</div></div><button class="btn btn-secondary" data-nav="/proof">${L('返回凭证列表', 'Back to tickets')}</button></div>`;
    return;
  }
  const shareUrl = `${window.location.origin}${window.location.pathname}?startapp=proof_${cert.id.replace('A9-STAKE-', '')}`;
  const bars = [2, 1, 3, 1, 2, 2, 1, 3, 1, 2];
  const miniBarcode = `<span class="receipt-barcode" aria-hidden="true">${bars.map((w) => `<i style="width:${w}px;"></i>`).join('')}</span>`;
  const estRaw = estimateRewardA9(cert.stakeTon, store.state.round);
  const estReward = estRaw !== null && Number.isFinite(estRaw)
    ? Math.round(estRaw)
    : (Number(cert.estRewardA9) || Math.round((Number(cert.stakeTon) || 0) * 5));
  const isFirst6h = Boolean(store.state.round?.inFirst6h);
  const slTag = isFirst6h
    ? L('头矿 6H · 5% 止损', 'First 6H · 5% Stop-Loss')
    : L('普通窗口 · 10% 止损', 'Standard · 10% Stop-Loss');

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="cert-pass is-settled cert-detail-card success-cert-stage anim-cert-drop anim-card-thump" id="success-cert-card">
        <div class="cert-top-bar">
          <span class="row-start" style="gap:7px;">
            <span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="cert-serial">QUEST ENTRY · R${String(cert.round).padStart(2, '0')}</span>
          </span>
          <span class="cert-status-pill">${icon('shieldCheck', 11)} ${L('已盖章', 'SEALED')}</span>
        </div>

        <div class="cert-body" style="position:relative;">
          <span class="success-stamp-seal tone-green anim-seal-slam" id="success-stamp-seal" aria-hidden="true">
            <b>${L('已出征', 'SEALED')}</b>
            <span>ROUND ${cert.round}</span>
          </span>

          <div style="text-align:center;padding:4px 0 2px;">
            <div class="icon-badge neon" style="width:44px;height:44px;margin:0 auto 8px;border-radius:13px;">${icon('checkCircle', 22)}</div>
            <div style="font-size:17.5px;font-weight:900;color:var(--ink);">${L('入场成功 · 凭证已盖章出征', 'Quest Entry Sealed')}</div>
            <div class="num-lg text-green mono" style="margin:5px 0 4px;font-weight:900;">${formatNum(cert.stakeTon)} A9 · ${L('全员 1:1 · 封顶 5×', '1:1 Fair · 5× Cap')}</div>
            <div class="num-xs text-gold" style="margin-bottom:6px;font-weight:700;">${slTag}</div>
            <button type="button" class="cert-hash-copy-btn" id="copy-tx" style="margin:0 auto;">
              <span class="mono">#${escapeHtml(cert.id)}</span>
              ${icon('copy', 11)}
            </button>
          </div>

          <div class="cert-perf" aria-hidden="true"><span class="cert-perf-line"></span></div>

          <div class="cert-metrics-grid">
            <div class="cert-metric-tile is-green">
              <small>${L('预计奖励', 'Est. Reward')}</small>
              <strong class="text-green">+${formatNum(estReward)} <span class="cert-unit">A9</span></strong>
            </div>
            <div class="cert-metric-tile">
              <small>${L('达标门槛', 'Pass Goal')}</small>
              <strong>8 / 12</strong>
            </div>
            <div class="cert-metric-tile is-gold">
              <small>${L('单轮封顶', 'Round Cap')}</small>
              <strong class="text-gold">5×</strong>
            </div>
          </div>
        </div>

        <div class="cert-foot">
          <span class="num-xs text-muted">${config.isDemo ? L('演示模式 · 模拟凭证', 'DEMO · simulated pass') : L('链上确认后可公开核验', 'On-chain verifiable')}</span>
          ${miniBarcode}
        </div>
      </div>

      <section class="card row-start" style="gap:12px;">
        <span class="nt-art-badge tone-green" aria-hidden="true">${icon('radar', 24)}</span>
        <div style="min-width:0;">
          <strong style="display:block;font-size:14px;font-weight:900;color:var(--ink);">${L('下一步：盯紧 12H 冲价进度', 'Next: Track the 12H Push Board')}</strong>
          <p class="num-xs text-sec" style="margin:3px 0 0;line-height:1.45;">${L('任意至少 8 个时段 1H 判定均价达标即通关；随时可在「我的 → 闯关凭证」核验与领取。', 'Any 8+ qualifying 1H slots pass the round; check your pass anytime in Me → Passes.')}</p>
        </div>
      </section>

      <button class="btn btn-nt-green" id="share-cert-btn">${icon('send', 15)} ${L('分享战绩邀请好友', 'Share Pass & Invite')}</button>
      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#${cert?.id ? `/proof/${escapeHtml(cert.id)}` : '/proof'}">
          <div class="sw-menu-left"><span class="sw-menu-title">${L('查看闯关凭证', 'View Quest Pass')}</span></div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <a class="sw-menu-row" href="#/round">
          <div class="sw-menu-left"><span class="sw-menu-title">${L('返回闯关', 'Back to Quest')}</span></div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
      </div>
    </div>
  `;

  const sealEl = root.querySelector('#success-stamp-seal');
  if (!isReducedMotion()) {
    setTimeout(() => {
      if (!root.isConnected || isReducedMotion()) return;
      A9Audio.sealSlam();
      A9Haptic.heavy();
      if (sealEl) burstParticles(sealEl);
    }, 280);
  }

  root.querySelector('#copy-tx').onclick = () => copyText(cert.txHash, L('已复制哈希', 'Copied Hash'));
  root.querySelector('#share-cert-btn').onclick = () => {
    A9TMA.shareInvite(shareUrl, `A9 #${cert.id}`);
    showToast(L('已生成分享链接', 'Share link ready'));
  };
}
