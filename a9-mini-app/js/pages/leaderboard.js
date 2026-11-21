/**
 * Leaderboard Page (/leaderboard) — Custom Action Sheet + Seamless Metric Strip + Zero Native <select>
 */

import { A9Haptic } from '../tma.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { openChoiceSheet } from '../components.js';

const ROUND_META = {
  R3: { zh: '第 3 轮 · 观察中', en: 'Round #3 · Live', target: '$0.1850', est: '$0.1895', bars: '12/16', pct: 75 },
  R2: { zh: '第 2 轮 · 已清算', en: 'Round #2 · Paid', target: '$0.1420', est: '$0.1618', bars: '19/16', pct: 100 },
  R1: { zh: '第 1 轮 · 创世轮', en: 'Round #1 · Genesis', target: '$0.1100', est: '$0.1325', bars: '21/16', pct: 100 }
};

const DATA = {
  personal: [
    { rank: '01', name: 'UQ...9F21', ton: '52,000 GRAM', a9: '13,104,000 A9' },
    { rank: '02', name: 'EQ...4A18', ton: '38,000 GRAM', a9: '9,576,000 A9' },
    { rank: '03', name: 'UQ...B702', ton: '25,000 GRAM', a9: '6,300,000 A9' },
    { rank: '04', name: 'EQ...81E3', ton: '18,500 GRAM', a9: '4,662,000 A9' },
    { rank: '08', name: 'UQ...489f (Me)', ton: '5,000 GRAM', a9: '1,260,000 A9', me: true }
  ],
  team: [
    { rank: '01', name: 'Genesis Alpha Node', ton: '580,000 GRAM', a9: '120,000,000 A9', me: true },
    { rank: '02', name: 'TON Quant Syndicate', ton: '462,000 GRAM', a9: '94,200,000 A9' },
    { rank: '03', name: 'Obsidian Whales DAO', ton: '295,000 GRAM', a9: '61,500,000 A9' }
  ],
  invite: [
    { rank: '01', name: 'UQ...9F21', ton: '42 Invites', a9: '320,000 A9' },
    { rank: '02', name: 'EQ...4A18', ton: '36 Invites', a9: '284,000 A9' },
    { rank: '03', name: 'UQ...489f (Me)', ton: '18 Invites', a9: '96,500 A9', me: true }
  ]
};

export function renderLeaderboard(root) {
  let activeTab = 'personal';
  let activeRound = 'R3';

  const render = () => {
    const rows = DATA[activeTab];
    const meta = ROUND_META[activeRound];
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:4px;">
            <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('本轮战报', 'Round Stats')}</span>
            <button class="pill-trigger neutral" id="btn-lb-round" type="button">${L(meta.zh, meta.en)} ${icon('chevronDown', 12)}</button>
          </div>
          <div class="metric-strip cols-3" style="margin-bottom:10px;">
            <div class="metric-cell"><span class="num-xs text-muted">${L('目标价', 'Target')}</span><span class="num-md">${meta.target}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('均价', 'TWAP')}</span><span class="num-md text-green">${meta.est}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('达标线', 'Bars')}</span><span class="num-md text-gold">${meta.bars}</span></div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${meta.pct}%"></div></div>
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${activeTab === 'personal' ? 'active' : ''}" data-ltab="personal">${L('个人榜', 'Traders')}</button>
          <button class="seg-tab ${activeTab === 'team' ? 'active' : ''}" data-ltab="team">${L('团队榜', 'Squads')}</button>
          <button class="seg-tab ${activeTab === 'invite' ? 'active' : ''}" data-ltab="invite">${L('邀请榜', 'Invites')}</button>
        </div>

        <div class="card">
          <div class="col-gap">
            ${rows.map(r => `
              <div class="list-row ${r.me ? 'is-me' : ''}">
                <div class="row-start">
                  <span class="chip ${r.rank === '01' ? 'chip-green' : r.me ? 'chip-green' : 'chip-muted'}">#${r.rank}</span>
                  <div>
                    <div class="num-sm" style="font-weight:${r.me ? '700' : '600'};">${r.name}</div>
                    <div class="num-xs text-muted">${r.ton}</div>
                  </div>
                </div>
                <div class="num-sm text-green" style="font-weight:600;">${r.a9}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    root.querySelector('#btn-lb-round').onclick = () => openChoiceSheet({
      title: L('选择历史轮次战报', 'Select Round Report'),
      selected: activeRound,
      options: [
        { value: 'R3', label: L(ROUND_META.R3.zh, ROUND_META.R3.en), sub: '700,000,000 A9 · 12/16' },
        { value: 'R2', label: L(ROUND_META.R2.zh, ROUND_META.R2.en), sub: '600,000,000 A9 · +412%' },
        { value: 'R1', label: L(ROUND_META.R1.zh, ROUND_META.R1.en), sub: '500,000,000 A9 · Genesis' }
      ],
      onSelect: (val) => { activeRound = val; render(); }
    });

    root.querySelectorAll('[data-ltab]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); activeTab = b.dataset.ltab; render(); };
    });
  };

  render();
}
