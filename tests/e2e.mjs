import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'jev-extension-test-'));
const evidence = process.env.EVIDENCE_DIR || join(tmpdir(), 'jev-adblock-evidence');
await mkdir(evidence, { recursive: true });
const html = await readFile(join(root, 'tests/fixtures/news.html'));
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = join(dir, 'extension'); await cp(join(root, 'dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json')));
// Test-only localhost permission avoids a browser permission prompt in headless mode.
// The distributed manifest remains opt-in. All other extension code is identical.
manifest.host_permissions.push('http://*/*', 'https://*/*');
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(join(dir, 'profile'), {
  headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1280, height: 960 }
});
const errors = [], checks = [];
context.on('page', p => { p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  // No live network request or real key: mock only the external API transport.
  await worker.evaluate(() => {
    globalThis.testMode = 'normal'; globalThis.testDelay = 0; globalThis.calls = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body); const payload = body.input || body; globalThis.calls.push(payload);
      globalThis.lastTransport = { url, authorization: options.headers.Authorization, model: body.model };
      const delay = globalThis.testDelay, mode = globalThis.testMode;
      if (delay) await new Promise(r => setTimeout(r, delay));
      if (mode === '401') return new Response('{}', { status: 401 });
      if (mode === '429') return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      if (mode === '500') return new Response('{}', { status: 500 });
      const answers = Object.fromEntries(Object.keys(payload.questions).map(k => [k, { type: 'noul', noul: mode === 'invalid' ? 2 : mode === 'low' ? .4 : .99 }]));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 200 } }));
    };
  });
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/src/options.html`);
  assert.match(await options.title(), /設定/);
  await options.locator('#account').fill('a'.repeat(32));
  await options.locator('#key').fill('synthetic-test-key'); await options.locator('#consent').check(); await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('設定済み'));
  await options.locator('#test').click(); await options.waitForFunction(() => document.querySelector('#notice').textContent.includes('接続成功'));
  await options.screenshot({ path: join(evidence, 'options-desktop.png'), fullPage: true });
  checks.push('Options: consent, session key, synthetic connection test');
  await options.locator('#key').fill('must-clear-on-switch');
  await options.locator('#provider').selectOption('typesafe');
  assert.equal(await options.locator('#gatewayFields').isVisible(), false);
  assert.equal(await options.locator('#key').inputValue(), '');
  assert.equal(await options.locator('#test').isDisabled(), true);
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('provider').then(s => s.provider)), 'cloudflare');
  await options.locator('#key').fill('synthetic-typesafe-key'); await options.locator('#consent').check(); await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('TypeSafe'));
  await options.locator('#test').click(); await options.waitForFunction(() => document.querySelector('#notice').textContent.includes('接続成功'));
  assert.deepEqual(await worker.evaluate(() => globalThis.lastTransport), { url: 'https://api.typesafe.ai/v1/systemone', authorization: 'Bearer synthetic-typesafe-key', model: 'jev-latest' });
  await options.reload(); await options.waitForFunction(() => document.querySelector('#provider').value === 'typesafe');
  assert.equal(await options.locator('#gatewayFields').isVisible(), false);
  await options.screenshot({ path: join(evidence, 'options-typesafe.png'), fullPage: true });
  await options.locator('#provider').selectOption('cloudflare');
  assert.equal(await options.locator('#gatewayFields').isVisible(), true);
  assert.equal(await options.locator('#account').inputValue(), 'a'.repeat(32));
  await options.locator('#key').fill('synthetic-test-key'); await options.locator('#consent').check(); await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('Cloudflare'));
  await options.locator('#test').click(); await options.waitForFunction(() => document.querySelector('#notice').textContent.includes('接続成功'));
  assert.equal((await worker.evaluate(() => globalThis.lastTransport)).authorization, 'Bearer synthetic-test-key');
  assert.ok((await worker.evaluate(() => globalThis.lastTransport)).url.startsWith('https://api.cloudflare.com/'));
  checks.push('Provider selector: field visibility, fresh key requirement, direct request, persistence, and switch back to Cloudflare');

  const setPolicy = (enabled = true, mode = 'remove') => options.evaluate(async ({ origin, enabled, mode }) => {
    const result = await chrome.runtime.sendMessage({ type: 'SET_POLICY', origin, update: { enabled, mode, threshold: .95 } });
    if (!result.ok) throw Error(JSON.stringify(result));
    if (enabled) { const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url?.startsWith(origin)); await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' }); }
  }, { origin, enabled, mode });
  const page = await context.newPage(); await page.goto(origin + '/news');
  const idleCalls = await worker.evaluate(() => globalThis.calls.length);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(await worker.evaluate(() => globalThis.calls.length), idleCalls);
  checks.push('Page load sends no classification request');
  await setPolicy(true, 'diagnostic');
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url?.startsWith(origin)).id, origin);
  const command = (message) => options.evaluate(async ({ tabId, message }) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), { tabId, message });
  async function until(fn, timeout = 7000) {
    const start = Date.now();
    while (!await fn()) { if (Date.now() - start > timeout) throw Error('Timed out waiting for test condition'); await new Promise(r => setTimeout(r, 100)); }
  }
  await until(async () => (await command({ type: 'PAGE_STATUS' })).records.length >= 3);
  assert.equal(await page.locator('#banner').count(), 1); assert.equal(await page.locator('#label-card').count(), 1);
  checks.push('Diagnostic mode keeps ads visible');
  await page.screenshot({ path: join(evidence, 'before.png'), fullPage: false });
  await setPolicy();
  await until(async () => (await command({ type: 'PAGE_STATUS' }).catch(() => null))?.removed === 3);
  for (const id of ['story','protected-form','ordinary','catalog','big-ad','editorial-advice']) assert.equal(await page.locator(`#${id}`).count(), 1, `${id} preserved`);
  await page.screenshot({ path: join(evidence, 'after.png'), fullPage: false });
  checks.push('Three ad cards removed; article, form, catalog and large container preserved');
  // Headless Chromium doesn't expose the toolbar popup as a Playwright page.
  // Render the unmodified popup in an extension tab and supply only the active-tab lookup.
  const popup = await context.newPage();
  await popup.addInitScript(({ tabId, origin }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = q => q.active && q.currentWindow ? Promise.resolve([{ id: tabId, url: origin + '/news' }]) : query(q);
  }, { tabId, origin });
  await popup.goto(`chrome-extension://${id}/src/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#removed')?.textContent === '3');
  assert.match(await popup.title(), /Jev/);
  await popup.locator('body').screenshot({ path: join(evidence, 'popup.png') });
  await popup.locator('#undo').click();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).removed === 2);
  await popup.close();
  checks.push('Popup UI (test active-tab lookup) shows counters; undo-last button restores one ad');
  const payloads = JSON.stringify(await worker.evaluate(() => globalThis.calls));
  assert.ok(!payloads.includes('private@example.com')); assert.ok(!payloads.includes('secret=tracking')); assert.ok(!payloads.includes('synthetic-test-key'));
  checks.push('API payload contains no form value, URL query or key');
  const restored = await command({ type: 'RESTORE', all: true }); assert.equal(restored.restored, 2);
  await command({ type: 'RESCAN' }); await new Promise(r => setTimeout(r, 1000));
  assert.equal(await page.locator('#banner').count(), 1); assert.equal((await command({ type: 'PAGE_STATUS' })).removed, 0);
  checks.push('Restore all keeps original nodes and prevents immediate removal');
  await page.evaluate(() => {
    const ad = document.createElement('div'); ad.id = 'late-ad'; ad.className = 'ad-slot slot'; ad.textContent = '広告: あとから届いた広告'; document.querySelector('aside').append(ad);
  });
  await new Promise(r => setTimeout(r, 900));
  assert.equal(await page.locator('#late-ad').count(), 1);
  await command({ type: 'RESCAN' });
  await until(async () => await page.locator('#late-ad').count() === 0);
  await setPolicy(false); assert.equal(await page.locator('#late-ad').count(), 1);
  checks.push('Later ads remain until manual rescan; turning off restores them');
  // Stale page contents must not be removed by an old high-probability response.
  await worker.evaluate(() => { globalThis.testDelay = 1200; globalThis.calls = []; });
  await page.reload(); await setPolicy();
  await until(async () => (await worker.evaluate(() => globalThis.calls.length)) > 0);
  await page.locator('#banner strong').evaluate(el => { el.textContent = '書き換えた通常コンテンツ'; });
  await setPolicy(false);
  await new Promise(r => setTimeout(r, 1600)); assert.equal(await page.locator('#banner').count(), 1);
  checks.push('Disabling while a judgment is pending prevents stale removal');
  await worker.evaluate(() => { globalThis.calls = []; });
  await page.reload(); await setPolicy();
  await until(async () => (await worker.evaluate(() => globalThis.calls.length)) > 0);
  await page.evaluate(() => { history.pushState({}, '', '/next'); document.querySelector('#banner strong').textContent = '次のページ'; });
  await setPolicy(false); await new Promise(r => setTimeout(r, 1600)); assert.equal(await page.locator('#banner').count(), 1);
  checks.push('SPA navigation invalidates pending results');
  await worker.evaluate(() => { globalThis.testDelay = 0; globalThis.testMode = 'invalid'; });
  await page.reload(); await setPolicy();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).status === 'invalid_response');
  assert.equal(await page.locator('#banner').count(), 1);
  checks.push('Invalid probabilities fail closed');
  for (const [mode, status] of [['401','invalid_key'],['429','rate_limited'],['500','api_error']]) {
    await setPolicy(false); await worker.evaluate(mode => { globalThis.testMode = mode; }, mode);
    await worker.evaluate(() => chrome.storage.session.set({ retryAt: 0 }));
    await page.reload(); await setPolicy();
    await until(async () => (await command({ type: 'PAGE_STATUS' })).status === status);
    assert.equal(await page.locator('#banner').count(), 1);
  }
  checks.push('401, 429 and 500 retain page contents and show error state');
  await setPolicy(false); await worker.evaluate(() => { globalThis.testMode = 'normal'; });
  // Reproduce empty cross-origin Google ad slots: low evidence must retain, enriched evidence must reach the model.
  await page.reload();
  await page.evaluate(() => {
    const slot = document.createElement('div'); slot.id = 'google-slot'; slot.className = 'ad-slot';
    slot.style.cssText = 'width:300px;height:180px';
    const frame = document.createElement('iframe'); frame.id = 'google_ads_iframe_sensitive-publisher-id';
    frame.title = '3rd party ad content'; frame.setAttribute('aria-label', 'Advertisement'); frame.style.cssText = 'width:300px;height:180px';
    slot.append(frame); document.querySelector('aside').append(slot);
  });
  await worker.evaluate(() => { globalThis.testMode = 'low'; globalThis.calls = []; });
  await setPolicy();
  await until(async () => (await command({ type: 'PAGE_STATUS' })).records.length >= 4);
  assert.equal(await page.locator('#google-slot').count(), 1);
  const adEvidence = await worker.evaluate(() => calls.flatMap(p => JSON.parse(p.state).candidates).find(c => c.signal.includes('Google ad-serving iframe')));
  assert.ok(adEvidence); assert.equal(adEvidence.label, 'Advertisement');
  assert.ok(adEvidence.signal.includes('third-party advertising content'));
  assert.ok(!JSON.stringify(adEvidence).includes('sensitive-publisher-id'));
  await worker.evaluate(() => { globalThis.testMode = 'normal'; });
  await command({ type: 'RESCAN' });
  await until(async () => await page.locator('#google-slot').count() === 0);
  await setPolicy(false);
  checks.push('Empty Google ad iframe evidence reaches AI; raw IDs withheld; low probability retains, high probability removes');
  // Exercise the actual automatic-mode checkbox, without the setPolicy helper's manual RESCAN.
  await page.reload();
  const autoPopup = await context.newPage();
  await autoPopup.addInitScript(({ tabId, origin }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = q => q.active && q.currentWindow ? Promise.resolve([{ id: tabId, url: origin + '/news' }]) : query(q);
  }, { tabId, origin });
  await autoPopup.goto(`chrome-extension://${id}/src/popup.html`);
  await options.locator('#provider').selectOption('typesafe');
  await options.locator('#key').fill('unsaved-draft-key');
  await autoPopup.locator('#automatic').check();
  await options.waitForFunction(() => document.querySelector('#automatic').checked);
  assert.equal(await options.locator('#provider').inputValue(), 'typesafe');
  assert.equal(await options.locator('#key').inputValue(), 'unsaved-draft-key');
  await options.locator('#key').fill('');
  await until(async () => (await command({ type: 'PAGE_STATUS' }).catch(() => null))?.removed === 3);
  assert.equal(await autoPopup.locator('#mode').isDisabled(), true);
  await autoPopup.locator('body').screenshot({ path: join(evidence, 'popup-automatic.png') });
  await page.reload();
  await until(async () => await page.locator('#banner').count() === 0);
  await context.route('https://new-site.example/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  const freshSite = await context.newPage();
  await freshSite.goto('https://new-site.example/article');
  await until(async () => await freshSite.locator('#banner').count() === 0);
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('policies').then(s => Boolean(s.policies['https://new-site.example']))), false);
  await freshSite.reload();
  await until(async () => await freshSite.locator('#banner').count() === 0);
  await freshSite.close();
  checks.push('Global automatic removes ads on a new domain without site setup, including reload');
  await page.goto(origin + '/another-article');
  await until(async () => await page.locator('#banner').count() === 0);
  await page.evaluate(() => {
    const ad = document.createElement('div'); ad.id = 'auto-late'; ad.className = 'ad-slot slot'; ad.textContent = '広告: 自動監視のテスト'; document.querySelector('aside').append(ad);
  });
  await until(async () => await page.locator('#auto-late').count() === 0);
  await command({ type: 'RESTORE', all: true });
  await new Promise(r => setTimeout(r, 900));
  assert.equal(await page.locator('#banner').count(), 1);
  await autoPopup.locator('#automatic').uncheck();
  await until(async () => !(await worker.evaluate(origin => chrome.storage.local.get('globalAutomatic').then(s => s.globalAutomatic), origin)));
  const idleAfterOff = await worker.evaluate(() => calls.length);
  await page.reload(); await new Promise(r => setTimeout(r, 1100));
  assert.equal(await page.locator('#banner').count(), 1);
  assert.equal(await worker.evaluate(() => calls.length), idleAfterOff);
  // Pending automatic classifications must not remove anything after OFF.
  await worker.evaluate(() => { globalThis.testDelay = 1200; });
  await autoPopup.locator('#automatic').check();
  await until(async () => (await worker.evaluate(() => calls.length)) > idleAfterOff);
  await autoPopup.locator('#automatic').uncheck();
  await new Promise(r => setTimeout(r, 1600));
  assert.equal(await page.locator('#banner').count(), 1);
  await worker.evaluate(() => { globalThis.testDelay = 0; });
  await worker.evaluate(() => chrome.storage.local.set({ policies: {} }));
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#sites').textContent.includes('OFF'));
  await options.locator('#automatic').check();
  await autoPopup.waitForFunction(() => document.querySelector('#automatic').checked);
  await options.waitForFunction(() => document.querySelector('#sites').textContent.includes('ON'));
  assert.match(await options.locator('#sites').innerText(), /サイト別の設定はありません/);
  await autoPopup.locator('#automatic').uncheck();
  await options.waitForFunction(() => !document.querySelector('#automatic').checked && document.querySelector('#sites').textContent.includes('OFF'));
  checks.push('Shared automatic control syncs both directions, preserves connection drafts, and explains empty per-site settings');
  await autoPopup.close();
  checks.push('Always-on checkbox: immediate run, reload, navigation, late ads, restore protection, OFF and pending-result cancellation');
  await options.setViewportSize({ width: 390, height: 844 }); await options.reload();
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('設定済み'));
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await options.screenshot({ path: join(evidence, 'options-mobile.png'), fullPage: true });
  await options.locator('#clear').click(); await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('未設定'));
  const stored = await worker.evaluate(() => chrome.storage.local.get(null)); assert.ok(!JSON.stringify(stored).includes('synthetic-test-key'));
  checks.push('Mobile options fit; clearing key works; local storage contains no key');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, consoleErrors: errors, evidence, browser: await context.browser()?.version(), fixture: origin, testOnlyHostPermission: true }, null, 2));
} catch (error) {
  for (const p of context.pages()) console.error('PAGE', p.url(), (await p.locator('body').innerText().catch(() => '')).slice(0, 2000));
  console.error('CONSOLE', errors); throw error;
} finally { await context.close(); server.close(); }
