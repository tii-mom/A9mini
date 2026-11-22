// A9 illustrated share cards. Text and QR payloads are generated at render time.
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
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#141027';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col))
        ctx.fillRect(x + (col + 4) * step, y + (row + 4) * step, step, step);
    }
  }
  if (config.isDemo) {
    ctx.fillStyle = '#53378c';
    ctx.fillRect(40, 38, 118, 42);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 27px sans-serif';
    ctx.fillText('DEMO', 52, 68);
  }
}

function paintPoster(canvas, title, lines, param, tall = false) {
  if (!canvas) return;
  const width = 720;
  const height = tall ? 1280 : 960;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#57408c');
  bg.addColorStop(1, '#161328');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#d6b273';
  ctx.strokeRect(20, 20, width - 40, height - 40);
  ctx.fillStyle = '#ffdaa1';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('A9  /  WEALTHVERSE', 46, 126);
  ctx.font = 'bold 56px sans-serif';
  ctx.fillText(title, 46, 215, width - 92);
  const drawDetails = () => {
    ctx.font = '28px sans-serif';
    ctx.fillStyle = '#fff4dd';
    lines.forEach((line, i) =>
      ctx.fillText(line, 46, height - 333 + i * 42, width - 92),
    );
    drawQrMatrix(ctx, 48, height - 222, 170, param);
    ctx.fillStyle = '#ffe1a8';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(
      L('扫码进入财富主城', 'Scan to enter Wealth City'),
      240,
      height - 120,
      425,
    );
  };
  drawDetails();
  const backdrop = new Image();
  backdrop.onload = () => {
    if (canvas.posterScene !== backdrop) return;
    ctx.drawImage(backdrop, 38, 259, width - 76, height - 642);
  };
  canvas.posterScene = backdrop;
  backdrop.src = './assets/wealthverse/game/city.webp';
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
  const same = id === r.currentRound;
  paintPoster(
    canvas,
    L('轮次战报', 'Round Report'),
    [
      L('轮次', 'Round') + ' ' + id,
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
    'round_' + id,
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
