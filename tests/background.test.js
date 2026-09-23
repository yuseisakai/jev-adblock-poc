import test from 'node:test';
import assert from 'node:assert/strict';
const extensionId = 'test-extension';
const origin = 'https://news.example';
const url = path => `chrome-extension://${extensionId}/src/${path}.html`;
const stores = {};
function area(name) {
  stores[name] = {};
  return {
    setAccessLevel: async ({ accessLevel }) => { assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); },
    get: async keys => Object.fromEntries((keys == null ? Object.keys(stores[name]) : Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(stores[name][k])])),
    set: async values => Object.assign(stores[name], structuredClone(values)),
    remove: async key => { delete stores[name][key]; }
  };
}
let receive, allow = true, requests = 0;
globalThis.chrome = {
  runtime: { id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: fn => { receive = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  storage: { local: area('local'), session: area('session') },
  permissions: { contains: async () => allow, onRemoved: { addListener() {} } },
  scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, updateContentScripts: async () => {}, unregisterContentScripts: async () => {} },
  tabs: { query: async () => [] }
};
await import('../src/background.js');
const content = { id: extensionId, tab: { id: 1 }, frameId: 0, url: origin + '/article' };
const ui = { id: extensionId, tab: { id: 2 }, url: url('options') };
const c = { id: 'c1', fingerprint: 'snap', features: { text: '広告', label: '広告', tag: 'aside', signal: 'ad slot', linkHost: '', frameHost: '', width: 300, height: 100 } };
function dispatch(m, sender = content) { return new Promise(resolve => receive(m, sender, resolve)); }
function setup() {
  stores.local = { gateway: { accountId: 'a'.repeat(32), gatewayId: 'default' }, policies: { [origin]: { enabled: true, mode: 'remove', threshold: .95, revision: 1 } } };
  stores.session = { apiKey: 'test-key' }; allow = true; requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } } })); };
}
const batch = () => ({ type: 'CLASSIFY_BATCH', epoch: 'page-1', revision: '0:1', candidates: [c] });
test('content cannot read or change API keys or invoke settings commands', async () => {
  setup();
  for (const type of ['GET_SETTINGS','SET_KEY','CLEAR_KEY','TEST_KEY','SET_POLICY','SET_GLOBAL']) assert.equal((await dispatch({ type, key: 'stolen-key' })).error, 'forbidden');
  assert.equal(stores.session.apiKey, 'test-key');
  const config = await dispatch({ type: 'GET_CONFIG' }); assert.equal(config.hasKey, true); assert.ok(!JSON.stringify(config).includes('test-key'));
});
test('extension settings tab is trusted by exact URL, not absence of tab metadata', async () => {
  setup();
  const settings = await dispatch({ type: 'GET_SETTINGS' }, ui); assert.equal(settings.ok, true); assert.ok(!JSON.stringify(settings).includes('test-key'));
  assert.equal((await dispatch({ type: 'SET_KEY', key: 'replacement-key', gateway: { accountId: 'a'.repeat(32), gatewayId: 'default' } }, ui)).ok, true);
  assert.equal(stores.session.apiKey, 'replacement-key'); assert.ok(!JSON.stringify(stores.local).includes('replacement-key'));
});
test('unauthorized origin, frame and stale revision cannot send API traffic', async () => {
  setup();
  assert.equal((await dispatch(batch(), { ...content, id: 'other' })).error, 'forbidden');
  assert.equal((await dispatch(batch(), { ...content, frameId: 1 })).error, 'forbidden');
  assert.equal((await dispatch(batch(), { ...content, url: 'https://other.example/' })).error, 'stale');
  assert.equal((await dispatch({ ...batch(), revision: 0 })).error, 'stale');
  allow = false; assert.equal((await dispatch(batch())).error, 'stale'); assert.equal(requests, 0);
});
test('session budget and rate-limit cooldown reject before network', async () => {
  setup();
  stores.session.budget = { start: Date.now(), requests: 300, inputTokens: 0 };
  assert.equal((await dispatch(batch())).error, 'budget_exceeded');
  stores.session.budget.requests = 0; stores.session.retryAt = Date.now() + 60000;
  assert.equal((await dispatch(batch())).error, 'rate_limited'); assert.equal(requests, 0);
});
test('changing policy during API call discards result', async () => {
  setup();
  globalThis.fetch = async () => {
    stores.local.policies[origin].revision = 2;
    return new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } } }));
  };
  assert.equal((await dispatch(batch())).error, 'stale');
});
test('concurrency cap allows two requests, blocks third, and budget reservations do not race', async () => {
  setup(); const releases = [];
  globalThis.fetch = () => new Promise(resolve => releases.push(() => resolve(new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } } })))));
  const a = dispatch(batch()), b = dispatch(batch());
  while (releases.length < 2) await new Promise(r => setTimeout(r, 1));
  assert.equal((await dispatch(batch())).error, 'busy');
  releases.forEach(r => r()); assert.equal((await a).ok, true); assert.equal((await b).ok, true);
  assert.equal(stores.session.budget.requests, 2);
});
test('Switch providers pairs the new key with the selected endpoint; invalid selection preserves settings', async () => {
  setup();
  assert.equal((await dispatch({ type: 'GET_SETTINGS' }, ui)).provider, 'cloudflare');
  assert.equal((await dispatch({ type: 'SET_KEY', provider: 'typesafe', key: 'direct-test-key' }, ui)).ok, true);
  globalThis.fetch = async (endpoint, options) => {
    assert.equal(endpoint, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer direct-test-key');
    return new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } } }));
  };
  assert.equal((await dispatch(batch())).ok, true);
  assert.equal((await dispatch({ type: 'SET_KEY', provider: 'other', key: 'invalid-change' }, ui)).error, 'invalid_provider');
  assert.equal(stores.local.provider, 'typesafe');
  assert.equal(stores.session.apiKey, 'direct-test-key');
  assert.equal((await dispatch({ type: 'SET_KEY', provider: 'cloudflare', key: 'cloudflare-new-key', gateway: stores.local.gateway }, ui)).ok, true);
  globalThis.fetch = async (endpoint, options) => {
    assert.ok(endpoint.startsWith('https://api.cloudflare.com/'));
    assert.equal(options.headers.Authorization, 'Bearer cloudflare-new-key');
    return new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } } }));
  };
  assert.equal((await dispatch(batch())).ok, true);
  assert.ok(!JSON.stringify(stores.local).includes('cloudflare-new-key'));
});
test('Automatic mode is opt-in, requires removal mode, and persists per origin', async () => {
  setup();
  assert.equal((await dispatch({ type: 'GET_CONFIG' })).policy.automatic, false);
  const update = { enabled: true, mode: 'remove', threshold: .95, automatic: true };
  assert.equal((await dispatch({ type: 'SET_POLICY', origin, update }, ui)).ok, true);
  assert.equal(stores.local.policies[origin].automatic, true);
  assert.equal((await dispatch({ type: 'GET_CONFIG' }, { ...content, url: 'https://other.example/' })).policy.automatic, false);
  assert.equal((await dispatch({ type: 'SET_POLICY', origin, update: { ...update, automatic: 'yes' } }, ui)).error, 'invalid_policy');
  assert.equal((await dispatch({ type: 'SET_POLICY', origin, update: { ...update, mode: 'diagnostic' } }, ui)).error, 'invalid_policy');
});

test('Global automatic covers new origins, preserves thresholds and OFF invalidates pending work', async () => {
  setup();
  allow = false;
  assert.equal((await dispatch({ type: 'SET_GLOBAL', enabled: true }, ui)).error, 'permission_required');
  allow = true;
  stores.local.policies[origin].threshold = .8;
  assert.equal((await dispatch({ type: 'SET_GLOBAL', enabled: true }, ui)).ok, true);
  assert.equal((await dispatch({ type: 'GET_CONFIG' })).policy.threshold, .8);
  const other = { ...content, url: 'https://new.example/article' };
  const config = await dispatch({ type: 'GET_CONFIG' }, other);
  assert.equal(config.policy.automatic, true);
  assert.equal(config.policy.enabled, true);
  assert.equal(config.policy.mode, 'remove');
  globalThis.fetch = async () => {
    await dispatch({ type: 'SET_GLOBAL', enabled: false }, ui);
    return new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } } }));
  };
  assert.equal((await dispatch({ ...batch(), revision: config.policy.revision }, other)).error, 'stale');
  assert.equal((await dispatch({ type: 'GET_CONFIG' }, other)).policy.enabled, false);
});
