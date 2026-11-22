import { portfolioPanel } from './wealthverse.js';
/**
 * Team & Referral Pages — 99-Point Pure Hero First (Zero Top Debug Tabs, Custom Action Sheet, SVG Progress Ring)
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { joinTeam, getEffectiveUserId } from '../data.js';
import { tonConnect } from '../tonconnect.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { escapeHtml, formatNum, showToast, copyText, animateSlotCounter, openChoiceSheet, renderProgressRing } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { renderReferralPoster, renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { triggerStoryShare } from '../share.js';

export function renderTeamHome(root, navigate) {
  if (!config.isDemo) {
    root.innerHTML=`<form class="card col-gap"><label>${L('商会编号','Guild ID')} <input name="guild" required maxlength="64"></label><button class="btn btn-primary">${L('申请加入','Join guild')}</button><output></output></form>`;
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
        form.querySelector('output').textContent=L('加入失败，请核对商会编号后重试','Join failed. Check the guild ID and retry.');
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
        <div class="row-between" style="margin-bottom:12px;">
          <span class="chip chip-green">Lv.${team.level || 1} · +${team.boostPct || 0}%</span>
          ${rolePill}
        </div>
        <div class="row-between" style="align-items:center;">
          <div>
            <div class="row-start" style="font-size:16px;font-weight:700;">${escapeHtml(team.name || L('我的团队', 'My Squad'))} ${icon('shieldCheck', 16, 'text-green')}</div>
            <div class="num-xs text-muted" style="margin-top:6px;">${L('本轮队长预估分红 (1%)', 'Est. Captain Fee (1%)')}</div>
            <div class="num-hero" id="captain-dividend-val" style="margin-top:3px;font-size:30px;">${formatNum(team.captainDividendTon || 0, 2)} <span class="num-sm text-green">TON</span></div>
          </div>
          ${renderProgressRing(progressPct, `${progressPct}%`, 'var(--green)')}
        </div>

        <div class="metric-strip cols-3">
          <div class="metric-cell"><span class="num-xs text-muted">${L('本轮参与', 'Active')}</span><span class="num-sm text-green">${team.membersActive}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('团队总数', 'Total')}</span><span class="num-sm">${team.membersTotal}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('有效邀请', 'Invites')}</span><span class="num-sm text-gold">${team.directInvites}</span></div>
        </div>

        <button class="btn btn-primary" data-nav="/team/invite">${icon('qr', 16)} ${L('生成招募海报 · 邀请奖励 12%', 'Generate Poster · 12% Referral')}</button>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('trophy', 15, 'text-gold')} ${L('团队主力 Top 3', 'Top Squad Members')}</div>
          <div class="row-start" style="gap:6px;">
            <button class="btn btn-secondary btn-sm" data-nav="/leaderboard">${icon('trophy', 12)} ${L('总榜', 'Ranks')}</button>
            <button class="btn btn-secondary btn-sm" data-nav="/team/bind-tg">${icon('send', 12)} ${L('TG 群', 'Group')}</button>
          </div>
        </div>
        <div class="guild-roster">
          ${(team.topMembers || []).length === 0
            ? `<div class="empty-state" style="padding:14px;"><div class="num-xs text-muted">${L('暂无成员数据', 'No members yet')}</div></div>`
            : (team.topMembers || []).map((m,i) => `
            <div class="guild-member"><img src="./assets/wealthverse/game/a${[5,2,3][i%3]}.webp" alt=""><div class="num-sm"><span class="text-gold">${escapeHtml(m.rank)}</span> ${escapeHtml(m.addr)}</div>
              <div class="num-sm text-green">${formatNum(m.ton)} TON</div>
            </div>
          `).join('')}
        </div>
      </div>

      <button class="btn btn-secondary" id="btn-broadcast-tg">${icon('send', 15)} ${L('一键广播至 TG 团队群', 'Broadcast to TG Group')}</button>
    `;
  } else if (role === 'member') {
    html = `
      <div class="card card-hero guild-board">
        <div class="row-between" style="margin-bottom:12px;">
          <span class="chip chip-gold">Lv.3 · +10%</span>
          ${rolePill}
        </div>
        <div class="row-between" style="align-items:center;">
          <div>
            <div style="font-size:18px;font-weight:700;">Cyber Capitalist DAO</div>
            <div class="num-xs text-muted" style="margin-top:4px;">${L('差 16 人升级 Lv.4 (+15%)', '16 more for Lv.4 (+15%)')}</div>
          </div>
          ${renderProgressRing(84, '84%', 'var(--green)')}
        </div>

        <div class="metric-strip">
          <div class="metric-cell"><span class="num-xs text-muted">${L('团队加成收益', 'Squad Bonus')}</span><span class="num-md text-green">+184,200 A9</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('邀请返佣', 'Referral')}</span><span class="num-md text-gold">+96,500 A9</span></div>
        </div>
        <button class="btn btn-primary" data-nav="/team/invite">${icon('qr', 16)} ${L('邀请好友 · 一起升级 +15%', 'Invite Friends · Unlock +15%')}</button>
      </div>

      <div class="grid-3">
        <button class="btn btn-secondary btn-sm" data-nav="/leaderboard" style="width:100%;min-height:44px;">${icon('trophy', 14)} ${L('排行榜', 'Ranks')}</button>
        <button class="btn btn-secondary btn-sm" data-nav="/team/profile/TM-8829" style="width:100%;min-height:44px;">${icon('layers', 14)} ${L('团队主页', 'Squad')}</button>
        <button class="btn btn-secondary btn-sm" id="btn-open-group" style="width:100%;min-height:44px;">${icon('send', 14)} ${L('团队群', 'Chat')}</button>
      </div>
      <div class="row-between num-xs" style="padding:4px 2px;">
        <button class="btn btn-sm" id="btn-switch-team" style="background:transparent;color:var(--text-secondary);padding:0;">${L('切换团队 (每赛季限1次，下轮生效)', 'Switch Team (1/season)')}</button>
        <button class="btn btn-sm" id="btn-leave-team" style="background:transparent;color:var(--red);padding:0;">${L('退出团队', 'Leave')}</button>
      </div>
    `;
  } else {
    const squads = [
      { id: 'TM-0001', name: 'Genesis Alpha Node', lv: 'Lv.4', boost: '+15%', members: '412/500' },
      { id: 'TM-8829', name: 'Cyber Capitalist DAO', lv: 'Lv.3', boost: '+10%', members: '84/100' },
      { id: 'TM-3042', name: 'TON Quant Syndicate', lv: 'Lv.3', boost: '+10%', members: '66/100' }
    ];
    html = `
      <div class="card card-hero guild-board">
        <div class="row-between" style="margin-bottom:8px;">
          <span class="chip chip-gold">${L('最高 +15% 加成', 'Up to +15% Boost')}</span>
          ${rolePill}
        </div>
        <div class="row-between">
          <div>
            <div style="font-size:18px;font-weight:700;">${L('加入精英团队', 'Join a Top Squad')}</div>
            <div class="text-sec" style="font-size:12px;margin-top:4px;">${L('一键免费加入，自动提升每轮收益与内盘额度。', '1-tap free join. Auto-boosts yield & presale quota.')}</div>
          </div>
          <button class="btn btn-secondary btn-sm" data-nav="/leaderboard">${icon('trophy', 13)} ${L('榜单', 'Ranks')}</button>
        </div>
      </div>

      <div class="col-gap">
        ${squads.map(s => `
          <div class="card row-between">
            <div>
              <div style="font-weight:700;">${s.name}</div>
              <div class="num-xs text-muted">${s.lv} · ${s.members}</div>
            </div>
            <div class="row-start">
              <span class="chip chip-gold">${s.boost}</span>
              <button class="btn btn-primary btn-sm" data-join-team="${s.id}">${L('加入', 'Join')}</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  root.innerHTML = `<div class="col-gap anim-page-enter">${html}</div>`;

  const divEl = root.querySelector('#captain-dividend-val');
  if (divEl) animateSlotCounter(divEl, Number(team.captainDividendTon) || 0, { duration: 600, decimals: 2, suffix: ' TON' });

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
        <div class="row-start" style="font-size:20px;font-weight:700;margin-top:8px;">Genesis Alpha Node ${icon('shieldCheck', 18, 'text-green')}</div>
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
    root.innerHTML=`<div class="card">${L('群组绑定状态等待服务端核验','Group binding awaits server verification')}</div>`;
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
      showToast(L('TG 群绑定校验通过', 'TG group verified'));
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

  const pitchText = L(
    `来 A9 财富主城查看轮次挑战与商会：${inviteLink}`,
    `Explore the A9 Wealth City and Guild: ${inviteLink}`
  );

  const paint = () => {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          ${config.isDemo ? L('演示推广奖励','Demo promotion rewards') : L('推广奖励等待核验','Promotion rewards await verification')}
          <button class="btn btn-secondary btn-sm" id="btn-claim-promo-hot" style="width:100%;margin-top:12px;">${icon(config.isDemo ? 'wallet' : 'lock', 14)} ${config.isDemo
            ? L('领取推广奖励（演示模拟 0.06 TON）', 'Claim Promo Rewards (Demo 0.06 TON)')
            : L('真实模式只读 · 推广领奖暂未开放', 'Read-Only Mode · Promo Claim Disabled')}</button>
          ${!config.isDemo ? `<div class="num-xs text-muted" id="live-readonly-promo-notice" style="margin-top:6px;">${L('当前真实模式仅支持只读浏览与连接钱包，暂不创建 0.06 TON 付款单或发起签名。', 'Live mode is read-only; no 0.06 TON payment intent or signature will be created.')}</div>` : ''}
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

        <div class="card">
          <div class="card-header">
            <span class="card-title">${icon('team', 15)} ${L('被邀请人列表 (18)', 'Invitees (18)')}</span>
            <span class="num-xs text-muted">${L('有效 16 人', '16 Valid')}</span>
          </div>
          <div class="col-gap">
            <div class="list-row"><div><div class="num-sm">UQ...8892</div><div class="num-xs text-muted">5,000 TON · 2.0x</div></div><span class="chip chip-green">${L('已达标', 'Passed')}</span></div>
            <div class="list-row"><div><div class="num-sm">EQ...3312</div><div class="num-xs text-muted">2,000 TON · 2.0x</div></div><span class="chip chip-gold">${L('观察中', 'Live')}</span></div>
            <div class="list-row"><div><div class="num-sm">UQ...77ea</div><div class="num-xs text-muted">0 TON</div></div><span class="chip chip-muted">${L('待参与', 'Pending')}</span></div>
          </div>
        </div>
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
        if (!config.isDemo || !store.fundsEnabled) {
          A9Haptic.warning();
          showToast(L('当前真实模式处于只读验收阶段，推广领奖付款单与 0.06 TON 签名暂未开放', 'Live mode is read-only; promo payout intent and 0.06 TON signing are disabled'), 'amber');
          return;
        }
        A9Haptic.success();
        const res = store.claimPromoDemo();
        if (res?.error) {
          showToast(res.error, 'amber');
          return;
        }
        showToast(L(`[演示模式] 已模拟领取 ${formatNum(res.amountA9)} A9 (${res.txHash})`, `[Demo] Simulated ${formatNum(res.amountA9)} A9 promo claim`));
      };
    }
  };

  paint();
}
