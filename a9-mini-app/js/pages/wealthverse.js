import { fetchUserPortfolio } from '../data.js';
import { L } from '../i18n.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { icon } from '../icons.js';

import { tiers, characterArt } from '../wealth-art.js';
const link = (path, label, glyph) =>
  `<a href="#${path}">${icon(glyph, 18)}${label}</a>`;
const waiting = () => L('等待核验', 'Awaiting verification');
function portrait(n) {
  return `<img class="wv-person" src="${characterArt(n)}" alt="A${n}"> `;
}
function hero(title, tag, content = '', figure = '', cls = '') {
  return `<section class="wv-hero ${cls}"><div class="wv-scenery"></div>${figure}<div class="wv-copy"><small>${tag}</small><h1>${title}</h1>${content}</div></section>`;
}
export function stageLabel(stage) {
  const stages = {
    warmup: ['预热', 'Warm-up'],
    participation: ['参与中', 'Entry open'],
    observation: ['观察中', 'Observing'],
    settlement_success: ['已结算 · 达标', 'Settled · passed'],
    settlement_burn: ['已结算 · 未达标', 'Settled · missed'],
    halted: ['技术中止', 'Aborted'],
  };
  return stages[stage] ? L(...stages[stage]) : waiting();
}
export function city() {
  const r = store.state.round;
  const tier = store.state.user.previewTier || 1;
  const title = config.isDemo ? 'A' + tier + ' · ' + L(...tiers[tier - 1].slice(0, 2)) : waiting();
  const gates = [
    ['/internal/market','guild',L('商行','Market')],
    ['/rewards','legendary',L('奖励宝库','Rewards')],
    ['/leaderboard','challenge',L('荣誉排行','Rankings')],
    ['/rules','city',L('玩法规则','Rules')]
  ];
  return `<section class="wv-hero game-city">
    <div class="city-sky"></div>
    <div class="city-mast"><small>A9 WEALTHVERSE</small><h1>${L('财富进化世界','Wealthverse')}</h1></div>
    <a class="city-profile" href="#/gallery"><b>${title}</b><span>${config.isDemo ? L('演示试穿','Demo preview') : L('持仓待核验','Holdings unverified')}</span></a>
    ${config.isDemo && tier === 1 ? '<img class="city-sticker" src="./assets/game-v2/city-sticker.webp" alt="A1">' : config.isDemo ? portrait(tier) : ''}
    <div class="city-controls"><div class="city-round"><i></i>${L('第','Round')} ${r.currentRound ?? '—'} · ${stageLabel(r.stage)}<a href="#/observation/records">${r.qualifiedCandles ?? '—'} / ${r.minQualifiedCandles ?? 16} ›</a></div>
    <a class="game-play" href="#/round">${L('进入轮次挑战','Enter challenge')} <b>›</b></a>
    <nav class="game-gates">${gates.map(([path,asset,label])=>`<a href="#${path}"><img src="./assets/game-v2/stickers/${asset}.webp" alt=""><span>${label}</span></a>`).join('')}</nav>
</div></section>`;
}
export function gallery(root, navigate, param) {
  const n = Number(param) || 1;
  const selected = n >= 1 && n <= 9 && Number.isInteger(n) ? n : 1;
  const [zh, en, detail, desc] = tiers[selected - 1];
  root.innerHTML =
    hero(
      L(zh, en),
      `A${selected} / ${L('角色预览', 'Character preview')}`,
      `<p>${L(detail, desc)}</p>`,
      portrait(selected),
      'wv-gallery-hero',
    ) +
    `<nav class="wv-gallery">${tiers.map(([a, b], i) => `<a href="#/gallery/${i + 1}" aria-current="${i + 1 === selected ? 'true' : 'false'}">${portrait(i + 1)}<b>A${i + 1}</b>${L(a, b)}</a>`).join('')}</nav><div class="card">${L('当前身份与下一阶条件待核验。称谓为设计预览。', 'Identity and next-tier conditions await verification. Titles are previews.')}</div><button class="btn btn-primary" id="wv-export">${L('保存角色预览卡', 'Save preview card')}</button>`;
  root.style.setProperty('--wv-hue', (selected - 1) * 19 + 'deg');
  if (config.isDemo) {
    const preview = document.createElement('button');
    preview.className = 'btn btn-secondary';
    preview.textContent = L('在演示主城试穿', 'Preview in demo city');
    preview.onclick = () => {
      store.update((state) => {
        state.user.previewTier = selected;
      });
      navigate('/challenge');
    };
    root.append(preview);
  }
  root.querySelector('#wv-export').onclick = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 960;
    const ctx = canvas.getContext('2d');
    const img = root.querySelector('.wv-hero .wv-person');
    if (img && !img.complete) await img.decode().catch(()=>{});
    const gradient = ctx.createLinearGradient(0, 0, 720, 960);
    gradient.addColorStop(0, '#573c98');
    gradient.addColorStop(1, '#171331');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 720, 960);
    if (img?.complete && img.naturalWidth) ctx.drawImage(img, 75, 95, 570, 640);
    ctx.fillStyle = '#ffe3a4';
    ctx.font = 'bold 52px sans-serif';
    ctx.fillText(`A${selected} · ${L(zh, en)}`, 45, 775);
    ctx.fillStyle = 'white';
    ctx.font = '27px sans-serif';
    ctx.fillText(
      L('A9 财富进化世界 · 角色预览', 'A9 Wealthverse · Character Preview'),
      45,
      860,
    );
    const a = document.createElement('a');
    a.href = canvas.toDataURL();
    a.download = `A9-preview-${selected}.png`;
    a.click();
  };
}
export function rewards(root) {
  const n = store.state.round.successCount;
  const u = store.state.user;
  const amounts = [
    [
      L('已解锁待领取', 'Unlocked and claimable'),
      config.isDemo ? u.a9Claimable : null,
    ],
    [L('待解锁', 'Locked'), config.isDemo ? u.a9Locked : null],
    [L('已销毁', 'Burned'), null],
  ];
  const balances = amounts
    .map(
      ([label, amount]) =>
        `<div class="list-row"><span>${label}</span><b>${amount == null ? waiting() : amount.toLocaleString('en-US') + ' A9'}</b></div>`,
    )
    .join('');

  const crystals = [
    ['basic', L('初阶', 'Basic')],
    ['starlight', L('星辉', 'Starlight')],
    ['legendary', L('传说', 'Legendary')],
  ];
  const crystalPreview = `<section class="card"><h2 class="card-title">${L('水晶美术预览', 'Crystal art preview')}</h2>
    <div class="crystal-preview">${crystals.map(([id, name]) => `<figure><img src="./assets/game-v2/stickers/${id}.webp" alt="" loading="lazy"><figcaption>${name}</figcaption></figure>`).join('')}</div></section>`;
  root.innerHTML =
    hero(
      L('奖励宝库', 'Reward Vault'),
      'A9 / TREASURY',
      `<p>${L('全网累计成功', 'Global successes')} · ${n ?? waiting()}</p>`,
      '',
      'wv-vault',
    ) +
    `<div class="wv-steps">${[
      ['1–5', '20%', '4 × 20%'],
      ['6–10', '40%', '2 × 30%'],
      ['11+', '100%', '—'],
    ]
      .map(
        ([range, pct, rest], i) =>
          `<article class="${n > 0 && (n <= 5 ? 0 : n <= 10 ? 1 : 2) === i ? 'current' : ''}"><small>${L('累计成功', 'Wins')} ${range}</small><strong>${pct}</strong>${L('即时解锁', 'Immediate')}<p>${rest}</p></article>`,
      )
      .join(
        '',
      )}</div><div class="card">${balances}</div><div class="card">${L('失败可能销毁此前未解锁的份额。轮次持续至奖池耗尽。', 'Failure can burn prior locked shares. Rounds continue until pool exhaustion.')}</div>${crystalPreview}<nav class="wv-links">${link('/claim', L('领取明细', 'Claim details'), 'unlock')}${link('/profile', L('我的资产', 'My assets'), 'wallet')}</nav>`;
}
export function tower(round) {
  const labels = {
    unknown: L('数据暂缺', 'Unavailable'),
    pending: L('未开始', 'Upcoming'),
    active: L('观察中', 'Observing'),
    pass: L('达标', 'Met'),
    miss: L('未达标', 'Missed'),
  };
  return `<section class="wv-tower"><small>24H / OBSERVATORY</small><h2>${L('财富挑战塔', 'Challenge Tower')}</h2><div class="wv-windows">${Array.from(
    { length: 24 },
    (_, i) => {
      const c = round.candles?.[i];
      const state = c?.confirmed
        ? c.bull
          ? 'pass'
          : 'miss'
        : labels[c?.status]
          ? c.status
          : 'unknown';
      return `<span data-state="${state}"><b>${String(i + 1).padStart(2, '0')}</b>${labels[state]}</span>`;
    },
  ).join(
    '',
  )}</div><p>${round.qualifiedCandles ?? '—'} / 16 · ${round.qualifiedCandles >= 16 && round.stage === 'observation' ? L('等待结算', 'Awaiting settlement') : L('达标门槛', 'Qualifying threshold')}</p></section>`;
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
export function portfolioPanel(root, guild = false) {
  const { user } = store.state;
  const panel = document.createElement('section');
  panel.className = 'card col-gap';
  root.prepend(panel);
  const links = guild
    ? [
        ['/team/profile', '商会资料', 'Guild profile'],
        ['/team/bind-tg', '群组绑定', 'Group binding'],
        ['/team/invite', '邀请', 'Invite'],
        ['/leaderboard', '排行榜', 'Rankings'],
      ]
    : [
        ['/claim', '领取明细', 'Claims'],
        ['/ledger', '账单', 'Ledger'],
        ['/records', '历史领取', 'History'],
        ['/proof', '质押凭证', 'Tickets'],
        ['/settings', '设置', 'Settings'],
      ];
  function show(data, state) {
    panel.replaceChildren();
    const row = (label, value) => {
      const el = document.createElement('div');
      el.className = 'list-row';
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('b');
      amount.textContent = value;
      el.append(name, amount);
      panel.append(el);
    };
    if (guild) {
      row(L('商会', 'Guild'), data?.team?.name || waiting());
      row(L('成员', 'Members'), data?.team?.memberCount ?? waiting());
      row(
        L('职位', 'Role'),
        data?.team?.captainWallet === user.address && user.address
          ? L('会长', 'Captain')
          : data?.team
            ? L('成员', 'Member')
            : waiting(),
      );
    } else {
      // 后端已严格区分数据不可用（a9BalanceRaw === null / balanceAvailable === false）与真实链上余额（含真实 0）。
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
          L('凭证本金 · 轮次', 'Ticket principal · round') +
            ' ' +
            ticket.roundId,
          exactA9(ticket.amountRaw),
        );
      if (!active.length) row(L('质押中 A9', 'Staked A9'), waiting());
      for (const labels of [
        ['已解锁待领取', 'Unlocked, unclaimed'],
        ['待解锁', 'Locked rewards'],
        ['已销毁', 'Burned shares'],
      ])
        row(L(...labels), waiting());
    }
    const status = document.createElement('p');
    status.textContent = state;
    panel.append(status);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = user.address
      ? L('重新读取', 'Read again')
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
        ? L('正在读取钱包', 'Reading wallet')
        : L('请连接钱包', 'Connect a wallet'),
    );
    if (!addr) return;
    try {
      const data = await fetchUserPortfolio(addr);
      if (
        panel.isConnected &&
        store.state.user.address === addr &&
        data.walletAddress === addr
      )
        show(data, L('来源 · 钱包只读接口', 'Source · read-only wallet API'));
    } catch {
      if (panel.isConnected && store.state.user.address === addr)
        show(null, L('钱包数据读取失败', 'Wallet read failed'));
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
  return `<section class="wv-tower"><small>A9 / ROUND ${r.currentRound ?? '—'}</small><h2>${stageLabel(r.stage)}</h2>
    <p>${L('参与窗口', 'Entry window')} · ${time(r.stakeOpenAt)} — ${time(r.stakeCloseAt)}</p>
    <p>${L('早鸟权重仅影响奖励分配份额', 'Early weights affect allocation only')} · 2.0× / 1.4× / 1.0×</p>
    <p>${L('失败将销毁该轮质押的 A9 本金。', 'Failure burns the A9 principal staked in the round.')}</p>
    <button class="btn btn-secondary" disabled>${L('只读 · 质押签名已关闭', 'Read-only · staking disabled')}</button></section>
    ${tower(r)}<nav class="wv-links">${link('/observation/records', L('时段明细', 'Slot details'), 'clock')}${link('/rewards', L('解锁阶段', 'Vesting'), 'unlock')}${link('/warmup', L('预热', 'Warm-up'), 'bolt')}${link('/rules', L('规则', 'Rules'), 'book')}</nav>`;
}
