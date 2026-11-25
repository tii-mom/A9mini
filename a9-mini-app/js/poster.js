// A9 任天堂实体卡带 / 收藏通行证海报生成器（运行时动态合成战绩数据与二维码）
import { store } from './store.js';
import { L } from './i18n.js';
import { stageLabel } from './pages/wealthverse.js';
import { characterArt, getBoxheadItem } from './wealth-art.js';
import qrcode from './vendor/qrcode.js';
import { config } from './config.js';
import { buildTmaDeepLink, getShareRef } from './share.js';

function fmtPosterNum(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function drawQrMatrix(ctx, x, y, size, startParam) {
  const targetUrl = buildTmaDeepLink(startParam);
  const code = qrcode(0, 'M');
  code.addData(targetUrl);
  code.make();
  const count = code.getModuleCount();
  const pad = 10;
  const inner = size - pad * 2;
  const step = inner / count;

  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 14);
  ctx.fill();
  ctx.strokeStyle = '#D5DAE6';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#141720';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) {
        ctx.fillRect(
          x + pad + col * step,
          y + pad + row * step,
          Math.ceil(step),
          Math.ceil(step),
        );
      }
    }
  }
}

function drawVerticalBarcode(ctx, x, y, width, height, seed = 'A9PASS') {
  const s = String(seed || 'A9PASS');
  ctx.fillStyle = '#141720';
  let curY = y;
  let i = 0;
  while (curY < y + height - 3) {
    const code = s.charCodeAt(i % s.length) + i * 11;
    const h = (code % 3) === 0 ? 5 : (code % 2) === 0 ? 3 : 2;
    ctx.fillRect(x, curY, width, Math.min(h, y + height - curY));
    curY += h + 3;
    i += 1;
  }
}

function drawPerforationLine(ctx, cardX, cardW, y, bgColor) {
  ctx.save();
  ctx.strokeStyle = '#D5DAE6';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(cardX + 18, y);
  ctx.lineTo(cardX + cardW - 18, y);
  ctx.stroke();
  ctx.restore();

  // 左右实体票根半圆切口
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.arc(cardX, y, 14, -Math.PI / 2, Math.PI / 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cardX + cardW, y, 14, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.fill();

  ctx.strokeStyle = '#C9CFD9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cardX, y, 14, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cardX + cardW, y, 14, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.stroke();
}

/**
 * 任天堂实体卡带 / SBT 收藏通行证统一画布引擎
 */
function paintCartridgePoster(canvas, {
  headerTone = 'green', // 'green' | 'red'
  serialTag = 'SBT PASS',
  title = '',
  subtitle = '',
  badgeText = '',
  metrics = [], // [{ label, value, tone?: 'green'|'gold'|'ink' }]
  progress = null, // { label, rightText, pct, thresholdPct? }
  serialCode = '',
  param = 'round',
  tall = false,
} = {}) {
  if (!canvas) return;
  const width = 720;
  const height = tall ? 1280 : 960;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = '#EEF1F5';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const cardX = 32;
  const cardY = 28;
  const cardW = width - 64;
  const cardH = height - 64;

  // 实体卡带底影厚度
  ctx.fillStyle = '#C3C9D6';
  ctx.beginPath();
  ctx.roundRect(cardX, cardY + 10, cardW, cardH, 32);
  ctx.fill();

  // 纯白实体卡身
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 32);
  ctx.fill();
  ctx.strokeStyle = '#C9CFD9';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 顶部实心卡带色条（任天堂绿 / 任天堂红）
  const isGreen = headerTone === 'green';
  const topColor = isGreen ? '#00A859' : '#E60012';
  const topDark = isGreen ? '#00743D' : '#9E000C';
  const headerH = 88;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, headerH, [32, 32, 0, 0]);
  ctx.clip();
  ctx.fillStyle = topColor;
  ctx.fillRect(cardX, cardY, cardW, headerH);
  // 左侧实体卡带防滑压纹
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.roundRect(cardX + 24 + i * 9, cardY + 26, 4, 36, 2);
    ctx.fill();
  }
  ctx.fillStyle = topDark;
  ctx.fillRect(cardX, cardY + headerH - 5, cardW, 5);
  ctx.restore();

  // 顶栏 A9 徽标与编号
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(cardX + 60, cardY + 22, 62, 42, 11);
  ctx.fill();
  ctx.fillStyle = topColor;
  ctx.font = '900 24px Rubik, sans-serif';
  ctx.fillText('A9', cardX + 74, cardY + 51);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '900 22px Rubik, sans-serif';
  ctx.fillText(serialTag, cardX + 136, cardY + 51, 310);

  // 右侧 DEMO / ON-CHAIN 实体胶囊
  const modeLabel = config.isDemo ? 'DEMO' : 'ON-CHAIN';
  ctx.fillStyle = config.isDemo ? 'rgba(255,255,255,0.24)' : '#141720';
  ctx.beginPath();
  ctx.roundRect(cardX + cardW - 148, cardY + 25, 124, 36, 18);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '800 18px Rubik, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(modeLabel, cardX + cardW - 86, cardY + 49);
  ctx.textAlign = 'left';

  // 标题区
  const titleY = cardY + headerH + 46;
  ctx.fillStyle = '#141720';
  ctx.font = '900 38px Rubik, sans-serif';
  ctx.fillText(title, cardX + 28, titleY, cardW - 180);

  if (subtitle) {
    ctx.fillStyle = '#52596B';
    ctx.font = '700 20px Rubik, sans-serif';
    ctx.fillText(subtitle, cardX + 28, titleY + 30, cardW - 56);
  }

  // 右上角权重/状态实体贴纸
  if (badgeText) {
    const bw = 148;
    const bx = cardX + cardW - bw - 26;
    const by = cardY + headerH + 18;
    ctx.fillStyle = '#FDF6E3';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, 40, 12);
    ctx.fill();
    ctx.strokeStyle = '#E5A000';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#8C5C00';
    ctx.font = '900 19px Rubik, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(badgeText, bx + bw / 2, by + 27);
    ctx.textAlign = 'left';
  }

  // 中央纸箱人展示舞台
  const stageX = cardX + 28;
  const stageY = titleY + (subtitle ? 48 : 22);
  const stageW = cardW - 56;
  const stageH = tall ? 430 : 284;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(stageX, stageY, stageW, stageH, 24);
  ctx.clip();
  ctx.fillStyle = isGreen ? '#EDF8F2' : '#F4F6FA';
  ctx.fillRect(stageX, stageY, stageW, stageH);

  // 柔和任天堂放射光线底纹
  const cx = stageX + stageW / 2;
  const cy = stageY + stageH * 0.52;
  ctx.fillStyle = isGreen ? 'rgba(0, 168, 89, 0.08)' : 'rgba(230, 0, 18, 0.06)';
  for (let i = 0; i < 12; i++) {
    const a1 = (i * Math.PI) / 6;
    const a2 = a1 + Math.PI / 14;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, stageW * 0.72, a1, a2);
    ctx.closePath();
    ctx.fill();
  }

  // 底部接触投影椭圆
  ctx.fillStyle = isGreen ? 'rgba(0, 116, 61, 0.14)' : 'rgba(20, 23, 32, 0.10)';
  ctx.beginPath();
  ctx.ellipse(cx, stageY + stageH - 26, 130, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = isGreen ? 'rgba(0, 168, 89, 0.28)' : '#DCE0EA';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(stageX, stageY, stageW, stageH, 24);
  ctx.stroke();

  // 左上角角色铭牌
  const tier = store.state.user.previewTier || 1;
  const series = store.state.user.previewSeries || 'activity';
  const boxhead = getBoxheadItem(tier, series);
  const seriesCode = series === 'wealth' ? 'WLT' : 'ACT';
  const charTag = `${seriesCode} 0${tier} · ${L(boxhead.nameZh, boxhead.nameEn)}`;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(stageX + 14, stageY + 14, 210, 34, 10);
  ctx.fill();
  ctx.strokeStyle = '#DCE0EA';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#141720';
  ctx.font = '800 16px Rubik, sans-serif';
  ctx.fillText(charTag, stageX + 26, stageY + 37, 188);

  // 票根打孔分割线
  const perfY = stageY + stageH + 26;
  drawPerforationLine(ctx, cardX, cardW, perfY, bg);

  // 核心战绩指标区（3 列实体数据卡）
  let cursorY = perfY + 22;
  if (metrics.length > 0) {
    const cols = metrics.length;
    const gap = 12;
    const tileW = (stageW - gap * (cols - 1)) / cols;
    const tileH = tall ? 112 : 94;
    metrics.forEach((m, idx) => {
      const tx = stageX + idx * (tileW + gap);
      const isG = m.tone === 'green';
      const isGold = m.tone === 'gold';
      ctx.fillStyle = isG ? '#E7F8EF' : isGold ? '#FDF6E3' : '#F3F4F7';
      ctx.beginPath();
      ctx.roundRect(tx, cursorY, tileW, tileH, 16);
      ctx.fill();
      ctx.strokeStyle = isG ? 'rgba(0,168,89,0.34)' : isGold ? 'rgba(229,160,0,0.34)' : '#DCE0EA';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = isG ? '#006B38' : isGold ? '#8C5C00' : '#7B8396';
      ctx.font = '800 16px Rubik, sans-serif';
      ctx.fillText(m.label, tx + 14, cursorY + 30, tileW - 24);

      ctx.fillStyle = isG ? '#00A859' : isGold ? '#8C5C00' : '#141720';
      ctx.font = '900 24px Rubik, monospace';
      ctx.fillText(m.value, tx + 14, cursorY + (tall ? 78 : 68), tileW - 24);
    });
    cursorY += tileH + 18;
  }

  // 24H 进度条（可选）
  if (progress) {
    ctx.fillStyle = '#52596B';
    ctx.font = '800 17px Rubik, sans-serif';
    ctx.fillText(progress.label, stageX, cursorY + 14);
    ctx.fillStyle = '#00A859';
    ctx.font = '900 17px Rubik, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(progress.rightText, stageX + stageW, cursorY + 14);
    ctx.textAlign = 'left';

    const barY = cursorY + 24;
    const barH = 14;
    ctx.fillStyle = '#EAECEF';
    ctx.beginPath();
    ctx.roundRect(stageX, barY, stageW, barH, 7);
    ctx.fill();
    const fillW = Math.max(12, Math.round((stageW * Math.max(0, Math.min(100, progress.pct))) / 100));
    ctx.fillStyle = '#00A859';
    ctx.beginPath();
    ctx.roundRect(stageX, barY, fillW, barH, 7);
    ctx.fill();
    if (progress.thresholdPct) {
      const markX = stageX + Math.round((stageW * progress.thresholdPct) / 100);
      ctx.fillStyle = '#E60012';
      ctx.fillRect(markX - 2, barY - 3, 4, barH + 6);
    }
    cursorY += 54;
  }

  // 底部紧凑通栏 QR 票根底条
  const stubH = 148;
  const stubY = cardY + cardH - stubH - 22;
  ctx.fillStyle = '#F3F4F7';
  ctx.beginPath();
  ctx.roundRect(stageX, stubY, stageW, stubH, 20);
  ctx.fill();
  ctx.strokeStyle = '#DCE0EA';
  ctx.lineWidth = 2;
  ctx.stroke();

  const qrSize = 120;
  drawQrMatrix(ctx, stageX + 14, stubY + 14, qrSize, param);

  const textX = stageX + qrSize + 30;
  if (serialCode) {
    ctx.fillStyle = '#141720';
    ctx.font = '900 20px Rubik, monospace';
    ctx.fillText(serialCode, textX, stubY + 46, stageW - qrSize - 86);
  }
  ctx.fillStyle = '#00A859';
  ctx.font = '900 22px Rubik, sans-serif';
  ctx.fillText(L('扫码进入 A9 广场', 'Scan to Enter A9 Plaza'), textX, stubY + 84, stageW - qrSize - 86);
  ctx.fillStyle = '#7B8396';
  ctx.font = '700 17px Rubik, monospace';
  ctx.fillText('A9 PROTOCOL v16.2 · TON', textX, stubY + 116, stageW - qrSize - 86);

  // 右侧装饰防伪竖条码
  drawVerticalBarcode(ctx, stageX + stageW - 34, stubY + 22, 18, stubH - 44, serialCode || param);

  // 异步绘制角色立绘
  const standee = new Image();
  standee.onload = () => {
    if (canvas.posterScene !== standee) return;
    const maxW = stageW - 80;
    const maxH = stageH - 54;
    const scale = Math.min(maxW / standee.naturalWidth, maxH / standee.naturalHeight);
    const dw = standee.naturalWidth * scale;
    const dh = standee.naturalHeight * scale;
    ctx.drawImage(standee, stageX + (stageW - dw) / 2, stageY + (stageH - dh) / 2 + 12, dw, dh);
  };
  canvas.posterScene = standee;
  standee.src = characterArt(tier, series);
}

export function renderReferralPoster(canvas) {
  const { team } = store.state;
  const ref = getShareRef();
  const teamPrefix = team.id && /^(?:G|T|TM|TEAM)-/i.test(team.id) ? `${team.id}_` : '';
  paintCartridgePoster(canvas, {
    headerTone: 'green',
    serialTag: 'A9 SQUAD PASS · v16.2',
    title: L('战队邀请函', 'Squad Invitation'),
    subtitle: L('24H 达标闯关 · 宝箱随机暴击 · 链上透明结算', '24H Pass Quest · Random Crit Chests · On-Chain'),
    badgeText: L('直推 6% 返佣', '6% REFERRAL'),
    metrics: [
      { label: L('直推宝箱返佣', 'Chest Referral'), value: '6%', tone: 'green' },
      { label: L('新人体验金', 'Rookie Floor'), value: '500 A9', tone: 'gold' },
      { label: L('单轮回报上限', 'Round Cap'), value: '15×', tone: 'ink' },
    ],
    serialCode: team?.name ? String(team.name) : 'A9 SQUAD INVITE',
    param: `invite_${teamPrefix}${ref}`,
    tall: false,
  });
}

export function renderProofFlexPoster(canvas, certInput) {
  const cert = certInput || store.state.certificates[0];
  const r = store.state.round || {};
  const isSettled = cert?.status === 'settled';
  const passed = Number.isFinite(Number(r.qualifiedCandles)) ? Number(r.qualifiedCandles) : 0;
  const confirmed = Number.isFinite(Number(r.candlesSeen)) ? Number(r.candlesSeen) : passed;
  const required = Number(r.minQualifiedCandles) || 16;

  paintCartridgePoster(canvas, {
    headerTone: isSettled ? 'green' : 'red',
    serialTag: cert ? `SBT PASS · R${String(cert.round).padStart(2, '0')}` : 'SBT PASS',
    title: L('链上闯关凭证', 'On-Chain Quest Pass'),
    subtitle: cert
      ? L(`第 ${cert.round} 轮 · ${isSettled ? '已通关结算' : '24H 观察期进行中'}`, `Round #${cert.round} · ${isSettled ? 'Settled' : '24H Observing'}`)
      : L('暂无已核验凭证', 'No verified ticket'),
    badgeText: cert ? `${(Number(cert.multiplier) || 1).toFixed(1)}× EARLY` : 'A9 v16.2',
    metrics: cert
      ? [
          { label: L('质押本金', 'Staked'), value: `${fmtPosterNum(cert.stakeTon)} A9`, tone: 'ink' },
          { label: L('早鸟权重', 'Weight'), value: `${(Number(cert.multiplier) || 1).toFixed(1)}×`, tone: 'gold' },
          { label: isSettled ? L('实际奖励', 'Confirmed') : L('预计奖励', 'Est. Reward'), value: `+${fmtPosterNum(cert.estRewardA9)} A9`, tone: 'green' },
        ]
      : [],
    progress: cert
      ? {
          label: L(`24H 观测进度（已确认 ${confirmed}/24）`, `24H Progress (${confirmed}/24 confirmed)`),
          rightText: `${passed} / ${required} ${L('达标', 'PASS')}`,
          pct: Math.round((passed / 24) * 100),
          thresholdPct: Math.round((required / 24) * 100),
        }
      : null,
    serialCode: cert ? `#${cert.id}` : 'A9-QUEST-PASS',
    param: cert ? 'proof_' + cert.id : 'round_' + (r.currentRound || 1),
    tall: false,
  });
}

export function renderStoryPoster(canvas, payload = {}) {
  const r = store.state.round || {};
  const cert = store.state.certificates.find((c) => c.id === payload.certId) || store.state.certificates[0] || null;
  const id = payload.roundId ?? cert?.round ?? r.currentRound;
  const same = Boolean(id) && id === r.currentRound;
  const passed = same && Number.isFinite(Number(r.qualifiedCandles)) ? Number(r.qualifiedCandles) : 0;
  const confirmed = same && Number.isFinite(Number(r.candlesSeen)) ? Number(r.candlesSeen) : passed;
  const required = Number(r.minQualifiedCandles) || 16;

  paintCartridgePoster(canvas, {
    headerTone: r.stage === 'settlement_burn' ? 'red' : 'green',
    serialTag: id ? `A9 STORY · R${String(id).padStart(2, '0')}` : 'A9 STORY',
    title: L('24H 轮次战报', '24H Round Report'),
    subtitle: same ? stageLabel(r.stage) : L('链上 24H 达标挑战', 'On-Chain 24H Challenge'),
    badgeText: cert ? `${(Number(cert.multiplier) || 1).toFixed(1)}× EARLY` : `${passed}/${required} PASS`,
    metrics: cert
      ? [
          { label: L('质押本金', 'Staked'), value: `${fmtPosterNum(cert.stakeTon)} A9`, tone: 'ink' },
          { label: L('早鸟权重', 'Weight'), value: `${(Number(cert.multiplier) || 1).toFixed(1)}×`, tone: 'gold' },
          { label: L('预计奖励', 'Est. Reward'), value: `+${fmtPosterNum(cert.estRewardA9)} A9`, tone: 'green' },
        ]
      : [
          { label: L('当前轮次', 'Round'), value: id ? `#${id}` : '—', tone: 'ink' },
          { label: L('达标进度', 'Qualified'), value: `${passed}/${required}`, tone: 'green' },
          { label: L('回报上限', 'Cap'), value: '15×', tone: 'gold' },
        ],
    progress: {
      label: L(`24H 达标进度（已确认 ${confirmed}/24）`, `24H Progress (${confirmed}/24 confirmed)`),
      rightText: `${passed} / ${required} ${L('达标', 'PASS')}`,
      pct: Math.round((passed / 24) * 100),
      thresholdPct: Math.round((required / 24) * 100),
    },
    serialCode: cert ? `#${cert.id}` : (id ? `A9-ROUND-${id}` : 'A9-PROTOCOL'),
    param: cert ? 'proof_' + cert.id : (id ? 'round_' + id : 'round'),
    tall: true,
  });
}

export function downloadPosterPng(canvas, filename = 'A9-Poster.png') {
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
