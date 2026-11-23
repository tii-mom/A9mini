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
  rawToA9,
} from '../data.js';
import { tonConnect } from '../tonconnect.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { escapeHtml, formatNum, showToast, copyText, animateSlotCounter, openChoiceSheet, renderProgressRing } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { renderReferralPoster, renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { triggerStoryShare } from '../share.js';

export function renderTeamHome(root, navigate) {
  if (!config.isDemo) {
    root.innerHTML=`<form class="card col-gap"><label>${L('战队编号','Squad ID')} <input name="guild" required maxlength="64"></label><button class="btn btn-primary">${L('申请加入','Join squad')}</button><output></output></form>`;
    portfolioPanel(root,true);
    const form=root.querySelector('form');
    form.onsubmit=async event=>{
      event.preventDefault();
      const wallet=store.state.user.address;
      if(!wallet){tonConnect.openConnectModal(()=>renderTeamHome(root,navigate));return;}
      const button=form.querySelector('button');
      button.disabled=true;
      try {
        await joinTeam({teamId:form.elements.guild.value.trim(),walletAddress:wallet,userId:getEffectiveUserId(store.state.user),referrerId:store.state.referral.referrerId});
        renderTeamHome(root,navigate);
      } catch {
        form.querySelector('output').textContent=L('加入失败，请核对战队编号后重试','Join failed. Check the squad ID and retry.');
        button.disabled=false;
      }
    };return;
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
              <span class="chip chip-gold">+${team.boostPct || 0}% ${L('加成', 'Boost')}</span>
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
            <span class="num-xs text-muted">${L('预估分红', 'Est. 1%')}</span>
            <span class="num-md text-gold" id="captain-dividend-val">${formatNum(team.captainDividendTon || 0, 2)} GRAM</span>
          </div>
        </div>

        <div class="row-between num-xs text-muted" style="margin-bottom:5px;">
          <span>${L('本轮战队冲刺进度', 'Round Sprint Progress')}</span>
          <span class="mono" style="color:var(--ink);font-weight:800;">${progressPct}%</span>
        </div>
        <div class="progress-track" style="margin-bottom:12px;"><div class="progress-fill" style="width:${progressPct}%"></div></div>

        <button class="btn btn-primary" data-nav="/team/invite">${icon('qr', 16)} ${L('生成招募海报 · 12% 邀请奖励', 'Invite Poster · 12% Bonus')}</button>
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
            <div class="guild-member"><img src="./assets/boxheads/wealth/avatars/wlt-0${[5,4,6][i%3]}.png" alt=""><div class="num-sm"><span class="text-gold">${escapeHtml(m.rank)}</span> ${escapeHtml(m.addr)}</div>
              <div class="num-xs text-green mono" style="font-weight:800;">${formatNum(m.ton)} GRAM</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card" style="border-color:var(--gold-border);">
        <div class="row-between" style="margin-bottom:4px;">
          <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('群主创世金库 & 返佣叮咚提醒', 'Captain Bonus & Live DM Alerts')}</span>
          <span class="chip chip-gold">+5,000 A9</span>
        </div>
        <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:8px;">${L('绑定满 50 人真实 TG 群立领 5,000 A9 创世金库；群内每成交 1 笔宝箱订单，Bot 实时私聊播报 12% 返佣到账。', 'Verify a 50+ member TG group for 5,000 A9 founding vault. Bot DMs you live on every 12% chest commission.')}</div>
        <button class="btn btn-secondary btn-sm" data-nav="/internal/market?tab=free" type="button" style="width:100%;">${icon('swap', 14)} ${L('前往宝箱商城冲击黄金/白金/钻石免费宝箱', 'Open Chest Mall Free Tiers')}</button>
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/team/bind-tg">${icon('send', 14)} ${L('管理 TG 群', 'TG Group')}</button>
        <button class="btn btn-secondary" id="btn-broadcast-tg">${icon('bell', 14)} ${L('一键群广播', 'Broadcast')}</button>
      </div>
    `;
  } else if (role === 'member') {
    html = `
      <div class="card card-hero guild-board">
        <div class="row-between" style="margin-bottom:8px;">
          <div>
            <div style="font-size:17px;font-weight:900;">${L('折纸星航战队', 'Origami Voyagers')}</div>
            <div class="row-start" style="margin-top:4px;gap:6px;">
              <span class="chip chip-cyan">${L('成员', 'Member')} · Lv.3</span>
              <span class="chip chip-gold">+10% ${L('加成', 'Boost')}</span>
            </div>
          </div>
          ${rolePill}
        </div>
        <div class="num-xs text-muted" style="margin-bottom:6px;">${L('升级进度 84% · 差 16 人升级 Lv.4 (+15%)', '84% · 16 more for Lv.4 (+15%)')}</div>
        <div class="progress-track" style="margin-bottom:10px;"><div class="progress-fill" style="width:84%"></div></div>

        <div class="metric-strip">
          <div class="metric-cell"><span class="num-xs text-muted">${L('团队加成收益', 'Squad Bonus')}</span><span class="num-md text-green">+184,200 A9</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('邀友奖励', 'Invite Rewards')}</span><span class="num-md text-gold">+96,500 A9</span></div>
        </div>
        <button class="btn btn-primary" data-nav="/team/invite">${icon('qr', 16)} ${L('邀请好友 · 冲击 Lv.4 (+15%)', 'Invite Friends · Reach +15%')}</button>
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
      { id: 'TM-0001', name: L('暖棉纸冒险团', 'Paper Craft Squad'), lv: 'Lv.4', boost: '+15%', members: '412/500' },
      { id: 'TM-8829', name: L('折纸星航战队', 'Origami Voyagers'), lv: 'Lv.3', boost: '+10%', members: '84/100' },
      { id: 'TM-3042', name: L('金箔典藏战队', 'Gold Foil Collectors'), lv: 'Lv.3', boost: '+10%', members: '66/100' }
    ];
    html = `
      <div class="card card-hero guild-board">
        <div class="row-between" style="margin-bottom:6px;">
          <span class="chip chip-gold">${L('未加入战队 · 最高 +15%', 'No Squad · Up to +15%')}</span>
          ${rolePill}
        </div>
        <div style="font-size:17px;font-weight:900;">${L('加入一个活跃战队', 'Join an Active Squad')}</div>
        <div class="text-sec" style="font-size:12px;margin-top:4px;">${L('免费加入后，自动提升每轮收益分配与兑换屋可用额度。', 'Join free to boost round rewards and exchange quota.')}</div>
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
                <div style="font-weight:800;">${s.name}</div>
                <div class="num-xs text-muted">${s.lv} · ${s.members} ${L('人', 'members')}</div>
              </div>
              <div class="row-start" style="gap:6px;">
                <span class="chip chip-gold">${s.boost}</span>
                <button class="btn btn-primary btn-sm" data-join-team="${s.id}">${L('加入', 'Join')}</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  root.innerHTML = `<div class="col-gap anim-page-enter">${html}</div>`;

  const divEl = root.querySelector('#captain-dividend-val');
  if (divEl) animateSlotCounter(divEl, Number(team.captainDividendTon) || 0, { duration: 600, decimals: 2, suffix: ' GRAM' });

  const roleBtn = root.querySelector('#btn-role-sheet');
  if (roleBtn) {
    roleBtn.onclick = () => openChoiceSheet({
      title: L('切换团队角色视角', 'Switch Squad View'),
      selected: role,
      options: [
        { value: 'captain', label: L('队长指挥中枢', 'Captain Console'), sub: L('查看全队质押与 1% 实时分红', 'Team volume & 1% live fee') },
        { value: 'member',  label: L('普通成员视图', 'Member View'),     sub: L('查看团队加成与升级进度', 'Squad boost & level progress') },
        { value: 'none',    label: L('未加入 · 团队大厅', 'Squad Lobby'), sub: L('浏览并一键加入精英团队', 'Browse & join top squads') }
      ],
      onSelect: (val) => {
        store.update(s => { s.team.role = val; });
        renderTeamHome(root, navigate);
      }
    });
  }

  const bcBtn = root.querySelector('#btn-broadcast-tg');
  if (bcBtn) bcBtn.onclick = () => { A9Haptic.success(); showToast(L(`已广播至 ${team.tgGroupHandle}`, `Broadcasted to ${team.tgGroupHandle}`)); };

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
        <span class="chip chip-gold">#${safeId} · Lv.4</span>
        <div class="row-start" style="font-size:20px;font-weight:700;margin-top:8px;">${L('暖棉纸冒险团', 'Paper Craft Squad')} ${icon('shieldCheck', 18, 'text-green')}</div>
        <div class="metric-strip cols-3">
          <div class="metric-cell"><span class="num-xs text-muted">${L('加成', 'Boost')}</span><span class="num-md text-green">+15%</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('成员', 'Members')}</span><span class="num-md">412</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('质押', 'Staked')}</span><span class="num-md">580,000</span></div>
        </div>
        <button class="btn btn-primary" data-nav="/challenge/confirm">${icon('bolt', 16)} ${L('加入并参与质押', 'Join & Stake')}</button>
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
              3. ${L('必须先将官方 Bot 拉入群且队长具备群管理员权限；核验通过且群人数 ≥ 50 人，自动向队长金库发放 5,000 A9 创世激活金（每群限 1 次）。', 'Bot must be in group and captain must be admin. Verified groups with 50+ members grant a one-time 5,000 A9 captain founding bonus.')}<br>
              4. ${L('同一真实群 ID（tgChatId）仅允许绑定 1 个战队；群内成员每次购箱返佣 12%，Bot 将私聊通知队长。', 'One tgChatId binds at most one squad; Bot DMs the captain on every 12% referral credit.')}
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
    unbound:   { chip: 'chip-muted', label: L('未绑定', 'Unbound'),  desc: L('将 @A9Terminal_bot 设为群管理员即可绑定。', 'Add @A9Terminal_bot as admin to bind.'), btn: L('一键绑定 TG 群', 'Bind TG Group') },
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
            <span class="card-title">${icon('send', 15, 'text-gold')} ${bindState === 'unbound' ? L('未关联群组', 'No Group') : team.tgGroupHandle}</span>
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
  const addrTail = (user.shortAddress || 'A9USER').slice(-4);
  const inviteLink = `${window.location.origin}${window.location.pathname}?mode=${config.mode}&startapp=invite_${team.id || 'A9'}_${addrTail}`;
  let template = 'invite';
  let livePromo = null;
  let livePromoErr = null;
  let promoClaimBusy = false;
  let lastClaimStatus = null;

  const pitchText = L(
    `来 A9 广场查看轮次闯关与战队：${inviteLink}`,
    `Explore A9 Plaza, Round Quest and Squads: ${inviteLink}`
  );

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

  const pollPromoClaimStatus = async (claimId) => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!root.isConnected) return null;
      try {
        const c = await fetchPromoClaim(claimId);
        if (c) {
          lastClaimStatus = c;
          paint();
          if (c.status === 'COMPLETED' || c.status === 'FAILED') return c;
        }
      } catch (_) {}
    }
    return null;
  };

  const paint = () => {
    const claimableA9 = livePromo ? (rawToA9(livePromo.claimableRaw) ?? 0) : null;
    const totalClaimedA9 = livePromo ? (rawToA9(livePromo.totalClaimedRaw) ?? 0) : null;
    const canLiveClaim = !config.isDemo && store.fundsEnabled;

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:6px;">
            <span class="card-title">${icon('wallet', 15, 'text-gold')} ${L('邀友与宝箱推广余额', 'Invite & Promo Balance')}</span>
            <span class="chip ${config.isDemo ? 'chip-green' : canLiveClaim ? 'chip-green' : 'chip-gold'}">${config.isDemo ? 'DEMO' : canLiveClaim ? L('已开放', 'OPEN') : L('只读模式', 'READ-ONLY')}</span>
          </div>
          ${config.isDemo
            ? `<div class="num-xs text-sec">${L('演示邀友奖励（不会发起真实钱包交易）', 'Demo invite rewards (no real wallet tx)')}</div>`
            : livePromo
              ? `<div class="metric-strip cols-2" style="margin:8px 0 4px;">
                  <div class="metric-cell"><span class="num-xs text-muted">${L('当前可领 A9', 'Claimable A9')}</span><span class="num-md text-green mono">${formatNum(claimableA9, 2)} A9</span></div>
                  <div class="metric-cell"><span class="num-xs text-muted">${L('累计已领 A9', 'Total Claimed')}</span><span class="num-md mono">${formatNum(totalClaimedA9, 2)} A9</span></div>
                </div>`
              : `<div class="num-xs text-sec">${escapeHtml(livePromoErr || (store.state.user.address ? L('正在读取真实推广余额…', 'Loading promo balance…') : L('连接并验证 TON 钱包后可查看可领余额', 'Connect and verify wallet to view claimable balance')))}</div>`}
          ${lastClaimStatus ? `<div class="num-xs text-green mono" style="margin-top:6px;">${L('最近领奖单', 'Latest claim')}: ${escapeHtml(lastClaimStatus.claimId)} · ${escapeHtml(lastClaimStatus.status)}${lastClaimStatus.payoutTxHash ? ` · ${escapeHtml(lastClaimStatus.payoutTxHash.slice(0, 14))}…` : ''}</div>` : ''}
          <button class="btn ${config.isDemo || canLiveClaim ? 'btn-primary' : 'btn-secondary'} btn-sm" id="btn-claim-promo-hot" style="width:100%;margin-top:12px;" ${promoClaimBusy ? 'disabled' : ''}>${icon(store.fundsEnabled ? 'wallet' : 'lock', 14)} ${config.isDemo
            ? L('领取邀友奖励（演示模拟 0.06 GRAM）', 'Claim Invite Rewards (Demo 0.06 GRAM)')
            : canLiveClaim
              ? (promoClaimBusy ? L('等待 0.06 GRAM 签名确认…', 'Waiting for 0.06 GRAM tx…') : L('领取推广 A9（付 0.06 GRAM 链上 Gas）', 'Claim Promo A9 (0.06 GRAM Gas)'))
              : L('真实模式只读 · 邀友领奖暂未开放', 'Read-Only Mode · Invite Claim Disabled')}</button>
          ${!config.isDemo && !canLiveClaim ? `<div class="num-xs text-muted" id="live-readonly-promo-notice" style="margin-top:6px;">${L('当前真实模式仅支持只读浏览与连接钱包，暂不创建 0.06 GRAM 付款单或发起签名。', 'Live mode is read-only; no 0.06 GRAM payment intent or signature will be created.')}</div>` : ''}
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${template === 'invite' ? 'active' : ''}" data-tpl="invite">${L('招募海报', 'Invite')}</button>
          <button class="seg-tab ${template === 'flex' ? 'active' : ''}" data-tpl="flex">${L('战绩卡', 'Flex')}</button>
          <button class="seg-tab ${template === 'story' ? 'active' : ''}" data-tpl="story">${L('9:16 Story 战报', '9:16 Story')}</button>
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
          <div class="share-copy-box">${pitchText}</div>
        </div>

        ${config.isDemo ? `<div class="card">
          <div class="card-header">
            <span class="card-title">${icon('team', 15)} ${L('被邀请人列表 (18) · 演示样例', 'Invitees (18) · Demo sample')}</span>
            <span class="num-xs text-muted">${L('有效 16 人', '16 Valid')}</span>
          </div>
          <div class="col-gap">
            <div class="list-row"><div><div class="num-sm">UQ...8892</div><div class="num-xs text-muted">5,000 GRAM · 2.0x</div></div><span class="chip chip-green">${L('已达标', 'Passed')}</span></div>
            <div class="list-row"><div><div class="num-sm">EQ...3312</div><div class="num-xs text-muted">2,000 GRAM · 2.0x</div></div><span class="chip chip-gold">${L('观察中', 'Live')}</span></div>
            <div class="list-row"><div><div class="num-sm">UQ...77ea</div><div class="num-xs text-muted">0 GRAM</div></div><span class="chip chip-muted">${L('待参与', 'Pending')}</span></div>
          </div>
        </div>` : `<div class="card">
          <div class="card-header"><span class="card-title">${icon('team', 15)} ${L('被邀请人列表', 'Invitees')}</span></div>
          <div class="num-xs text-muted">${L('暂无数据：真实邀请记录需服务端确认后显示。', 'No data yet: invite records appear after server confirmation.')}</div>
        </div>`}
      </div>
    `;

    const canvas = root.querySelector('#a9-poster-canvas');
    if (template === 'story') renderStoryPoster(canvas, { roundId: store.state.round.currentRound });
    else if (template === 'flex') renderProofFlexPoster(canvas, store.state.certificates[0]);
    else renderReferralPoster(canvas);

    root.querySelectorAll('[data-tpl]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); template = b.dataset.tpl; paint(); };
    });

    root.querySelector('#btn-dl-poster').onclick = () => {
      A9Haptic.success();
      const name = template === 'story' ? 'A9-Story-9x16.png' : template === 'flex' ? 'A9-Yield-Flex.png' : 'A9-Invite-Poster.png';
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
    root.querySelector('#btn-copy-pitch').onclick = () => copyText(pitchText, L('已复制群推话术', 'Copied pitch'));
    root.querySelector('#btn-tg-share').onclick = () => {
      A9TMA.shareInvite(inviteLink, pitchText);
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
        promoClaimBusy = true;
        paint();
        try {
          const intent = await requestPromoClaimIntent(wallet);
          await tonConnect.sendV15PromoFee(intent);
          A9Haptic.success();
          showToast(L(`已支付 0.06 GRAM 手续费（单号 ${intent.claimId}），热钱包正在自动发放 A9…`, `0.06 GRAM fee sent (claim ${intent.claimId}), awaiting automatic A9 payout…`));
          const finalClaim = await pollPromoClaimStatus(intent.claimId);
          if (finalClaim?.status === 'COMPLETED') {
            showToast(L('推广 A9 已发放至你的链上钱包！', 'Promo A9 sent to your wallet!'));
          }
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
