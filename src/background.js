import { DEFAULT_POLICY, LIMITS, originOf, patternFor, validThreshold, validateBatch, judge, validateGateway } from './core.js';

let active = 0;
let serial = Promise.resolve();
function locked(fn) { const next = serial.then(fn); serial = next.catch(() => {}); return next; }
const ready = Promise.all([
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
async function policies() { return (await chrome.storage.local.get('policies')).policies || {}; }
const ALL_WEB = ['http://*/*', 'https://*/*'];
async function policy(origin) {
  const s = await chrome.storage.local.get(['policies', 'globalAutomatic', 'globalRevision']);
  const p = { ...DEFAULT_POLICY, ...s.policies?.[origin] };
  return { ...p, ...(s.globalAutomatic ? { enabled: true, automatic: true, mode: 'remove' } : {}), revision: `${s.globalRevision || 0}:${p.revision}` };
}
function trusted(sender, page) { return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(`src/${page}.html`); }
function isUI(sender) { return trusted(sender, 'popup') || trusted(sender, 'options'); }
async function permitted(origin) { return chrome.permissions.contains({ origins: [patternFor(origin)] }); }
async function syncScripts() {
  const all = await policies();
  const { globalAutomatic } = await chrome.storage.local.get('globalAutomatic');
  const matches = globalAutomatic ? ALL_WEB : [...new Set(Object.entries(all).filter(([, p]) => p.enabled).map(([o]) => patternFor(o)))];
  const allowed = [];
  for (const match of matches) if (await chrome.permissions.contains({ origins: [match] })) allowed.push(match);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['jev-sites'] });
  if (!allowed.length) { if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['jev-sites'] }); return; }
  const config = { id: 'jev-sites', matches: allowed, js: ['src/content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true };
  if (existing.length) await chrome.scripting.updateContentScripts([config]);
  else await chrome.scripting.registerContentScripts([config]);
}
async function refreshTabs(origin, inject = false) {
  for (const tab of await chrome.tabs.query({})) {
    const tabOrigin = originOf(tab.url);
    if (!tabOrigin || (origin && tabOrigin !== origin)) continue;
    try {
      if (inject && tab.id && await permitted(tabOrigin)) await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['src/content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'REFRESH' }, { frameId: 0 });
    } catch { /* Tabs without a content script or restricted pages are expected. */ }
  }
}
async function setPolicy(origin, update) {
  if (!origin || originOf(origin) !== origin) throw Error('invalid_origin');
  const result = await locked(async () => {
    const all = await policies();
    const old = { ...DEFAULT_POLICY, ...all[origin] };
    const next = { ...old, ...update, revision: old.revision + 1 };
    if (next.enabled && !await permitted(origin)) throw Error('permission_required');
    all[origin] = next;
    await chrome.storage.local.set({ policies: all });
    await syncScripts();
    return next;
  });
  await refreshTabs(origin, result.enabled);
  return result;
}
async function requestJudge(candidates) {
  if (active >= 2) throw Error('busy');
  active++;
  try {
    const connection = await locked(async () => {
      const s = await chrome.storage.session.get(['apiKey', 'budget', 'retryAt']);
      if (!s.apiKey) throw Error('missing_key');
      const now = Date.now();
      if (s.retryAt > now) throw Error('rate_limited');
      const budget = s.budget && now - s.budget.start < 3600000 ? s.budget : { start: now, requests: 0, inputTokens: 0 };
      if (budget.requests >= LIMITS.hourly) throw Error('budget_exceeded');
      budget.requests++;
      await chrome.storage.session.set({ budget });
      const settings = await chrome.storage.local.get(['gateway', 'provider']);
      return { apiKey: s.apiKey, gateway: settings.gateway, provider: settings.provider || 'cloudflare' };
    });
    const result = await judge(connection.apiKey, candidates, fetch, connection.gateway, connection.provider);
    await locked(async () => {
      const { budget } = await chrome.storage.session.get('budget');
      if (budget) await chrome.storage.session.set({ budget: { ...budget, inputTokens: budget.inputTokens + result.inputTokens } });
    });
    return result;
  } catch (error) {
    if (error.retryMs) await chrome.storage.session.set({ retryAt: Date.now() + error.retryMs });
    throw error;
  } finally { active--; }
}
async function handle(m, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id || !m || typeof m.type !== 'string') throw Error('forbidden');
  const content = Boolean(sender.tab && sender.frameId === 0 && originOf(sender.url));
  const origin = content ? originOf(sender.url) : null;
  if (m.type === 'GET_CONFIG' && content) {
    const p = await policy(origin);
    const { apiKey } = await chrome.storage.session.get('apiKey');
    return { policy: { ...p, enabled: p.enabled && await permitted(origin) }, hasKey: Boolean(apiKey) };
  }
  if (m.type === 'CLASSIFY_BATCH' && content) {
    const p = await policy(origin);
    if (!p.enabled || !await permitted(origin) || p.revision !== m.revision || typeof m.epoch !== 'string' || m.epoch.length > 80) throw Error('stale');
    const candidates = validateBatch(m.candidates);
    const result = await requestJudge(candidates);
    // Content script additionally validates epoch, fingerprint and settings after await.
    const current = await policy(origin);
    if (!current.enabled || current.revision !== m.revision || !await permitted(origin)) throw Error('stale');
    return { ...result, epoch: m.epoch, revision: m.revision };
  }
  if (!isUI(sender)) throw Error('forbidden');
  if (m.type === 'SET_GLOBAL') {
    if (typeof m.enabled !== 'boolean') throw Error('invalid_policy');
    await locked(async () => {
      if (m.enabled && !await chrome.permissions.contains({ origins: ALL_WEB })) throw Error('permission_required');
      const s = await chrome.storage.local.get(['globalRevision', 'policies']);
      const all = s.policies || {};
      for (const p of Object.values(all)) if (p.automatic) { p.automatic = false; p.revision++; }
      await chrome.storage.local.set({ globalAutomatic: m.enabled, globalRevision: (s.globalRevision || 0) + 1, policies: all });
      await syncScripts();
    });
    await refreshTabs(null, m.enabled);
    return {};
  }
  if (m.type === 'GET_SETTINGS') {
    const s = await chrome.storage.session.get(['apiKey', 'budget', 'retryAt']);
    return { globalAutomatic: Boolean((await chrome.storage.local.get('globalAutomatic')).globalAutomatic), provider: (await chrome.storage.local.get('provider')).provider || 'cloudflare', gateway: (await chrome.storage.local.get('gateway')).gateway || null, policies: await policies(), hasKey: Boolean(s.apiKey), budget: s.budget || { requests: 0, inputTokens: 0 }, retryAt: s.retryAt || 0 };
  }
  if (m.type === 'SET_POLICY') {
    const u = m.update || {};
    if ((u.automatic !== undefined && typeof u.automatic !== 'boolean') || (u.automatic === true && u.mode !== 'remove') || typeof u.enabled !== 'boolean' || !['diagnostic', 'remove'].includes(u.mode) || !validThreshold(u.threshold)) throw Error('invalid_policy');
    return { policy: await setPolicy(m.origin, { enabled: u.enabled, automatic: u.automatic ?? false, mode: u.mode, threshold: u.threshold }) };
  }
  if (m.type === 'SET_KEY' && trusted(sender, 'options')) {
    if (typeof m.key !== 'string' || m.key.length < 8 || m.key.length > 512 || /\s/.test(m.key)) throw Error('invalid_key');
    const provider = m.provider ?? 'cloudflare';
    if (!['cloudflare', 'typesafe'].includes(provider)) throw Error('invalid_provider');
    const gateway = provider === 'cloudflare' ? validateGateway(m.gateway) : null;
    await locked(async () => {
      await chrome.storage.local.set({ provider, ...(gateway ? { gateway } : {}) });
      await chrome.storage.session.set({ apiKey: m.key, retryAt: 0 });
    });
    await refreshTabs();
    return {};
  }
  if (m.type === 'CLEAR_KEY' && trusted(sender, 'options')) {
    await chrome.storage.session.remove('apiKey');
    await refreshTabs();
    return {};
  }
  if (m.type === 'TEST_KEY' && trusted(sender, 'options')) {
    await requestJudge([{ id: 'c0', fingerprint: 'synthetic', features: { text: '広告: 架空の商品のスポンサー枠', label: '広告', tag: 'aside', linkHost: 'example.com', frameHost: '', signal: 'sponsored', width: 300, height: 100 } }]);
    return {};
  }
  throw Error('unknown_message');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(data => reply({ ok: true, ...data }), error => {
    const known = new Set(['invalid_provider','invalid_gateway','invalid_batch','batch_too_large','invalid_candidate','invalid_features','invalid_host','invalid_origin','permission_required','busy','missing_key','rate_limited','budget_exceeded','invalid_key','api_error','invalid_response','forbidden','stale','invalid_policy']);
    reply({ ok: false, error: known.has(error.message) ? error.message : error.name === 'TimeoutError' ? 'timeout' : 'connection_error' });
  });
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  ready.then(() => locked(async () => {
    const { threshold90Applied } = await chrome.storage.local.get('threshold90Applied');
    if (!threshold90Applied) {
      const all = await policies();
      for (const p of Object.values(all)) { p.threshold = .90; p.revision++; }
      await chrome.storage.local.set({ policies: all, threshold90Applied: true });
    }
    await syncScripts();
  })).then(() => refreshTabs()).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { ready.then(() => locked(syncScripts)).catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => {
  ready.then(() => locked(async () => {
    const g = await chrome.storage.local.get(['globalAutomatic', 'globalRevision']);
    if (g.globalAutomatic && !await chrome.permissions.contains({ origins: ALL_WEB })) await chrome.storage.local.set({ globalAutomatic: false, globalRevision: (g.globalRevision || 0) + 1 });
    const all = await policies();
    for (const [o, p] of Object.entries(all)) if (p.enabled && !await permitted(o)) all[o] = { ...p, enabled: false, revision: p.revision + 1 };
    await chrome.storage.local.set({ policies: all });
    await syncScripts();
  })).then(() => refreshTabs()).catch(() => {});
});
