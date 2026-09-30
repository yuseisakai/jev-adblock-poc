// Actual public site + actual extension; only AI transport is mocked.
// This verifies extraction and DOM behavior, not Jev accuracy.
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const dir = await mkdtemp(join(tmpdir(), 'jev-live-'));
const evidence = join(tmpdir(), 'jev-adblock-live-evidence');
await mkdir(evidence, { recursive: true });
const ext = join(dir, 'extension');
await cp(new URL('../dist', import.meta.url), ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json')));
manifest.host_permissions.push('https://iphone-mania.jp/*');
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(join(dir, 'profile'), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1440, height: 1000 }
});
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.calls = [];
    globalThis.fetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      globalThis.calls.push(payload);
      const candidates = JSON.parse(payload.input.state).candidates;
      // Explicit deterministic test oracle. NEVER a replacement for Jev.
      const answers = Object.fromEntries(
        candidates.map((c) => [
          c.id,
          { type: 'noul', noul: c.signal.includes('ad ') || /広告|スポンサー/.test(c.label) ? 0.99 : 0.1 }
        ])
      );
      return new Response(JSON.stringify({ success: true, result: { answers, usage: { input_tokens: 0 } } }));
    };
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options.html`);
  await options.locator('#account').fill('a'.repeat(32));
  await options.locator('#key').fill('synthetic-test-key');
  await options.locator('#consent').check();
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#keyState').textContent.includes('設定済み'));
  const page = await context.newPage();
  const siteErrors = [];
  page.on('pageerror', (e) => siteErrors.push(e.message));
  await page.goto('https://iphone-mania.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const title = await page.title();
  assert.match(title, /iPhone/i);
  const headings = await page.locator('h1,h2').allTextContents();
  const beforeLinks = await page.locator('a[href]').count();
  assert.ok(beforeLinks > 20, 'Public news page rendered');
  assert.equal(await worker.evaluate(() => calls.length), 0);
  await page.screenshot({ path: join(evidence, 'before.png'), fullPage: false });
  const tabId = await worker.evaluate(
    async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('https://iphone-mania.jp/')).id
  );
  const popup = await context.newPage();
  await popup.addInitScript(
    ({ tabId }) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q) =>
        q.active && q.currentWindow
          ? Promise.resolve([{ id: tabId, url: 'https://iphone-mania.jp/' }])
          : query(q);
    },
    { tabId }
  );
  await popup.goto(`chrome-extension://${id}/src/popup.html`);
  await popup.locator('#toggle').click();
  const command = (message) =>
    popup.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), {
      tabId,
      message
    });
  await page.waitForTimeout(5000);
  const status = await command({ type: 'PAGE_STATUS' });
  const requests = await worker.evaluate(() => calls);
  assert.equal(status.ok, true);
  assert.ok(status.tested > 0, 'Actual page yields candidates');
  assert.ok(status.removed > 0, 'Mock-approved ads removed');
  assert.deepEqual(await page.locator('h1,h2').allTextContents(), headings, 'News headings unchanged');
  await page.screenshot({ path: join(evidence, 'after.png'), fullPage: false });
  await popup.waitForFunction(() => Number(document.querySelector('#removed').textContent) > 0);
  await popup.locator('body').screenshot({ path: join(evidence, 'popup.png') });
  await popup.locator('#undoAll').click();
  await page.waitForTimeout(500);
  const restored = await command({ type: 'PAGE_STATUS' });
  assert.equal(restored.removed, 0);
  const afterCallCount = await worker.evaluate(() => calls.length);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  assert.equal(
    await worker.evaluate(() => calls.length),
    afterCallCount,
    'Reload never classifies automatically'
  );
  const report = {
    url: page.url(),
    title,
    viewport: { width: 1440, height: 1000 },
    liveAI: false,
    transport: 'Cloudflare response mock',
    status,
    headingsPreserved: headings.length,
    restoreRemaining: restored.removed,
    requests: requests.length,
    candidates: requests.flatMap((r) => JSON.parse(r.input.state).candidates),
    siteErrors,
    evidence
  };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
}
