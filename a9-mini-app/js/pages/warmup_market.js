import { personalRanks, teamRanks } from '../demo-data.js';
import { fetchWarmupRank } from '../data.js';
/**
 * Warm-up & Internal Market Pages — Aligned Rules + Zero-Friction Drawers
 * - Warm-up: 8,000,000 A9 full number, 4-state distribution status, discreet cancel link
 * - Warm-up Rank: Personal Top 50 + Team Warm-up Board toggle + freeze note
 * - Internal Market: Inline TG-Binding Sheet if unbound + 4-state order records
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { registerWarmup, getEffectiveUserId } from '../data.js';
import { tonConnect } from '../tonconnect.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { formatNum, formatTimer, showToast, copyText, burstParticles, openModal, closeModal } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';

export function renderWarmupHome(root, navigate) {
  const { user, round } = store.state;
  const reg = user.warmupRegistered;
  const safeAddr = (user.shortAddress || 'A9USER').replace(/[^a-zA-Z0-9]/g, '');
  const inviteUrl = `${window.location.origin}${window.location.pathname}?startapp=invite_${safeAddr}`;

  const distSteps = [
    { key: 'pending_freeze', label: L('待冻结 (T)', 'Freeze (T)') },
    { key: 'confirming',     label: L('名单确认 (T+24H)', 'Verify (T+24H)') },
    { key: 'distributing',   label: L('自动发放中', 'Sending') },
    { key: 'done',           label: L('已发放 (T+48H)', 'Sent (T+48H)') }
  ];

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between" style="margin-bottom:10px;">
          <span class="chip chip-gold">${L(`第 ${round.currentRound} 轮预热 (12H)`, `R${round.currentRound} Warm-Up (12H)`)}</span>
          <span class="row-start num-sm text-sec">${icon('clock', 13)} <span id="early-cd" class="mono">${formatTimer(round.earlyBirdSec)}</span></span>
        </div>
        <div class="num-xs text-muted">${L('本轮预热奖励池', 'Warm-Up Pool')}</div>
        <div class="num-hero" style="margin-top:4px;">8,000,000 <span class="num-md text-green">A9</span></div>

        <div class="metric-strip cols-3">
          <div class="metric-cell"><span class="num-xs text-muted">${L('有效直邀', 'Invites')}</span><span class="num-md">${reg ? user.warmupInvites : 0}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('预热排名', 'Rank')}</span><span class="num-md text-gold">${reg && config.isDemo ? 'No.08' : '--'}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('预计奖励', 'Est. A9')}</span><span class="num-md text-green">${!reg ? '0' : (config.isDemo ? '400,000' : L('待核验', 'Pending'))}</span></div>
        </div>

        ${!reg
          ? `<button class="btn btn-primary" id="btn-register-warmup">${icon('bolt', 16)} ${L('立即报名预热 (需 ≥1 有效直邀)', 'Join Warm-Up (≥1 Invite)')}</button>`
          : `<button class="btn btn-primary" id="btn-share-warmup">${icon('send', 15)} ${L('分享冲榜 · 冲击前 10 名', 'Share to Reach Top 10')}</button>`
        }
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('clock', 15, 'text-gold')} ${L('热钱包自动发放进度', 'Auto-Distribution Timeline')}</div>
          <span class="chip chip-green">${L('无需手动领取', 'Auto-Drop')}</span>
        </div>
        <div class="grid-2">
          ${distSteps.map((st, idx) => `
            <div class="list-row" style="${idx === 0 ? 'border-color:var(--gold-border);' : ''}">
              <span class="num-xs ${idx === 0 ? 'text-gold' : 'text-muted'}">${idx + 1}. ${st.label}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('trophy', 15, 'text-gold')} ${L('前 50 名阶梯奖励', 'Top 50 Tiers')}</div>
        </div>
        <div class="col-gap">
          <div class="list-row"><b>${L('第 1–10 名', 'Top 1–10')}</b><span class="num-sm text-green">400,000 A9 / ${L('人', 'ea')}</span></div>
          <div class="list-row"><b>${L('第 11–25 名', 'Top 11–25')}</b><span class="num-sm text-gold">160,000 A9 / ${L('人', 'ea')}</span></div>
          <div class="list-row"><b>${L('第 26–50 名', 'Top 26–50')}</b><span class="num-sm text-sec">64,000 A9 / ${L('人', 'ea')}</span></div>
        </div>
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/warmup/rank">${icon('trophy', 15)} ${L('预热榜', 'Board')}</button>
        <button class="btn btn-secondary" id="btn-copy-invite">${icon('copy', 15)} ${L('复制邀请链', 'Copy Link')}</button>
      </div>

      ${reg ? `<button class="btn btn-sm" id="btn-cancel-warmup" style="width:100%;background:transparent;color:var(--text-muted);font-weight:500;">${L('取消本轮预热报名', 'Cancel Warm-Up Registration')}</button>` : ''}
    </div>
  `;

  if (!config.isDemo) {
    root.querySelector('.num-hero').textContent=L('待核验','Awaiting verification');
    root.querySelector('.metric-strip').remove();
  }
  const regBtn = root.querySelector('#btn-register-warmup');
  if (regBtn) {
    regBtn.onclick = async () => {
      if (!config.isDemo) {
        const uid = getEffectiveUserId(user);
        if (!uid) {
          showToast(L('请在 Telegram 内打开或先连接 TON 钱包', 'Open in Telegram or connect TON wallet first'), 'amber');
          tonConnect.openConnectModal(() => renderWarmupHome(root, navigate));
          return;
        }
        regBtn.disabled = true;
        try {
          await registerWarmup({ walletAddress: user.address, userId: uid, referrerId: store.state.referral.referrerId });
          A9Haptic.success();
          burstParticles(regBtn);
          store.update(s => { s.user.warmupRegistered = true; });
          showToast(L('预热报名成功', 'Warm-Up registered'));
          renderWarmupHome(root, navigate);
        } catch (e) {
          showToast(e?.message || L('预热报名失败，请重试', 'Registration failed'), 'error');
          regBtn.disabled = false;
        }
        return;
      }
      A9Haptic.success();
      store.update(s => { s.user.warmupRegistered = true; });
      burstParticles(regBtn);
      showToast(L('报名成功 · 当前排位 No.08', 'Joined · Rank #08'));
      renderWarmupHome(root, navigate);
    };
  }
  const shareBtn = root.querySelector('#btn-share-warmup');
  if (shareBtn) {
    shareBtn.onclick = () => {
      A9TMA.shareInvite(inviteUrl, 'A9 8,000,000 A9 Warm-Up Pool');
      showToast(L('已调起分享', 'Share opened'));
    };
  }
  const cancelBtn = root.querySelector('#btn-cancel-warmup');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      A9Haptic.warning();
      store.update(s => { s.user.warmupRegistered = false; });
      showToast(L('已取消本轮预热报名', 'Registration cancelled'), 'amber');
      renderWarmupHome(root, navigate);
    };
  }
  root.querySelector('#btn-copy-invite').onclick = () => copyText(inviteUrl, L('已复制链接', 'Copied'));
}

export function renderWarmupRank(root) {
  if (!config.isDemo) {
    const panel=document.createElement('div');
    panel.className='card col-gap';
    root.replaceChildren(panel);
    const load=async()=>{
      panel.textContent=L('正在读取预热榜','Loading warm-up rankings');
      try {
        const rows=await fetchWarmupRank(store.state.round.currentRound);
        panel.textContent=L('预热邀请榜','Warm-up invites');
        for(const entry of rows) {
          const row=document.createElement('div');row.className='list-row';
          row.textContent='#'+entry.rank+' · '+entry.walletAddress+' · '+entry.validInvites+' '+L('邀请','invites');panel.append(row);
        }
        if (!rows.length) panel.textContent=L('暂无预热排名','No warm-up rankings yet');
      } catch {
        panel.textContent=L('榜单暂不可读取','Rankings unavailable');
        const retry=document.createElement('button');retry.className='btn btn-secondary';retry.textContent=L('重试','Retry');retry.onclick=load;panel.append(retry);
      }
    };load();return;
  }
  let tab = 'personal';
  const paint = () => {
    const rows = tab === 'personal' ? personalRanks : teamRanks;
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card" style="border-color:var(--gold-border);">
          <div class="row-between">
            <div>
              <div class="num-xs text-gold">${L('前 50 名守门员门槛 · 每 5 分钟刷新', 'Top 50 Cutoff · Refreshes 5m')}</div>
              <div style="font-size:14px;font-weight:700;margin-top:3px;">≥ 6 ${L('名有效直邀 (冻结后 T+24H 公示)', 'Valid Invites (Final at T+24H)')}</div>
            </div>
            <span class="chip chip-green">DEMO</span>
          </div>
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${tab === 'personal' ? 'active' : ''}" data-wt="personal">${L('个人预热榜 (前50)', 'Top 50 Users')}</button>
          <button class="seg-tab ${tab === 'team' ? 'active' : ''}" data-wt="team">${L('团队预热榜', 'Top Teams')}</button>
        </div>

        <div class="card">
          <div class="col-gap">
            ${rows.map(item => `
              <div class="list-row ${item.me ? 'is-me' : ''}">
                <div class="row-start">
                  <span class="chip ${item.me ? 'chip-green' : item.cutoff ? 'chip-gold' : 'chip-muted'}">#${item.r}</span>
                  <span class="num-sm" style="font-weight:${item.me ? '700' : '500'};">${item.addr}</span>
                </div>
                <div style="text-align:right;">
                  <div class="num-sm text-green" style="font-weight:600;">${item.reward}</div>
                  <div class="num-xs text-muted">${item.invites} ${L('人', 'inv')}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    root.querySelectorAll('[data-wt]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); tab = b.dataset.wt; paint(); };
    });
  };
  paint();
}

export function renderInternalMarket(root, navigate) {
  const { market, user } = store.state;
  if (!config.isDemo) {
    root.innerHTML = `<section class="card col-gap"><h2>${L('内盘额度','Market quota')}</h2><p>${L('钱包额度与报价等待核验。真实购买已关闭。','Wallet quota and price await verification. Live purchases are disabled.')}</p><button class="btn btn-secondary" disabled id="btn-buy-market">${L('真实模式只读','Live read-only')}</button><a href="#/internal/records">${L('订单记录','Order history')}</a></section>`;
    return;
  }
  const unlocked = Number(market.unlockedQuotaTon) || 0;
  const used = Number(market.usedQuotaTon) || 0;
  const hardCap = Number(market.hardCapTon) || 1;
  const availQuota = Math.max(0, unlocked - used);
  const usedPct = Math.min(100, Math.round((used / hardCap) * 100));
  const availPct = Math.min(100 - usedPct, Math.round((availQuota / hardCap) * 100));
  let payTon = Math.min(100, availQuota || 100);

  const openTgBindSheet = (afterBind) => {
    openModal(`
      <div class="sheet-handle"></div>
      <div class="empty-state" style="padding:14px 6px;">
        <div class="icon-badge gold" style="width:48px;height:48px;border-radius:14px;">${icon('send', 22)}</div>
        <div style="font-size:17px;font-weight:700;margin-top:4px;">${L('需要绑定 Telegram 账号', 'Telegram Binding Required')}</div>
        <div class="text-sec" style="font-size:12px;max-width:280px;">${L('内盘购买与团队加成功能必须绑定 Telegram 身份，点击下方 1 秒完成绑定。', 'Internal market & team boost require Telegram binding. Complete in 1 tap.')}</div>
        <button class="btn btn-primary" id="sheet-bind-tg-btn" style="margin-top:10px;">${icon('checkCircle', 16)} ${L('立即绑定 Telegram', 'Bind Telegram Now')}</button>
        <button class="btn btn-secondary" id="sheet-bind-cancel">${L('稍后再说', 'Later')}</button>
      </div>
    `);
    document.getElementById('sheet-bind-cancel').onclick = closeModal;
    document.getElementById('sheet-bind-tg-btn').onclick = () => {
      A9Haptic.success();
      store.update(s => { s.user.tgBound = true; });
      closeModal();
      showToast(L('Telegram 账号已绑定，可立即购买', 'Telegram bound! Ready to buy.'));
      if (afterBind) afterBind();
    };
  };

  const render = () => {
    const estA9 = payTon * market.rateA9PerTon;
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero exchange-counter ${market.soldOut ? 'card-glow-red' : ''}">
          <header class="counter-keeper"><img src="./assets/wealthverse/game/a8.webp" alt=""><h2>${L('兑换柜台','Exchange counter')}</h2></header><div class="row-between" style="margin-bottom:14px;">
            <span class="chip chip-muted">1 TON = ${formatNum(market.rateA9PerTon)} A9</span>
            <span class="chip ${market.soldOut ? 'chip-red' : !user.tgBound ? 'chip-amber' : 'chip-green'}">${market.soldOut ? L('已售罄', 'SOLD OUT') : !user.tgBound ? L('需绑定 TG', 'BIND TG') : L('开放中', 'OPEN')}</span>
          </div>

          ${market.soldOut ? `
            <div class="sub-tile" style="border-color:var(--red-border);margin-bottom:14px;">
              <div class="row-start text-red" style="font-weight:700;font-size:12px;margin-bottom:4px;">${icon('shieldAlert', 15)} ${L('本轮内盘已售罄', 'Presale Sold Out')}</div>
              <div class="num-xs text-sec">${L('售罄或关闭触发被动退款（≥1 TON 免手续费原路退回；主动退款扣 0.05 TON；≤0.1 TON 粉尘不退）。', 'Passive refunds ≥1 TON are free. Voluntary refund fee: 0.05 TON. Dust ≤0.1 TON non-refundable.')}</div>
            </div>
          ` : ''}

          <div class="row-between num-xs text-muted" style="margin-bottom:8px;">
            <span>${L('单笔限额 5 – 200 TON', '5 – 200 TON / order')}</span>
            <span>${L('可用额度', 'Avail')} <b style="color:var(--text-primary);">${formatNum(availQuota)} TON</b></span>
          </div>
          <label for="market-ton-input" class="counter-label">${L('支付金额','You pay')}</label><div class="input-box">
            <input id="market-ton-input" type="number" min="5" max="200" value="${payTon}" ${market.soldOut ? 'disabled' : ''} />
            <div class="row-start" style="gap:6px;flex-shrink:0;">
              <button class="chip chip-green" id="btn-market-max" type="button" style="cursor:pointer;">MAX</button>
              <span class="caps text-sec">TON</span>
            </div>
          </div>
          <div class="grid-4" style="margin:10px 0 14px;">
            ${[20, 50, 100, 200].map(v => `<button class="quick-btn ${payTon === v ? 'active' : ''}" aria-pressed="${payTon === v}" data-qton="${v}" type="button">${v} TON</button>`).join('')}
          </div>

          <div class="sub-tile row-between exchange-receipt" style="margin-bottom:14px;"><img src="./assets/wealthverse/game/purse.webp" alt="">
            <span class="num-xs text-muted">${L('预计获得', 'Estimated Receive')}</span>
            <span class="num-lg text-green" id="market-est-a9">${formatNum(estA9)} A9</span>
          </div>

          ${!config.isDemo ? `
            <div class="sub-tile" id="live-readonly-market-notice" style="border-color:var(--gold-border);margin-bottom:14px;">
              <div class="row-start text-gold" style="font-weight:700;font-size:12px;margin-bottom:4px;">${icon('shieldAlert', 15)} ${L('真实只读模式 · 暂未开放内盘下单与付款', 'Live Read-Only · Presale Disabled')}</div>
              <div class="num-xs text-sec">${L('当前真实模式仅支持只读查看与钱包连接，不会创建内盘支付单或唤起钱包签名。', 'Live mode is read-only; no presale order intent or wallet signature will be triggered.')}</div>
            </div>
          ` : ''}

          <button class="btn ${config.isDemo ? 'btn-primary' : 'btn-secondary'}" id="btn-buy-market" ${config.isDemo && (market.soldOut || availQuota <= 0) ? 'disabled' : ''}>
            ${!config.isDemo
              ? `${icon('lock', 15)} ${L('真实模式只读 · 暂未开放内盘购买', 'Read-Only Mode · Presale Disabled')}`
              : market.soldOut
                ? L('内盘已售罄', 'Sold Out')
                : !user.tgBound
                  ? `${icon('send', 15)} ${L('绑定 Telegram 并购买', 'Bind TG & Buy')}`
                  : `${icon('bolt', 16)} ${L(`购买 ${formatNum(estA9)} A9`, `Buy ${formatNum(estA9)} A9`)}`}
          </button>
        </div>

        <div class="card">
          <div class="row-between" style="margin-bottom:10px;">
            <div class="card-title" style="font-size:14px;">${icon('wallet', 15, 'text-green')} ${L('个人额度', 'Personal Quota')}</div>
            <span class="num-sm mono">${formatNum(market.unlockedQuotaTon)} <span class="text-muted">/ ${formatNum(market.hardCapTon)} TON</span></span>
          </div>
          <div class="progress-track" style="display:flex;height:7px;margin-bottom:12px;">
            <div style="width:${usedPct}%;background:var(--text-muted);opacity:0.45;"></div>
            <div style="width:${availPct}%;background:var(--green);"></div>
          </div>
          <div class="grid-4" style="gap:8px;">
            <div class="sub-tile" style="padding:8px 6px;text-align:center;"><div class="num-xs text-muted">${L('基础', 'Base')}</div><div class="num-sm" style="margin-top:2px;">200</div></div>
            <div class="sub-tile" style="padding:8px 6px;text-align:center;"><div class="num-xs text-muted">${L('团队', 'Team')}</div><div class="num-sm" style="margin-top:2px;">50</div></div>
            <div class="sub-tile" style="padding:8px 6px;text-align:center;"><div class="num-xs text-muted">${L('规模', 'Scale')}</div><div class="num-sm" style="margin-top:2px;">150</div></div>
            <div class="sub-tile" style="padding:8px 6px;text-align:center;"><div class="num-xs text-muted">${L('邀请', 'Invite')}</div><div class="num-sm text-green" style="margin-top:2px;">350</div></div>
          </div>
        </div>

        <div class="card" style="padding:14px 18px;">
          <div class="list-row clickable" data-nav="/internal/records" style="padding:0;">
            <div class="row-start">
              <span class="icon-badge sky" style="width:36px;height:36px;border-radius:11px;">${icon('receipt', 15)}</span>
              <div>
                <div style="font-weight:600;font-size:14px;">${L('内盘购买记录', 'Presale Order History')}</div>
                <div class="num-xs text-muted">${L(`共 ${market.records.length} 笔订单 · 含成交与退款明细`, `${market.records.length} orders · fills & refunds`)}</div>
              </div>
            </div>
            <span class="text-muted">${icon('chevronRight', 16)}</span>
          </div>
        </div>
      </div>
    `;

    const inp = root.querySelector('#market-ton-input');
    inp.oninput = (e) => {
      payTon = Number(e.target.value) || 0;
      root.querySelectorAll('[data-qton]').forEach(button => {
        const selected = Number(button.dataset.qton) === payTon;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      const a9 = payTon * market.rateA9PerTon;
      root.querySelector('#market-est-a9').textContent = `${formatNum(a9)} A9`;
      const btn = root.querySelector('#btn-buy-market');
      if (btn && config.isDemo && !market.soldOut && user.tgBound) btn.innerHTML = `${icon('bolt', 16)} ${L(`购买 ${formatNum(a9)} A9`, `Buy ${formatNum(a9)} A9`)}`;
    };

    const maxBtn = root.querySelector('#btn-market-max');
    if (maxBtn) {
      maxBtn.onclick = () => {
        if (market.soldOut) return;
        A9Haptic.light();
        payTon = Math.min(market.maxOrderTon, availQuota);
        render();
      };
    }

    root.querySelectorAll('[data-qton]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); payTon = Number(b.dataset.qton); render(); };
    });

    const buyBtn = root.querySelector('#btn-buy-market');
    buyBtn.onclick = async () => {
      if (!config.isDemo || !store.fundsEnabled) {
        A9Haptic.warning();
        showToast(L('当前真实模式处于只读验收阶段，内盘买单与钱包签名暂未开放', 'Live mode is read-only; presale orders and wallet signing are disabled'), 'amber');
        return;
      }
      if (!user.tgBound) {
        openTgBindSheet(render);
        return;
      }
      const res = store.buyInternalMarket(payTon);
      if (res.error) {
        A9Haptic.error();
        showToast(res.error, 'error');
      } else {
        A9Haptic.success();
        burstParticles(buyBtn);
        showToast(L(`购买成功 · +${formatNum(res.receivedA9)} A9`, `Purchased · +${formatNum(res.receivedA9)} A9`));
        render();
      }
    };
  };

  render();
}

export function renderInternalRecords(root) {
  const { records } = store.state.market;
  const badgeCls = (st) => st === '已成交' ? 'chip-green' : st === '退款中' ? 'chip-gold' : st === '已退款' ? 'chip-muted' : 'chip-gold';

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('receipt', 15)} ${L('内盘购买记录', 'Market Records')}</div>
          <span class="chip chip-muted">${records.length}</span>
        </div>
        ${records.length === 0 ? `
          <div class="empty-state"><div class="num-sm text-muted">${L('暂无内盘订单', 'No orders yet')}</div></div>
        ` : `
          <div class="col-gap">
            ${records.map(r => `
              <div class="list-row">
                <div>
                  <div class="num-sm">${formatNum(r.a9)} A9 <span class="num-xs text-muted">(-${r.ton} TON)</span></div>
                  <div class="num-xs text-muted">${r.time} · ${r.hash}</div>
                </div>
                <span class="chip ${badgeCls(r.status)}">${r.status}</span>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}
