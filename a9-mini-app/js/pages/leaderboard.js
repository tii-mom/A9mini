/**
 * Leaderboard Page (/leaderboard) — Custom Action Sheet + Seamless Metric Strip + Zero Native <select>
 */

import { A9Haptic } from '../tma.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { openChoiceSheet } from '../components.js';

import { characterArt } from '../wealth-art.js';
import { config } from '../config.js';
import { ROUND_META, DEMO_RANKS as DATA } from '../demo-data.js';

export function renderLeaderboard(root) {
  if (!config.isDemo) {
    root.innerHTML = '<section class="wv-tower"><small>A9 / HALL OF FAME</small><h2>'+L('财富排行榜','Wealth Rankings')+'</h2><p>'+L('个人榜、商会榜及邀请榜等待核验。','Personal, guild and invitation rankings await verification.')+'</p></section>';
    return;
  }
  let activeTab = 'personal';
  let activeRound = 'R3';

  const render = () => {
    const rows = DATA[activeTab];
    const meta = ROUND_META[activeRound];
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:4px;">
            <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('演示战报', 'Demo Round Stats')}</span>
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

        <div class="wv-podium">${[1,0,2].map(i=>`<div class="rank-${i+1}"><img class="wv-person" src="${characterArt(i+1)}" alt=""><b>#${i+1}</b><small>${rows[i].name}</small></div>`).join('')}</div>
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
