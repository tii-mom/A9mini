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
async function visit(page, path) {
  await page.evaluate((path) => {
    location.hash = path;
  }, path);
  await page.waitForFunction((path) => location.hash === '#' + path, path);
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
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
    (theme) => localStorage.setItem('a9_theme_mode', theme),
    theme,
  );
  await page.goto(base + '/?mode=demo');
  await page.locator('.wv-hero').waitFor();
  const routes = await page.evaluate(async () =>
    (await import('/js/router.js')).ROUTES.map((r) => r.path),
  );
  for (const route of routes) {
    await visit(page, route);
    assert.ok((await page.locator('#app-main').innerText()).trim(), route);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    assert.ok(overflow <= 0, route + ' overflow ' + overflow);
    await capture(
      page,
      (width === 390 ? 'after' : 'narrow') + route.replaceAll('/', '-'),
    );
    record.push({ route, width, height, locale, theme, overflow });
  }
  await visit(page, '/challenge');
  assert.equal(await page.locator('.tab-item').count(), 4);
  for (const path of ['/challenge', '/round', '/team', '/profile']) {
    await visit(page, '/challenge');
    await page.locator(`.tab-item[data-nav="${path}"]`).click();
    assert.equal(new URL(page.url()).hash, '#'+path);
  }
  await visit(page, '/challenge');
  assert.equal(await page.locator('.handbook-stamp-cell').count(), 4);
  await page.locator('[data-stamp-task="daily_checkin"]').click();
  await page.locator('[data-stamp-task="daily_checkin"][aria-pressed="true"]').waitFor();
  await page.locator('.game-gates a[href="#/internal/market"]').click();
  assert.equal(new URL(page.url()).hash, '#/internal/market');
  await visit(page, '/rewards');
  assert.equal(await page.locator('.crystal-preview img').count(), 3);
  await visit(page, '/challenge');
  await page.locator('.game-play').click();
  assert.match(page.url(), /#\/round$/);
  await visit(page, '/gallery/9');
  await page.locator('a[aria-current=true][href="#/gallery/9"]').waitFor();
  const download = page.waitForEvent('download');
  await page.locator('#wv-export').click();
  assert.equal((await download).suggestedFilename(), 'A9-preview-9.png');
  await page.locator('#wv-export + button').click();
  await page.locator('.wv-hero img[alt=A9]').waitFor();
  await visit(page, '/observation/records');
  assert.equal(await page.locator('.wv-windows span').count(), 24);
  await page.locator('[data-slot="4"]').click();
  assert.match(await page.locator('.star-reading').innerText(), /已确认未达标|Confirmed · missed/);
  await page.locator('[data-slot="24"]').click();
  assert.match(await page.locator('.star-reading').innerText(), /尚未开始|Upcoming/);
  await visit(page,'/internal/market');
  await page.locator('[data-qton="50"]').click();
  assert.equal(await page.locator('#market-ton-input').inputValue(),'50');
  assert.match(await page.locator('#market-est-a9').innerText(), /100,100 A9/);
  await page.locator('#market-ton-input').fill('51');
  assert.equal(await page.locator('[data-qton][aria-pressed=true]').count(),0);
  await visit(page,'/team');
  assert.equal(await page.locator('.guild-member').count(),3);
  await visit(page,'/profile');
  await page.locator('[data-ticket-filter="settled"]').click();
  assert.equal(await page.locator('.collectible-ticket:visible').count(),1);
  await page.locator('.collectible-ticket:visible').click();
  assert.match(page.url(), /#\/proof\//);
  await page.route('**/game/a8.webp', (r) => r.abort());
  await page.goto(base + '/?mode=demo&artFailure=1#/gallery/8');
  await page.locator('.wv-hero .wv-missing').waitFor();
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
    const data = path === '/api/user/test-wallet' ? {
      walletAddress:'test-wallet',jettonWallet:'test-jetton',a9BalanceRaw:'12345678901234567890123456789',
      tickets:[{roundId:7,amountRaw:'1000000000001',principalDone:false}]
    } :
      path === '/api/config'
        ? { candleCount: 24, poolState: { successCount: 6 } }
        : path === '/api/rounds'
          ? [{ roundId: 7, state: 'OBSERVING' }]
          : path === '/api/rounds/7'
            ? {
                roundId: 7,
                state: 'OBSERVING',
                secondsRemaining: 0,
                nextState: 'AWAITING_SETTLE',
                qualifiedCandles: 16,
                candlesSeen: 16,
                candles: Array.from({ length: 16 }, (_, i) => ({
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
  await page.goto(base + '/?mode=live');
  await page.locator('#app-main button').first().waitFor();
  await capture(page, 'live-offline');
  online = true;
  await page.locator('#app-main button').first().click();
  await page.locator('.wv-hero').waitFor();
  await visit(page, '/observation/records');
  assert.equal(await page.locator('[data-state=pass]').count(), 16);
  assert.equal(await page.locator('[data-state=unknown]').count(), 8);
  assert.match(await page.locator('.wv-tower').innerText(), /等待结算/);
  await capture(page, 'live-awaiting-settlement');
  await visit(page, '/rewards');
  assert.match(await page.locator('.wv-steps .current').innerText(), /40%/);
  await visit(page, '/challenge/confirm');
  assert.ok(await page.locator('#app-main button[disabled]').count());
  await visit(page, '/gallery/9');
  assert.equal(await page.locator('#wv-export + button').count(), 0);
  await visit(page, '/leaderboard');
  assert.doesNotMatch(
    await page.locator('#app-main').innerText(),
    /13,104,000/,
  );
  await page.evaluate(async()=>{
    const {store}=await import('/js/store.js');
    store.update(state=>{state.user.address='test-wallet';state.user.connected=true;});
    document.documentElement.style.setProperty('--tg-content-safe-area-inset-bottom','34px');
    document.documentElement.style.setProperty('--tg-content-safe-area-inset-top','18px');
  });
  await visit(page,'/profile');
  await page.getByText('12,345,678,901,234,567,890.123456789 A9',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);
  assert.ok(await page.locator('#app-tabbar').evaluate(el=>parseFloat(getComputedStyle(el).bottom)>=34));
  await capture(page,'live-long-balance-safe-area');
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
      ' route/viewport checks passed. Gallery export, demo preview, image fallback, offline retry and live read-only states passed.',
  );
} finally {
  await browser.close();
}
