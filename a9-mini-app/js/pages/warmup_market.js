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
import { SHOP_SCALLOP_AWNING } from '../paper-art.js';

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

  const roundLabel = round.currentRound
    ? L(`第 ${round.currentRound} 轮开局预热 (12H)`, `R${round.currentRound} Pre-Round (12H)`)
    : L('开局预热待核验', 'Pre-Round Pending');
  const cdText = round.earlyBirdSec === null || round.earlyBirdSec === undefined
    ? '—'
    : formatTimer(round.earlyBirdSec);

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between" style="margin-bottom:10px;">
          <span class="chip chip-gold">${roundLabel}</span>
          <span class="row-start num-sm text-sec">${icon('clock', 13)} <span id="early-cd" class="mono">${cdText}</span></span>
        </div>
        <div class="num-xs text-muted">${L('本轮开局预热池', 'Pre-Round Pool')}</div>
        <div class="num-hero" style="margin-top:4px;">${config.isDemo ? '8,000,000 <span class="num-md text-green">A9</span>' : L('待核验', 'Awaiting verification')}</div>

        ${config.isDemo ? `
        <div class="metric-strip cols-3">
          <div class="metric-cell"><span class="num-xs text-muted">${L('有效直邀', 'Invites')}</span><span class="num-md">${reg ? user.warmupInvites : 0}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('预热排名', 'Rank')}</span><span class="num-md text-gold">${reg ? 'No.08' : '--'}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('预计奖励', 'Est. A9')}</span><span class="num-md text-green">${!reg ? '0' : '400,000'}</span></div>
        </div>
        ` : ''}

        ${!reg
          ? `<button class="btn btn-primary" id="btn-register-warmup">${icon('bolt', 16)} ${L('立即报名开局预热 (需 ≥1 有效直邀)', 'Join Pre-Round (≥1 Invite)')}</button>`
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
        ${config.isDemo ? `
        <div class="col-gap">
          <div class="list-row"><b>${L('第 1–10 名', 'Top 1–10')}</b><span class="num-sm text-green">400,000 A9 / ${L('人', 'ea')}</span></div>
          <div class="list-row"><b>${L('第 11–25 名', 'Top 11–25')}</b><span class="num-sm text-gold">160,000 A9 / ${L('人', 'ea')}</span></div>
          <div class="list-row"><b>${L('第 26–50 名', 'Top 26–50')}</b><span class="num-sm text-sec">64,000 A9 / ${L('人', 'ea')}</span></div>
        </div>
        ` : `<div class="num-xs text-muted">${L('预热奖池与阶梯发放标准等待服务端公布后展示。', 'Warm-up reward tiers await server publication.')}</div>`}
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/warmup/rank">${icon('trophy', 15)} ${L('早鸟先锋榜', 'Early Bird Board')}</button>
        <button class="btn btn-secondary" id="btn-copy-invite">${icon('copy', 15)} ${L('复制邀请链', 'Copy Link')}</button>
      </div>

      ${reg ? `<button class="btn btn-sm" id="btn-cancel-warmup" style="width:100%;background:transparent;color:var(--text-muted);font-weight:500;">${L('取消本轮开局预热报名', 'Cancel Pre-Round Registration')}</button>` : ''}
    </div>
  `;

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
          showToast(L('开局预热报名成功', 'Pre-Round registered'));
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
      A9TMA.shareInvite(inviteUrl, config.isDemo ? 'A9 8,000,000 A9 Pre-Round Pool' : L('A9 协议开局预热入口', 'A9 Protocol Pre-Round'));
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
      if (!store.state.round.currentRound) {
        panel.textContent=L('暂无预热排名','No warm-up rankings yet');
        return;
      }
      panel.textContent=L('正在读取早鸟先锋榜','Loading early bird rankings');
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
          <button class="seg-tab ${tab === 'personal' ? 'active' : ''}" data-wt="personal">${L('个人先锋榜 (前50)', 'Top 50 Users')}</button>
          <button class="seg-tab ${tab === 'team' ? 'active' : ''}" data-wt="team">${L('战队先锋榜', 'Top Squads')}</button>
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
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero exchange-counter">
          ${SHOP_SCALLOP_AWNING}
          <div class="shop-counter-body">
            <header class="counter-keeper">
              <div class="counter-keeper-left">
                <img src="./assets/wealthverse/game/a8.png" alt="">
                <div>
                  <h2>${L('A9 兑换屋 · 固定汇率兑换柜台', 'A9 Exchange · Fixed-Rate Counter')}</h2>
                  <div class="num-xs text-muted">${L('1 GRAM = 2,002 A9 协议固定报价 · 单笔 5–200 GRAM', '1 GRAM = 2,002 A9 fixed quote · 5–200 GRAM per order')}</div>
                </div>
              </div>
              <span class="chip chip-gold">${L('只读模式', 'READ-ONLY')}</span>
            </header>
            <div class="sub-tile" style="margin-bottom:12px;">
              <div class="row-between num-xs"><span class="text-sec">${L('钱包可用额度', 'Wallet quota')}</span><b class="mono">${L('待核验', 'Pending')}</b></div>
              <div class="row-between num-xs" style="margin-top:6px;"><span class="text-sec">${L('当前兑换报价', 'Swap rate')}</span><b class="mono">${L('待核验', 'Pending')}</b></div>
            </div>
            <p class="num-xs text-sec" style="margin:0 0 12px;line-height:1.5;">${L('真实模式下固定兑换入口暂未开放，不会发起下单或钱包签名。', 'Live fixed-rate swaps are currently disabled. No order or wallet signature will be triggered.')}</p>
            <button class="btn btn-secondary" disabled id="btn-buy-market">${icon('lock', 15)} ${L('真实模式只读 · 暂未开放兑换', 'Live read-only · swap disabled')}</button>
          </div>
        </section>
        <a class="btn btn-secondary" href="#/internal/records">${icon('receipt', 15)} ${L('查看兑换小票', 'Exchange Receipts')}</a>
      </div>`;
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
        <div class="text-sec" style="font-size:12px;max-width:280px;">${L('A9 兑换屋与战队加成功能必须绑定 Telegram 身份，点击下方 1 秒完成绑定。', 'A9 Exchange & squad boost require Telegram binding. Complete in 1 tap.')}</div>
        <button class="btn btn-primary" id="sheet-bind-tg-btn" style="margin-top:10px;">${icon('checkCircle', 16)} ${L('立即绑定 Telegram', 'Bind Telegram Now')}</button>
        <button class="btn btn-secondary" id="sheet-bind-cancel">${L('稍后再说', 'Later')}</button>
      </div>
    `);
    document.getElementById('sheet-bind-cancel').onclick = closeModal;
    document.getElementById('sheet-bind-tg-btn').onclick = () => {
      A9Haptic.success();
      store.update(s => { s.user.tgBound = true; });
      closeModal();
      showToast(L('Telegram 账号已绑定，可立即兑换', 'Telegram bound! Ready to swap.'));
      if (afterBind) afterBind();
    };
  };

  const render = () => {
    const estA9 = Math.round(payTon * market.rateA9PerTon);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero exchange-counter ${market.soldOut ? 'card-glow-red' : ''}">
          ${SHOP_SCALLOP_AWNING}
          <div class="shop-counter-body">
          <header class="counter-keeper">
            <div class="counter-keeper-left">
              <img src="./assets/wealthverse/game/a8.png" alt="">
              <div>
                <h2>${L('A9 兑换屋 · 固定汇率兑换柜台', 'A9 Exchange · Fixed-Rate Counter')}</h2>
                <div class="num-xs text-muted mono">1 GRAM = ${formatNum(market.rateA9PerTon)} A9 · ${L('单笔 5–200 GRAM 协议固定报价', '5–200 GRAM fixed protocol quote')}</div>
              </div>
            </div>
            <span class="chip ${market.soldOut ? 'chip-red' : !user.tgBound ? 'chip-amber' : 'chip-green'}">${market.soldOut ? L('已售罄', 'SOLD OUT') : !user.tgBound ? L('需绑定 TG', 'BIND TG') : L('演示开放', 'DEMO OPEN')}</span>
          </header>

          ${market.soldOut ? `
            <div class="sub-tile" style="border-color:var(--red-border);margin-bottom:12px;">
              <div class="row-start text-red" style="font-weight:800;font-size:12px;margin-bottom:4px;">${icon('shieldAlert', 15)} ${L('本轮兑换已售罄', 'Sold Out')}</div>
              <div class="num-xs text-sec">${L('售罄触发被动退款（≥1 GRAM 免手续费原路退回；主动撤单扣 0.05 GRAM；≤0.1 GRAM 粉尘不退）。', 'Passive refunds ≥1 GRAM are free. Voluntary fee: 0.05 GRAM. Dust ≤0.1 GRAM non-refundable.')}</div>
            </div>
          ` : ''}

          <label for="market-ton-input" class="counter-label">${L('1. 输入支付金额', '1. You Pay')}</label>
          <div class="input-box">
            <input id="market-ton-input" type="number" min="5" max="200" value="${payTon}" ${market.soldOut ? 'disabled' : ''} />
            <div class="row-start" style="gap:6px;flex-shrink:0;">
              <button class="chip chip-blue" id="btn-market-max" type="button" style="cursor:pointer;">MAX</button>
              <span class="caps text-sec">GRAM</span>
            </div>
          </div>
          <div class="grid-4" style="margin:9px 0 12px;">
            ${[20, 50, 100, 200].map(v => `<button class="quick-btn ${payTon === v ? 'active' : ''}" aria-pressed="${payTon === v}" data-qton="${v}" type="button">${v} GRAM</button>`).join('')}
          </div>

          <div class="sub-tile row-between exchange-receipt">
            <div class="row-start" style="gap:8px;">
              <img src="./assets/paper-craft/ticket.png" alt="">
              <div>
                <div class="num-xs text-muted">${L('2. 预计获得（估算）', '2. Estimated Receive')}</div>
                <div class="num-xs text-sec">${L('按当前汇率折算', 'At current fixed rate')}</div>
              </div>
            </div>
            <span class="num-lg text-green" id="market-est-a9">${formatNum(estA9)} A9</span>
          </div>

          <div class="shop-terms-row">
            <span>${L('3. 单笔 5–200 GRAM', '3. 5–200 GRAM/order')}</span>
            <span>${L('可用额度', 'Avail')} <b class="mono" style="color:var(--ink);">${formatNum(availQuota)} GRAM</b></span>
          </div>

          <button class="btn ${config.isDemo ? 'btn-primary' : 'btn-secondary'}" id="btn-buy-market" ${config.isDemo && (market.soldOut || availQuota <= 0) ? 'disabled' : ''}>
            ${!config.isDemo
              ? `${icon('lock', 15)} ${L('真实模式只读 · 暂未开放兑换', 'Live Read-Only · Disabled')}`
              : market.soldOut
                ? L('本轮已售罄', 'Sold Out')
                : !user.tgBound
                  ? `${icon('send', 15)} ${L('绑定 Telegram 并兑换', 'Bind TG & Swap')}`
                  : `${icon('bolt', 16)} ${L(`确认兑换 ${formatNum(estA9)} A9`, `Swap ${formatNum(estA9)} A9`)}`}
          </button>
          </div>
        </div>

        <div class="card">
          <div class="row-between" style="margin-bottom:10px;">
            <div class="card-title" style="font-size:14px;">${icon('wallet', 15, 'text-green')} ${L('个人额度', 'Personal Quota')}</div>
            <span class="num-sm mono">${formatNum(market.unlockedQuotaTon)} <span class="text-muted">/ ${formatNum(market.hardCapTon)} GRAM</span></span>
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
                <div style="font-weight:600;font-size:14px;">${L('兑换小票', 'Exchange Receipts')}</div>
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
        showToast(L('当前真实模式处于只读验收阶段，兑换屋下单与钱包签名暂未开放', 'Live mode is read-only; exchange orders and wallet signing are disabled'), 'amber');
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
          <div class="card-title">${icon('receipt', 15)} ${L('兑换小票', 'Exchange Receipts')}</div>
          <span class="chip chip-muted">${records.length}</span>
        </div>
        ${records.length === 0 ? `
          <div class="empty-state"><div class="num-sm text-muted">${L('暂无兑换小票', 'No receipts yet')}</div></div>
        ` : `
          <div class="col-gap">
            ${records.map(r => `
              <div class="list-row">
                <div>
                  <div class="num-sm">${formatNum(r.a9)} A9 <span class="num-xs text-muted">(-${r.ton} GRAM)</span></div>
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
