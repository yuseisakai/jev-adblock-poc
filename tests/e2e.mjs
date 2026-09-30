import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const dir = await mkdtemp(join(tmpdir(), 'jev-e2e-'));
const evidence = process.env.EVIDENCE_DIR || join(tmpdir(), 'jev-adblock-evidence');
await mkdir(evidence, { recursive: true });
const html = await readFile(new URL('fixtures/news.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const ext = join(dir, 'extension');
await cp(new URL('../dist/', import.meta.url), ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json')));
// Test-only permissions. Native activeTab and permission prompts require a manual check.
manifest.host_permissions.push('http://*/*', 'https://*/*');
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));
let context;
const checks = [],
  errors = [];
async function until(fn) {
  const end = Date.now() + 10000;
  while (
    !(await fn().catch((e) => {
      if (/Receiving end does not exist/.test(e.message)) return false;
      throw e;
    }))
  ) {
    if (Date.now() > end) throw Error('Timed out');
    await new Promise((r) => setTimeout(r, 80));
  }
}
try {
  context = await chromium.launchPersistentContext(join(dir, 'profile'), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 960 }
  });
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.calls = [];
    globalThis.score = 0.9;
    globalThis.delay = 0;
    globalThis.httpStatus = 200;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body),
        payload = body.input || body;
      calls.push({ url, payload, authorization: options.headers.Authorization });
      const status = httpStatus,
        probability = score;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return new Response(
        JSON.stringify({
          answers: Object.fromEntries(
            Object.keys(payload.questions).map((k) => [k, { type: 'noul', noul: probability }])
          )
        }),
        { status }
      );
    };
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options.html`);
  const send = (m) => options.evaluate((m) => chrome.runtime.sendMessage(m), m);
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('未設定'));
  assert.equal(await options.locator('#threshold').inputValue(), '80');
  assert.equal(await options.locator('#automatic').isChecked(), false);
  await options.locator('#save').click();
  assert.match(await options.locator('#notice').innerText(), /チェック/);
  await options.locator('#provider').selectOption('typesafe');
  await options.locator('#key').fill('synthetic-typesafe-key');
  await options.locator('#consent').check();
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('設定済み'));
  await options.locator('#test').click();
  await options.waitForFunction(() => document.querySelector('#notice').textContent.includes('接続成功'));
  assert.equal((await worker.evaluate(() => calls.at(-1))).url, 'https://api.typesafe.ai/v1/systemone');
  checks.push('Consent required; direct provider connection; default 80%, automatic opt-in');
  const page = await context.newPage();
  await page.goto(origin);
  const tabId = await worker.evaluate(
    async (origin) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(origin)).id,
    origin
  );
  const popup = await context.newPage();
  await popup.addInitScript(
    ({ tabId, origin }) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q) => (q.active ? Promise.resolve([{ id: tabId, url: origin }]) : query(q));
    },
    { tabId, origin }
  );
  await popup.goto(`chrome-extension://${id}/src/popup.html`);
  const command = (m) => options.evaluate(({ tabId, m }) => chrome.tabs.sendMessage(tabId, m), { tabId, m });
  const stored = () =>
    worker.evaluate(async () => ({
      local: await chrome.storage.local.get(null),
      session: await chrome.storage.session.get(null)
    }));
  await popup.locator('#toggle').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).removed === 2);
  for (const name of ['story', 'sponsor', 'protected-form', 'ordinary'])
    assert.equal(await page.locator(`#${name}`).count(), 1);
  await popup.locator('#undo').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).removed === 1);
  await popup.locator('#undoAll').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).removed === 0);
  await popup.locator('#toggle').click();
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#banner').count(), 1);
  checks.push(
    'Manual removes two ads; article/form protected even with high score; undo prevents re-removal'
  );
  const before = await worker.evaluate(() => calls.length);
  await page.reload();
  await page.waitForTimeout(600);
  assert.equal(await worker.evaluate(() => calls.length), before);
  await popup.locator('#advanced > summary').click();
  await popup.locator('#mode').selectOption('diagnostic');
  await popup.locator('#toggle').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).records.length >= 2);
  assert.equal(await page.locator('#banner').count(), 1);
  checks.push('Manual reload does not classify; diagnostic mode does not remove');
  await popup.locator('#threshold').fill('49');
  await popup.locator('#thresholdForm button').click();
  assert.equal(await popup.locator('#threshold').getAttribute('aria-invalid'), 'true');
  assert.equal((await stored()).local.threshold, 0.8);
  await popup.locator('#threshold').fill('95');
  await popup.locator('#thresholdForm button').click();
  await until(async () => (await stored()).local.threshold === 0.95);
  await options.waitForFunction(() => document.querySelector('#threshold').value === '95');
  await popup.locator('#mode').selectOption('remove');
  await popup.locator('#toggle').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).records.length >= 2);
  assert.equal(await page.locator('#banner').count(), 1);
  await options.locator('#threshold').fill('80');
  await options.locator('#thresholdForm button').click();
  await popup.waitForFunction(() => document.querySelector('#threshold').value === '80');
  checks.push('Threshold validation, cross-window sync and actual removal boundary');
  await options.locator('#provider').selectOption('cloudflare');
  await options.locator('#key').fill('draft-key-not-saved');
  await popup.locator('#automatic').check();
  await options.waitForFunction(() => document.querySelector('#automatic').checked);
  assert.equal(await options.locator('#key').inputValue(), 'draft-key-not-saved');
  assert.equal(await options.locator('#provider').inputValue(), 'cloudflare');
  await until(async () => (await page.locator('#banner').count()) === 0);
  await page.reload();
  await until(async () => (await page.locator('#banner').count()) === 0);
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'late-ad';
    el.style.cssText = 'width:280px;height:80px';
    el.textContent = '広告: 合成テスト';
    document.querySelector('aside').append(el);
  });
  await until(async () => (await page.locator('#late-ad').count()) === 0);
  await context.route('https://fresh.example/**', (route) =>
    route.fulfill({ body: html, contentType: 'text/html' })
  );
  const fresh = await context.newPage();
  await fresh.goto('https://fresh.example/article');
  await until(async () => (await fresh.locator('#banner').count()) === 0);
  await fresh.close();
  assert.ok(!JSON.stringify(await stored()).includes(origin));
  assert.ok(!JSON.stringify(await stored()).includes('fresh.example'));
  assert.equal((await stored()).local.policies, undefined);
  checks.push(
    'Automatic reload, new domain, late ads; no origin/URL in local or session storage; connection drafts preserved'
  );
  await popup.locator('#automatic').uncheck();
  assert.equal(await page.locator('#banner').count(), 0);
  await worker.evaluate(() => {
    delay = 1000;
  });
  await page.reload();
  const count = await worker.evaluate(() => calls.length);
  await popup.locator('#automatic').check();
  await until(async () => (await worker.evaluate(() => calls.length)) > count);
  await popup.locator('#automatic').uncheck();
  await page.waitForTimeout(1300);
  assert.equal(await page.locator('#banner').count(), 1);
  await worker.evaluate(() => {
    delay = 0;
  });
  checks.push('OFF invalidates pending results');
  // Privacy regression: capture the real request from hidden/query-containing candidate text.
  await page.reload();
  await page.evaluate(() => {
    document
      .querySelector('#banner')
      .insertAdjacentHTML(
        'beforeend',
        '<span style="display:none">HIDDEN_TEST_SECRET</span><span style="visibility:hidden">INVISIBLE_TEST_SECRET</span><span> HTTPS://example.com/reset?token=ABS_TEST_SECRET /reset?token=REL_TEST_SECRET visible@example.com</span>'
      );
  });
  await worker.evaluate(() => {
    calls = [];
  });
  await popup.locator('#toggle').click();
  await until(async () => (await worker.evaluate(() => calls.length)) > 0);
  const payload = JSON.stringify(await worker.evaluate(() => calls.map((c) => c.payload)));
  for (const secret of [
    'HIDDEN_TEST_SECRET',
    'INVISIBLE_TEST_SECRET',
    'ABS_TEST_SECRET',
    'REL_TEST_SECRET',
    'visible@example.com',
    'secret=tracking'
  ])
    assert.ok(!payload.includes(secret), secret);
  checks.push('Actual mock payload excludes CSS-hidden text, absolute/relative URL queries and emails');
  for (const status of [401, 429, 500]) {
    await worker.evaluate(async (status) => {
      httpStatus = status;
      await chrome.storage.session.set({ retryAt: 0 });
    }, status);
    await page.reload();
    await popup.locator('#toggle').click();
    await until(async () =>
      ['invalid_key', 'rate_limited', 'api_error'].includes((await command({ type: 'PAGE_STATUS' })).status)
    );
    assert.equal(await page.locator('#banner').count(), 1);
  }
  checks.push('API 401/429/500 fail closed');
  await worker.evaluate(async () => {
    httpStatus = 200;
    score = 2;
    await chrome.storage.session.set({ retryAt: 0 });
  });
  await page.reload();
  await popup.locator('#toggle').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).status === 'invalid_response');
  assert.equal(await page.locator('#banner').count(), 1);
  checks.push('Invalid probabilities fail closed');
  await worker.evaluate(() => {
    score = 0.9;
    delay = 1000;
    calls = [];
  });
  await page.reload();
  await popup.locator('#toggle').click();
  await until(async () => (await worker.evaluate(() => calls.length)) > 0);
  await page.evaluate(() => {
    history.pushState({}, '', '/next');
    document.querySelector('#banner strong').textContent = '次のページの記事';
  });
  await page.waitForTimeout(1400);
  assert.equal(await page.locator('#banner').count(), 1);
  await worker.evaluate(() => {
    delay = 0;
  });
  checks.push('SPA navigation discards pending decisions');

  await worker.evaluate(() => {
    score = 0.9;
  });
  await page.reload();
  await popup.locator('#toggle').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).removed === 2);
  await popup.waitForFunction(() => document.querySelector('#removed').textContent === '2');
  await popup.setViewportSize({ width: 160, height: 600 });
  assert.equal(await popup.locator('html').evaluate((el) => el.getBoundingClientRect().width), 480);
  await popup.setViewportSize({ width: 480, height: 600 });
  await popup.locator('#advanced').evaluate((el) => {
    el.open = false;
  });
  await popup.locator('#notice').evaluate((el) => {
    el.textContent = '';
  });
  const popupSize = await popup.locator('body').boundingBox();
  assert.equal(popupSize.width, 480);
  assert.ok(popupSize.height <= 600, `Popup height: ${popupSize.height}`);
  await popup.locator('body').screenshot({ path: join(evidence, 'popup.png') });
  await options.locator('#key').fill('');
  await options.locator('#provider').selectOption('typesafe');
  await options.screenshot({ path: join(evidence, 'options-desktop.png'), fullPage: true });
  await options.locator('#threshold').focus();
  assert.equal(
    await options.locator('#threshold').evaluate((el) => getComputedStyle(el).outlineStyle),
    'solid'
  );
  await options.keyboard.press('Tab');
  assert.equal(
    await options.locator('#thresholdForm button').evaluate((el) => document.activeElement === el),
    true
  );
  for (const width of [390, 320]) {
    await options.setViewportSize({ width, height: 844 });
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await options.screenshot({ path: join(evidence, 'options-mobile.png'), fullPage: true });
  await options.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await options.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  checks.push('Keyboard focus and Tab order, 320/390px reflow, enlarged text');
  await options.locator('#clear').click();
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('未設定'));
  assert.ok(!JSON.stringify((await stored()).local).includes('synthetic-typesafe-key'));
  assert.equal((await stored()).session.apiKey, undefined);
  checks.push('Key deletion; local storage contains no API key');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, consoleErrors: errors, evidence, liveAI: false }, null, 2));
} finally {
  await context?.close();
  server.close();
}
