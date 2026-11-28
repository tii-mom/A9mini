import { escapeHtml } from '../components.js';
import { PROTOCOL_SPECS, serverNowMs } from '../data.js';
import { L } from '../i18n.js';
import { fmtUsdOrDash } from './quest-ui.js';

const positive = value => Number(value) > 0 && Number.isFinite(Number(value));

const pricePaused = round => String(round.rawState || '').toUpperCase() === 'ORACLE_PAUSED';
const priceStale = round => round.stale || round.detailStale;

export function canShowProvisionalPrice(round) {
  return !pricePaused(round) && !priceStale(round) && round.priceValid !== false;
}

function formatSampleTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const ref = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sameDay = d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
    if (sameDay) return `${hh}:${mm}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${mo}-${da} ${hh}:${mm}`;
  } catch (_) {
    return null;
  }
}

function formatCadenceLabel(sec, count) {
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return L(`${h} 小时 / 格 · 共 ${count} 格`, `${h}h / slot · ${count} slots`);
  }
  const m = Math.max(1, Math.round(sec / 60));
  return L(`${m} 分钟 / 格 · 共 ${count} 格`, `${m}m / slot · ${count} slots`);
}

/**
 * 严格区分有效行情采样时间与接口读取同步时间：
 * 绝不回退到 round.updatedAt / round.fetchedAt（它们只代表接口同步时刻，不能证明行情有新样本）。
 */
function resolveLastValidTime(round, lastPoint, accepting) {
  if (lastPoint?.active && accepting) {
    const sampled = formatSampleTime(round.priceSampledAt) ?? formatSampleTime(round.lastValidPriceAt);
    if (sampled) return sampled;
  }
  if (lastPoint && !lastPoint.active && lastPoint.periodEnd) {
    return formatSampleTime(lastPoint.periodEnd);
  }
  const closedWithTime = (round?.candles || []).filter(c => c.status === 'closed' && positive(c.p) && c.periodEnd);
  if (closedWithTime.length) {
    return formatSampleTime(Math.max(...closedWithTime.map(c => Number(c.periodEnd))));
  }
  if (round?.lastConfirmedCandleAt) {
    return formatSampleTime(round.lastConfirmedCandleAt);
  }
  if (accepting && positive(round?.twap24h) && (round?.priceSampledAt || round?.lastValidPriceAt)) {
    return formatSampleTime(round.priceSampledAt ?? round.lastValidPriceAt);
  }
  return null;
}

const asPositive = (value) => positive(value) ? Number(value) : null;
const toSeconds = (value) => positive(value) ? Number(value) / (Number(value) >= 1e12 ? 1000 : 1) : null;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function racePriceChart(round, demo, selectedSlot = null) {
  const accepting = canShowProvisionalPrice(round);
  const { protocolConfig } = round;
  const configuredCount = asPositive(protocolConfig?.candleCount);
  const count = Number.isInteger(configuredCount) ? configuredCount : PROTOCOL_SPECS.passTotal;
  const lockStart = toSeconds(round.stakeOpenAt);
  const lockEnd = toSeconds(round.stakeCloseAt);
  const firstEnd = toSeconds(round.earlyCloseAt);
  const lockSeconds = lockEnd > lockStart && lockStart !== null ? lockEnd - lockStart
    : asPositive(protocolConfig?.stakeDurationSeconds) ?? PROTOCOL_SPECS.lockHours * 3600;
  const firstSeconds = firstEnd > lockStart && lockStart !== null ? firstEnd - lockStart
    : asPositive(round.earlyWindowSeconds ?? protocolConfig?.earlyWindowSeconds) ?? PROTOCOL_SPECS.first6hHours * 3600;
  const seconds = asPositive(round.candleSeconds ?? protocolConfig?.candleSeconds)
    ?? (asPositive(protocolConfig?.observationSeconds) ?? PROTOCOL_SPECS.pushHours * 3600) / count;
  const fullSeconds = lockSeconds + count * seconds;
  const points = [];
  for (const slot of round.candles ?? []) {
    const index = Number(slot.index);
    if (!Number.isInteger(index) || index < 1 || index > count) continue;
    const active = slot.status === 'active';
    if (slot.status !== 'closed' && !(active && accepting)) continue;
    const price = asPositive(slot.p);
    if (price === null) continue;
    const progress = clamp(Number(slot.progressBps) / 10000 || 0, 0, 1);
    points.push({
      slot: index, time: lockSeconds + seconds * (active ? index - 1 + progress : index),
      price, active, qualified: slot.bull, periodEnd: slot.periodEnd ?? null,
    });
  }
  points.sort((a, b) => a.slot - b.slot);

  const preview = demo && accepting && round.rawState === 'STAKING_OPEN' && !points.length;
  if (preview) {
    const history = (round.demoRacePrices ?? round.priceHistory ?? []).filter(positive).map(Number);
    const livePrice = asPositive(round.livePrice);
    if (livePrice !== null) {
      if (history.length) history[history.length - 1] = livePrice;
      else history.push(livePrice);
    }
    const elapsed = lockStart === null ? 0 : clamp(serverNowMs() / 1000 - lockStart, 0, lockSeconds);
    history.forEach((price, i) => points.push({
      slot: i + 1, time: elapsed * (history.length === 1 ? 1 : i / (history.length - 1)), price,
    }));
  }

  const last = points.at(-1);
  const target = asPositive(round.targetPrice);
  const base = asPositive(round.roundBasePrice);
  const value = last?.price ?? null;
  const label = preview ? L('现价 · 模拟', 'Price · Demo')
    : last?.active ? L('本时段暂定均价', 'Provisional hourly average')
    : last ? L('最近确认均价', 'Last confirmed average') : L('现价', 'Current price');
  const status = pricePaused(round) ? L('判定暂停', 'Oracle paused')
    : priceStale(round) ? L('等待重新同步', 'Awaiting refresh')
    : !preview && !last ? L('冲价均价待同步', 'Awaiting hourly data') : '';
  const gapPct = accepting && value !== null && target !== null
    ? value >= target ? (value / target - 1) * 100 : (target / value - 1) * 100
    : null;
  const gapSize = gapPct === null ? '' : gapPct < 0.1 ? '&lt; 0.1%' : `+${gapPct.toFixed(1)}%`;
  const gapHtml = gapPct === null ? '' : gapPct === 0
    ? `<div class="q-price-gap q-up">${L('等于目标价', 'At target')}</div>`
    : value > target
      ? `<div class="q-price-gap q-up">${L(`已高于目标 ${gapSize}`, `Above target ${gapSize}`)}</div>`
      : `<div class="q-price-gap">${L(`距目标还差 ${gapSize}`, `${gapSize} rise to target`)}</div>`;
  const basePct = accepting && value !== null && base !== null ? (value / base - 1) * 100 : null;
  const deltaText = basePct === null ? '' : `${basePct >= 0 ? '+' : ''}${basePct.toFixed(1)}%`;
  const multiple = base !== null && target !== null ? (target / base).toFixed(2) : null;
  const targetLabel = multiple === null ? L('目标价', 'Target price') : L(`目标价 · 基准 ${multiple}×`, `Target · ${multiple}× baseline`);
  const header = `<div class="q-price-row">
    <div><small>${label}</small><b class="q-num">${fmtUsdOrDash(value)}</b>
      ${deltaText ? `<div class="q-price-gap ${basePct >= 0 ? 'q-up' : 'q-down'}">${L(`${deltaText} 较基准`, `${deltaText} vs baseline`)}</div>` : ''}</div>
    <div class="q-race-quote-target"><small>${targetLabel}</small><b class="q-num q-target-price">${fmtUsdOrDash(target)}</b>${gapHtml}</div>
  </div>`;

  const values = points.map(point => point.price);
  if (base !== null) values.push(base * 0.95);
  if (target !== null) values.push(target * 1.10);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const bottom = min * 0.99;
  const top = Math.max(max * 1.01, bottom + 0.00000001);
  const x = (time) => (100 * time / fullSeconds).toFixed(2);
  const y = (price) => (91 - 82 * (price - bottom) / (top - bottom)).toFixed(2);
  const picked = preview ? null : points.find(point => point.slot === selectedSlot);
  const firstWidth = x(Math.min(firstSeconds, lockSeconds));
  const pushStart = x(lockSeconds);
  const pushHours = count * seconds / 3600;
  const runs = [];
  let provisionalLine = '';
  for (const [i, point] of points.entries()) {
    const previous = points[i - 1];
    const xy = `${x(point.time)} ${y(point.price)}`;
    const adjacent = previous && !previous.active && previous.slot + 1 === point.slot;
    if (point.active) {
      if (adjacent) provisionalLine = `<path class="q-ch-line" data-provisional="1" d="M${x(previous.time)} ${y(previous.price)}L${xy}"/>`;
      continue;
    }
    if (adjacent) runs.at(-1).push(point);
    else runs.push([point]);
  }
  const paths = runs.filter(run => run.length > 1).map(run => {
    const line = 'M' + run.map(point => `${x(point.time)} ${y(point.price)}`).join('L');
    return `<path class="q-race-chart-area" d="${line}L${x(run.at(-1).time)} 100H${x(run[0].time)}Z"/><path class="q-ch-line" d="${line}"/>`;
  }).join('');
  const markers = preview
    ? last ? `<span class="q-race-point is-latest" style="--plot-x:${x(last.time)}%;--plot-y:${y(last.price)}%" aria-hidden="true"></span>` : ''
    : points.map((point) => {
        const tone = point.active ? 'provisional' : point.qualified === true ? 'passed' : point.qualified === false ? 'missed' : '';
        const aria = L(`第 ${point.slot} 小时 · ${fmtUsdOrDash(point.price)}`, `Hour ${point.slot} · ${fmtUsdOrDash(point.price)}`);
        return `<button type="button" class="q-race-point ${tone}${point === picked ? ' is-picked' : ''}${point.active ? ' q-price-active' : ''}" style="--plot-x:${x(point.time)}%;--plot-y:${y(point.price)}%" data-race-point="${point.slot}" aria-pressed="${point === picked}" aria-label="${escapeHtml(aria)}"></button>`;
      }).join('');

  const validTime = resolveLastValidTime(round, last, accepting);
  const syncTime = formatSampleTime(round.syncedAt ?? round.updatedAt ?? round.fetchedAt);
  const meta = demo ? '' : `<div class="q-chart-meta">
    <span>${L('采样周期', 'Cadence')}: ${formatCadenceLabel(seconds, count)}</span>
    <span>${L('最后有效行情', 'Last valid price')}: <b class="q-num" data-price-time="1">${validTime || L('待同步', 'Pending')}</b></span>
    ${syncTime ? `<span>${L('接口同步', 'API sync')}: <span class="q-num" data-sync-time="1">${syncTime}</span></span>` : ''}
  </div>`;
  const baseY = base === null ? null : y(base);
  const targetY = target === null ? null : y(target);
  const chartLabel = L(`${label} ${fmtUsdOrDash(value)}。基准价 ${fmtUsdOrDash(base)}。目标价 ${fmtUsdOrDash(target)}。`, `${label}: ${fmtUsdOrDash(value)}. Baseline: ${fmtUsdOrDash(base)}. Target: ${fmtUsdOrDash(target)}.`);
  return header + `
    <div class="q-race-chart-canvas${!preview && last ? ' has-hourly-data' : ''}" style="--early-end:${firstWidth}%;--push-start:${pushStart}%">
      <span class="q-race-band q-race-band-early" aria-hidden="true">${L('头矿', 'First 6H')}</span>
      <span class="q-race-band q-race-band-push" aria-hidden="true">${L(`封盘 · 冲价 ${pushHours}H`, `Sealed · ${pushHours}H`)}</span>
      <svg class="q-race-chart-plot" role="img" aria-label="${escapeHtml(chartLabel)}" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs><linearGradient id="q-race-area" x2="0" y2="1"><stop stop-color="var(--q-red)" stop-opacity=".18"/><stop offset="1" stop-color="var(--q-red)" stop-opacity="0"/></linearGradient></defs>
        ${baseY === null ? '' : `<line class="q-ch-base" x2="100" y1="${baseY}" y2="${baseY}"/>`}
        ${targetY === null ? '' : `<line class="q-ch-target" x2="100" y1="${targetY}" y2="${targetY}"/>`}
        ${paths}${provisionalLine}
        ${picked ? `<path class="q-race-selected-guide" d="M${x(picked.time)} 9V91"/>` : ''}
      </svg>
      ${targetY === null ? '' : `<span class="q-race-line-label is-target" style="--line-y:${targetY}%">${L('目标', 'Target')} ${fmtUsdOrDash(target)}</span>`}
      ${baseY === null ? '' : `<span class="q-race-line-label is-base" style="--line-y:${baseY}%">${L('基准', 'Baseline')} ${fmtUsdOrDash(base)}</span>`}
      ${markers}
      ${status ? `<span class="q-chart-status">${status}</span>` : ''}
    </div>${meta}`;
}
