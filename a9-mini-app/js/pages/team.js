import { portfolioPanel } from './wealthverse.js';
/**
 * Team & Referral Pages — 99-Point Pure Hero First (Zero Top Debug Tabs, Custom Action Sheet, SVG Progress Ring)
 */

import { store } from '../store.js';
import { config } from '../config.js';
import {
  joinTeam,
  bindTeamGroupTg,
  verifyTeamGroupTg,
  getEffectiveUserId,
  fetchPromoBalance,
  fetchPromoClaim,
  requestPromoClaimIntent,
  fetchMyStakeReferrals,
  rawToA9,
} from '../data.js';
import { tonConnect, canonicalWalletKey } from '../tonconnect.js';

function formatExactGramFromNano(nano) {
  const v = BigInt(String(nano || '0'));
  const whole = v / 1_000_000_000n;
  const frac = String(v % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}
import { pendingTxManager } from '../tx-ux.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { escapeHtml, formatNum, showToast, copyText, animateSlotCounter, openChoiceSheet, renderProgressRing } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { renderReferralPoster, renderProofFlexPoster, renderStoryPoster, renderScenarioPoster, downloadPosterPng } from '../poster.js';
import { triggerStoryShare, buildTmaDeepLink, getShareRef } from '../share.js';

function renderTeamStakeReferralCardHtml({ loading = false, error = null, data = null } = {}) {
  const totalA9 = data ? (rawToA9(data.totalCommissionRaw) ?? 0) : null;
  const creditedA9 = data ? (rawToA9(data.creditedRaw) ?? 0) : null;
  const pendingA9 = data ? (rawToA9(data.pendingRaw) ?? 0) : null;
  const items = Array.isArray(data?.items) ? data.items : [];
  const unbound = data && data.bound === false;

  let body = '';
  if (loading) {
    body = `<div class="num-xs text-muted">${L('正在读取好友通关 8% 返佣明细…', 'Loading 8% pass referral credits…')}</div>`;
  } else if (error) {
    body = `<div class="row-between" style="gap:8px;"><span class="num-xs text-red">${escapeHtml(error)}</span><button class="btn btn-secondary btn-sm" id="btn-retry-team-ref" type="button">${L('重试', 'Retry')}</button></div>`;
  } else if (!data || unbound) {
    body = `<div class="num-xs text-muted">${L('在 Telegram 内打开并绑定钱包后，好友通关的 8% 返佣将自动并入站内推广金库，0.06 GRAM 一键一起领。', 'Open in Telegram and bind wallet to accumulate 8% pass referral credits into your promo vault (0.06 GRAM 1-tap claim).')}</div>`;
  } else {
    body = `
      <div class="metric-strip cols-3" style="margin:6px 0 8px;">
        <div class="metric-cell"><span class="num-xs text-muted">${L('累计 8% 返佣', 'Total 8%')}</span><span class="num-sm text-green mono" style="font-weight:800;">${formatNum(totalA9, 2)} A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('已入推广池', 'Credited')}</span><span class="num-sm mono" style="font-weight:800;">${formatNum(creditedA9, 2)} A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('待入账', 'Pending')}</span><span class="num-sm text-gold mono" style="font-weight:800;">${formatNum(pendingA9, 2)} A9</span></div>
      </div>
      ${items.length === 0
        ? `<div class="num-xs text-muted">${L('暂无好友通关返佣记录，邀请好友参与涨价解锁即可享通关奖金 8% 返佣。', 'No 8% pass referral credits yet. Invite friends to lock A9 and earn 8% when they pass.')}</div>`
        : `<div class="col-gap" style="gap:6px;">${items.slice(0, 5).map((it) => {
            const commA9 = rawToA9(it.commissionRaw) ?? 0;
            const isCred = String(it.status || '').toUpperCase() === 'CREDITED';
            return `
              <div class="list-row" style="padding:7px 10px;">
                <div>
                  <div class="num-sm" style="font-weight:800;">${L(`第 ${it.roundId} 轮`, `Round #${it.roundId}`)} · <span class="mono">${escapeHtml(it.refereeWallet || '—')}</span></div>
                  <div class="num-xs text-muted">${L('好友通关 8% 返佣', '8% Pass Referral')}</div>
                </div>
                <div style="text-align:right;">
                  <div class="num-sm text-green mono" style="font-weight:900;">+${formatNum(commA9, 2)} A9</div>
                  <span class="chip ${isCred ? 'chip-green' : 'chip-gold'}" style="min-height:18px;font-size:9.5px;">${isCred ? L('已入赏金', 'Credited') : L('待入账', 'Pending')}</span>
                </div>
              </div>
            `;
          }).join('')}</div>`}
    `;
  }

  return `
    <section class="card" id="team-stake-referral-card">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="card-title">${icon('team', 15, 'text-gold')} ${L('好友通关 8% 返佣明细', '8% Pass Referral Credits')}</span>
        <a class="text-link-btn" href="#/team/invite">${L('去 0.06 GRAM 领取', 'Claim (0.06 GRAM)')} ›</a>
      </div>
      ${body}
    </section>
  `;
}

function mountTeamStakeReferrals(root) {
  const mount = root.querySelector('#team-stake-referral-mount');
  if (!mount) return;
  if (!config.isDemo && !A9TMA.getRawInitData()) {
    mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, data: null });
    return;
  }
  mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: true });
  fetchMyStakeReferrals(20)
    .then((res) => {
      if (!mount.isConnected) return;
      mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, data: res });
    })
    .catch((e) => {
      if (!mount.isConnected) return;
      mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, error: e?.message || L('返佣明细读取失败', 'Failed to load referral credits') });
      const retryBtn = mount.querySelector('#btn-retry-team-ref');
      if (retryBtn) retryBtn.onclick = () => mountTeamStakeReferrals(root);
    });
}

export function renderTeamHome(root, navigate) {
  if (!config.isDemo) {
    const addr = store.state.user.address || null;
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero" id="team-dual-engine-card">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="card-title">${icon('wallet', 15, 'text-green')} ${L('双引擎返佣看板 · 8% + 6%', 'Dual-Engine Referral · 8% + 6%')}</span>
            <span class="chip chip-green mono">0.06 GRAM ${L('全提', '1-Tap')}</span>
          </div>
          <div class="metric-strip cols-3" style="margin:6px 0 10px;">
            <div class="metric-cell">
              <span class="num-xs text-muted">${L('好友通关返佣', 'Pass Referral')}</span>
              <span class="num-md text-green mono" style="font-weight:900;">8%</span>
            </div>
            <div class="metric-cell">
              <span class="num-xs text-muted">${L('商城直推返佣', 'Mall Direct')}</span>
              <span class="num-md text-gold mono" style="font-weight:900;">6%</span>
            </div>
            <div class="metric-cell">
              <span class="num-xs text-muted">${L('可领站内赏金', 'Claimable A9')}</span>
              <span class="num-sm text-green mono" id="team-live-promo-bal" style="font-weight:900;">${addr ? L('同步中…', 'Syncing…') : L('待连接', 'Connect')}</span>
            </div>
          </div>
          <div class="grid-2" style="gap:8px;">
            <button class="btn btn-primary btn-sm" data-nav="/team/invite" type="button" style="width:100%;min-height:42px;white-space:nowrap;">${icon('wallet', 13)} ${L('查看推广奖励', 'Referral rewards')}</button>
            <button class="btn btn-secondary btn-sm" data-nav="/team/invite" type="button" style="width:100%;min-height:42px;white-space:nowrap;">${icon('qr', 13)} ${L('生成招募海报', 'Invite Poster')}</button>
          </div>
        </section>

        <div id="team-stake-referral-mount">${renderTeamStakeReferralCardHtml({ loading: Boolean(A9TMA.getRawInitData()) })}</div>

        <section id="team-captain-task" class="card" hidden style="border-color:var(--gold-border);">
          <div class="row-between" style="margin-bottom:6px;">
            <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('战队成长任务 · 群主创世金库', 'Squad Mission · Captain Vault')}</span>
            <span class="chip chip-gold mono">+5,000 A9</span>
          </div>
          <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:10px;">${L('绑定 ≥ 50 人真实 Telegram 群且战队满 3 名成员，可核验 5,000 A9 创世金库（并入站内赏金一键领）。', 'Verify a 50+ member Telegram group with ≥ 3 squad members to claim 5,000 A9 into your bounty vault.')}</div>
          <p class="num-sm mono" data-captain-progress></p>
          <button class="btn btn-secondary btn-sm" data-nav="/team/bind-tg" type="button" style="width:100%;min-height:38px;">${icon('send', 13)} ${L('查看绑群与发放资格', 'Verify TG Group for 5,000 A9')}</button>
        </section>

        <form class="card col-gap" id="live-join-team-form" hidden>
          <div class="card-title">${icon('team', 15, 'text-cyan')} ${L('加入已有战队', 'Join an Existing Squad')}</div>
          <label class="num-xs text-sec">${L('战队编号', 'Squad ID')} <input name="guild" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" required maxlength="64" placeholder="TM-0001"></label>
          <button class="btn btn-primary">${L('申请加入', 'Join Squad')}</button>
          <output class="num-xs text-red"></output>
        </form>
      </div>
    `;
    portfolioPanel(root.firstElementChild, true, data => {
      const visible = data?.privateDataVisible === true;
      const task = root.querySelector('#team-captain-task');
      task.hidden = !(visible && data.team?.role === 'captain');
      if (!task.hidden) task.querySelector('[data-captain-progress]').textContent =
        L(`TG 群 ${data.team.tgMemberCount ?? '—'} / 50 人 · 战队 ${data.team.memberCount ?? '—'} / 3 人`,
          `TG group ${data.team.tgMemberCount ?? '—'} / 50 · Squad ${data.team.memberCount ?? '—'} / 3`);
      if (!task.hidden) root.firstElementChild.firstElementChild.after(task);
      root.querySelector('#live-join-team-form').hidden = !(visible && !data.team);
    });
    mountTeamStakeReferrals(root);
    if (addr) {
      fetchPromoBalance(addr)
        .then((res) => {
          const el = root.querySelector('#team-live-promo-bal');
          if (!el || !el.isConnected || store.state.user.address !== addr) return;
          const a9 = res?.claimableRaw !== undefined ? rawToA9(res.claimableRaw) : null;
          el.textContent = a9 !== null ? `${formatNum(a9, a9 % 1 === 0 ? 0 : 2)} A9` : L('待核验', 'Pending');
        })
        .catch(() => {
          const el = root.querySelector('#team-live-promo-bal');
          if (el && el.isConnected) el.textContent = L('待核验', 'Pending');
        });
    }
    const form = root.querySelector('#live-join-team-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const wallet = store.state.user.address;
      if (!wallet) { tonConnect.openConnectModal(() => renderTeamHome(root, navigate)); return; }
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await joinTeam({ teamId: form.elements.guild.value.trim(), walletAddress: wallet, userId: getEffectiveUserId(store.state.user), referrerId: store.state.referral.referrerId });
        renderTeamHome(root, navigate);
      } catch {
        form.querySelector('output').textContent = L('加入失败，请核对战队编号后重试', 'Join failed. Check the squad ID and retry.');
        button.disabled = false;
      }
    };
    return;
  }
  const { team } = store.state;
  const role = team.role;

  const roleLabels = {
    captain: L('队长视图', 'Captain'),
    member:  L('成员视图', 'Member'),
    none:    L('团队大厅', 'Lobby')
  };
  const rolePill = `<button class="pill-trigger neutral" id="btn-role-sheet" type="button">${roleLabels[role]} ${icon('chevronDown', 12)}</button>`;

  let html = '';

  if (role === 'captain') {
    const target = Number(team.teamStakedTarget) || 1;
    const progressPct = Math.min(100, Math.round(((Number(team.teamStakedTon) || 0) / target) * 100));
    html = `
      <div class="card card-hero guild-board">
        <div class="row-between" style="margin-bottom:8px;">
          <div>
            <div class="row-start" style="font-size:17px;font-weight:900;">${escapeHtml(team.name || L('我的战队', 'My Squad'))} ${icon('shieldCheck', 16, 'text-green')}</div>
            <div class="row-start" style="margin-top:4px;gap:6px;">
              <span class="chip chip-green">${L('队长', 'Captain')} · Lv.${team.level || 1}</span>
              <span class="chip chip-gold">${L('通关 8% + 商城 6%', '8% Pass + 6% Mall')} · DEMO</span>
            </div>
          </div>
          ${rolePill}
        </div>

        <div class="metric-strip cols-3" style="margin:10px 0;">
          <div class="metric-cell">
            <span class="num-xs text-muted">${L('本轮参与', 'Active')}</span>
            <span class="num-md text-green">${team.membersActive} / ${team.membersTotal}</span>
          </div>
          <div class="metric-cell">
            <span class="num-xs text-muted">${L('有效直邀', 'Invites')}</span>
            <span class="num-md">${team.directInvites}</span>
          </div>
          <div class="metric-cell">
            <span class="num-xs text-muted">${L('可领赏金', 'Bounty A9')}</span>
            <span class="num-md text-gold" id="captain-dividend-val">${formatNum(store.state.user.promoClaimableA9)} A9</span>
          </div>
        </div>

        <div class="row-between num-xs text-muted" style="margin-bottom:5px;">
          <span>${L('本轮战队冲刺进度', 'Round Sprint Progress')}</span>
          <span class="mono" style="color:var(--ink);font-weight:800;">${progressPct}%</span>
        </div>
        <div class="progress-track" style="margin-bottom:12px;"><div class="progress-fill" style="width:${progressPct}%"></div></div>

        <div class="grid-2" style="gap:8px;">
          <button class="btn btn-primary btn-sm" data-nav="/team/invite" type="button" style="width:100%;min-height:42px;">${icon('wallet', 14)} ${L('查看推广奖励', 'Referral rewards')}</button>
          <button class="btn btn-secondary btn-sm" data-nav="/team/invite" type="button" style="width:100%;min-height:42px;">${icon('qr', 14)} ${L('招募海报', 'Poster')}</button>
        </div>
      </div>

      <div class="card" style="border-color:var(--gold-border);">
        <div class="row-between" style="margin-bottom:4px;">
          <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('战队成长任务 · 群主创世金库', 'Squad Mission · Captain Vault')}</span>
          <span class="chip chip-gold">+5,000 A9</span>
        </div>
        <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:8px;">${L('绑 ≥ 50 人 TG 群（满 3 成员）领 5,000 A9 · 好友通关 8% + 商城直推 6% 双引擎返佣', 'Verify 50+ member TG group (≥ 3 members) for 5,000 A9 · 8% pass + 6% mall dual-engine referrals')}</div>
        <button class="btn btn-secondary btn-sm" data-nav="/internal/market?tab=free" type="button" style="width:100%;">${icon('swap', 14)} ${L('前往宝箱商城冲击黄金/白金/钻石免费宝箱', 'Open Chest Mall Free Tiers')}</button>
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/team/bind-tg">${icon('send', 14)} ${L('管理 TG 群', 'TG Group')}</button>
        <button class="btn btn-secondary" disabled>${icon('bell', 14)} ${L('群广播未开放', 'Broadcast unavailable')}</button>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('trophy', 15, 'text-gold')} ${L('本轮主力成员 Top 3', 'Top 3 Members')}</div>
          <button class="text-link-btn" data-nav="/leaderboard" type="button">${L('完整榜单', 'Full Board')} ${icon('chevronRight', 13)}</button>
        </div>
        <div class="guild-roster">
          ${(team.topMembers || []).length === 0
            ? `<div class="empty-state" style="padding:14px;grid-column:1/-1;"><div class="num-xs text-muted">${L('暂无成员闯关战绩', 'No active members yet')}</div></div>`
            : (team.topMembers || []).map((m,i) => `
            <div class="guild-member"><div class="num-sm"><span class="text-gold">${escapeHtml(m.rank)}</span> ${escapeHtml(m.addr)}</div>
              <div class="num-xs text-green mono" style="font-weight:800;">${formatNum(m.ton)} A9</div>
            </div>
          `).join('')}
        </div>
      </div>

    `;
  } else if (role === 'member') {
    html = `
      <div class="card card-hero guild-board">
        <div class="row-between" style="margin-bottom:8px;">
          <div>
            <div style="font-size:17px;font-weight:900;">${L('星航冲锋战队', 'Star Voyagers')}</div>
            <div class="row-start" style="margin-top:4px;gap:6px;">
              <span class="chip chip-cyan">${L('成员', 'Member')} · Lv.3</span>
              <span class="chip chip-gold">${L('通关 8% + 商城 6%', '8% Pass + 6% Mall')} · DEMO</span>
            </div>
          </div>
          ${rolePill}
        </div>
        <div class="num-xs text-muted" style="margin-bottom:6px;">${L('战队活跃进度 84% · 好友通关 8% + 直推购箱 6% 双引擎返佣（演示样例）', '84% active · 8% pass + 6% direct chest referral (Demo sample)')}</div>
        <div class="progress-track" style="margin-bottom:10px;"><div class="progress-fill" style="width:84%"></div></div>

        <div class="metric-strip">
          <div class="metric-cell"><span class="num-xs text-muted">${L('战队累计参与', 'Squad Volume')}</span><span class="num-md text-green">184,200 A9</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('我的 8%+6% 赏金', 'My 8%+6% Bounty')}</span><span class="num-md text-gold">${formatNum(store.state.user.promoClaimableA9)} A9</span></div>
        </div>
        <button class="btn btn-primary" data-nav="/team/invite">${icon('qr', 16)} ${L('生成招募海报 · 赚 8% + 6% 返佣', 'Invite Poster · 8% + 6% Referral')}</button>
      </div>

      <div class="grid-3">
        <button class="btn btn-secondary btn-sm" data-nav="/leaderboard" style="width:100%;min-height:42px;">${icon('trophy', 14)} ${L('排行榜', 'Ranks')}</button>
        <button class="btn btn-secondary btn-sm" data-nav="/team/profile/TM-8829" style="width:100%;min-height:42px;">${icon('layers', 14)} ${L('战队名片', 'Squad Card')}</button>
        <button class="btn btn-secondary btn-sm" id="btn-open-group" style="width:100%;min-height:42px;">${icon('send', 14)} ${L('战队群', 'Chat')}</button>
      </div>
      <div class="row-between num-xs" style="padding:4px 2px;">
        <button class="btn btn-sm" id="btn-switch-team" style="background:transparent;color:var(--text-secondary);padding:0;box-shadow:none;">${L('切换战队（每赛季限 1 次）', 'Switch Squad (1/season)')}</button>
        <button class="btn btn-sm" id="btn-leave-team" style="background:transparent;color:var(--red);padding:0;box-shadow:none;">${L('退出战队', 'Leave')}</button>
      </div>
    `;
  } else {
    const squads = [
      { id: 'TM-0001', name: L('A9 冒险战队', 'A9 Quest Squad'), lv: 'Lv.4', tag: L('8% + 6%', '8% + 6%'), members: '412/500' },
      { id: 'TM-8829', name: L('星航冲锋战队', 'Star Voyagers'), lv: 'Lv.3', tag: L('活跃榜', 'Active'), members: '84/100' },
      { id: 'TM-3042', name: L('金箔典藏战队', 'Gold Foil Collectors'), lv: 'Lv.3', tag: L('同行队', 'Co-Op'), members: '66/100' }
    ];
    html = `
      <div class="card card-hero guild-board">
        <div class="row-between" style="margin-bottom:6px;">
          <span class="chip chip-gold">${L('v17.0 双引擎战队 · 8% + 6%', 'v17.0 Dual-Engine · 8% + 6%')}</span>
          ${rolePill}
        </div>
        <div style="font-size:17px;font-weight:900;">${L('加入一个活跃战队', 'Join an Active Squad')}</div>
        <div class="text-sec" style="font-size:12px;margin-top:4px;">${L('免费入队同步 12H 冲价战报；好友通关返佣 8%、直推购箱返佣 6%，群主绑群领 5,000 A9 创世金库。', 'Join free for 12H push alerts; earn 8% pass referral, 6% direct chest referral, and 5,000 A9 captain founding vault.')}</div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${L('推荐战队', 'Featured Squads')}</div>
          <button class="text-link-btn" data-nav="/leaderboard" type="button">${L('查看排行', 'Rankings')} ${icon('chevronRight', 13)}</button>
        </div>
        <div>
          ${squads.map(s => `
            <div class="list-row">
              <div>
                <div style="font-weight:800;">${escapeHtml(s.name)}</div>
                <div class="num-xs text-muted">${escapeHtml(s.lv)} · ${escapeHtml(s.members)} ${L('人', 'members')}</div>
              </div>
              <div class="row-start" style="gap:6px;">
                <span class="chip chip-gold">${escapeHtml(s.tag)}</span>
                <button class="btn btn-primary btn-sm" data-join-team="${escapeHtml(s.id)}">${L('加入', 'Join')}</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  root.innerHTML = `<div class="col-gap anim-page-enter">${html}<div id="team-stake-referral-mount">${renderTeamStakeReferralCardHtml({ loading: true })}</div></div>`;
  mountTeamStakeReferrals(root);

  const divEl = root.querySelector('#captain-dividend-val');
  if (divEl) animateSlotCounter(divEl, Number(store.state.user.promoClaimableA9) || 0, { duration: 600, decimals: 0, suffix: ' A9' });

  const roleBtn = root.querySelector('#btn-role-sheet');
  if (roleBtn) {
    roleBtn.onclick = () => openChoiceSheet({
      title: L('切换团队角色视角', 'Switch Squad View'),
      selected: role,
      options: [
        { value: 'captain', label: L('队长指挥中枢', 'Captain Console'), sub: L('查看全队参与、8% + 6% 返佣与 5,000 A9 创世金库', 'Squad volume, 8% + 6% referral & 5,000 A9 vault') },
        { value: 'member',  label: L('普通成员视图', 'Member View'),     sub: L('查看战队动态与 8% + 6% 邀友返佣', 'Squad activity & 8% + 6% referral') },
        { value: 'none',    label: L('未加入 · 团队大厅', 'Squad Lobby'), sub: L('浏览并一键加入活跃战队', 'Browse & join active squads') }
      ],
      onSelect: (val) => {
        store.update(s => { s.team.role = val; });
        renderTeamHome(root, navigate);
      }
    });
  }

  const grpBtn = root.querySelector('#btn-open-group');
  if (grpBtn) grpBtn.onclick = () => showToast(L('正在打开 TG 团队群...', 'Opening TG group...'));

  const switchBtn = root.querySelector('#btn-switch-team');
  if (switchBtn) {
    switchBtn.onclick = () => {
      A9Haptic.light();
      store.update(s => { s.team.role = 'none'; });
      showToast(L('已进入团队大厅，可选择新团队（下轮生效）', 'Browse squads to switch (effective next round)'));
      renderTeamHome(root, navigate);
    };
  }
  const leaveBtn = root.querySelector('#btn-leave-team');
  if (leaveBtn) {
    leaveBtn.onclick = () => {
      A9Haptic.warning();
      store.update(s => { s.team.role = 'none'; });
      showToast(L('已退出当前团队', 'Left squad'), 'amber');
      renderTeamHome(root, navigate);
    };
  }

  root.querySelectorAll('[data-join-team]').forEach(b => {
    b.onclick = async () => {
      const tid = b.dataset.joinTeam;
      if (!config.isDemo) {
        const uid = getEffectiveUserId(store.state.user);
        if (!uid) {
          showToast(L('请在 Telegram 内打开或先连接 TON 钱包', 'Open in Telegram or connect TON wallet first'), 'amber');
          tonConnect.openConnectModal(() => renderTeamHome(root, navigate));
          return;
        }
        b.disabled = true;
        try {
          await joinTeam({
            teamId: tid,
            walletAddress: store.state.user.address,
            userId: uid,
            referrerId: store.state.referral.referrerId
          });
          A9Haptic.success();
          store.update(s => { s.team.role = 'member'; s.team.id = tid; });
          showToast(L(`已加入团队 #${tid}`, `Joined #${tid}`));
          renderTeamHome(root, navigate);
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('加入团队失败，请重试', 'Join team failed'), 'error');
          b.disabled = false;
        }
        return;
      }
      A9Haptic.success();
      store.update(s => { s.team.role = 'member'; });
      showToast(L(`已加入团队 #${tid}`, `Joined #${tid}`));
      renderTeamHome(root, navigate);
    };
  });
}

export function renderTeamProfile(root, navigate, id) {
  if(!config.isDemo){root.replaceChildren();portfolioPanel(root,true);return;}
  const safeId = escapeHtml(id || 'TM-0001');
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <span class="chip chip-gold">#${safeId} · Lv.4 · DEMO</span>
        <div class="row-start" style="font-size:20px;font-weight:700;margin-top:8px;">${L('A9 冒险战队', 'A9 Quest Squad')} ${icon('shieldCheck', 18, 'text-green')}</div>
        <div class="metric-strip cols-3">
          <div class="metric-cell"><span class="num-xs text-muted">${L('直推返佣', 'Referral')}</span><span class="num-md text-green">6%</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('成员', 'Members')}</span><span class="num-md">412</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('锁仓 A9', 'Locked A9')}</span><span class="num-md">580,000</span></div>
        </div>
        <button class="btn btn-primary" data-nav="/challenge/confirm">${icon('bolt', 16)} ${L('加入并参与锁仓', 'Join & Lock')}</button>
      </div>
    </div>
  `;
}

export function renderBindTgGroup(root) {
  const { team } = store.state;
  if (!config.isDemo) {
    let liveStatus = 'unbound';
    let lastMsg = L('填写战队编号与 Telegram 群 @用户名 后先进入核验中，再由服务端核验 Bot 入群状态、群管理员权限与群唯一性。', 'Submit Squad ID and Telegram @group handle to enter verifying state, then run server verification for bot presence, admin role, and group uniqueness.');
    const statusChip = {
      unbound: ['chip-muted', L('未绑定', 'Unbound')],
      verifying: ['chip-gold', L('核验中', 'Verifying')],
      bound: ['chip-green', L('已通过核验', 'Verified Bound')],
      expired: ['chip-red', L('权限已失效', 'Expired')],
    };
    const paintLive = () => {
      const [cls, txt] = statusChip[liveStatus] || statusChip.unbound;
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="card card-hero">
            <div class="row-between" style="margin-bottom:8px;">
              <span class="card-title">${icon('send', 15, 'text-gold')} ${L('战队 Telegram 群真实核验', 'Squad Telegram Group Verification')}</span>
              <span class="chip ${cls}" id="live-tg-bind-status">${txt}</span>
            </div>
            <div class="num-xs text-sec" id="live-tg-bind-msg" style="margin-bottom:12px;line-height:1.5;">${escapeHtml(lastMsg)}</div>
            <form id="live-tg-bind-form" class="col-gap">
              <label class="num-xs text-sec">${L('战队编号 (Squad ID)', 'Squad ID')}
                <input name="teamId" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" placeholder="TM-0001" required maxlength="64" value="${escapeHtml(team.id || '')}">
              </label>
              <label class="num-xs text-sec">${L('Telegram 群组 @用户名', 'Telegram Group @handle')}
                <input name="tgGroupHandle" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" placeholder="@your_guild_group" required maxlength="64" value="${escapeHtml(team.tgGroupHandle || '')}">
              </label>
              <div class="grid-2" style="margin-top:4px;">
                <button type="submit" class="btn btn-secondary" id="btn-live-submit-tg">${L('1. 提交进入核验中', '1. Submit Handle')}</button>
                <button type="button" class="btn btn-primary" id="btn-live-verify-tg">${L('2. 发起服务端核验', '2. Verify Now')}</button>
              </div>
            </form>
          </div>
          <div class="card">
            <div class="card-title" style="margin-bottom:6px;">${icon('shieldCheck', 15, 'text-green')} ${L('服务端四重防伪核验规则', '4-Step Server Verification Rules')}</div>
            <div class="num-xs text-sec" style="line-height:1.6;">
              1. ${L('仅队长本人（已验签绑定钱包）可发起提交与核验，普通成员将被拒绝（403）。', 'Captain-only (verified wallet required); members are rejected (403).')}<br>
              2. ${L('仅提交 @群名 始终停留在「核验中」，绝不伪造已绑定状态。', 'Submitting @handle only sets verifying status; never faked as bound.')}<br>
              3. ${L('拉官方 Bot 入群且队长为管理员；群 ≥50 人、满 3 成员即发 5,000 A9（限 1 次）。', 'Add official Bot as admin; verified 50+ member groups with ≥3 squad members earn 5,000 A9 once.')}<br>
              4. ${L('同一真实群 ID（tgChatId）仅允许绑定 1 个战队；直推成员每次购箱返佣 6%，Bot 将私聊通知队长。', 'One tgChatId binds at most one squad; Bot DMs the captain on every 6% referral credit.')}
            </div>
          </div>
        </div>
      `;
      const form = root.querySelector('#live-tg-bind-form');
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const tid = form.elements.teamId.value.trim();
        const handle = form.elements.tgGroupHandle.value.trim();
        if (!tid || !handle) return;
        const submitBtn = root.querySelector('#btn-live-submit-tg');
        submitBtn.disabled = true;
        try {
          const res = await bindTeamGroupTg({ teamId: tid, tgGroupHandle: handle });
          liveStatus = res?.bindStatus || 'verifying';
          lastMsg = L('已提交群组信息，当前状态为「核验中」。请确保官方 Bot 已入群后点击右侧「发起服务端核验」。', 'Submitted. Status is verifying. Add the official bot to the group and click Verify Now.');
          showToast(L('已进入核验中（verifying）', 'Status: verifying'));
        } catch (e) {
          lastMsg = e?.message || L('提交失败，请确认已在 Telegram 内打开并已验证绑定队长钱包', 'Submission failed. Verify Telegram session & captain wallet.');
          showToast(lastMsg, 'error');
        }
        paintLive();
      };
      root.querySelector('#btn-live-verify-tg').onclick = async () => {
        const tid = form.elements.teamId.value.trim();
        if (!tid) {
          showToast(L('请先填写战队编号', 'Enter Squad ID first'), 'amber');
          return;
        }
        const verifyBtn = root.querySelector('#btn-live-verify-tg');
        verifyBtn.disabled = true;
        try {
          const res = await verifyTeamGroupTg({ teamId: tid });
          liveStatus = res?.bindStatus || 'bound';
          lastMsg = L('服务端核验通过：Bot 在群内且队长群管理员权限有效。', 'Server verification passed: bot in group & captain admin role confirmed.');
          showToast(L('Telegram 群绑定核验通过', 'Group verification passed'));
        } catch (e) {
          if (liveStatus === 'bound') liveStatus = 'expired';
          lastMsg = e?.message || L('服务端核验未通过，请检查机器人入群与管理员权限', 'Verification failed. Check bot presence and admin permissions.');
          showToast(lastMsg, 'error');
        }
        paintLive();
      };
    };
    paintLive();
    return;
  }
  let bindState = team.tgGroupBound ? 'bound' : 'unbound';
  const stateMeta = {
    bound:     { chip: 'chip-green', label: L('已绑定', 'Bound'),    desc: L('Bot 权限正常，整点收盘自动播报。', 'Bot active. Hourly pushes enabled.'), btn: L('重新校验', 'Re-verify') },
    unbound:   { chip: 'chip-muted', label: L('未绑定', 'Unbound'),  desc: L('将 @A9_TonBot 设为群管理员即可绑定。', 'Add @A9_TonBot as admin to bind.'), btn: L('一键绑定 TG 群', 'Bind TG Group') },
    verifying: { chip: 'chip-gold',  label: L('验证中', 'Checking'), desc: L('正在校验管理员权限...', 'Verifying admin permissions...'), btn: L('刷新状态', 'Refresh') },
    expired:   { chip: 'chip-red',   label: L('已失效', 'Expired'),  desc: L('Bot 管理员权限已失效，请重新授权。', 'Admin rights revoked. Re-authorize.'), btn: L('恢复授权', 'Restore Access') }
  };

  const paint = () => {
    const meta = stateMeta[bindState];
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="seg-tabs">
          <button class="seg-tab ${bindState === 'bound' ? 'active' : ''}" data-bs="bound">${L('已绑定', 'Bound')}</button>
          <button class="seg-tab ${bindState === 'unbound' ? 'active' : ''}" data-bs="unbound">${L('未绑定', 'None')}</button>
          <button class="seg-tab ${bindState === 'verifying' ? 'active' : ''}" data-bs="verifying">${L('验证中', 'Check')}</button>
          <button class="seg-tab ${bindState === 'expired' ? 'active' : ''}" data-bs="expired">${L('失效', 'Lost')}</button>
        </div>
        <div class="card ${bindState === 'expired' ? 'card-glow-red' : ''}">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="card-title">${icon('send', 15, 'text-gold')} ${bindState === 'unbound' ? L('未关联群组', 'No Group') : escapeHtml(team.tgGroupHandle || '')}</span>
            <span class="chip ${meta.chip}">${meta.label}</span>
          </div>
          <div class="text-sec" style="font-size:12px;margin-bottom:14px;">${meta.desc}</div>
          <button class="btn btn-primary" id="btn-toggle-bind">${icon('refresh', 15)} ${meta.btn}</button>
        </div>
      </div>
    `;
    root.querySelectorAll('[data-bs]').forEach(b => { b.onclick = () => { A9Haptic.light(); bindState = b.dataset.bs; paint(); }; });
    root.querySelector('#btn-toggle-bind').onclick = () => {
      A9Haptic.success();
      bindState = 'bound';
      store.update(s => { s.team.tgGroupBound = true; });
      showToast(L('[演示] 模拟绑定状态，未连接真实 Telegram 群', '[Demo] Simulated state, no real Telegram group'));
      paint();
    };
  };
  paint();
}

export function renderInviteShare(root) {
  const { user, team } = store.state;
  const shareRef = getShareRef();
  const inviteLink = config.isDemo
    ? `${window.location.origin}${window.location.pathname}?mode=${config.mode}&startapp=invite_${encodeURIComponent(shareRef)}`
    : buildTmaDeepLink(`invite_${shareRef}`);
  let template = 'push';
  let livePromo = null;
  let livePromoErr = null;
  let promoClaimBusy = false;
  let lastClaimStatus = null;

  const buildScenarioPitch = (tpl) => {
    const r = store.state.round || {};
    const roundLabel = r.currentRound ? L(`第 ${r.currentRound} 轮`, `Round #${r.currentRound}`) : L('本轮', 'Current Round');
    const targetStr = (r.targetPrice !== null && r.targetPrice !== undefined && Number.isFinite(Number(r.targetPrice)) && Number(r.targetPrice) > 0)
      ? `$${Number(r.targetPrice).toFixed(4)}`
      : null;
    const rawCur = r.priceValid !== false ? (r.livePrice ?? r.twap24h) : null;
    const curNum = (rawCur !== null && rawCur !== undefined && Number.isFinite(Number(rawCur)) && Number(rawCur) > 0) ? Number(rawCur) : null;
    const gapPct = (targetStr && curNum) ? (((Number(r.targetPrice) - curNum) / curNum) * 100) : null;
    const gapLineZh = targetStr && gapPct !== null
      ? (gapPct <= 0 ? `已站上目标价 ${targetStr}（+${Math.abs(gapPct).toFixed(1)}%）` : `目标价 ${targetStr}，距解锁还差 +${gapPct.toFixed(1)}%`)
      : (targetStr ? `目标价 ${targetStr}` : '链上实时目标价核验中');
    const gapLineEn = targetStr && gapPct !== null
      ? (gapPct <= 0 ? `above ${targetStr} target (+${Math.abs(gapPct).toFixed(1)}%)` : `target ${targetStr} (+${gapPct.toFixed(1)}% away)`)
      : (targetStr ? `target ${targetStr}` : 'on-chain target syncing');
    const poolStr = (r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9)))
      ? `${formatNum(r.rewardBudgetA9)} A9`
      : L('700,000,000 A9 奖池（链上实时核验）', '700,000,000 A9 pool (on-chain verified)');
    if (tpl === 'chest') {
      return L(
        `A9 宝箱商城升级「纯随机合并直发钱包」：0.99 GRAM 起保底 1,500 A9、最高开出 2,500 A9（传说箱最高 1,300,000 A9），只收一次 0.06 GRAM Gas，买完直接进头矿 6H（未通关仅 5% 止损）。直推好友购箱实时返佣 6%：${inviteLink}`,
        `A9 Chest Mall now pays base + random bonus straight to your wallet in one tx (0.06 GRAM gas once): from 0.99 GRAM (1,500–2,500 A9) up to 1,300,000 A9, plus 6% direct referral: ${inviteLink}`
      );
    }
    if (tpl === 'win') {
      return L(
        `A9 ${roundLabel} 涨价解锁机制：70% 奖池 + 12% 团队全锁价格，100 A9 起锁仓永不爆仓（头矿 6H 仅 5% 止损退 95%），12H 冲价达标 ≥ 8/12 段通关分 ${poolStr}，最高 5 倍币、20% 秒提 + 14 天逐秒解锁：${inviteLink}`,
        `A9 ${roundLabel} Price-Unlock: 70% pool + 12% team locked on price, lock from 100 A9 with zero liquidation (First 6H 5% Stop-Loss / 95% refund), pass 8/12 slots to split ${poolStr} up to 5x: ${inviteLink}`
      );
    }
    return L(
      `【A9 ${roundLabel} 冲价喊单】${gapLineZh}！70% 奖池（${poolStr}）+ 12% 团队全锁价格，齐心冲上目标价稳住 8/12 小时全员分奖，没过自动退 95%/90% 永不爆仓。0.99 GRAM 开箱或 100 A9 锁仓一起冲：${inviteLink}`,
      `[A9 ${roundLabel} Price-Push] ${gapLineEn}! 70% pool (${poolStr}) + 12% team locked on price—hold 8/12 hourly slots to split rewards, 95%/90% refund if missed. Join from 0.99 GRAM chest or 100 A9 lock: ${inviteLink}`
    );
  };

  const loadLivePromo = async () => {
    if (config.isDemo) return;
    const wallet = store.state.user.address;
    if (!wallet) return;
    try {
      livePromo = await fetchPromoBalance(wallet);
      livePromoErr = null;
    } catch (e) {
      livePromoErr = e?.message || L('暂无法读取推广余额', 'Promo balance unavailable');
    }
    if (root.isConnected) paint();
  };

  const paint = () => {
    const claimableA9 = livePromo ? (rawToA9(livePromo.claimableRaw) ?? 0) : null;
    const totalClaimedA9 = livePromo ? (rawToA9(livePromo.totalClaimedRaw) ?? 0) : null;
    const canLiveClaim = !config.isDemo && store.fundsEnabled;
    const promoTxLocked = pendingTxManager.isLocked('promo');
    const promoDisabled = promoClaimBusy || promoTxLocked;

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:6px;">
            <span class="card-title">${icon('wallet', 15, 'text-gold')} ${L('邀友与宝箱推广余额', 'Invite & Promo Balance')}</span>
            <span class="chip ${config.isDemo ? 'chip-green' : canLiveClaim ? 'chip-green' : 'chip-gold'}">${config.isDemo ? 'DEMO' : canLiveClaim ? L('已开放', 'OPEN') : L('只读模式', 'READ-ONLY')}</span>
          </div>
          ${config.isDemo
            ? `<div class="num-xs text-sec">${L('推广可领', 'Claimable referral rewards')} · ${formatNum(store.state.user.promoClaimableA9)} A9 ${L('（演示）', '(Demo)')}</div>`
            : livePromo
              ? `<div class="metric-strip cols-2" style="margin:8px 0 4px;">
                  <div class="metric-cell"><span class="num-xs text-muted">${L('当前可领 A9', 'Claimable A9')}</span><span class="num-md text-green mono">${formatNum(claimableA9, 2)} A9</span></div>
                  <div class="metric-cell"><span class="num-xs text-muted">${L('累计已领 A9', 'Total Claimed')}</span><span class="num-md mono">${formatNum(totalClaimedA9, 2)} A9</span></div>
                </div>`
              : `<div class="num-xs text-sec">${escapeHtml(livePromoErr || (store.state.user.address ? L('正在读取真实推广余额…', 'Loading promo balance…') : L('连接并验证 TON 钱包后可查看可领余额', 'Connect and verify wallet to view claimable balance')))}</div>`}
          ${lastClaimStatus ? `<div class="num-xs text-green mono" style="margin-top:6px;">${L('最近领奖单', 'Latest claim')}: ${escapeHtml(lastClaimStatus.claimId)} · ${escapeHtml(lastClaimStatus.status)}${lastClaimStatus.payoutTxHash ? ` · ${escapeHtml(lastClaimStatus.payoutTxHash.slice(0, 14))}…` : ''}</div>` : ''}
          <button class="btn ${config.isDemo || (canLiveClaim && !promoTxLocked) ? 'btn-primary' : 'btn-secondary'} btn-sm" id="btn-claim-promo-hot" style="width:100%;margin-top:12px;" ${promoDisabled ? 'disabled' : ''}>${icon(store.fundsEnabled ? (promoTxLocked ? 'clock' : 'wallet') : 'lock', 14)} ${config.isDemo
            ? L('领取邀友 A9（演示付 0.06 GRAM Gas）', 'Claim Invite A9 (Demo 0.06 GRAM Gas)')
            : canLiveClaim
              ? (promoTxLocked
                  ? L('推广发放确认中（防重锁）', 'Promo Payout Confirming…')
                  : promoClaimBusy
                    ? L('等待 0.06 GRAM 签名确认…', 'Waiting for 0.06 GRAM tx…')
                    : L('领取推广 A9（付 0.06 GRAM 链上 Gas）', 'Claim Promo A9 (0.06 GRAM Gas)'))
              : L('真实模式只读 · 邀友领奖暂未开放', 'Read-Only Mode · Invite Claim Disabled')}</button>
          ${!config.isDemo && !canLiveClaim ? `<div class="num-xs text-muted" id="live-readonly-promo-notice" style="margin-top:6px;">${L('当前真实模式仅支持只读浏览与连接钱包，暂不创建 0.06 GRAM 付款单或发起签名。', 'Live mode is read-only; no 0.06 GRAM payment intent or signature will be created.')}</div>` : ''}
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${template === 'push' ? 'active' : ''}" data-tpl="push">${L('冲价喊单卡', 'Push Call')}</button>
          <button class="seg-tab ${template === 'chest' ? 'active' : ''}" data-tpl="chest">${L('开箱喜报卡', 'Unboxing')}</button>
          <button class="seg-tab ${template === 'win' ? 'active' : ''}" data-tpl="win">${L('通关盈利卡', 'Pass Card')}</button>
        </div>

        <div class="card">
          <canvas id="a9-poster-canvas" class="poster-canvas ${template === 'story' ? 'story-aspect' : ''}"></canvas>
          <div class="grid-2" style="margin-top:12px;">
            <button class="btn btn-primary" id="btn-dl-poster" style="min-height:46px;font-size:14px;">${icon('download', 15)} ${L('保存高清 PNG', 'Save PNG')}</button>
            <button class="btn btn-secondary" id="btn-tg-share" style="min-height:46px;font-size:14px;">${icon('send', 15)} ${L('转发 Telegram', 'Share TG')}</button>
          </div>
          <button class="btn btn-secondary" id="btn-tg-story-share" type="button" style="margin-top:10px;min-height:44px;font-size:14px;">${icon('story', 15)} ${L('一键发 TG Story', 'Post to TG Story')}</button>
        </div>

        <div class="card">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="card-title">${icon('copy', 14, 'text-gold')} ${L('一键复制群推话术', '1-Tap Viral Pitch')}</span>
            <button class="pill-trigger" id="btn-copy-pitch" type="button">${L('复制全文', 'Copy')}</button>
          </div>
          <div class="share-copy-box">${escapeHtml(buildScenarioPitch(template))}</div>
        </div>

        ${config.isDemo ? `<div class="card">
          <div class="card-header">
            <span class="card-title">${icon('team', 15)} ${L('被邀请人列表 (18) · 演示样例', 'Invitees (18) · Demo sample')}</span>
            <span class="num-xs text-muted">${L('有效 16 人', '16 Valid')}</span>
          </div>
          <div class="col-gap">
            <div class="list-row"><div><div class="num-sm">UQ...8892</div><div class="num-xs text-muted">5,000 A9 · ${L('头矿 6H', 'First 6H')}</div></div><span class="chip chip-green">${L('已达标', 'Passed')}</span></div>
            <div class="list-row"><div><div class="num-sm">EQ...3312</div><div class="num-xs text-muted">2,000 A9 · ${L('头矿 6H', 'First 6H')}</div></div><span class="chip chip-gold">${L('12H 冲价中', '12H Push')}</span></div>
            <div class="list-row"><div><div class="num-sm">UQ...77ea</div><div class="num-xs text-muted">0 A9</div></div><span class="chip chip-muted">${L('待参与', 'Pending')}</span></div>
          </div>
        </div>` : `<div class="card">
          <div class="card-header"><span class="card-title">${icon('team', 15)} ${L('被邀请人列表', 'Invitees')}</span></div>
          <div class="num-xs text-muted">${L('暂无数据：真实邀请记录需服务端确认后显示。', 'No data yet: invite records appear after server confirmation.')}</div>
        </div>`}
      </div>
    `;

    const canvas = root.querySelector('#a9-poster-canvas');
    if (template === 'story') renderStoryPoster(canvas, { roundId: store.state.round.currentRound });
    else if (template === 'push' || template === 'chest' || template === 'win') renderScenarioPoster(canvas, template);
    else if (template === 'flex') renderProofFlexPoster(canvas, store.state.certificates[0]);
    else renderReferralPoster(canvas);

    root.querySelectorAll('[data-tpl]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); template = b.dataset.tpl; paint(); };
    });

    const activePitch = buildScenarioPitch(template);
    root.querySelector('#btn-dl-poster').onclick = () => {
      A9Haptic.success();
      const name = template === 'story' ? 'A9-Story-9x16.png' : template === 'chest' ? 'A9-Unboxing-Card.png' : template === 'win' ? 'A9-Round-Pass-Card.png' : 'A9-Price-Push-Card.png';
      downloadPosterPng(canvas, name);
      showToast(L('高清海报已保存', 'Poster saved'));
    };
    const storyBtn = root.querySelector('#btn-tg-story-share');
    if (storyBtn) {
      storyBtn.onclick = () => {
        if (template !== 'story') {
          template = 'story';
          paint();
          const nextCanvas = root.querySelector('#a9-poster-canvas');
          triggerStoryShare({ canvas: nextCanvas, type: 'round', id: store.state.round.currentRound, filename: 'A9-Story-9x16.png' });
          return;
        }
        triggerStoryShare({ canvas, type: 'round', id: store.state.round.currentRound, filename: 'A9-Story-9x16.png' });
      };
    }
    root.querySelector('#btn-copy-pitch').onclick = () => copyText(activePitch, L('已复制群推话术', 'Copied pitch'));
    root.querySelector('#btn-tg-share').onclick = () => {
      A9Haptic.light();
      A9TMA.shareInvite(inviteLink, activePitch);
      showToast(L('已调起 Telegram 分享', 'Share opened'));
    };
    const promoBtn = root.querySelector('#btn-claim-promo-hot');
    if (promoBtn) {
      promoBtn.onclick = async () => {
        if (!store.fundsEnabled) {
          A9Haptic.warning();
          showToast(L('当前真实模式处于只读验收阶段，推广领奖付款单与 0.06 GRAM 签名暂未开放', 'Live mode is read-only; promo payout intent and 0.06 GRAM signing are disabled'), 'amber');
          return;
        }
        if (config.isDemo) {
          A9Haptic.success();
          const res = store.claimPromoDemo();
          if (res?.error) {
            showToast(res.error, 'amber');
            return;
          }
          showToast(L(`[演示模式] 已模拟领取 ${formatNum(res.amountA9)} A9 (${res.txHash})`, `[Demo] Simulated ${formatNum(res.amountA9)} A9 promo claim`));
          return;
        }
        const wallet = store.state.user.address;
        if (!store.state.user.connected || !wallet) {
          showToast(L('请先连接并验证 TON 钱包后再领取', 'Connect and verify TON wallet first'), 'amber');
          tonConnect.openConnectModal(() => loadLivePromo());
          return;
        }
        if (promoClaimBusy || pendingTxManager.isLocked('promo')) {
          showToast(L('已有推广领币交易正在发放确认中', 'Promo payout already confirming'), 'amber');
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        A9Haptic.light();
        promoClaimBusy = true;
        paint();
        try {
          const intent = await requestPromoClaimIntent(wallet);
          const expectedPromoHot = store.state.round?.protocolConfig?.promoHotWallet?.address || '';
          if (expectedPromoHot && canonicalWalletKey(intent.payTo) !== canonicalWalletKey(expectedPromoHot)) {
            throw new Error(L('领奖目标热钱包地址与协议配置不一致，已拦截签名', 'Promo hot wallet mismatch with protocol config; signature blocked'));
          }
          const feeNano = BigInt(String(intent.feeRequiredNano || '60000000'));
          const feeGramText = formatExactGramFromNano(feeNano);
          const payoutA9 = rawToA9(intent.amountRaw ?? livePromo?.claimableRaw) ?? 0;
          const ok = await tonConnect.confirmBeforeSign({
            title: L('确认推广领币手续费（签名前核验）', 'Confirm Promo A9 Claim Fee'),
            contractLabel: L('推广热钱包 PromoHotWallet', 'PromoHotWallet'),
            targetAddress: intent.payTo,
            principalText: `${formatNum(payoutA9, 2)} A9 (${L('热钱包发放', 'Hot wallet payout')})`,
            gasText: `${feeGramText} GRAM (${L('覆盖链上发放 Gas', 'delivery fee')})`,
            totalText: `${feeGramText} GRAM`,
            memo: intent.memo,
            note: L(`确认支付 ${feeGramText} GRAM 后，推广热钱包将自动核验回执并向当前钱包转入全部可领 A9（项目方 0 Gas）。`, `After paying ${feeGramText} GRAM, PromoHotWallet automatically verifies and sends your A9.`),
            confirmText: L(`确认并支付 ${feeGramText} GRAM 领币`, `Confirm & Pay ${feeGramText} GRAM`),
          });
          if (!ok) return;

          await tonConnect.sendV15PromoFee(intent);
          A9Haptic.success();
          showToast(L(`已支付 ${feeGramText} GRAM 手续费（单号 ${intent.claimId}），热钱包正在自动发放 A9…`, `${feeGramText} GRAM fee sent (claim ${intent.claimId}), awaiting automatic A9 payout…`));
          const pendingTx = pendingTxManager.start({
            kind: 'promo',
            title: '推广 A9 自动发放',
            titleEn: 'Promo A9 Payout',
            amountText: `${formatNum(payoutA9, 2)} A9`,
            explorerAddress: intent.payTo,
            refId: intent.claimId,
            targetRoute: '/team/invite',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const c = await fetchPromoClaim(intent.claimId);
              if (c) {
                lastClaimStatus = c;
                if (root.isConnected) paint();
                if (c.status === 'COMPLETED') {
                  return {
                    confirmed: true,
                    detail: `推广 ${formatNum(payoutA9, 2)} A9 已自动发放至钱包。`,
                    detailEn: `Promo ${formatNum(payoutA9, 2)} A9 credited on-chain.`,
                  };
                }
                if (c.status === 'FAILED' || c.status === 'EXPIRED') {
                  return { terminal: true, claim: c };
                }
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('推广 A9 已发放至你的链上钱包！', 'Promo A9 sent to your wallet!'));
              loadLivePromo();
            },
            onTimeout: () => {
              showToast(L('热钱包发放确认较慢，可点击顶部状态条 Tonviewer 核验', 'Payout confirming slowly; check Tonviewer via top bar'), 'amber');
            },
          }).then((res) => {
            if (res?.terminal && res.result?.claim) {
              const st = res.result.claim.status;
              showToast(
                st === 'EXPIRED'
                  ? L(`领奖单 ${intent.claimId} 已过期，余额已保留，可重新发起领取`, `Claim ${intent.claimId} expired; balance kept`)
                  : L(`领奖单 ${intent.claimId} 发放异常，请核查钱包或在记录中重试`, `Claim ${intent.claimId} failed; please check details`),
                'error',
              );
              loadLivePromo();
            }
          });
          await loadLivePromo();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起推广领奖失败，请重试', 'Promo claim failed'), 'error');
        } finally {
          promoClaimBusy = false;
          if (root.isConnected) paint();
        }
      };
    }
  };

  paint();
  loadLivePromo();
}
