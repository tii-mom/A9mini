import { fetchUserPortfolio, fetchProgressionUser, claimProgressionTask, getEffectiveUserId, rawToA9, PROTOCOL_SPECS, serverNowMs } from '../data.js';

import { L } from '../i18n.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { icon } from '../icons.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast } from '../components.js';
import { burstParticles } from '../components-heavy.js';

import { tonConnect, canonicalWalletKey } from '../tonconnect.js';
import { renderNintendoGateIcon } from '../paper-art.js';
import { deriveRoundUiState } from '../round-state.js';

const link = (path, label, glyph) =>
  `<a href="#${path}">${icon(glyph, 16)}${label}</a>`;
const waiting = () => L('待核验', 'Awaiting verification');

export function stageLabel(stageOrRound) {
  const detail = stageOrRound && typeof stageOrRound === 'object'
    ? stageOrRound
    : { stage: stageOrRound };
  const refNowMs = detail?.rawState
    ? serverNowMs()
    : (Number(detail?.stakeOpenAt) > 0 && Number(detail?.stakeCloseAt) > Number(detail?.stakeOpenAt)
      ? Number(detail.stakeOpenAt) * 1000 + 1000
      : serverNowMs());
  const ui = deriveRoundUiState({ detail, user: store.state.user, serverNowMs: refNowMs });
  return ui.stage === 'unknown' ? waiting() : ui.badgeLabel;
}

function toFiniteNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function priceOrDash(v) {
  const n = toFiniteNum(v);
  return n === null || n <= 0 ? '—' : `$${n.toFixed(4)}`;
}

function handbookLevelTitle(lv) {
  const n = Math.max(1, Number(lv) || 1);
  const titles = [
    ['新手玩家', 'Quest Rookie'],
    ['集章学徒', 'Stamp Apprentice'],
    ['印章记录员', 'Stamp Keeper'],
    ['沙盘绘制师', 'Sandtable Crafter'],
    ['金箔典藏家', 'Foil Collector'],
  ];
  return L(...titles[Math.min(titles.length - 1, n - 1)]);
}

/**
 * 阶段三：广场每日集章卡（Daily Stamp Card）
 * - 每日 4 枚通关印章（打卡 / 0 GRAM 预言 / 12H 巡视 / 战报分享）+ 满章加赠 + 成长等级与成就徽章
 * - 显式标明：非链上代币资产，不可交易或直接兑换 A9 / GRAM
 */
export function renderHandbookStampCard() {
  const prog = store.state.progression || {};
  const r = store.state.round;
  const pred = store.state.prediction;
  const hasTgAuth = config.isDemo || Boolean(A9TMA.getRawInitData());

  if (!config.isDemo && !hasTgAuth) {
    return `
      <section class="card handbook-stamp-card" id="a9-handbook-card">
        <div class="row-between">
          <div class="card-title">${icon('checkCircle', 15, 'text-green')} ${L('广场每日印章', 'Plaza Daily Stamps')}</div>
          <span class="chip chip-muted">${L('游戏成长数据', 'In-Game EXP')}</span>
        </div>
        <p class="num-xs text-sec" style="margin:8px 0 0;line-height:1.5;">${L('请在 Telegram 小程序内打开以同步你的每日集章进度、连续打卡天数与成长等级（非代币资产，不可兑换 A9/GRAM）。', 'Open inside Telegram Mini App to sync your daily stamps, streak and handbook level (non-financial growth data).')}</p>
      </section>
    `;
  }

  if (!config.isDemo && prog.error) {
    return `
      <section class="card handbook-stamp-card" id="a9-handbook-card">
        <div class="row-between">
          <div class="card-title">${icon('shieldAlert', 15, 'text-red')} ${L('广场每日印章', 'Plaza Daily Stamps')}</div>
          <button class="btn btn-secondary btn-sm" id="btn-prog-retry" type="button">${L('重试读取', 'Retry')}</button>
        </div>
        <p class="num-xs text-muted" style="margin:6px 0 0;">${L('每日集章数据暂不可读取，请点击重试。', 'Handbook progression unavailable. Tap to retry.')}</p>
      </section>
    `;
  }

  const todaySet = new Set(Array.isArray(prog.todayClaims) ? prog.todayClaims : []);
  const achClaimed = new Set(Array.isArray(prog.achievementsClaimed) ? prog.achievementsClaimed : []);
  const unlockableAch = Array.isArray(prog.unlockableAchievements) ? prog.unlockableAchievements : [];
  const hasPredBet = Boolean(pred?.currentBet);

  const dailyTasks = [
    {
      key: 'daily_checkin',
      zh: '广场打卡',
      en: 'Check-in',
      exp: 30,
      done: todaySet.has('daily_checkin'),
      actionZh: '盖打卡章',
      actionEn: 'Stamp',
    },
    {
      key: 'daily_prediction',
      zh: '达标竞猜',
      en: '12H Guess',
      exp: 50,
      done: todaySet.has('daily_prediction'),
      actionZh: hasPredBet ? '盖竞猜章' : '先去竞猜',
      actionEn: hasPredBet ? 'Stamp' : 'Go Guess',
    },
    {
      key: 'daily_observe',
      zh: '12H 巡视',
      en: '12H Inspect',
      exp: 30,
      done: todaySet.has('daily_observe'),
      actionZh: '盖巡视章',
      actionEn: 'Stamp',
    },
    {
      key: 'daily_share',
      zh: '卡片分享',
      en: 'Share Card',
      exp: 40,
      done: todaySet.has('daily_share'),
      actionZh: '盖分享章',
      actionEn: 'Stamp',
    },
  ];

  const achLabels = {
    ach_first_stamp: [L('初枚印章', 'First Stamp'), 50],
    ach_streak_3:    [L('三日连签', '3d Streak'), 120],
    ach_pred_pioneer:[L('竞猜观星', 'Predictor'), 100],
    ach_stamp_10:    [L('十章典藏', '10 Stamps'), 200],
  };

  const fullBonusReady = prog.allDailyStampsDone && !prog.dailyFullBonusClaimed;
  const nextAchKey = unlockableAch[0] || null;

  return `
    <section class="card handbook-stamp-card" id="a9-handbook-card" data-round="${r.currentRound ?? 1}">
      <div class="row-between" style="margin-bottom:6px;">
        <div class="row-start" style="gap:6px;flex-wrap:wrap;">
          <strong class="card-title">${L('广场每日印章', 'Plaza Daily Stamps')}</strong>
          <span class="chip chip-gold">Lv.${prog.level || 1} · ${handbookLevelTitle(prog.level)}</span>
        </div>
        <span class="chip chip-muted mono">${L('连签', 'Streak')} ${prog.checkinStreak || 0}${L('天', 'd')} · ${prog.dailyDoneCount || 0}/4</span>
      </div>

      <div class="row-between num-xs text-muted" style="margin-bottom:4px;">
        <span>${L('集章经验', 'Stamp EXP')} <b class="mono" style="color:var(--ink);">${prog.exp || 0} EXP</b>（${prog.currentLevelExp || 0}/${prog.expPerLevel || 200}）</span>
        <span>${L('游戏内成长 · 非代币资产', 'In-game growth · non-token')}</span>
      </div>
      <div class="progress-track" style="height:6px;margin-bottom:10px;">
        <div class="progress-fill" style="width:${prog.progressPct || 0}%"></div>
      </div>

      <div class="handbook-stamp-grid" role="group" aria-label="${L('每日集章任务', 'Daily stamp missions')}">
        ${dailyTasks.map((t) => `
          <button type="button" class="handbook-stamp-cell ${t.done ? 'stamped' : ''}"
            data-stamp-task="${t.key}"
            aria-pressed="${t.done}">
            <span class="handbook-seal" aria-hidden="true">${t.done ? '✓' : '+'}</span>
            <strong class="handbook-task-name">${L(t.zh, t.en)}</strong>
            <small class="handbook-task-meta">${t.done ? L('已盖章', 'Stamped') : `+${t.exp} EXP`}</small>
          </button>
        `).join('')}
      </div>

      ${fullBonusReady ? `
        <button type="button" class="btn btn-primary btn-sm" data-stamp-task="daily_full_bonus" style="width:100%;margin-top:10px;min-height:38px;">
          ${icon('checkCircle', 14)} ${L('今日 4 章集齐 · 领取满章加赠 (+80 EXP)', 'All 4 Stamps Done · Claim +80 EXP Bonus')}
        </button>
      ` : nextAchKey && achLabels[nextAchKey] ? `
        <button type="button" class="btn btn-secondary btn-sm" data-stamp-task="${nextAchKey}" style="width:100%;margin-top:10px;min-height:38px;border-color:var(--nt-gold-edge);background:var(--nt-gold-soft);">
          ${icon('trophy', 14, 'text-gold')} ${L(`解锁成就印章「${achLabels[nextAchKey][0]}」(+${achLabels[nextAchKey][1]} EXP)`, `Claim Achievement "${achLabels[nextAchKey][0]}" (+${achLabels[nextAchKey][1]} EXP)`)}
        </button>
      ` : ''}

      <div class="handbook-ach-row" aria-label="${L('成就印章图鉴', 'Achievement stamps')}">
        ${Object.entries(achLabels).map(([key, [label]]) => {
          const owned = achClaimed.has(key);
          return `<span class="handbook-ach-pill ${owned ? 'owned' : ''}">${owned ? '✓ ' : ''}${label}</span>`;
        }).join('')}
      </div>
    </section>
  `;
}

/**
 * 极简钱包信息栏：仅展示钱包地址与 GRAM 余额
 */
export function identityStage({ modePill = '', walletAddr, gramText }) {
  return `<section class="card row-between"><div><div class="card-title">${L('我的钱包', 'My Wallet')}</div>
    <span class="mono">${escapeHtml(walletAddr)}</span><div class="mono">${escapeHtml(gramText)}</div></div>${modePill}</section>`;
}

function repaintHandbookCard(root, navigate) {
  const cardEl = root.querySelector('#a9-handbook-card');
  if (!cardEl) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = renderHandbookStampCard().trim();
  const nextEl = wrap.firstElementChild;
  if (nextEl) {
    cardEl.replaceWith(nextEl);
    bindHandbookStampEvents(root, navigate);
  }
}

export async function syncProgressionState(root, navigate) {
  const { round, user } = store.state;
  const uid = getEffectiveUserId(user);
  const roundId = round.currentRound || 1;
  try {
    const data = await fetchProgressionUser(uid, roundId);
    if (!data) return;
    store.update((s) => {
      Object.assign(s.progression, data, { loaded: true, error: false });
    });
    if (root && root.isConnected) repaintHandbookCard(root, navigate);
  } catch {
    store.update((s) => {
      s.progression.error = true;
    });
    if (root && root.isConnected) repaintHandbookCard(root, navigate);
  }
}

function bindHandbookStampEvents(root, navigate) {
  const card = root.querySelector('#a9-handbook-card');
  if (!card) return;
  const retryBtn = card.querySelector('#btn-prog-retry');
  if (retryBtn) {
    retryBtn.onclick = () => {
      A9Haptic.light();
      syncProgressionState(root, navigate);
    };
  }

  card.querySelectorAll('[data-stamp-task]').forEach((btn) => {
    btn.onclick = async () => {
      const taskKey = btn.dataset.stampTask;
      if (!taskKey) return;
      const todaySet = new Set(store.state.progression?.todayClaims || []);
      const achSet = new Set(store.state.progression?.achievementsClaimed || []);
      if (todaySet.has(taskKey) || achSet.has(taskKey)) {
        A9Haptic.light();
        showToast(L('该印章已盖章领取', 'Stamp already claimed'));
        return;
      }

      if (taskKey === 'daily_prediction' && !store.state.prediction?.currentBet) {
        A9Haptic.light();
        A9Audio.tick();
        store.state.referral.pendingScrollTarget = 'prediction';
        showToast(L('请先完成本轮 0 GRAM 12H 预言擂台后盖章', 'Complete your 0 GRAM 12H prediction first'));
        if (navigate) navigate('/round');
        else window.location.hash = '#/round';
        return;
      }

      const uid = getEffectiveUserId(store.state.user);
      const roundId = store.state.round.currentRound || 1;
      btn.disabled = true;
      try {
        const res = await claimProgressionTask({ userId: uid, taskKey, roundId });
        A9Haptic.success();
        A9Audio.stamp();
        burstParticles(btn);
        if (res?.progression) {
          store.update((s) => {
            Object.assign(s.progression, res.progression, { loaded: true, error: false });
          });
        }
        showToast(L(`已盖章 · +${res?.expAwarded || 0} EXP（集章成长数据）`, `Stamped · +${res?.expAwarded || 0} EXP`));
        if (root.isConnected) {
          repaintHandbookCard(root, navigate);
          const stampedBtn = root.querySelector(`[data-stamp-task="${taskKey}"]`);
          if (stampedBtn) {
            stampedBtn.classList.add('anim-slot-confirmed');
            setTimeout(() => stampedBtn.classList.remove('anim-slot-confirmed'), 260);
          }
        }
      } catch (e) {
        A9Haptic.error();
        showToast(e?.message || L('盖章失败，请重试', 'Stamp failed, please retry'), 'amber');
        btn.disabled = false;
      }
    };
  });
}

/** 弹出 v17.0 合约防 Rug 链上验真卡（展示实时奖池余量、admin_address = addr_none、7天 AbortRound 逃生舱、code_hash 与 Tonviewer 查验） */
function demoProgressionInitSnapshot(uid, roundId) {
  return {
    exp: 160,
    level: 1,
    expPerLevel: 200,
    currentLevelExp: 160,
    nextLevelExp: 200,
    progressPct: 80,
    checkinStreak: 2,
    totalStamps: 5,
    dailyDoneCount: 1,
    dailyTotalCount: 4,
    allDailyStampsDone: false,
    dailyFullBonusClaimed: false,
    todayClaims: ['daily_observe'],
    achievementsClaimed: ['ach_first_stamp'],
    unlockableAchievements: []
  };
}

// 历史 gallery 已迁出至 js/pages/_retired/gallery.js；#/gallery 与 #/gallery/:id 由 ROUTE_ALIASES 统一收敛至 #/profile。

let rewardsRenderSeq = 0;

function fmtRewardsA9(val, loading = false) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return loading ? '…' : '—';
  const n = Number(val);
  return `${formatNum(n, n % 1 === 0 ? 0 : 2)} A9`;
}

/**
 * 奖金解锁详情页（#/rewards）：
 * v17.0 极简 14 天逐秒解锁机制（通关退 100% 本金 + 秒提 20% 奖金，余下 80% 分 14 天每日 +5.71% 逐秒解锁，支持随时 3 折急提，永久累计不倒扣）
 */
export function rewards(root) {
  const n = store.state.round.successCount;

  const renderSwitchRewards = ({ claimableA9 = null, lockedA9 = null, tickets = [], loading = false, error = false, hasWallet = true, isLive = false } = {}) => {
    const dailyRateA9 = lockedA9 !== null && lockedA9 !== undefined && Number.isFinite(Number(lockedA9))
      ? Math.round(Number(lockedA9) * (PROTOCOL_SPECS.dailyUnlockPct / 80))
      : null;
    const lockedTickets = tickets.filter((t) => Number(rawToA9(t?.lockedRemainingRaw) || 0) > 0);

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero col-gap">
          <div class="row-between">
            <div>
              <div class="num-xs text-muted">${L('14 天逐秒待解锁总额', '14D Per-Second Unlock Remaining')}</div>
              <div class="sw-asset-main" style="margin-top:4px;">${lockedA9 === null || lockedA9 === undefined ? (loading ? '…' : '—') : `${formatNum(Number(lockedA9), Number(lockedA9) % 1 === 0 ? 0 : 2)} <span class="sw-asset-main-unit">A9</span>`}</div>
            </div>
            <span class="nt-art-badge tone-blue" aria-hidden="true">${renderNintendoGateIcon('vault', 34)}</span>
          </div>
          <div class="sw-status-steps">
            <div class="sw-status-step is-done">
              <small>${L('通关即领', 'Day 0')}</small>
              <strong>20%</strong>
            </div>
            <div class="sw-status-step is-active">
              <small>${L('14 天逐秒解锁', '14D Unlock')}</small>
              <strong>+5.71%/${L('天', 'd')}</strong>
            </div>
            <div class="sw-status-step">
              <small>${L('3 折急提', 'Instant')}</small>
              <strong>${L('30% 实拿', '30% Now')}</strong>
            </div>
          </div>
          <div class="num-xs text-sec" style="line-height:1.5;">
            ${L('通关秒提 20% + 100% 本金，余下 80% 按 14 天逐秒解锁（永久累计不倒扣）；如需提前变现，仅未解锁部分按 30% 实发、70% 永久销毁。', '20% instant + 100% principal on win; remaining 80% unlocks per second over 14 days (never forfeited). Instant Cashout pays 30% of unvested rewards now and burns 70%.')} · ${L('全网通关', 'Wins')}: <b class="mono">${n ?? waiting()}</b>
          </div>
        </section>

        <div>
          <div class="sw-section-label">${L('解锁明细', 'Unlock Breakdown')}</div>
          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/claim">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('已解锁待领取', 'Unlocked & Claimable')}</span>
                <span class="sw-menu-sub">${L('前往领奖中心发起领取（0.22 GRAM Gas）', 'Go to Claims (0.22 GRAM gas)')}</span>
              </div>
              <div class="sw-menu-right">
                <span class="sw-menu-amount ${Number(claimableA9) > 0 ? 'is-green' : (claimableA9 == null ? 'is-muted' : '')}">${fmtRewardsA9(claimableA9, loading)}</span>
                <span class="sw-menu-arrow" aria-hidden="true">›</span>
              </div>
            </a>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('每日解锁节奏（5.71%/天）', 'Daily Unlock Pace (5.71%/day)')}</span>
                <span class="sw-menu-sub">${L('按秒连续释放，随时可领', 'Continuous per-second release')}</span>
              </div>
              <div class="sw-menu-right">
                <span class="sw-menu-amount ${dailyRateA9 == null ? 'is-muted' : ''}">${fmtRewardsA9(dailyRateA9, loading)}</span>
              </div>
            </div>
            ${error ? `
              <div class="sw-menu-error" role="alert">
                <span>${L('读取失败', 'Read failed')}</span>
                <button type="button" class="sw-retry-link" id="btn-rewards-retry">${L('重试', 'Retry')}</button>
              </div>
            ` : ''}
          </div>
        </div>

        ${isLive && !hasWallet ? `
          <div class="sw-menu-group">
            <button type="button" class="sw-menu-row" id="btn-rewards-connect">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('连接钱包查看各凭证解锁进度', 'Connect Wallet for Per-Pass Unlock')}</span>
                <span class="sw-menu-sub">${L('读取链上 StakeTicket 实时待解锁余额', 'Read on-chain StakeTicket locked balances')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </button>
          </div>
        ` : ''}

        ${isLive && hasWallet && !loading && !error ? `
          <div>
            <div class="sw-section-label">${L('各凭证待解锁余额', 'Per-Pass Locked Balances')}</div>
            <div class="sw-menu-group">
              ${lockedTickets.length === 0
                ? `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('当前无待解锁凭证余额', 'No locked rewards on passes')}</span></div></div>`
                : lockedTickets.map((t) => {
                    const remA9 = rawToA9(t.lockedRemainingRaw);
                    const cashA9 = rawToA9(t.instantCashoutTotalRaw);
                    const burnA9 = rawToA9(t.instantCashoutBurnRaw);
                    const pctText = (t.unlockedPctBps !== null && t.unlockedPctBps !== undefined && Number.isFinite(Number(t.unlockedPctBps)))
                      ? `${(Number(t.unlockedPctBps) / 100).toFixed(1)}%`
                      : null;
                    const href = t.ticketAddress ? `#/claim?ticket=${encodeURIComponent(t.ticketAddress)}` : '#/claim';
                    return `
                      <a class="sw-menu-row" href="${href}">
                        <div class="sw-menu-left">
                          <span class="sw-menu-title">${L(`第 ${escapeHtml(String(t.roundId ?? '—'))} 轮凭证`, `Round #${escapeHtml(String(t.roundId ?? '—'))} Pass`)}${pctText ? ` · ${L('已解锁', 'Unlocked')} ${pctText}` : ''}</span>
                          <span class="sw-menu-sub">${cashA9 != null && burnA9 != null ? L(`3 折急提实拿 ${formatNum(cashA9, 2)} A9 / 销毁 ${formatNum(burnA9, 2)} A9`, `Instant Cashout ${formatNum(cashA9, 2)} A9 / Burn ${formatNum(burnA9, 2)} A9`) : L('点击前往领奖或查看 3 折急提', 'Tap to claim or view Instant Cashout')}</span>
                        </div>
                        <div class="sw-menu-right">
                          <span class="sw-menu-amount is-amber">${fmtRewardsA9(remA9)}</span>
                          <span class="sw-menu-arrow" aria-hidden="true">›</span>
                        </div>
                      </a>
                    `;
                  }).join('')}
            </div>
          </div>
        ` : ''}

        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/claim">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('前往领奖中心', 'Go to Claims')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/profile">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回我的', 'Back to Me')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;

    const connBtn = root.querySelector('#btn-rewards-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => rewards(root));
    const retryBtn = root.querySelector('#btn-rewards-retry');
    if (retryBtn) retryBtn.onclick = () => rewards(root);
  };

  if (!config.isDemo) {
    const seq = ++rewardsRenderSeq;
    const addr = store.state.user.address || null;
    if (!addr) {
      renderSwitchRewards({ hasWallet: false, isLive: true });
      return;
    }
    renderSwitchRewards({ loading: true, hasWallet: true, isLive: true });
    fetchUserPortfolio(addr)
      .then((data) => {
        if (seq !== rewardsRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        const claimableA9 = data?.claimableRaw !== null && data?.claimableRaw !== undefined ? rawToA9(data.claimableRaw) : null;
        const lockedA9 = data?.lockedRaw !== null && data?.lockedRaw !== undefined ? rawToA9(data.lockedRaw) : null;
        renderSwitchRewards({
          claimableA9,
          lockedA9,
          tickets: Array.isArray(data?.tickets) ? data.tickets : [],
          loading: false,
          error: data?.ticketsAvailable === false,
          hasWallet: true,
          isLive: true,
        });
      })
      .catch(() => {
        if (seq !== rewardsRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        renderSwitchRewards({ loading: false, error: true, hasWallet: true, isLive: true });
      });
    return;
  }

  const u = store.state.user;
  const lockedNum = Number.isFinite(Number(u.a9Locked)) ? Number(u.a9Locked) : null;
  renderSwitchRewards({
    claimableA9: Number.isFinite(Number(u.a9Claimable)) ? Number(u.a9Claimable) : null,
    lockedA9: lockedNum,
    loading: false,
    error: false,
    hasWallet: true,
    isLive: false,
  });
}

export function tower(round) {
  const totalSlots = Number(round.candleCount) || 12;
  const required = Number(round.minQualifiedCandles) || 8;
  const labels = {
    unknown: L('待核验', 'Pending'),
    pending: L('未开始', 'Upcoming'),
    active: L('冲价中', 'Pushing'),
    pass: L('达标', 'Met'),
    miss: L('未达标', 'Missed'),
  };
  const symbols = { unknown: '?', pending: '·', active: '◉', pass: '✓', miss: '×' };
  const confirmedCount = Array.isArray(round.candles)
    ? round.candles.filter((c) => c.confirmed || c.status === 'closed').length
    : (round.candlesSeen ?? 0);
  return `<section class="wv-tower">
    <div class="row-between" style="margin-bottom:6px;">
      <div>
        <small>12H / PUSH BOARD</small>
        <h2 style="margin:2px 0 0;">${L('12H 冲价集章板', '12H Push Board')}</h2>
      </div>
      <span class="chip chip-muted mono">${L('已确认', 'Confirmed')} ${confirmedCount}/${totalSlots}</span>
    </div>
    <div class="wv-windows">${Array.from(
      { length: totalSlots },
      (_, i) => {
        const c = round.candles?.[i];
        const state = c?.confirmed
          ? (c.bull ? 'pass' : 'miss')
          : labels[c?.status]
            ? c.status
            : 'unknown';
        return `<span data-state="${state}"><i>${symbols[state]}</i><b>${String(i + 1).padStart(2, '0')}</b></span>`;
      },
    ).join('')}</div>
    <p>${L('已达标', 'Qualified')} <b class="mono">${round.qualifiedCandles ?? '—'} / ${required}</b> · ${round.qualifiedCandles >= required && deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() }).stage === 'charge' ? L('等待结算', 'Awaiting settlement') : L(`达标门槛 ${required} 段`, `${required} slots to pass`)}</p>
  </section>`;
}

function exactA9(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const digits = raw.padStart(10, '0');
  const fraction = digits.slice(-9).replace(/0+$/, '');
  return (
    BigInt(digits.slice(0, -9)).toLocaleString('en-US') +
    (fraction ? '.' + fraction : '') +
    ' A9'
  );
}

export function portfolioPanel(root, guild = false, onPortfolio) {
  const { user } = store.state;
  const panel = document.createElement('section');
  panel.className = guild ? 'card col-gap' : 'card card-hero col-gap';
  if (guild) root.prepend(panel);
  else root.append(panel);
  const links = guild
    ? [
        ['/team/profile', '战队名片', 'Squad Card'],
        ['/team/bind-tg', '绑定 TG 群', 'Link TG Group'],
        ['/team/invite', '邀友赢奖', 'Invite & Earn'],
        ['/leaderboard', '财富榜', 'Rich List'],
      ]
    : [
        ['/rewards', '我的奖励', 'My Rewards'],
        ['/records?type=ledger', '记录', 'Records'],
        ['/proof', '闯关凭证', 'Quest Pass'],
        ['/settings', '设置', 'Settings'],
      ];
  function show(data, state, isError = false) {
    onPortfolio?.(data);
    panel.replaceChildren();
    const row = (label, value) => {
      const el = document.createElement('div');
      el.className = 'list-row';
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('b');
      amount.className = 'mono';
      amount.textContent = value;
      el.append(name, amount);
      panel.append(el);
    };
    if (guild) {
      row(L('战队', 'Squad'), data?.team?.name || waiting());
      row(L('成员', 'Members'), data?.team?.memberCount ?? waiting());
      row(
        L('职位', 'Role'),
        data?.team?.role === 'captain' || (Boolean(user.address) && Boolean(data?.team?.captainWallet) && canonicalWalletKey(data.team.captainWallet) === canonicalWalletKey(user.address))
          ? L('队长', 'Captain')
          : data?.team
            ? L('成员', 'Member')
            : waiting(),
      );
    } else {
      const balance =
        data?.balanceAvailable !== false &&
        data?.jettonWallet &&
        typeof data.a9BalanceRaw === 'string' &&
        /^\d+$/.test(data.a9BalanceRaw)
          ? exactA9(data.a9BalanceRaw)
          : null;
      row(L('可用 A9', 'Available A9'), balance ?? waiting());
      const active = (data?.tickets || []).filter(
        (t) => !t.principalDone && /^\d+$/.test(t.amountRaw),
      );
      for (const ticket of active)
        row(
          L('凭证本金 · 第', 'Ticket principal · R') + ticket.roundId + L(' 轮', ''),
          exactA9(ticket.amountRaw),
        );
      if (!active.length) row(L('锁仓中 A9', 'Locked A9'), waiting());
      for (const labels of [
        ['已解锁待领取', 'Unlocked, unclaimed'],
        ['14 天逐秒待解锁', '14D Per-Second Unlock'],
      ])
        row(L(...labels), waiting());
    }
    const status = document.createElement('p');
    status.className = `num-xs ${isError ? 'text-red' : 'text-muted'}`;
    status.style.margin = '2px 0';
    status.textContent = state;
    panel.append(status);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = user.address
      ? (isError ? L('重试读取', 'Retry') : L('重新读取', 'Read again'))
      : L('连接钱包', 'Connect wallet');
    btn.onclick = () =>
      user.address
        ? refresh()
        : document.getElementById('btn-wallet-pill')?.click();
    panel.append(btn);
    const nav = document.createElement('nav');
    nav.className = 'wv-links';
    nav.innerHTML = links
      .map(([path, zh, en]) => link(path, L(zh, en), 'chevronRight'))
      .join('');
    panel.append(nav);
  }
  async function refresh() {
    const addr = user.address;
    show(
      null,
      addr
        ? L('正在读取钱包数据…', 'Reading wallet…')
        : L('未连接钱包 · 连接后可核验链上余额与凭证', 'Connect a wallet to verify balances and tickets'),
    );
    if (!addr) return;
    try {
      const data = await fetchUserPortfolio(addr);
      if (
        panel.isConnected &&
        store.state.user.address === addr &&
        data.walletAddress === addr
      )
        show(data, L('来源 · 钱包只读接口（真实只读）', 'Source · read-only wallet API'));
    } catch {
      if (panel.isConnected && store.state.user.address === addr)
        show(null, L('读取失败 · 请检查网络后重试', 'Read failed · check network and retry'), true);
    }
  }
  refresh();
}

export function liveRound(r) {
  const time = (value) => {
    if (!Number.isFinite(value) || value <= 0) return waiting();
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime())
      ? waiting()
      : date.toLocaleString(L('zh-CN', 'en-US'), { timeZone: 'UTC' }) + ' UTC';
  };
  const refNowMs = r.rawState
    ? serverNowMs()
    : (Number(r.stakeOpenAt) > 0 && Number(r.stakeCloseAt) > Number(r.stakeOpenAt)
      ? Number(r.stakeOpenAt) * 1000 + 1000
      : serverNowMs());
  const uiState = deriveRoundUiState({ detail: r, user: store.state.user, serverNowMs: refNowMs });
  const canLiveStake = !config.isDemo && store.fundsEnabled && uiState.stage === 'stake';
  const hasPool = r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9));
  const chipCls = uiState.stage === 'passed' ? 'chip-green' : uiState.stage === 'failed' ? 'chip-red' : 'chip-gold';
  return `<section class="card card-hero">
    <div class="row-between" style="margin-bottom:8px;">
      <span class="chip ${chipCls} mono">${L('第', 'R')} ${r.currentRound ?? '—'} ${L('轮', '')} · ${uiState.stage === 'unknown' ? waiting() : uiState.badgeLabel}</span>
      <span class="num-xs text-muted mono">v17.0 · 5× ${L('封顶', 'Cap')}</span>
    </div>
    <div class="num-xs text-muted">${L('涨价解锁 · 本轮奖池', 'Price-Unlock Round Pool')}</div>
    <div class="num-hero" style="margin-top:3px;">${hasPool ? `${formatNum(r.rewardBudgetA9)} <span class="num-md text-green">A9</span>` : waiting()}</div>
    <div class="metric-strip cols-3">
      <div class="metric-cell"><span class="num-xs text-muted">${L('目标底价', 'Target')}</span><span class="num-sm mono">${priceOrDash(r.targetPrice)}</span></div>
      <div class="metric-cell"><span class="num-xs text-muted">${L('1H 均价', '1H TWAP')}</span><span class="num-sm mono text-green">${priceOrDash(r.twap24h ?? r.livePrice)}</span></div>
      <div class="metric-cell"><span class="num-xs text-muted">${L('自动止损', 'Auto Stop-Loss')}</span><span class="num-sm mono">5% / 10%</span></div>
    </div>
    <div class="num-xs text-sec" style="margin-bottom:10px;">${L('24H 锁仓窗口', '24H Lock Window')}: ${time(r.stakeOpenAt)} — ${time(r.stakeCloseAt)} · ${L('永不爆仓 · 未达 8/12 退 95%/90%', 'No Liquidation · < 8/12 refunds 95%/90%')}</div>
    ${canLiveStake
      ? `<a class="btn btn-primary" href="#/challenge/confirm">${icon('bolt', 15)} ${L('100 A9 起锁仓参与本轮', 'Lock from 100 A9 in Round')}</a>`
      : `<button class="btn btn-secondary" disabled>${store.fundsEnabled ? L('当前非锁仓窗口', 'Lock window closed') : L('真实只读 · 暂未开放锁仓', 'Live read-only · locking disabled')}</button>`}
  </section>
  ${tower(r)}<nav class="wv-links">${link('/observation/records', L('12H 冲价明细', '12H Slots'), 'clock')}${link('/rewards', L('14天解锁', '14D Unlock'), 'unlock')}${link('/warmup', L('预热', 'Warm-up'), 'bolt')}${link('/rules', L('规则', 'Rules'), 'book')}</nav>`;
}
