// A9 方案 A 暖棉纸立体书分享海报生成器（运行时动态合成文本与二维码）
import { store } from './store.js';
import { L } from './i18n.js';
import { stageLabel } from './pages/wealthverse.js';
import qrcode from './vendor/qrcode.js';
import { config } from './config.js';

function drawQrMatrix(ctx, x, y, size, startParam) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('mode', config.mode);
  url.searchParams.set('startapp', startParam);
  const code = qrcode(0, 'M');
  code.addData(url.href);
  code.make();
  const count = code.getModuleCount();
  const step = Math.floor(size / (count + 8));

  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(x - 6, y - 6, size + 12, size + 12, 16);
  ctx.fill();
  ctx.strokeStyle = '#E7DFD1';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#2B2523';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col))
        ctx.fillRect(x + (col + 4) * step, y + (row + 4) * step, step, step);
    }
  }
  if (config.isDemo) {
    ctx.fillStyle = '#ECE6DA';
    ctx.beginPath();
    ctx.roundRect(548, 72, 108, 38, 12);
    ctx.fill();
    ctx.fillStyle = '#6A615B';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('DEMO', 568, 99);
  }
}

function paintPoster(canvas, title, lines, param, tall = false) {
  if (!canvas) return;
  const width = 720;
  const height = tall ? 1280 : 960;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // 暖棉纸基底
  ctx.fillStyle = '#F5F0E6';
  ctx.fillRect(0, 0, width, height);

  // 纯白厚卡纸底托 + 暖灰纸板底厚度
  ctx.fillStyle = '#D6CBB9';
  ctx.beginPath();
  ctx.roundRect(36, 46, width - 72, height - 86, 36);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(36, 36, width - 72, height - 86, 36);
  ctx.fill();

  // 手工针脚内虚线框
  ctx.save();
  ctx.strokeStyle = 'rgba(178, 162, 138, 0.52)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([9, 8]);
  ctx.beginPath();
  ctx.roundRect(52, 52, width - 104, height - 118, 26);
  ctx.stroke();
  ctx.restore();

  // 任天堂朱红 A9 印章
  ctx.fillStyle = '#B82D25';
  ctx.beginPath();
  ctx.roundRect(72, 82, 88, 50, 14);
  ctx.fill();
  ctx.fillStyle = '#E8453C';
  ctx.beginPath();
  ctx.roundRect(72, 76, 88, 50, 14);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('A9', 96, 111);

  ctx.fillStyle = '#988E86';
  ctx.font = 'bold 21px sans-serif';
  ctx.fillText('A9 / PAPER CRAFT WORLD', 178, 109);

  ctx.fillStyle = '#2B2523';
  ctx.font = 'bold 52px sans-serif';
  ctx.fillText(title, 72, 198, width - 144);

  // 中央柔和剪纸舞台
  const stageY = 230;
  const stageH = height - 600;
  ctx.fillStyle = '#FAF6EE';
  ctx.beginPath();
  ctx.roundRect(72, stageY, width - 144, stageH, 28);
  ctx.fill();
  ctx.fillStyle = '#E3EADF';
  ctx.beginPath();
  ctx.ellipse(width / 2, stageY + stageH - 36, 210, 32, 0, 0, Math.PI * 2);
  ctx.fill();

  const drawDetails = () => {
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = '#6A615B';
    lines.filter(Boolean).forEach((line, i) =>
      ctx.fillText(line, 72, height - 332 + i * 40, width - 144),
    );
    drawQrMatrix(ctx, 76, height - 236, 156, param);
    ctx.fillStyle = '#2B2523';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(
      L('扫码进入财富主城', 'Scan to enter Wealth City'),
      260,
      height - 156,
      390,
    );
    ctx.fillStyle = '#988E86';
    ctx.font = '22px sans-serif';
    ctx.fillText('A9 · Telegram Mini App', 260, height - 116, 390);
  };
  drawDetails();

  const standee = new Image();
  standee.onload = () => {
    if (canvas.posterScene !== standee) return;
    const maxW = width - 220;
    const maxH = stageH - 32;
    const scale = Math.min(maxW / standee.naturalWidth, maxH / standee.naturalHeight);
    const dw = standee.naturalWidth * scale;
    const dh = standee.naturalHeight * scale;
    ctx.drawImage(standee, (width - dw) / 2, stageY + (stageH - dh) / 2 - 4, dw, dh);
  };
  canvas.posterScene = standee;
  const tier = store.state.user.previewTier || 9;
  standee.src = `./assets/wealthverse/game/a${tier}.webp`;
}

export function renderReferralPoster(canvas) {
  const { team, user } = store.state;
  paintPoster(
    canvas,
    L('商会邀请函', 'Guild Invitation'),
    [L('轮次挑战 · 身份图鉴', 'Round challenges · Identity gallery')],
    `invite_${team.id || 'A9'}_${(user.shortAddress || 'A9USER').slice(-4)}`,
  );
}

export function renderProofFlexPoster(canvas, certInput) {
  const cert = certInput || store.state.certificates[0];
  paintPoster(
    canvas,
    L('质押凭证', 'Stake Ticket'),
    cert
      ? [String(cert.id), L('所属轮次', 'Round') + ' ' + cert.round]
      : [L('暂无已核验凭证', 'No verified ticket')],
    cert ? 'proof_' + cert.id : 'round_' + store.state.round.currentRound,
  );
}

export function renderStoryPoster(canvas, payload = {}) {
  const r = store.state.round;
  const id = payload.roundId ?? r.currentRound;
  const same = Boolean(id) && id === r.currentRound;
  paintPoster(
    canvas,
    L('轮次战报', 'Round Report'),
    [
      id ? L('轮次', 'Round') + ' ' + id : L('轮次待核验', 'Round pending verification'),
      same
        ? stageLabel(r.stage)
        : L('历史状态待核验', 'Historical state awaits verification'),
      same
        ? L('已达标时段', 'Qualified slots') +
          ' ' +
          (r.qualifiedCandles ?? '—') +
          ' / 24'
        : '',
    ],
    id ? 'round_' + id : 'round',
    true,
  );
}

export function downloadPosterPng(canvas, filename = 'A9-Poster.png') {
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
