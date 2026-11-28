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

export function racePriceChart(round, demo) {
  const accepting = canShowProvisionalPrice(round);
  const configuredCount = Number(round.protocolConfig?.candleCount);
  const count = Number.isInteger(configuredCount) && configuredCount > 0 ? configuredCount : 12;
  const configuredSeconds = Number(round.candleSeconds ?? round.protocolConfig?.candleSeconds);
  const seconds = positive(configuredSeconds) ? configuredSeconds : 3600;
  const points = [];
  for (const slot of round.candles || []) {
    const index = Number(slot.index);
    if (!Number.isInteger(index) || index < 1 || index > count) continue;
    const active = slot.status === 'active';
    if (slot.status !== 'closed' && !(active && accepting)) continue;
    const price = active && demo ? round.livePrice : slot.p;
    if (!positive(price)) continue;
    const progress = Math.max(0, Math.min(1, (Number(slot.progressBps) || 0) / 10000));
    points.push({
      slot: index,
      time: active ? index - 1 + progress : index,
      price: Number(price),
      active,
      qualified: slot.bull,
      periodEnd: slot.periodEnd ?? null,
    });
  }
  points.sort((a, b) => a.slot - b.slot);
  const preview = demo && accepting && round.rawState === 'STAKING_OPEN' && !points.length;
  if (preview) {
    const history = (round.priceHistory || []).filter(positive);
    if (!history.length && positive(round.livePrice)) history.push(round.livePrice);
    history.forEach((price, i) => points.push({
      slot: i + 1,
      time: count * (history.length === 1 ? 1 : i / (history.length - 1)),
      price,
      active: i === history.length - 1,
      periodEnd: null,
    }));
  }
  const last = points.at(-1);
  const target = positive(round.targetPrice) ? Number(round.targetPrice) : null;
  const value = last?.price ?? (accepting && positive(round.twap24h) ? round.twap24h : null);
  const label = preview
    ? L('模拟参考价', 'Demo reference price')
    : last?.active
      ? L('本时段暂定均价', 'Provisional hourly average')
      : last
        ? L('最近确认均价', 'Last confirmed average')
        : L('24 小时参考均价', '24h reference average');
  const status = pricePaused(round) ? L('判定暂停', 'Oracle paused')
    : priceStale(round) ? L('等待重新同步', 'Awaiting refresh')
    : round.priceValid === false ? L('行情待确认', 'Price unverified') : '';
  const cadenceText = formatCadenceLabel(seconds, count);
  const validTime = resolveLastValidTime(round, last, accepting);
  const syncTime = formatSampleTime(round.syncedAt ?? round.updatedAt ?? round.fetchedAt);
  const metaStrip = `<div class="q-chart-meta"><span>${L('采样周期', 'Cadence')}: ${cadenceText}</span><span>${L('最后有效行情', 'Last valid price')}: <b class="q-num" data-price-time="1">${validTime || L('待同步', 'Pending')}</b></span>${syncTime ? `<span>${L('接口同步', 'API sync')}: <span class="q-num" data-sync-time="1">${syncTime}</span></span>` : ''}</div>`;
  const gapPct = (accepting && value !== null && target !== null)
    ? ((value - target) / target) * 100
    : null;
  const gapBelowPrecision = Math.abs(gapPct) < 0.1;
  const gapSize = gapBelowPrecision ? '&lt; 0.1%' : `${Math.abs(gapPct).toFixed(1)}%`;
  const aboveTarget = gapBelowPrecision ? gapSize : `+${gapSize}`;
  const gapHtml = gapPct === null
    ? ''
    : gapPct === 0
      ? `<div class="q-price-gap q-up">${L('等于目标价', 'At target')}</div>`
      : gapPct > 0
        ? `<div class="q-price-gap q-up">${L(`已高于目标 ${aboveTarget}`, `Above target ${aboveTarget}`)}</div>`
        : `<div class="q-price-gap q-down">${L(`距目标还差 ${gapSize}`, `${gapSize} below target`)}</div>`;

  const header = `<div class="q-price-row"><div><small>${label}</small><b class="q-num">${fmtUsdOrDash(value)}</b>${gapHtml}</div><div class="q-ta-r"><small>${L('本关目标价', 'Target price')}</small><b class="q-num q-target-price">${fmtUsdOrDash(target)}</b></div></div>`;
  if (!points.length) {
    const emptyText = ['UNOPENED', 'STAKING_OPEN', 'STAKING_CLOSED'].includes(round.rawState)
      ? L('冲价尚未开始', 'Price push has not started')
      : L('暂无冲价时段均价', 'No hourly averages yet');
    return header + `<div class="q-price-empty">${status || emptyText}</div>` + metaStrip;
  }
  const values = points.map(point => point.price);
  if (target !== null) values.push(target);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.14, max * 0.001, 0.00000001);
  const bottom = Math.max(min / 2, min - padding);
  const top = max + padding;
  const x = time => (5 + 250 * time / count).toFixed(2);
  const y = price => (110 - 100 * (price - bottom) / (top - bottom)).toFixed(2);
  const segments = points.map((point, i) => {
    const prev = points[i - 1];
    const adjacent = prev && prev.slot + 1 === point.slot;
    const provisional = point.active && !preview;
    return (adjacent ? `<line class="q-ch-line" ${provisional ? 'data-provisional="1" stroke-dasharray="4 3"' : ''} x1="${x(prev.time)}" y1="${y(prev.price)}" x2="${x(point.time)}" y2="${y(point.price)}"/>` : '') +
      `<circle ${point.active ? 'class="q-price-active"' : ''} cx="${x(point.time)}" cy="${y(point.price)}" r="${point.active ? 4 : 3}" fill="${point.active ? 'var(--q-blue-ink)' : point.qualified === true ? 'var(--q-green)' : point.qualified === false ? 'var(--q-red)' : 'var(--q-ink)'}"/>`;
  }).join('');
  const duration = slots => {
    const total = slots * seconds;
    return total % 3600 === 0 ? L(`${total / 3600} 小时`, `${total / 3600}h`) : L(`${total / 60} 分钟`, `${total / 60}m`);
  };
  const legend = `<div class="q-race-chart-key" aria-hidden="true">
    ${points.some(point => !point.active) || preview ? `<span>${preview ? L('模拟采样', 'Demo samples') : L('确认均价', 'Confirmed average')}</span>` : ''}
    ${last?.active && !preview ? `<span class="q-race-key-provisional">${L('暂定均价', 'Provisional average')}</span>` : ''}
    ${target !== null ? `<span class="q-race-key-target">${L('目标价', 'Target')}</span>` : ''}
  </div>`;
  const chartLabel = L(`${label} ${fmtUsdOrDash(value)}。目标价 ${fmtUsdOrDash(target)}。`, `${label}: ${fmtUsdOrDash(value)}. Target: ${fmtUsdOrDash(target)}.`);
  return header + `<div class="q-race-chart-frame">
    <div class="q-race-price-axis q-num" aria-hidden="true"><span>${fmtUsdOrDash(top)}</span><span>${fmtUsdOrDash(bottom)}</span></div>
    <svg class="q-race-chart-plot" role="img" aria-label="${chartLabel}" viewBox="0 0 260 120" preserveAspectRatio="none">
      ${[10, 60, 110].map(row => `<path class="q-race-chart-grid" d="M5 ${row}h250"/>`).join('')}
      ${target === null ? '' : `<path class="q-ch-target" d="M5 ${y(target)}h250"/>`}${segments}
    </svg>
    <div class="q-race-time-axis q-num" aria-hidden="true"><span>${preview ? L('近期采样', 'Recent samples') : duration(0)}</span><span>${preview ? '' : duration(count / 2)}</span><span>${preview ? L('现在', 'Now') : duration(count)}</span></div>
  </div>${legend}
    ${metaStrip}
    ${status ? `<small class="q-chart-status">${status}</small>` : ''}`;
}
