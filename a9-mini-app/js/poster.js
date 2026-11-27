// A9 任天堂实体卡带 / 收藏通行证海报生成器（运行时动态合成战绩数据与二维码）
import { store } from './store.js';
import { L } from './i18n.js';
import { stageLabel } from './pages/wealthverse.js';
import qrcode from './vendor/qrcode.js';
import { config } from './config.js';
import { buildTmaDeepLink, getShareRef } from './share.js';

function finiteNumOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function fmtPosterNum(val) {
  const n = finiteNumOrNull(val);
  if (n === null) return '—';
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

  // 中央 A9 官方代币品牌徽章舞台
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
  const cy = stageY + stageH * 0.5;
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

  // 中心圆形实体徽章底托
  const coinR = tall ? 112 : 84;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(cx, cy + 4, coinR + 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = isGreen ? 'rgba(0, 168, 89, 0.30)' : 'rgba(230, 0, 18, 0.24)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = isGreen ? 'rgba(0, 168, 89, 0.28)' : '#DCE0EA';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(stageX, stageY, stageW, stageH, 24);
  ctx.stroke();

  // 左上角协议标牌
  const brandTag = L('A9 · TON 涨价解锁', 'A9 · TON Price-Unlock');
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(stageX + 14, stageY + 14, 218, 34, 10);
  ctx.fill();
  ctx.strokeStyle = '#DCE0EA';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#141720';
  ctx.font = '800 15px Rubik, sans-serif';
  ctx.fillText(brandTag, stageX + 26, stageY + 37, 194);

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
  ctx.fillText(L('扫码进入广场', 'Scan to Enter Plaza'), textX, stubY + 84, stageW - qrSize - 86);
  ctx.fillStyle = '#7B8396';
  ctx.font = '700 17px Rubik, monospace';
  ctx.fillText('A9 PROTOCOL v17.0 · TON', textX, stubY + 116, stageW - qrSize - 86);

  // 右侧装饰防伪竖条码
  drawVerticalBarcode(ctx, stageX + stageW - 34, stubY + 22, 18, stubH - 44, serialCode || param);

  // 异步绘制 A9 官方代币徽章（使用 assets/token/，零角色素材依赖）
  const tokenImg = new Image();
  tokenImg.onload = () => {
    if (canvas.posterScene !== tokenImg) return;
    const size = tall ? 210 : 156;
    ctx.drawImage(tokenImg, cx - size / 2, cy + 4 - size / 2, size, size);
  };
  canvas.posterScene = tokenImg;
  tokenImg.src = './assets/token/a9-token-2048.png';
}

export function renderReferralPoster(canvas) {
  const { team } = store.state;
  const ref = getShareRef();
  const teamPrefix = team.id && /^(?:G|T|TM|TEAM)-/i.test(team.id) ? `${team.id}_` : '';
  paintCartridgePoster(canvas, {
    headerTone: 'green',
    serialTag: 'A9 SQUAD PASS · v17.0',
    title: L('战队邀请函 · 涨价解锁', 'Squad Invite · Price-Unlock'),
    subtitle: L('24H 锁仓 → 12H 冲价 · 永不爆仓 · 头矿 6H 5% 止损', '24H Lock → 12H Push · No Liquidation · First 6H 5% SL'),
    badgeText: L('通关返佣 8%', '8% REBATE'),
    metrics: [
      { label: L('好友通关返佣', '8% Referral Rebate'), value: '8%', tone: 'green' },
      { label: L('最低锁仓门槛', 'Min Lock'), value: '100 A9', tone: 'gold' },
      { label: L('单轮封顶倍率', 'Round Cap'), value: '5×', tone: 'ink' },
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
  const passed = finiteNumOrNull(r.qualifiedCandles) ?? 0;
  const confirmed = finiteNumOrNull(r.candlesSeen) ?? passed;
  const required = Number(r.minQualifiedCandles) || 8;
  const totalSlots = Number(r.protocolConfig?.candleCount) || 12;

  paintCartridgePoster(canvas, {
    headerTone: isSettled ? 'green' : 'red',
    serialTag: cert ? `SBT PASS · R${String(cert.round).padStart(2, '0')}` : 'SBT PASS',
    title: L('涨价解锁凭证', 'Price-Unlock Pass'),
    subtitle: cert
      ? L(`第 ${cert.round} 轮 · ${isSettled ? '已通关结算' : '12H 冲价进行中'}`, `Round #${cert.round} · ${isSettled ? 'Settled' : '12H Pushing'}`)
      : L('暂无已核验凭证', 'No verified ticket'),
    badgeText: 'A9 v17.0 · 5% SL',
    metrics: cert
      ? [
          { label: L('锁仓本金', 'Locked'), value: `${fmtPosterNum(cert.stakeTon)} A9`, tone: 'ink' },
          { label: L('头矿/止损', 'Stop-Loss'), value: '5% / 10%', tone: 'gold' },
          { label: isSettled ? L('实际奖金', 'Confirmed') : L('预计奖金', 'Est. Reward'), value: `+${fmtPosterNum(cert.estRewardA9)} A9`, tone: 'green' },
        ]
      : [],
    progress: cert
      ? {
          label: L(`12H 冲价进度（已确认 ${confirmed}/${totalSlots}）`, `12H Push (${confirmed}/${totalSlots} confirmed)`),
          rightText: `${passed} / ${required} ${L('达标', 'PASS')}`,
          pct: Math.round((passed / totalSlots) * 100),
          thresholdPct: Math.round((required / totalSlots) * 100),
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
  const passed = same ? (finiteNumOrNull(r.qualifiedCandles) ?? 0) : 0;
  const confirmed = same ? (finiteNumOrNull(r.candlesSeen) ?? passed) : 0;
  const required = Number(r.minQualifiedCandles) || 8;
  const totalSlots = Number(r.protocolConfig?.candleCount) || 12;

  paintCartridgePoster(canvas, {
    headerTone: r.stage === 'settlement_burn' ? 'red' : 'green',
    serialTag: id ? `A9 STORY · R${String(id).padStart(2, '0')}` : 'A9 STORY',
    title: L('12H 冲价战报', '12H Push Report'),
    subtitle: same ? stageLabel(r.stage) : L('涨价解锁 · 12H 冲价挑战', 'Price-Unlock · 12H Push'),
    badgeText: `${passed}/${required} PASS`,
    metrics: cert
      ? [
          { label: L('锁仓本金', 'Locked'), value: `${fmtPosterNum(cert.stakeTon)} A9`, tone: 'ink' },
          { label: L('止损保护', 'Stop-Loss'), value: '5% / 10%', tone: 'gold' },
          { label: L('预计奖金', 'Est. Reward'), value: `+${fmtPosterNum(cert.estRewardA9)} A9`, tone: 'green' },
        ]
      : [
          { label: L('当前轮次', 'Round'), value: id ? `#${id}` : '—', tone: 'ink' },
          { label: L('冲价进度', 'Qualified'), value: `${passed}/${required}`, tone: 'green' },
          { label: L('封顶倍率', 'Cap'), value: '5×', tone: 'gold' },
        ],
    progress: {
      label: L(`12H 冲价进度（已确认 ${confirmed}/${totalSlots}）`, `12H Push (${confirmed}/${totalSlots} confirmed)`),
      rightText: `${passed} / ${required} ${L('达标', 'PASS')}`,
      pct: Math.round((passed / totalSlots) * 100),
      thresholdPct: Math.round((required / totalSlots) * 100),
    },
    serialCode: cert ? `#${cert.id}` : (id ? `A9-ROUND-${id}` : 'A9-PROTOCOL'),
    param: cert ? 'proof_' + cert.id : (id ? 'round_' + id : 'round'),
    tall: true,
  });
}

/**
 * 3 套裂变场景化海报（① 冲价喊单卡 / ② 开箱喜报卡 / ③ 通关盈利卡）
 * 严格遵循 Live 缺值护栏：价格、距目标价涨幅、奖池等字段为 null 时严禁展示演示数值，仅展示「待核验 / Pending」。
 */
export function renderScenarioPoster(canvas, scenario = 'push', extra = {}) {
  const r = store.state.round || {};
  const team = store.state.team || {};
  const ref = getShareRef();
  const teamPrefix = team.id && /^(?:G|T|TM|TEAM)-/i.test(team.id) ? `${team.id}_` : '';
  const pendingTxt = L('待核验', 'Pending');

  const roundNum = r.currentRound ?? null;
  const required = Number(r.minQualifiedCandles) || 8;
  const totalSlots = Number(r.protocolConfig?.candleCount ?? r.candleCount) || 12;
  const passed = finiteNumOrNull(r.qualifiedCandles);
  const confirmed = finiteNumOrNull(r.candlesSeen) ?? passed;

  const targetPriceRaw = finiteNumOrNull(r.targetPrice);
  const targetPrice = targetPriceRaw !== null && targetPriceRaw > 0 ? targetPriceRaw : null;
  const rawCurPrice = r.priceValid !== false ? (r.livePrice ?? r.twap24h) : null;
  const curPriceRaw = finiteNumOrNull(rawCurPrice);
  const curPrice = curPriceRaw !== null && curPriceRaw > 0 ? curPriceRaw : null;
  const gapPct = (targetPrice !== null && curPrice !== null)
    ? (((targetPrice - curPrice) / curPrice) * 100)
    : null;
  const gapStr = gapPct === null
    ? pendingTxt
    : gapPct <= 0
      ? `+${Math.abs(gapPct).toFixed(1)}%`
      : `+${gapPct.toFixed(1)}%`;
  const poolStr = (r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9)))
    ? `${fmtPosterNum(r.rewardBudgetA9)} A9`
    : pendingTxt;

  if (scenario === 'chest') {
    const latestRec = Array.isArray(store.state.market?.records) && store.state.market.records.length > 0
      ? store.state.market.records[0]
      : null;
    const totalA9 = extra.totalA9 ?? (config.isDemo ? (latestRec?.totalA9 ?? latestRec?.a9 ?? null) : null);
    const baseA9 = extra.baseA9 ?? (config.isDemo ? (latestRec?.baseA9 ?? null) : null);
    const bonusA9 = extra.bonusA9 ?? (config.isDemo ? (latestRec?.bonusA9 ?? null) : null);

    paintCartridgePoster(canvas, {
      headerTone: 'green',
      serialTag: 'A9 CHEST · DIRECT PAYOUT',
      title: L('开箱喜报 · 合并直发钱包', 'Unboxing · Direct to Wallet'),
      subtitle: L('6 档纯随机开箱 · 0.99 GRAM 起 · 买完直通头矿 6H', '6-Tier Random Chest · From 0.99 GRAM · Straight to First 6H'),
      badgeText: L('直推返佣 6%', '6% REFERRAL'),
      metrics: [
        { label: L('本箱到账', 'Total Got'), value: totalA9 !== null ? `${fmtPosterNum(totalA9)} A9` : L('1,500–1,300,000 A9', '1,500–1,300,000 A9'), tone: 'green' },
        { label: L('保底 / 加赠', 'Base / Bonus'), value: (baseA9 !== null && bonusA9 !== null) ? `${fmtPosterNum(baseA9)}+${fmtPosterNum(bonusA9)}` : L('最高 +66.7%', 'Up to +66.7%'), tone: 'gold' },
        { label: L('起投门槛', 'Entry'), value: '0.99 GRAM', tone: 'ink' },
      ],
      serialCode: team?.name ? String(team.name) : 'A9 CHEST MALL',
      param: `market_${teamPrefix}${ref}`,
      tall: false,
    });
    return;
  }

  if (scenario === 'win') {
    const cert = extra.cert || store.state.certificates?.[0] || null;
    const hasCert = Boolean(cert && finiteNumOrNull(cert.stakeTon) !== null);
    const estVal = hasCert && finiteNumOrNull(cert.estRewardA9) !== null ? `+${fmtPosterNum(cert.estRewardA9)} A9` : pendingTxt;
    paintCartridgePoster(canvas, {
      headerTone: 'green',
      serialTag: roundNum ? `A9 PASS · R${String(roundNum).padStart(2, '0')}` : 'A9 PASS',
      title: L('通关盈利卡 · 涨价解锁', 'Round Pass · Price-Unlock'),
      subtitle: L('20% 秒提 + 14 天逐秒解锁 · 永不爆仓，自动止损', '20% Instant + 14D Per-Second Unlock · No Liquidation'),
      badgeText: L('封顶 5× 收益', 'UP TO 5×'),
      metrics: [
        { label: L('锁仓本金', 'Locked'), value: hasCert ? `${fmtPosterNum(cert.stakeTon)} A9` : pendingTxt, tone: 'ink' },
        { label: L('通关奖金', 'Prize'), value: estVal, tone: 'green' },
        { label: L('头矿止损', 'First 6H SL'), value: '5% / 95%退', tone: 'gold' },
      ],
      progress: passed !== null
        ? {
            label: L(`12H 冲价进度（已确认 ${confirmed ?? passed}/${totalSlots}）`, `12H Push (${confirmed ?? passed}/${totalSlots} confirmed)`),
            rightText: `${passed} / ${required} ${L('达标', 'PASS')}`,
            pct: Math.round((passed / totalSlots) * 100),
            thresholdPct: Math.round((required / totalSlots) * 100),
          }
        : null,
      serialCode: cert ? `#${cert.id}` : (team?.name ? String(team.name) : 'A9 PRICE-UNLOCK'),
      param: `invite_${teamPrefix}${ref}`,
      tall: false,
    });
    return;
  }

  // Default: 'push' 冲价喊单卡
  paintCartridgePoster(canvas, {
    headerTone: 'red',
    serialTag: roundNum ? `A9 12H PUSH · R${String(roundNum).padStart(2, '0')}` : 'A9 12H PUSH',
    title: L('冲价喊单卡 · 齐心冲目标价', 'Price-Push · Hit Target'),
    subtitle: L('70% 奖池 + 12% 团队全锁涨价解锁 · 100 A9 起锁仓永不爆仓', '70% Pool + 12% Team Price-Unlock · Lock from 100 A9'),
    badgeText: passed !== null ? `${passed}/${required} PASS` : pendingTxt,
    metrics: [
      { label: L('目标底价', 'Target'), value: targetPrice !== null ? `$${targetPrice.toFixed(4)}` : pendingTxt, tone: 'ink' },
      { label: L('距目标价', 'To Target'), value: gapStr, tone: gapPct !== null && gapPct <= 0 ? 'green' : 'gold' },
      { label: L('本轮奖池', 'Round Pool'), value: poolStr, tone: 'green' },
    ],
    progress: passed !== null
      ? {
          label: L(`12H 冲价血条（已确认 ${confirmed ?? passed}/${totalSlots}）`, `12H Push Bar (${confirmed ?? passed}/${totalSlots})`),
          rightText: `${passed} / ${required} ${L('达标', 'PASS')}`,
          pct: Math.round((passed / totalSlots) * 100),
          thresholdPct: Math.round((required / totalSlots) * 100),
        }
      : null,
    serialCode: team?.name ? String(team.name) : 'A9 SQUAD CALL',
    param: `invite_${teamPrefix}${ref}`,
    tall: false,
  });
}

export function downloadPosterPng(canvas, filename = 'A9-Poster.png') {
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
