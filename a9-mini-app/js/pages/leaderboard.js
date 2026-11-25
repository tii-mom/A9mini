import { renderNintendoGateIcon } from '../paper-art.js';
/**
 * 财富榜 (/leaderboard) — 轻战报摘要 + Top 3 立牌领奖台 + 紧凑完整列表 + 状态记忆
 */

import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { openChoiceSheet, escapeHtml } from '../components.js';
import { uiMemory } from '../app.js';
import { characterArt } from '../wealth-art.js';
import { config } from '../config.js';
import { ROUND_META, DEMO_RANKS as DATA } from '../demo-data.js';

export function renderLeaderboard(root) {
  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card empty-state">
          <span class="nt-art-badge tone-gold" aria-hidden="true">${renderNintendoGateIcon('trophy', 36)}</span>
          <div style="font-size:16px;font-weight:900;">${L('榜单数据待核验', 'Rankings awaiting verification')}</div>
          <div class="num-xs text-sec" style="max-width:260px;">${L('个人榜、战队榜与邀请榜将在服务端同步后展示。', 'Personal, squad and invite rankings appear once synced from the server.')}</div>
          <a class="btn btn-secondary btn-sm" style="margin-top:8px;" href="#/challenge">${L('返回广场', 'Back to Plaza')}</a>
        </section>
      </div>`;
    return;
  }

  let activeTab = uiMemory.leaderboardTab || 'personal';
  let activeRound = uiMemory.leaderboardRound || 'R3';

  const render = () => {
    uiMemory.leaderboardTab = activeTab;
    uiMemory.leaderboardRound = activeRound;
    const rows = DATA[activeTab];
    const meta = ROUND_META[activeRound];
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card">
          <div class="row-between" style="margin-bottom:6px;">
            <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('轮次战报摘要', 'Round Summary')}</span>
            <button class="pill-trigger neutral" id="btn-lb-round" type="button">${L(meta.zh, meta.en)} ${icon('chevronDown', 12)}</button>
          </div>
          <div class="metric-strip cols-3" style="margin:6px 0 8px;padding:8px 0;">
            <div class="metric-cell"><span class="num-xs text-muted">${L('目标底价', 'Target')}</span><span class="num-sm">${meta.target}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('判定均价', 'TWAP')}</span><span class="num-sm text-green">${meta.est}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('达标进度', 'Slots')}</span><span class="num-sm text-gold">${meta.bars}</span></div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${meta.pct}%"></div></div>
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${activeTab === 'personal' ? 'active' : ''}" data-ltab="personal">${L('个人榜', 'Traders')}</button>
          <button class="seg-tab ${activeTab === 'team' ? 'active' : ''}" data-ltab="team">${L('战队榜', 'Squads')}</button>
          <button class="seg-tab ${activeTab === 'invite' ? 'active' : ''}" data-ltab="invite">${L('邀请榜', 'Invites')}</button>
        </div>

        <div class="wv-podium">${[1, 0, 2].map(i => `<div class="rank-${i + 1}"><img class="wv-person" src="${characterArt(9 - i, 'activity')}" alt="" width="64" height="64" loading="lazy" decoding="async"><b>#${i + 1}</b><small>${escapeHtml(rows[i].name)}</small></div>`).join('')}</div>

        <div class="card">
          <div class="card-header" style="margin-bottom:4px;">
            <span class="card-title">${L('完整排名', 'Full Rankings')}</span>
            <span class="chip chip-muted">DEMO</span>
          </div>
          <div>
            ${rows.map(r => `
              <div class="list-row ${r.me ? 'is-me' : ''}">
                <div class="row-start">
                  <span class="chip ${r.rank === '01' ? 'chip-gold' : r.me ? 'chip-green' : 'chip-muted'}" style="min-width:34px;">#${escapeHtml(r.rank)}</span>
                  <div>
                    <div class="num-sm" style="font-weight:${r.me ? '800' : '700'};">${escapeHtml(r.name)}</div>
                    <div class="num-xs text-muted">${escapeHtml(r.ton)}</div>
                  </div>
                </div>
                <div class="num-sm text-green" style="font-weight:800;">${escapeHtml(r.a9)}</div>
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
      b.onclick = () => { A9Haptic.light(); A9Audio.tick(); activeTab = b.dataset.ltab; render(); };
    });
  };

  render();
}
