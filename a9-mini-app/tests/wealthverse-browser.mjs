// Start dev-server.mjs first. PLAYWRIGHT_MODULE can point to an existing Playwright installation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);

const base = process.env.A9_TEST_URL || 'http://127.0.0.1:8091';
const output = process.env.A9_SCREENSHOTS || 'output/wealthverse';
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});

const errors = [];
const record = [];

const capture = (page, name) =>
  page.screenshot({
    path: join(output, name + '.png'),
    animations: 'disabled',
  });

const ROUTE_READY_SELECTORS = {
  '/challenge': '.plaza-overview',
  '/round': '#round-price-arena, .card-hero',
  '/gallery': 'a[href="#/challenge"]',
  '/rewards': '.sw-status-steps',
  '/challenge/confirm': '.card-hero, .card',
  '/challenge/success': '.card-hero, .card',
  '/observation/records': '.stamp-logbook .sw-stamp-grid',
  '/warmup': '.card-hero, .card',
  '/warmup/rank': '.card-hero, .card',
  '/internal/market': '[data-cm-tab="mall"]',
  '/market': '[data-cm-tab="mall"]',
  '/internal/records': '.card-hero, .card, .sw-menu-group',
  '/team': '.card-hero, .card',
  '/team/profile': '.card-hero, .card',
  '/team/bind-tg': '.card-hero, .card',
  '/team/invite': '.card-hero, .card',
  '/leaderboard': '.card-hero, .card',
  '/profile': '#profile-asset-card',
  '/claim': '.card-hero, .card',
  '/proof': '.cert-pass, .card-hero, .card',
  '/renew': '.card-hero, .card, .sw-menu-group',
  '/ledger': '.card-hero, .card',
  '/records': '.card-hero, .card',
  '/settings': '.card-hero, .card, .sw-menu-group',
  '/risk/matrix': '.card-hero, .card',
  '/risk/audit': '.card-hero, .card',
  '/rules': '.user-guide',
};

function resolveReadySelector(path, customSelector) {
  if (customSelector) return customSelector;
  const clean = path.split('?')[0];
  if (ROUTE_READY_SELECTORS[clean]) return ROUTE_READY_SELECTORS[clean];
  const prefix = '/' + clean.split('/').filter(Boolean).slice(0, -1).join('/');
  return ROUTE_READY_SELECTORS[prefix] || '#app-main .route-view-host > *';
}

async function waitForRouteReady(page, expectedPath, readySelector) {
  await page.waitForFunction(
    (target) => {
      const current = window.location.hash || '#/challenge';
      if (current !== '#' + target) return false;
      const main = document.getElementById('app-main');
      if (!main) return false;
      const host = main.querySelector('.route-view-host');
      if (!host || host.getAttribute('aria-busy') === 'true') return false;
      if (main.querySelector('.nt-boot-skeleton')) return false;
      return main.innerText.trim().length > 0;
    },
    expectedPath,
    { timeout: 15000 },
  );
  const selector = resolveReadySelector(expectedPath, readySelector);
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function visit(page, path, readySelector) {
  await page.evaluate((target) => {
    const nextHash = '#' + target;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    } else {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, path);
  await waitForRouteReady(page, path, readySelector);
}

async function clickAndWaitRoute(page, locator, expectedPath, readySelector) {
  await locator.click();
  await waitForRouteReady(page, expectedPath, readySelector);
}

async function mobile(width, height, locale, theme) {
  const page = await browser.newPage({
    viewport: { width, height },
    locale,
    reducedMotion: 'reduce',
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https:/, (r) => r.abort());
  await page.addInitScript(
    ({ themeMode, language }) => {
      localStorage.setItem(
        'a9_ui_prefs_v1',
        JSON.stringify({
          settings: { themeMode, language, reducedMotion: true, hapticsEnabled: true },
          user: { profileMode: 'active', autoRenew: true },
        }),
      );
    },
    { themeMode: theme, language: locale },
  );

  await page.goto(base + '/?mode=demo#/challenge');
  await waitForRouteReady(page, '/challenge', '.plaza-overview');
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    theme,
    `theme mismatch for ${locale}/${theme}`,
  );

  const routes = await page.evaluate(async () =>
    (await import('/js/router.js')).ROUTES.map((r) => r.path),
  );
  for (const route of routes) {
    await visit(page, route);
    assert.ok((await page.locator('#app-main').innerText()).trim(), route);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    assert.ok(overflow <= 0, `${route} overflow ${overflow}`);
    await capture(
      page,
      (width === 390 ? 'after' : 'narrow') + route.replaceAll('/', '-'),
    );
    record.push({ route, width, height, locale, theme, overflow });
  }

  // 4-tab navigation readiness check
  await visit(page, '/challenge');
  assert.equal(await page.locator('.tab-item').count(), 4);
  for (const path of ['/round', '/team', '/profile', '/challenge']) {
    await clickAndWaitRoute(page, page.locator(`.tab-item[data-nav="${path}"]`), path);
  }

  // Plaza: 12-slot strip, 4 gates, pending activation -> Chest Mall
  await visit(page, '/challenge');
  assert.equal(await page.locator('.plaza-overview .sw-stamp-row .sw-stamp-cell').count(), 12);
  assert.equal(await page.locator('.sw-gate-grid .sw-gate-tile').count(), 4);
  const plazaActivationLink = page.locator('#plaza-activity:not([hidden]) a[href="#/internal/market?from=activation"]');
  await plazaActivationLink.waitFor({ state: 'visible' });
  await clickAndWaitRoute(page, plazaActivationLink, '/internal/market?from=activation', '[data-cm-tab="mall"]');
  assert.match(await page.locator('#app-main').innerText(), /待激活奖励|Pending Activation/);

  // Plaza primary CTA -> Round Quest
  await visit(page, '/challenge');
  await clickAndWaitRoute(page, page.locator('.plaza-overview a.btn.btn-primary[href="#/round"]'), '/round');

  // Me (#/profile): pending activation entry -> Chest Mall
  await visit(page, '/profile');
  assert.equal(await page.locator('#a9-cosmetic-box').count(), 0);
  const profileActivationLink = page.locator('#profile-progress-group a[href="#/internal/market?from=activation"]');
  await profileActivationLink.waitFor({ state: 'visible' });
  await clickAndWaitRoute(page, profileActivationLink, '/internal/market?from=activation', '[data-cm-tab="mall"]');
  assert.match(await page.locator('#app-main').innerText(), /待激活奖励|Pending Activation/);

  // Chest Mall SKU & Free Chests tab
  await visit(page, '/internal/market');
  assert.equal(await page.locator('.sticker-pack-card').count(), 0);
  await page.locator('[data-pick-sku="chest_gold"]').click();
  await page.locator('[data-pick-sku="chest_gold"].is-selected').waitFor({ state: 'visible' });
  await page.locator('[data-cm-tab="free"]').click();
  await page.locator('[data-cm-tab="free"].active').waitFor({ state: 'visible' });
  assert.match(await page.locator('#app-main').innerText(), /青铜|Bronze/);

  // Rewards: 14D unlock 3-step summary
  await visit(page, '/rewards');
  assert.equal(await page.locator('.sw-status-steps .sw-status-step').count(), 3);
  assert.equal(await page.locator('.sticker-pack-card').count(), 0);

  // 12H Stamp Log: 12 slots & slot inspection
  await visit(page, '/observation/records');
  assert.equal(await page.locator('.sw-stamp-grid [data-slot]').count(), 12);
  await page.locator('[data-slot="4"]').click();
  await page.locator('[data-slot="4"][aria-pressed="true"]').waitFor({ state: 'visible' });
  assert.match(await page.locator('.star-reading').innerText(), /已确认未达标|Confirmed · missed/);
  await page.locator('[data-slot="12"]').click();
  await page.locator('[data-slot="12"][aria-pressed="true"]').waitFor({ state: 'visible' });
  assert.match(await page.locator('.star-reading').innerText(), /尚未开始|Upcoming/);

  // Legacy gallery deep link: archived notice, zero boxhead images, working Plaza & Guide links
  await visit(page, '/gallery/act-09');
  assert.match(await page.locator('#app-main').innerText(), /原角色图鉴功能已退役|Character Archive Retired/);
  assert.match(await page.locator('#app-main').innerText(), /#act-09/);
  assert.equal(await page.locator('img[src*="boxheads"]').count(), 0);
  await clickAndWaitRoute(page, page.locator('#app-main a[href="#/challenge"]'), '/challenge', '.plaza-overview');
  await visit(page, '/gallery');
  assert.match(await page.locator('#app-main').innerText(), /原角色图鉴功能已退役|Character Archive Retired/);
  await clickAndWaitRoute(page, page.locator('#app-main a[href="#/rules"]'), '/rules', '.user-guide');

  // Proof deep link & switcher
  await visit(page, '/proof');
  assert.ok((await page.locator('.cert-pass').count()) >= 1);

  await page.close();
}

try {
  await mobile(390, 844, 'zh-CN', 'light');
  await mobile(360, 780, 'en-US', 'dark');

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: 'zh-CN',
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https:/, (r) => r.abort());

  let online = false;
  const writes = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') writes.push(req.method());
    const path = new URL(req.url()).pathname;
    const data =
      path === '/api/user/test-wallet'
        ? {
            walletAddress: 'test-wallet',
            jettonWallet: 'test-jetton',
            balanceAvailable: true,
            ticketsAvailable: true,
            a9BalanceRaw: '987654321000000000000',
            claimableRaw: '0',
            lockedRaw: '0',
            tickets: [{ roundId: 7, amountRaw: '1000000000000', principalDone: false, exited: false, forfeited: false }],
          }
        : path === '/api/promo/balance/test-wallet'
          ? { claimableRaw: '0' }
          : path === '/api/config'
            ? { candleCount: 12, minQualifiedCandles: 8, poolState: { successCount: 6 } }
            : path === '/api/rounds'
              ? [{ roundId: 7, state: 'OBSERVING' }]
              : path === '/api/rounds/7'
                ? {
                    roundId: 7,
                    state: 'OBSERVING',
                    secondsRemaining: 0,
                    nextState: 'AWAITING_SETTLE',
                    qualifiedCandles: 8,
                    candlesSeen: 8,
                    candles: Array.from({ length: 8 }, (_, i) => ({
                      candleIndex: i,
                      qualified: true,
                    })),
                  }
                : null;
    return route.fulfill({
      json:
        online && data
          ? { ok: true, data, ts: Date.now() }
          : {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Test source offline' },
            },
    });
  });

  // Live offline -> retry recovery
  await page.goto(base + '/?mode=live#/challenge');
  await page.locator('#data-retry').waitFor({ state: 'visible' });
  await capture(page, 'live-offline');
  online = true;
  await page.locator('#data-retry').click();
  await waitForRouteReady(page, '/challenge', '.plaza-overview');

  // Live 12H Stamp Log: 8 pass + 4 unknown + awaiting settlement
  await visit(page, '/observation/records');
  assert.equal(await page.locator('.sw-stamp-grid [data-slot]').count(), 12);
  assert.equal(await page.locator('[data-state="pass"]').count(), 8);
  assert.equal(await page.locator('[data-state="unknown"]').count(), 4);
  assert.match(await page.locator('.stamp-logbook').innerText(), /等待结算/);
  await capture(page, 'live-awaiting-settlement');

  // Live Rewards: 14D unlock steps
  await visit(page, '/rewards');
  assert.match(await page.locator('.sw-status-steps').innerText(), /\+5\.71%/);

  // Live Challenge Confirm: read-only disabled button
  await visit(page, '/challenge/confirm');
  assert.ok(await page.locator('#app-main button[disabled]').count());

  // Live Legacy Gallery: archived notice + Plaza & Guide links
  await visit(page, '/gallery/act-09');
  assert.match(await page.locator('#app-main').innerText(), /原角色图鉴功能已退役|Character Archive Retired/);
  assert.equal(await page.locator('img[src*="boxheads"]').count(), 0);
  await clickAndWaitRoute(page, page.locator('#app-main a[href="#/rules"]'), '/rules', '.user-guide');

  // Live Leaderboard: no demo data leak
  await visit(page, '/leaderboard');
  assert.doesNotMatch(
    await page.locator('#app-main').innerText(),
    /13,104,000/,
  );

  // Live Profile: connected wallet long balance + safe-area inset + zero overflow
  await page.evaluate(async () => {
    const { store } = await import('/js/store.js');
    store.update((state) => {
      state.user.address = 'test-wallet';
      state.user.connected = true;
    });
    document.documentElement.style.setProperty('--tg-content-safe-area-inset-bottom', '34px');
    document.documentElement.style.setProperty('--tg-content-safe-area-inset-top', '18px');
  });
  await visit(page, '/profile');
  await page.locator('#profile-asset-card .sw-asset-main').filter({ hasText: '987,654,321,000 A9' }).waitFor({ state: 'visible' });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    0,
  );
  assert.ok(
    await page.locator('#app-tabbar').evaluate((el) => parseFloat(getComputedStyle(el).bottom) >= 34),
  );
  await capture(page, 'live-long-balance-safe-area');

  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);

  await writeFile(
    join(output, 'browser-results.json'),
    JSON.stringify(
      {
        screens: record,
        errors,
        liveWriteRequests: writes,
        liveSource: 'isolated HTTP fixture',
      },
      null,
      2,
    ),
  );
  console.log(
    record.length +
      ' route/viewport checks passed. 12-slot logbook, archived gallery links, Plaza/Me activation routing, offline retry, and live read-only checks passed.',
  );
} finally {
  await browser.close();
}
