/**
 * A9 High-DPI HTML5 Canvas Poster Studio (2 Templates)
 * 1. renderReferralPoster(canvas) — 700,000,000 A9 Invite & 10% Referral Poster
 * 2. renderProofFlexPoster(canvas, cert) — Collectible Stake Proof / Yield Flex Card
 */

import { store } from './store.js';
import { formatNum } from './components.js';

function drawQrMatrix(ctx, x, y, size, seedStr) {
  const cells = 21;
  const cell = size / cells;
  ctx.fillStyle = '#F5F7FA';
  ctx.fillRect(x - 10, y - 10, size + 20, size + 20);

  const drawFinder = (gx, gy) => {
    ctx.fillStyle = '#060708';
    ctx.fillRect(x + gx * cell, y + gy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#F5F7FA';
    ctx.fillRect(x + (gx + 1) * cell, y + (gy + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#060708';
    ctx.fillRect(x + (gx + 2) * cell, y + (gy + 2) * cell, 3 * cell, 3 * cell);
  };
  drawFinder(0, 0);
  drawFinder(cells - 7, 0);
  drawFinder(0, cells - 7);

  let hash = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    hash ^= seedStr.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  ctx.fillStyle = '#060708';
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const inFinder = (r < 8 && c < 8) || (r < 8 && c >= cells - 8) || (r >= cells - 8 && c < 8);
      if (inFinder) continue;
      hash = Math.imul(hash ^ (r * 31 + c * 17), 16777619);
      if ((hash >>> 0) % 2 === 0) {
        ctx.fillRect(x + c * cell, y + r * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
}

function drawOrbitalLines(ctx, W, light) {
  ctx.save();
  ctx.strokeStyle = light ? 'rgba(11, 11, 13, 0.06)' : 'rgba(250, 102, 15, 0.17)';
  ctx.lineWidth = 1.25;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.ellipse(W * 0.78, 170, 140 + i * 36, 78 + i * 24, -0.35, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBaseFrame(ctx, W, H, light = false) {
  if (light) {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#E8ECF4');
    bgGrad.addColorStop(1, '#E0E5F0');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
  } else {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#030304');
    bgGrad.addColorStop(0.55, '#131726');
    bgGrad.addColorStop(1, '#1F2439');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
  }

  const glowNeon = ctx.createRadialGradient(W * 0.78, 150, 12, W * 0.78, 150, 440);
  glowNeon.addColorStop(0, light ? 'rgba(242, 92, 5, 0.11)' : 'rgba(250, 102, 15, 0.24)');
  glowNeon.addColorStop(1, 'rgba(250, 102, 15, 0)');
  ctx.fillStyle = glowNeon;
  ctx.fillRect(0, 0, W, H);

  drawOrbitalLines(ctx, W, light);

  ctx.strokeStyle = light ? 'rgba(22, 27, 46, 0.10)' : 'rgba(226, 234, 255, 0.15)';
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, W - 56, H - 56);

  // Corner laser crop marks
  ctx.strokeStyle = light ? '#F25C05' : '#FA660F';
  ctx.lineWidth = 3;
  const m = 28; const s = 22;
  [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(([x, y, dx, dy]) => {
    ctx.beginPath(); ctx.moveTo(x, y + dy * s); ctx.lineTo(x, y); ctx.lineTo(x + dx * s, y); ctx.stroke();
  });
}

export function renderReferralPoster(canvas) {
  if (!canvas) return;
  const W = 780; const H = 1100;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { team, round, user } = store.state;
  const light = document.documentElement.dataset.theme !== 'dark';
  const accent = light ? '#F25C05' : '#FA660F';
  const fg = light ? '#161B2E' : '#F4F6FA';
  const sub = light ? '#4E566E' : '#9DA5BC';
  const muted = light ? '#7F879E' : '#69728C';
  const panel = light ? 'rgba(255, 255, 255, 0.86)' : 'rgba(31, 36, 57, 0.62)';
  const border = light ? 'rgba(22, 27, 46, 0.09)' : 'rgba(226, 234, 255, 0.14)';

  drawBaseFrame(ctx, W, H, light);

  ctx.fillStyle = accent;
  ctx.beginPath(); ctx.arc(68, 84, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = '700 28px "JetBrains Mono", monospace';
  ctx.fillText('A9 // TON TERMINAL', 92, 94);
  ctx.fillStyle = sub;
  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.fillText(`ROUND #0${round.currentRound}  ·  2.0X EARLY BIRD`, 62, 138);

  ctx.fillStyle = fg;
  ctx.font = '700 54px "JetBrains Mono", monospace';
  ctx.fillText('700,000,000', 62, 236);
  ctx.fillStyle = accent;
  ctx.font = '700 32px "JetBrains Mono", monospace';
  ctx.fillText('A9 PRIZE POOL', 62, 286);
  ctx.fillStyle = sub;
  ctx.font = '500 22px "Inter", sans-serif';
  ctx.fillText('邀请奖励 12%  ·  团队奖励 18%', 62, 338);

  ctx.fillStyle = panel;
  ctx.fillRect(60, 388, W - 120, 260);
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.strokeRect(60, 388, W - 120, 260);

  const safeTeamId = team.id || 'A9-0001';
  const safeTeamName = team.name || 'A9 Genesis Squad';
  const safeAddr = user.shortAddress || 'A9USER';

  ctx.fillStyle = sub;
  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.fillText(`SYNDICATE #${safeTeamId}  ·  LV.${team.level || 1} GENESIS`, 90, 434);
  ctx.fillStyle = fg;
  ctx.font = '700 32px "Inter", sans-serif';
  ctx.fillText(safeTeamName, 90, 482);

  [
    { label: 'TEAM VOLUME', val: `${formatNum(team.teamStakedTon || 0)} GRAM`, color: fg },
    { label: 'SQUAD BOOST', val: `+${team.boostPct || 0}.0%`, color: fg },
    { label: 'REFERRAL', val: '12% LIVE', color: accent }
  ].forEach((item, i) => {
    const mx = 90 + i * 205;
    ctx.fillStyle = muted; ctx.font = '600 15px "JetBrains Mono", monospace'; ctx.fillText(item.label, mx, 550);
    ctx.fillStyle = item.color; ctx.font = '700 24px "JetBrains Mono", monospace'; ctx.fillText(item.val, mx, 588);
  });

  ctx.fillStyle = panel;
  ctx.fillRect(60, 696, W - 120, 314);
  ctx.strokeStyle = light ? 'rgba(242, 92, 5, 0.38)' : 'rgba(250, 102, 15, 0.44)';
  ctx.strokeRect(60, 696, W - 120, 314);

  drawQrMatrix(ctx, 98, 740, 224, `invite_${safeAddr}_${safeTeamId}`);
  ctx.fillStyle = fg; ctx.font = '700 26px "Inter", sans-serif'; ctx.fillText('扫码加入 A9 终端', 364, 792);
  ctx.fillStyle = sub; ctx.font = '500 20px "Inter", sans-serif'; ctx.fillText('加入团队 · 团队奖励 18%', 364, 836);
  ctx.fillText('邀请好友 · 邀请奖励 12%', 364, 870);
  ctx.fillStyle = accent; ctx.font = '600 18px "JetBrains Mono", monospace'; ctx.fillText(`CODE: ${safeTeamId}-${safeAddr.slice(-4).toUpperCase()}`, 364, 944);
}

/**
 * Template 2: Collectible On-Chain Stake Proof / Yield Flex Card
 */
export function renderProofFlexPoster(canvas, certInput) {
  if (!canvas) return;
  const W = 780; const H = 1100;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { user, round } = store.state;
  const cert = certInput || store.state.certificates[0] || {
    id: 'A9-STAKE-PREVIEW',
    round: round.currentRound || 1,
    stakeTon: 0,
    multiplier: 2.0,
    estRewardA9: 0,
    status: 'observation',
    txHash: 'PENDING'
  };
  const safeMult = Number(cert.multiplier) || 1.0;
  const safeHolder = user.shortAddress || 'A9USER';

  drawBaseFrame(ctx, W, H, false);

  ctx.fillStyle = '#FA660F';
  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.fillText('ON-CHAIN VERIFIED STAKE PASS  ·  TVM L1', 62, 92);

  ctx.fillStyle = '#F4F6FA';
  ctx.font = '700 32px "JetBrains Mono", monospace';
  ctx.fillText(`#${cert.id}`, 62, 146);

  ctx.fillStyle = '#9DA5BC';
  ctx.font = '500 20px "Inter", sans-serif';
  ctx.fillText(`第 ${cert.round || 1} 轮早鸟质押凭证 · 已锁定 ${safeMult.toFixed(1)}x 权重`, 62, 192);

  // Big Yield Flex Display
  ctx.fillStyle = '#69728C';
  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.fillText('ESTIMATED ROUND YIELD', 62, 290);

  ctx.fillStyle = '#F4F6FA';
  ctx.font = '700 60px "JetBrains Mono", monospace';
  ctx.fillText(`+${formatNum(cert.estRewardA9)}`, 62, 366);

  ctx.fillStyle = '#FA660F';
  ctx.font = '700 30px "JetBrains Mono", monospace';
  ctx.fillText('A9 TOKEN  (20% TGE INSTANT)', 62, 416);

  // Certificate Spec Panel (Midnight Navy Glass)
  ctx.fillStyle = 'rgba(31, 36, 57, 0.72)';
  ctx.fillRect(60, 468, W - 120, 184);
  ctx.strokeStyle = 'rgba(226, 234, 255, 0.16)';
  ctx.lineWidth = 2;
  ctx.strokeRect(60, 468, W - 120, 184);

  [
    { label: 'STAKED PRINCIPAL', val: `${formatNum(cert.stakeTon)} GRAM`, color: '#F4F6FA' },
    { label: 'EARLY BOOST', val: `${safeMult.toFixed(1)}x`, color: '#F4F6FA' },
    { label: 'STATUS', val: cert.status === 'settled' ? 'PAID' : 'LIVE', color: '#FF8A3D' }
  ].forEach((item, i) => {
    const mx = 90 + i * 205;
    ctx.fillStyle = '#9DA5BC'; ctx.font = '600 15px "JetBrains Mono", monospace'; ctx.fillText(item.label, mx, 526);
    ctx.fillStyle = item.color; ctx.font = '700 26px "JetBrains Mono", monospace'; ctx.fillText(item.val, mx, 568);
  });

  ctx.fillStyle = '#69728C';
  ctx.font = '500 15px "JetBrains Mono", monospace';
  ctx.fillText(`TX: ${cert.txHash || 'PENDING'}  ·  HOLDER: ${safeHolder}`, 90, 622);

  // Bottom QR Scan to Copy Trade
  ctx.fillStyle = 'rgba(31, 36, 57, 0.72)';
  ctx.fillRect(60, 696, W - 120, 314);
  ctx.strokeStyle = 'rgba(250, 102, 15, 0.44)';
  ctx.strokeRect(60, 696, W - 120, 314);

  drawQrMatrix(ctx, 98, 740, 224, `proof_${cert.id}`);
  ctx.fillStyle = '#F4F6FA'; ctx.font = '700 26px "Inter", sans-serif'; ctx.fillText('扫码跟投 · 领 2.0x 早鸟', 364, 796);
  ctx.fillStyle = '#9DA5BC'; ctx.font = '500 20px "Inter", sans-serif'; ctx.fillText('10 GRAM 即可参与 · 零滑点', 364, 840);
  ctx.fillStyle = '#FF8A3D'; ctx.font = '600 18px "JetBrains Mono", monospace'; ctx.fillText('TEAM 18% / INVITE 12%', 364, 920);
}

export function downloadPosterPng(canvas, filename = 'A9-Poster.png') {
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

/**
 * Template 3 (Scheme 2): 9:16 Vertical Telegram Story Poster (1080x1920)
 * - Dual-theme compatible (Polar Night dark / Satin Morning-Mist light)
 * - Renders Round ID, 24H 2x12 Crystal Matrix (or Burn Monument badge), full Target Price & Prize Pool, and QR Invite Code
 */
export function renderStoryPoster(canvas, payload = {}) {
  if (!canvas) return;
  const W = 1080;
  const H = 1920;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { round, team, user } = store.state;

  const isBurn = payload.stage === 'settlement_burn' || round.stage === 'settlement_burn';
  const light = payload.theme ? payload.theme === 'light' : (document.documentElement.dataset.theme !== 'dark');
  const accent = isBurn ? '#DF3B4B' : (light ? '#F25C05' : '#FA660F');
  const accentSoft = isBurn
    ? (light ? 'rgba(223, 59, 75, 0.12)' : 'rgba(242, 78, 97, 0.20)')
    : (light ? 'rgba(242, 92, 5, 0.12)' : 'rgba(250, 102, 15, 0.22)');
  const fg = light ? '#161B2E' : '#F4F6FA';
  const sub = light ? '#4E566E' : '#9DA5BC';
  const muted = light ? '#7F879E' : '#69728C';
  const panel = light ? 'rgba(255, 255, 255, 0.88)' : 'rgba(31, 36, 57, 0.68)';
  const border = light ? 'rgba(22, 27, 46, 0.10)' : 'rgba(226, 234, 255, 0.16)';

  drawBaseFrame(ctx, W, H, light);

  const roundNum = payload.roundId || round.currentRound || 1;
  const passed = payload.qualified ?? round.qualifiedCandles ?? 0;
  const required = payload.required ?? round.minQualifiedCandles ?? 16;
  const targetText = round.targetPrice ? `$${Number(round.targetPrice).toFixed(4)}` : 'TBD';
  const poolText = formatNum(round.rewardBudgetA9 ?? 700000000);
  const safeTeamId = team.id || 'A9-0001';
  const safeAddr = user.shortAddress || 'A9USER';
  const inviteCode = `${safeTeamId}-${safeAddr.slice(-4).toUpperCase()}`;

  // Header brand
  ctx.fillStyle = accent;
  ctx.fillRect(72, 108, 86, 44);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 26px "JetBrains Mono", monospace';
  ctx.fillText('A9', 98, 139);

  ctx.fillStyle = fg;
  ctx.font = '700 32px "JetBrains Mono", monospace';
  ctx.fillText('TON TERMINAL', 176, 141);

  const pred = store.state.prediction || {};
  const streak = Number(payload.streak ?? pred.streak) || 0;
  const winRate = (payload.winRate ?? pred.winRate) !== null && Number.isFinite(Number(payload.winRate ?? pred.winRate))
    ? Number(payload.winRate ?? pred.winRate) : null;
  if (streak >= 2 || winRate !== null) {
    const badgeLabel = streak >= 2
      ? `${streak} 连胜${winRate !== null ? ` · ${winRate}%` : ''}`
      : `胜率 ${winRate}%`;
    ctx.fillStyle = accentSoft;
    ctx.fillRect(W - 356, 104, 284, 52);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(W - 356, 104, 284, 52);
    ctx.fillStyle = accent;
    ctx.font = '700 22px "JetBrains Mono", monospace';
    ctx.fillText(badgeLabel, W - 332, 138);
  }

  ctx.fillStyle = sub;
  ctx.font = '600 24px "JetBrains Mono", monospace';
  ctx.fillText(`ROUND #0${roundNum}  ·  ${isBurn ? 'BURN MONUMENT' : '24H MATCH POINT'}`, 72, 206);

  // Main Headline + Prize Pool (Full numbers, zero abbreviation)
  ctx.fillStyle = muted;
  ctx.font = '600 22px "JetBrains Mono", monospace';
  ctx.fillText(isBurn ? 'ROUND SETTLEMENT RESULT' : 'ROUND USER REWARD POOL', 72, 294);

  ctx.fillStyle = fg;
  ctx.font = '700 72px "JetBrains Mono", monospace';
  ctx.fillText(isBurn ? `${passed} / ${required} SLOTS` : poolText, 72, 386);

  ctx.fillStyle = accent;
  ctx.font = '700 36px "JetBrains Mono", monospace';
  ctx.fillText(isBurn ? 'ON-CHAIN BURN EXECUTED · V15' : 'A9 REWARD POOL · 24H CORRIDOR', 72, 444);

  // Key Metrics Card
  ctx.fillStyle = panel;
  ctx.fillRect(72, 504, W - 144, 196);
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.strokeRect(72, 504, W - 144, 196);

  [
    { label: 'TARGET PRICE', val: targetText, color: fg },
    { label: 'QUALIFIED SLOTS', val: `${passed} / ${required}`, color: accent },
    { label: 'EARLY BOOST', val: '2.0x MAX', color: fg }
  ].forEach((m, idx) => {
    const mx = 112 + idx * 300;
    ctx.fillStyle = muted;
    ctx.font = '600 20px "JetBrains Mono", monospace';
    ctx.fillText(m.label, mx, 576);
    ctx.fillStyle = m.color;
    ctx.font = '700 34px "JetBrains Mono", monospace';
    ctx.fillText(m.val, mx, 636);
  });

  // Middle Showcase: 24H 2x12 Crystal Tile Matrix OR Burn Monument Emblem
  ctx.fillStyle = panel;
  ctx.fillRect(72, 744, W - 144, 520);
  ctx.strokeStyle = isBurn ? 'rgba(223, 59, 75, 0.36)' : border;
  ctx.strokeRect(72, 744, W - 144, 520);

  if (isBurn) {
    ctx.fillStyle = accentSoft;
    ctx.fillRect(112, 796, W - 224, 108);
    ctx.fillStyle = accent;
    ctx.font = '700 32px "JetBrains Mono", monospace';
    ctx.fillText(`ROUND #0${roundNum} BURN MONUMENT`, 148, 862);

    ctx.fillStyle = fg;
    ctx.font = '700 44px "Inter", sans-serif';
    ctx.fillText('24H 观察未达标 · 链上严格销毁', 112, 996);

    ctx.fillStyle = sub;
    ctx.font = '500 26px "Inter", sans-serif';
    ctx.fillText(`本轮最终确认达标 ${passed} / ${required} 个时段`, 112, 1062);
    ctx.fillText('协议按 v15 规则自动执行销毁，下一轮预热即将开启', 112, 1112);

    // Progress bar
    ctx.fillStyle = light ? 'rgba(22, 27, 46, 0.08)' : 'rgba(255, 255, 255, 0.10)';
    ctx.fillRect(112, 1172, W - 224, 24);
    ctx.fillStyle = accent;
    ctx.fillRect(112, 1172, Math.max(24, Math.round(((W - 224) * Math.min(1, passed / Math.max(1, required))))), 24);
  } else {
    ctx.fillStyle = fg;
    ctx.font = '700 28px "Inter", sans-serif';
    ctx.fillText('24H 时段达标晶体矩阵', 112, 814);
    ctx.fillStyle = accent;
    ctx.font = '700 24px "JetBrains Mono", monospace';
    ctx.fillText(`PASSED ${passed}/${required}`, W - 310, 814);

    const candles = Array.isArray(round.candles) && round.candles.length === 24
      ? round.candles
      : Array.from({ length: 24 }, (_, i) => ({ index: i + 1, status: i < passed ? 'closed' : 'pending', bull: i < passed }));

    const tileW = 60;
    const tileH = 60;
    const gapX = 12;
    const gapY = 58;
    const startX = 112;
    const startY = 886;

    candles.forEach((c, i) => {
      const col = i % 12;
      const row = Math.floor(i / 12);
      const tx = startX + col * (tileW + gapX);
      const ty = startY + row * (tileH + gapY);

      if (c.status === 'closed' && c.bull) {
        ctx.fillStyle = light ? '#0FA968' : '#12CA7D';
        ctx.fillRect(tx, ty, tileW, tileH);
      } else if (c.status === 'closed' && !c.bull) {
        ctx.fillStyle = light ? 'rgba(223, 59, 75, 0.16)' : 'rgba(242, 78, 97, 0.22)';
        ctx.fillRect(tx, ty, tileW, tileH);
        ctx.fillStyle = light ? '#DF3B4B' : '#F24E61';
        ctx.fillRect(tx, ty + tileH - 8, tileW, 8);
      } else if (c.status === 'active') {
        ctx.fillStyle = accentSoft;
        ctx.fillRect(tx, ty, tileW, tileH);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 4;
        ctx.strokeRect(tx + 2, ty + 2, tileW - 4, tileH - 4);
        ctx.fillStyle = accent;
        ctx.fillRect(tx + 8, ty + tileH - 14, tileW - 16, 8);
      } else {
        ctx.fillStyle = light ? 'rgba(22, 27, 46, 0.06)' : 'rgba(255, 255, 255, 0.06)';
        ctx.fillRect(tx, ty, tileW, tileH);
        ctx.strokeStyle = border;
        ctx.lineWidth = 2;
        ctx.strokeRect(tx + 1, ty + 1, tileW - 2, tileH - 2);
      }

      ctx.fillStyle = c.status === 'active' ? accent : muted;
      ctx.font = '600 18px "JetBrains Mono", monospace';
      ctx.fillText(String(c.index), tx + (c.index >= 10 ? 18 : 24), ty + tileH + 26);
    });

    // Optional certificate or prediction subtitle
    ctx.fillStyle = sub;
    ctx.font = '500 22px "Inter", sans-serif';
    const note = payload.certId
      ? `链上质押凭证 #${payload.certId} · 参与 ${formatNum(payload.stakeTon || 0)} GRAM`
      : '0 GRAM 可参与 24H 生死预言局 · 16/24 达标结算';
    ctx.fillText(note, 112, 1214);
  }

  // Bottom Story Sticker & QR Card
  ctx.fillStyle = panel;
  ctx.fillRect(72, 1320, W - 144, 460);
  ctx.strokeStyle = isBurn ? 'rgba(223, 59, 75, 0.40)' : (light ? 'rgba(242, 92, 5, 0.38)' : 'rgba(250, 102, 15, 0.44)');
  ctx.lineWidth = 2.5;
  ctx.strokeRect(72, 1320, W - 144, 460);

  drawQrMatrix(ctx, 126, 1396, 300, `story_${roundNum}_${inviteCode}`);

  ctx.fillStyle = fg;
  ctx.font = '700 38px "Inter", sans-serif';
  ctx.fillText('扫码进入 A9 终端', 476, 1468);

  ctx.fillStyle = sub;
  ctx.font = '500 26px "Inter", sans-serif';
  ctx.fillText('24H 生死预言 · 0 GRAM 参战', 476, 1530);
  ctx.fillText('邀请奖励 12% · 团队奖励 18%', 476, 1578);

  ctx.fillStyle = accent;
  ctx.font = '700 26px "JetBrains Mono", monospace';
  ctx.fillText(`CODE: ${inviteCode}`, 476, 1666);

  ctx.fillStyle = muted;
  ctx.font = '500 20px "JetBrains Mono", monospace';
  ctx.fillText('TELEGRAM MINI APP · TON L1', 476, 1716);
}
