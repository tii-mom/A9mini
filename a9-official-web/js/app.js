import { PROTOCOL_META, I18N, ROUNDS_DATA, STATE_LABELS, EVOLUTION_CARDS } from './data.js';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  lang: localStorage.getItem('a9_official_lang') === 'en' ? 'en' : 'zh',
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  selectedRoundId: 3,
  selectedAllocId: 3,
  selectedCandleIdx: null,
  simWeight: 0.95,
  activeNavSection: 'top',
  lastModalTrigger: null,
  modalTimer: null,
  modalFrame: null,
  previousOverflow: null,
  hasAwakenedObs: false,
};

const sandboxStamps = Array.from(
  { length: PROTOCOL_META.candleCount },
  (_, index) => index < PROTOCOL_META.minQualified,
);

const $ = (sel) => document.querySelector(sel);

function t(key) {
  return I18N[state.lang][key] ?? key;
}

function stateBadgeClass(roundState) {
  if (roundState === 'SUCCEEDED') return 'pass';
  if (roundState === 'FAILED_PERMANENT') return 'burn';
  if (roundState === 'UNOPENED') return 'upcoming';
  return '';
}

function formatUsd(val) {
  if (val === null || val === undefined) return t('targetTbd');
  return `$${val.toFixed(val >= 0.1 ? 2 : 4)}`;
}

/* ==========================================================================
   01. DATA AWAKENING — Smooth Ease-Out Count-Up (Runs Once, Stays Stable)
   ========================================================================== */
function animateCounter(el) {
  const target = Number(el.dataset.countTarget);
  if (!Number.isFinite(target) || el.dataset.awakened === '1') return;
  el.dataset.awakened = '1';
  const suffix = el.dataset.countSuffix || '';
  const fmt = new Intl.NumberFormat('en-US');

  if (prefersReducedMotion) {
    el.textContent = `${fmt.format(target)}${suffix}`;
    return;
  }

  const duration = 950;
  const start = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3); // Ease-Out Cubic
    const current = Math.round(target * eased);
    el.textContent = `${fmt.format(current)}${suffix}`;
    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      el.textContent = `${fmt.format(target)}${suffix}`;
    }
  }
  requestAnimationFrame(frame);
}

function setupDataAwakening() {
  const counters = document.querySelectorAll('[data-count-target]');
  if (!('IntersectionObserver' in window)) {
    counters.forEach(animateCounter);
    return;
  }

  const counterObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.25 });

  counters.forEach((el) => counterObserver.observe(el));

  const obsEl = $('#observatory');
  if (obsEl) {
    const obsObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !state.hasAwakenedObs) {
          state.hasAwakenedObs = true;
          $('#ladder-grid')?.classList.add('is-awakening');
          $('#stamp-grid')?.classList.add('is-awakening');
          setTimeout(() => {
            $('#ladder-grid')?.classList.remove('is-awakening');
            $('#stamp-grid')?.classList.remove('is-awakening');
          }, 950);
          observer.unobserve(obsEl);
        }
      });
    }, { threshold: 0.18 });
    obsObserver.observe(obsEl);
  }
}

/* ==========================================================================
   04. SLIDING HIGHLIGHT — Desktop Nav & Early-Bird Weight Segmented Control
   ========================================================================== */
function moveIndicator(container, indicator, activeEl) {
  if (!container || !indicator || !activeEl) return;
  const cRect = container.getBoundingClientRect();
  const aRect = activeEl.getBoundingClientRect();
  if (aRect.width === 0) return;
  const x = aRect.left - cRect.left;
  indicator.style.width = `${aRect.width}px`;
  indicator.style.transform = `translateX(${x}px)`;
}

function updateNavIndicator(sectionId) {
  const nav = $('#desktop-nav');
  const indicator = $('#nav-indicator');
  if (!nav || !indicator) return;
  const links = nav.querySelectorAll('a[data-section]');
  let targetLink = null;
  links.forEach((link) => {
    const match = link.dataset.section === sectionId;
    link.classList.toggle('is-active', match);
    if (match) targetLink = link;
  });
  if (targetLink) {
    state.activeNavSection = sectionId;
    moveIndicator(nav, indicator, targetLink);
  }
}

function updateSegIndicator() {
  const group = $('#sim-weight-group');
  const indicator = $('#seg-indicator');
  const activeBtn = group?.querySelector('.seg-btn.is-active');
  moveIndicator(group, indicator, activeBtn);
}

function setupScrollSpy() {
  const sections = ['top', 'observatory', 'unlock', 'allocation', 'ledger']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!('IntersectionObserver' in window) || sections.length === 0) return;

  const spy = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((e) => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (visible.length > 0) {
      updateNavIndicator(visible[0].target.id);
    }
  }, { rootMargin: '-28% 0px -55% 0px', threshold: [0.1, 0.4] });

  sections.forEach((sec) => spy.observe(sec));
}

/* ==========================================================================
   THEME & I18N
   ========================================================================== */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem('a9_official_theme', state.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#121318' : '#F4F5F8');
  $('#theme-icon').textContent = state.theme === 'dark' ? '☀' : '☾';
  $('#theme-label').textContent = state.theme === 'dark' ? t('themeToLight') : t('themeToDark');
}

function applyI18n() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('pageTitle');
  localStorage.setItem('a9_official_lang', state.lang);
  $('#lang-toggle').textContent = state.lang === 'zh' ? 'EN' : '中文';

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = I18N[state.lang][key];
    if (typeof val === 'string') {
      el.textContent = val;
    }
  });

  applyTheme();
  renderLadder();
  renderObservatoryDetail();
  renderSandbox();
  renderAllocationRibbon();
  renderStages();
  renderLedger();
  renderEvolution();
  updateSimulator();

  requestAnimationFrame(() => {
    updateNavIndicator(state.activeNavSection);
    updateSegIndicator();
  });
}

/* ==========================================================================
   CORE RENDERERS
   ========================================================================== */
function renderLadder() {
  const container = $('#ladder-grid');
  container.innerHTML = '';
  ROUNDS_DATA.forEach((round, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ladder-btn${round.id === state.selectedRoundId ? ' is-selected' : ''}`;
    btn.dataset.state = round.state;
    btn.dataset.round = String(round.id);
    btn.style.setProperty('--idx', String(i));
    btn.setAttribute('aria-pressed', String(round.id === state.selectedRoundId));
    const tag = String(round.id).padStart(2, '0');
    const label = round.targetLocked ? formatUsd(round.targetPrice) : t('targetTbd');
    const status = STATE_LABELS[round.state][state.lang];
    btn.setAttribute('aria-label', state.lang === 'zh'
      ? `第 ${tag} 轮，${status}，目标价 ${label}`
      : `Round ${tag}, ${status}, target price ${label}`);

    btn.innerHTML = `
      <span class="ladder-bar mono">${round.targetLocked ? label : '—'}</span>
      <span class="ladder-idx mono">${tag}</span>
    `;

    const selectRound = (index) => {
      state.selectedRoundId = ROUNDS_DATA[index].id;
      state.selectedCandleIdx = null;
      renderLadder();
      renderObservatoryDetail();
      container.querySelector('[aria-pressed="true"]').focus();
    };

    btn.addEventListener('click', () => selectRound(i));
    btn.addEventListener('keydown', (event) => {
      const total = ROUNDS_DATA.length;
      const destinations = new Map([
        ['ArrowLeft', (i + total - 1) % total],
        ['ArrowRight', (i + 1) % total],
        ['Home', 0],
        ['End', total - 1],
      ]);
      if (!destinations.has(event.key)) return;
      event.preventDefault();
      selectRound(destinations.get(event.key));
    });
    container.appendChild(btn);
  });
}

function renderObservatoryDetail() {
  const round = ROUNDS_DATA.find((r) => r.id === state.selectedRoundId) || ROUNDS_DATA[2];
  const tag = String(round.id).padStart(2, '0');
  $('#obs-round-title').textContent = state.lang === 'zh' ? `第 ${tag} 轮` : `ROUND ${tag}`;

  const statusEl = $('#obs-round-status');
  statusEl.textContent = STATE_LABELS[round.state][state.lang];
  statusEl.className = `status-badge ${stateBadgeClass(round.state)}`;

  $('#obs-target').textContent = round.targetPrice !== null ? formatUsd(round.targetPrice) : t('targetTbd');
  $('#obs-twap').textContent = round.latestTwap !== null ? formatUsd(round.latestTwap) : '—';
  $('#obs-qualified').textContent = round.seen > 0 ? `${round.qualified} / ${PROTOCOL_META.candleCount}` : `0 / ${PROTOCOL_META.candleCount}`;

  const stampGrid = $('#stamp-grid');
  stampGrid.innerHTML = '';
  round.candles.forEach((c, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `stamp-tile ${c.status}${state.selectedCandleIdx === c.index ? ' is-active' : ''}${c.index === PROTOCOL_META.minQualified ? ' is-threshold' : ''}`;
    btn.style.setProperty('--idx', String(idx));
    const mark = c.status === 'hit' ? '✓' : c.status === 'miss' ? '×' : '·';
    btn.innerHTML = `<span>H${String(c.index).padStart(2, '0')}</span><span>${mark}</span>`;
    btn.addEventListener('click', () => {
      state.selectedCandleIdx = c.index;
      renderObservatoryDetail();
      const statusTxt = c.status === 'hit'
        ? t('stampLegendHit')
        : c.status === 'miss'
          ? t('stampLegendMiss')
          : t('stampLegendPending');
      const priceTxt = c.price !== null ? formatUsd(c.price) : '—';
      $('#stamp-inspector').textContent = `H${String(c.index).padStart(2, '0')} (${c.hour}) · TWAP ${priceTxt} · ${statusTxt}`;
    });
    stampGrid.appendChild(btn);
  });

  if (state.selectedCandleIdx === null) {
    $('#stamp-inspector').textContent = t('stampHint');
  }
}

function renderAllocationRibbon() {
  const container = $('#alloc-ribbon');
  container.innerHTML = '';
  ROUNDS_DATA.forEach((round) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ribbon-seg${round.id === state.selectedAllocId ? ' is-lit' : ''}`;
    btn.textContent = String(round.id).padStart(2, '0');
    btn.addEventListener('click', () => {
      state.selectedAllocId = round.id;
      renderAllocationRibbon();
    });
    container.appendChild(btn);
  });

  const teamSeg = document.createElement('div');
  teamSeg.className = 'ribbon-reserve is-team';
  teamSeg.textContent = t('ribbonTeam');
  container.appendChild(teamSeg);

  const otherSeg = document.createElement('div');
  otherSeg.className = 'ribbon-reserve is-other';
  otherSeg.textContent = t('ribbonOther');
  container.appendChild(otherSeg);

  const selected = ROUNDS_DATA.find((r) => r.id === state.selectedAllocId) || ROUNDS_DATA[2];
  const tag = String(selected.id).padStart(2, '0');
  const tier = selected.multiplier
      ? (state.lang === 'zh' ? `${selected.multiplier} 动态走廊` : `${selected.multiplier} Corridor`)
      : t('targetTbd');

  $('#alloc-ribbon-note').textContent = state.lang === 'zh'
    ? `第 ${tag} 轮 · ${tier} · 基础预算 700,000,000 A9（7%）`
    : `Round ${tag} · ${tier} · Base pool 700,000,000 A9 (7%)`;
}

function renderStages() {
  const container = $('#stages-grid');
  container.innerHTML = '';
  I18N[state.lang].stages.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'stage-item';
    li.innerHTML = `
      <div class="stage-top">
        <span class="stage-idx">${s.idx}</span>
        <span class="stage-dur mono">${s.dur}</span>
      </div>
      <p>${s.desc}</p>
    `;
    container.appendChild(li);
  });
}

function renderLedger() {
  const tbody = $('#ledger-tbody');
  tbody.innerHTML = '';
  ROUNDS_DATA.forEach((round) => {
    const tr = document.createElement('tr');
    if (round.state === 'OBSERVING') tr.className = 'is-live';
    const tag = String(round.id).padStart(2, '0');
    const corridor = round.multiplier || '—';
    const target = round.targetPrice !== null ? formatUsd(round.targetPrice) : t('targetTbd');
    const qual = round.seen > 0 ? `${round.qualified} / ${PROTOCOL_META.candleCount}` : '—';
    const badgeCls = stateBadgeClass(round.state);
    const statusText = STATE_LABELS[round.state][state.lang];

    tr.innerHTML = `
      <td class="mono"><strong>${tag}</strong></td>
      <td class="mono">${corridor}</td>
      <td class="mono">${target}</td>
      <td class="mono">${qual}</td>
      <td class="mono">${round.poolA9} A9</td>
      <td><span class="status-badge ${badgeCls}">${statusText}</span></td>
      <td><button type="button" class="pill-btn mono" data-inspect="${round.id}">${t('inspectBtn')}</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-inspect]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      openRoundModal(Number(btn.getAttribute('data-inspect')), e.currentTarget);
    });
  });
}

/* ==========================================================================
   03. RESTRAINED 3D HOVER & FLIP — Expressive Collector Cards Only (A1–A9)
   ========================================================================== */
function attachSubtleTilt(el, maxDeg = 7) {
  if (!el || prefersReducedMotion) return;
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    const rx = (-py * maxDeg * 2).toFixed(2);
    const ry = (px * maxDeg * 2).toFixed(2);
    el.style.transform = `perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-2px)`;
  });
  el.addEventListener('pointerleave', () => {
    el.style.transform = '';
  });
}

function renderEvolution() {
  const strip = $('#evo-strip');
  strip.innerHTML = '';
  EVOLUTION_CARDS.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'evo-card';
    btn.setAttribute('aria-pressed', 'false');
    const req = state.lang === 'zh' ? item.reqZh : item.reqEn;
    const perk = state.lang === 'zh' ? item.perkZh : item.perkEn;

    btn.innerHTML = `
      <div class="evo-card-inner">
        <div class="evo-face evo-front">
          <div class="evo-cart-bar mono">
            <strong>${item.id}</strong>
            <em>${item.rarity || 'TIER'}</em>
          </div>
          <div class="evo-art-frame">
            <img src="${item.img}" alt="${item[state.lang]}" loading="lazy" />
          </div>
          <div class="evo-front-foot">
            <span class="evo-front-name">${item[state.lang]}</span>
            <small class="evo-front-hint">${state.lang === 'zh' ? '点击翻卡 ↻' : 'Flip ↻'}</small>
          </div>
        </div>
        <div class="evo-face evo-back">
          <div class="evo-cart-bar mono is-back">
            <strong>${item.id}</strong>
            <em>${item.rarity || 'TIER'}</em>
          </div>
          <div class="evo-back-body">
            <div class="evo-back-title">${item[state.lang]}</div>
            <div class="evo-back-req">${req}</div>
            <div class="evo-back-perk">${perk}</div>
          </div>
        </div>
      </div>
    `;

    btn.addEventListener('click', () => {
      const flipped = btn.classList.toggle('is-flipped');
      btn.setAttribute('aria-pressed', String(flipped));
    });

    if (!prefersReducedMotion) {
      btn.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse' || btn.classList.contains('is-flipped')) return;
        const rect = btn.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        const inner = btn.querySelector('.evo-card-inner');
        inner.style.transform = `rotateX(${(-py * 12).toFixed(1)}deg) rotateY(${(px * 12).toFixed(1)}deg) translateY(-3px)`;
      });
      btn.addEventListener('pointerleave', () => {
        if (btn.classList.contains('is-flipped')) return;
        const inner = btn.querySelector('.evo-card-inner');
        inner.style.transform = '';
      });
    }

    strip.appendChild(btn);
  });
}

function updateSimulator() {
  const stakeInput = $('#sim-stake');
  const assumedInput = $('#sim-assumed-reward');
  const principal = Math.max(PROTOCOL_META.minStake, Number(stakeInput.value) || PROTOCOL_META.minStake);
  const tierRaw = String($('#sim-tier').value || '0.2');
  const isCashout = tierRaw === 'cashout';
  const instantRate = isCashout ? 0.44 : (Number(tierRaw) || 0.2);
  const refundRatio = Number(state.simWeight) > 0 && Number(state.simWeight) <= 1 ? Number(state.simWeight) : 0.95;
  const failRefund = Math.floor(principal * refundRatio);
  const failBurn = principal - failRefund;
  const maxCapReward = principal * (PROTOCOL_META.maxRewardMultiplier || 5);
  const rawAssumed = Math.max(0, Number(assumedInput?.value) || 0);
  const effectiveReward = Math.min(maxCapReward, Math.round(rawAssumed));
  const instantClaim = Math.round(principal + effectiveReward * instantRate);
  const lockedOrBurn = Math.round(effectiveReward * (1 - instantRate));

  const fmt = new Intl.NumberFormat('en-US');
  $('#sim-out-weight').textContent = `${fmt.format(failRefund)} A9 (-${fmt.format(failBurn)})`;
  $('#sim-out-cap').textContent = `${fmt.format(maxCapReward)} A9`;
  $('#sim-out-instant').textContent = `${fmt.format(instantClaim)} A9`;
  $('#sim-out-locked').textContent = isCashout
    ? `${fmt.format(lockedOrBurn)} A9 (BURN)`
    : `${fmt.format(lockedOrBurn)} A9`;
}

/* ==========================================================================
   05. SPATIAL CARD EXPANSION (FLIP Open & Collapse — 4-Column Hourly Grid)
   ========================================================================== */
function openRoundModal(roundId, triggerEl = null) {
  const round = ROUNDS_DATA.find((r) => r.id === roundId) || ROUNDS_DATA[2];
  const tag = String(round.id).padStart(2, '0');
  $('#modal-title').textContent = `${t('modalTitlePrefix')}${tag}${t('modalTitleSuffix')}`;

  const body = $('#modal-body');
  const listHtml = round.candles.map((c, idx) => {
    const st = c.status === 'hit' ? t('stampLegendHit') : c.status === 'miss' ? t('stampLegendMiss') : t('stampLegendPending');
    const pr = c.price !== null ? formatUsd(c.price) : '—';
    return `
      <div class="modal-candle ${c.status} mono" style="--idx:${idx}">
        <div><strong>H${String(c.index).padStart(2, '0')}</strong> · ${c.hour}</div>
        <div>TWAP: ${pr}</div>
        <div>${st}</div>
      </div>
    `;
  }).join('');

  body.innerHTML = `<div class="modal-candle-list">${listHtml}</div>`;

  const backdrop = $('#round-modal');
  const sheet = backdrop.querySelector('.modal-sheet');
  clearTimeout(state.modalTimer);
  state.modalTimer = null;
  cancelAnimationFrame(state.modalFrame);
  state.lastModalTrigger = triggerEl;
  if (state.previousOverflow === null) state.previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  backdrop.hidden = false;
  sheet.style.transition = 'none';
  sheet.style.transform = '';
  $('#modal-close').focus();

  if (!prefersReducedMotion && triggerEl) {
    const from = triggerEl.getBoundingClientRect();
    const to = sheet.getBoundingClientRect();
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const sx = Math.max(0.25, from.width / to.width);
    const sy = Math.max(0.18, from.height / to.height);

    sheet.style.transition = 'none';
    sheet.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    sheet.style.opacity = '0.3';
    sheet.getBoundingClientRect(); // force layout

    state.modalFrame = requestAnimationFrame(() => {
      backdrop.classList.add('is-open');
      sheet.style.transition = 'transform 0.38s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.24s ease-out';
      sheet.style.transform = 'translate(0, 0) scale(1)';
      sheet.style.opacity = '1';
    });
  } else {
    backdrop.classList.add('is-open');
    sheet.style.transform = '';
    sheet.style.opacity = '1';
  }
}

function closeRoundModal() {
  const backdrop = $('#round-modal');
  const sheet = backdrop.querySelector('.modal-sheet');
  if (backdrop.hidden || state.modalTimer !== null) return;
  cancelAnimationFrame(state.modalFrame);
  backdrop.classList.remove('is-open');

  const finishClose = () => {
    backdrop.hidden = true;
    sheet.style.transform = '';
    sheet.style.opacity = '';
    document.body.style.overflow = state.previousOverflow;
    state.previousOverflow = null;
    state.modalTimer = null;
    state.lastModalTrigger?.focus();
  };
  if (!prefersReducedMotion && state.lastModalTrigger) {
    const to = state.lastModalTrigger.getBoundingClientRect();
    const from = sheet.getBoundingClientRect();
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    sheet.style.transition = 'transform 0.26s cubic-bezier(0.4, 0, 1, 1), opacity 0.22s ease-in';
    sheet.style.transform = `translate(${dx}px, ${dy}px) scale(0.35)`;
    sheet.style.opacity = '0';
    state.modalTimer = setTimeout(finishClose, 260);
  } else {
    finishClose();
  }
}

/* ==========================================================================
   EVENTS & BOOT
   ========================================================================== */
function renderSandbox() {
  const grid = $('#sandbox-stamps');
  if (!grid.childElementCount) {
    sandboxStamps.forEach((_, index) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.innerHTML = '<span></span><span aria-hidden="true"></span>';
      tile.firstElementChild.textContent = `H${String(index + 1).padStart(2, '0')}`;
      tile.addEventListener('click', () => {
        sandboxStamps[index] = !sandboxStamps[index];
        renderSandbox();
      });
      grid.append(tile);
    });
  }

  Array.from(grid.children).forEach((tile, index) => {
    const hit = sandboxStamps[index];
    const isThreshold = index + 1 === PROTOCOL_META.minQualified;
    tile.className = `stamp-tile ${hit ? 'hit' : 'miss'}${isThreshold ? ' is-threshold' : ''}`;
    tile.lastElementChild.textContent = hit ? '✓' : '×';
    tile.setAttribute('aria-pressed', String(hit));
    tile.setAttribute('aria-label', `${tile.firstElementChild.textContent} · ${t(hit ? 'stampLegendHit' : 'stampLegendMiss')}`);
  });

  const qualified = sandboxStamps.filter(Boolean).length;
  const pass = qualified >= PROTOCOL_META.minQualified;
  $('#sandbox-count').textContent = `${qualified} / ${PROTOCOL_META.candleCount}`;
  $('#sandbox-verdict').textContent = t(pass ? 'sandboxPass' : 'sandboxFail');
  $('#sandbox-result').dataset.outcome = pass ? 'pass' : 'fail';
}

function bindEvents() {
  document.querySelectorAll('[data-sandbox-preset]').forEach((preset) => {
    preset.addEventListener('click', () => {
      const qualified = Number(preset.dataset.sandboxPreset);
      sandboxStamps.forEach((_, index) => { sandboxStamps[index] = index < qualified; });
      renderSandbox();
    });
  });
  $('#theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });

  $('#lang-toggle').addEventListener('click', () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    applyI18n();
  });

  $('#desktop-nav')?.querySelectorAll('a[data-section]').forEach((link) => {
    link.addEventListener('click', () => {
      updateNavIndicator(link.dataset.section);
    });
  });

  const menuBtn = $('#mobile-menu-btn');
  const drawer = $('#mobile-drawer');
  menuBtn.addEventListener('click', () => {
    const open = drawer.hidden;
    drawer.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  });

  drawer.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      drawer.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    });
  });

  $('#obs-open-modal').addEventListener('click', (e) => openRoundModal(state.selectedRoundId, e.currentTarget));
  $('#modal-close').addEventListener('click', closeRoundModal);
  $('#round-modal').addEventListener('click', (e) => {
    if (e.target === $('#round-modal')) closeRoundModal();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#round-modal').hidden) return;
    if (e.key === 'Escape') closeRoundModal();
    if (e.key === 'Tab') {
      e.preventDefault();
      $('#modal-close').focus();
    }
  });

  const stakeInput = $('#sim-stake');
  const assumedInput = $('#sim-assumed-reward');
  stakeInput.min = String(PROTOCOL_META.minStake);
  stakeInput.addEventListener('input', updateSimulator);
  stakeInput.addEventListener('blur', () => {
    if (stakeInput.valueAsNumber >= PROTOCOL_META.minStake) return;
    stakeInput.value = String(PROTOCOL_META.minStake);
    updateSimulator();
  });
  if (assumedInput) {
    assumedInput.addEventListener('input', updateSimulator);
    assumedInput.addEventListener('blur', () => {
      const principal = Math.max(PROTOCOL_META.minStake, Number(stakeInput.value) || PROTOCOL_META.minStake);
      const capped = Math.min(principal * (PROTOCOL_META.maxRewardMultiplier || 5), Math.max(0, Math.round(Number(assumedInput.value) || 0)));
      assumedInput.value = String(capped);
      updateSimulator();
    });
  }
  document.querySelectorAll('[data-reward-mult]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mult = Number(btn.dataset.rewardMult) || 1;
      const principal = Math.max(PROTOCOL_META.minStake, Number(stakeInput.value) || PROTOCOL_META.minStake);
      if (assumedInput) assumedInput.value = String(Math.round(principal * mult));
      updateSimulator();
    });
  });
  $('#sim-tier').addEventListener('change', updateSimulator);
  $('#sim-weight-group').querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#sim-weight-group').querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.simWeight = Number(btn.dataset.weight) || 0.95;
      updateSegIndicator();
      updateSimulator();
    });
  });

  $('#back-to-top').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  window.addEventListener('resize', () => {
    updateNavIndicator(state.activeNavSection);
    updateSegIndicator();
  });
}

for (const [id, amount] of [
  ['pool-giant-num', PROTOCOL_META.rewardPool],
  ['burn-counter', PROTOCOL_META.confirmedBurned],
  ['remain-counter', PROTOCOL_META.remainingSupply],
]) {
  if (amount === null) continue;
  const counter = document.getElementById(id);
  counter.dataset.countTarget = String(amount);
  counter.textContent = `${amount.toLocaleString('en-US')}${counter.dataset.countSuffix}`;
}

if (PROTOCOL_META.confirmedBurned !== null) {
  const fill = $('#burn-ratio-fill');
  fill.style.width = `${PROTOCOL_META.confirmedBurned / PROTOCOL_META.totalSupply * 100}%`;
  fill.parentElement.hidden = false;
}

bindEvents();
const miniAppHref = `${location.protocol === 'file:' ? 'https:' : location.protocol}//app.a9.lat/`;
document.querySelectorAll('[data-miniapp-cta]').forEach((el) => {
  el.setAttribute('href', miniAppHref);
  el.setAttribute('target', '_blank');
  el.setAttribute('rel', 'noopener noreferrer');
});
applyI18n();
setupDataAwakening();
setupScrollSpy();
attachSubtleTilt($('#focal-art'), 7);
