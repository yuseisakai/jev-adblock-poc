import {
  DEFAULT_POLICY,
  LIMITS,
  originOf,
  supportedPage,
  validThreshold,
  validateBatch,
  judge,
  validateGateway
} from './core.js';

let active = 0;
let serial = Promise.resolve();
function locked(fn) {
  const next = serial.then(fn);
  serial = next.catch(() => {});
  return next;
}
const ALL_WEB = ['http://*/*', 'https://*/*'];
const ready = (async () => {
  await Promise.all([
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  ]);
  const s = await chrome.storage.local.get(['settingsVersion', 'threshold', 'globalRevision']);
  if (s.settingsVersion !== 1) {
    // Remove historical origin-indexed settings; never persist browsing locations again.
    await chrome.storage.local.remove(['policies', 'threshold90Applied']);
    await chrome.storage.local.set({
      settingsVersion: 1,
      threshold: validThreshold(s.threshold) ? s.threshold : 0.8,
      globalRevision: (s.globalRevision || 0) + 1
    });
    const grants = await chrome.permissions.getAll();
    const oldSites = (grants.origins || []).filter(
      (o) =>
        /^https?:/.test(o) &&
        !ALL_WEB.includes(o) &&
        !['https://api.cloudflare.com/*', 'https://api.typesafe.ai/*'].includes(o)
    );
    if (oldSites.length) await chrome.permissions.remove({ origins: oldSites });
  }
})();
function trusted(sender, page) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(`src/${page}.html`);
}
function isUI(sender) {
  return trusted(sender, 'popup') || trusted(sender, 'options');
}
async function policy(sender) {
  const s = await chrome.storage.local.get(['globalAutomatic', 'threshold', 'globalRevision']);
  const automatic = Boolean(s.globalAutomatic) && (await chrome.permissions.contains({ origins: ALL_WEB }));
  const { manualPages = {} } = await chrome.storage.session.get('manualPages');
  const page = manualPages[sender.tab?.id];
  const manual = page && page.documentId === sender.documentId;
  return {
    ...DEFAULT_POLICY,
    enabled: automatic || Boolean(manual),
    automatic,
    mode: automatic ? 'remove' : manual ? page.mode : 'diagnostic',
    threshold: validThreshold(s.threshold) ? s.threshold : 0.8,
    revision: `${s.globalRevision || 0}:${manual ? page.revision : 0}`
  };
}
async function syncScripts() {
  const { globalAutomatic } = await chrome.storage.local.get('globalAutomatic');
  const enabled = globalAutomatic && (await chrome.permissions.contains({ origins: ALL_WEB }));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['jev-sites'] });
  if (!enabled) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['jev-sites'] });
    return;
  }
  const config = {
    id: 'jev-sites',
    matches: ALL_WEB,
    js: ['src/content.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true
  };
  if (existing.length) await chrome.scripting.updateContentScripts([config]);
  else await chrome.scripting.registerContentScripts([config]);
}
async function refreshTabs(inject = false) {
  for (const tab of await chrome.tabs.query({})) {
    try {
      if (inject && supportedPage(tab.url))
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: ['src/content.js']
        });
      await chrome.tabs.sendMessage(tab.id, { type: 'REFRESH' }, { frameId: 0 });
    } catch {
      /* Restricted pages and tabs without our content script. */
    }
  }
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
      const budget =
        s.budget && now - s.budget.start < 3600000 ? s.budget : { start: now, requests: 0, inputTokens: 0 };
      if (budget.requests >= LIMITS.hourly) throw Error('budget_exceeded');
      budget.requests++;
      await chrome.storage.session.set({ budget });
      const settings = await chrome.storage.local.get(['gateway', 'provider']);
      return { apiKey: s.apiKey, gateway: settings.gateway, provider: settings.provider || 'cloudflare' };
    });
    const result = await judge(connection.apiKey, candidates, fetch, connection.gateway, connection.provider);
    await locked(async () => {
      const { budget } = await chrome.storage.session.get('budget');
      if (budget)
        await chrome.storage.session.set({
          budget: { ...budget, inputTokens: budget.inputTokens + result.inputTokens }
        });
    });
    return result;
  } catch (error) {
    if (error.retryMs) await chrome.storage.session.set({ retryAt: Date.now() + error.retryMs });
    throw error;
  } finally {
    active--;
  }
}
async function handle(m, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id || !m || typeof m.type !== 'string') throw Error('forbidden');
  const content = Boolean(sender.tab && sender.frameId === 0 && originOf(sender.url));

  if (m.type === 'GET_CONFIG' && content) {
    const p = await policy(sender);
    const { apiKey } = await chrome.storage.session.get('apiKey');
    return { policy: { ...p, enabled: p.enabled }, hasKey: Boolean(apiKey) };
  }
  if (m.type === 'CLASSIFY_BATCH' && content) {
    const p = await policy(sender);
    if (!p.enabled || p.revision !== m.revision || typeof m.epoch !== 'string' || m.epoch.length > 80)
      throw Error('stale');
    const candidates = validateBatch(m.candidates);
    const result = await requestJudge(candidates);
    // Content script additionally validates epoch, fingerprint and settings after await.
    const current = await policy(sender);
    if (!current.enabled || current.revision !== m.revision) throw Error('stale');
    return { ...result, epoch: m.epoch, revision: m.revision };
  }
  if (!isUI(sender)) throw Error('forbidden');
  if (m.type === 'SET_GLOBAL') {
    if (typeof m.enabled !== 'boolean') throw Error('invalid_policy');
    await locked(async () => {
      if (m.enabled && !(await chrome.permissions.contains({ origins: ALL_WEB })))
        throw Error('permission_required');
      const s = await chrome.storage.local.get('globalRevision');
      await chrome.storage.local.set({
        globalAutomatic: m.enabled,
        globalRevision: (s.globalRevision || 0) + 1
      });
      await chrome.storage.session.remove('manualPages');
      await syncScripts();
    });
    await refreshTabs(m.enabled);
    return {};
  }
  if (m.type === 'GET_SETTINGS') {
    const s = await chrome.storage.session.get(['apiKey', 'budget', 'retryAt']);
    const settings = await chrome.storage.local.get(['globalAutomatic', 'provider', 'gateway', 'threshold']);
    return {
      globalAutomatic: Boolean(settings.globalAutomatic),
      threshold: validThreshold(settings.threshold) ? settings.threshold : 0.8,
      provider: settings.provider || 'cloudflare',
      gateway: settings.gateway || null,
      hasKey: Boolean(s.apiKey),
      budget: s.budget || { requests: 0, inputTokens: 0 },
      retryAt: s.retryAt || 0
    };
  }
  if (m.type === 'SET_THRESHOLD') {
    if (!validThreshold(m.threshold)) throw Error('invalid_threshold');
    await locked(async () => {
      const s = await chrome.storage.local.get('globalRevision');
      await chrome.storage.local.set({ threshold: m.threshold, globalRevision: (s.globalRevision || 0) + 1 });
    });
    await refreshTabs();
    return {};
  }
  if (m.type === 'SET_PAGE') {
    if (!Number.isInteger(m.tabId) || !['diagnostic', 'remove'].includes(m.mode))
      throw Error('invalid_policy');
    const tab = await chrome.tabs.get(m.tabId);
    if (!supportedPage(tab.url)) throw Error('invalid_origin');
    // activeTab is sufficient for manual scans; no per-site grants or URL storage.
    const frames = await chrome.scripting.executeScript({
      target: { tabId: m.tabId, frameIds: [0] },
      files: ['src/content.js']
    });
    const documentId = frames[0]?.documentId;
    if (!documentId) throw Error('stale');
    await locked(async () => {
      const { manualPages = {} } = await chrome.storage.session.get('manualPages');
      manualPages[m.tabId] = {
        documentId,
        mode: m.mode,
        revision: (manualPages[m.tabId]?.revision || 0) + 1
      };
      await chrome.storage.session.set({ manualPages });
    });
    await chrome.tabs.sendMessage(m.tabId, { type: 'REFRESH' }, { documentId });
    return {};
  }
  if (m.type === 'SET_KEY' && trusted(sender, 'options')) {
    if (typeof m.key !== 'string' || m.key.length < 8 || m.key.length > 512 || /\s/.test(m.key))
      throw Error('invalid_key');
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
    await requestJudge([
      {
        id: 'c0',
        fingerprint: 'synthetic',
        features: {
          text: '広告: 架空の商品のスポンサー枠',
          label: '広告',
          tag: 'aside',
          linkHost: 'example.com',
          frameHost: '',
          signal: 'sponsored',
          width: 300,
          height: 100
        }
      }
    ]);
    return {};
  }
  throw Error('unknown_message');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(
    (data) => reply({ ok: true, ...data }),
    (error) => {
      const known = new Set([
        'invalid_threshold',
        'invalid_provider',
        'invalid_gateway',
        'invalid_batch',
        'batch_too_large',
        'invalid_candidate',
        'invalid_features',
        'invalid_host',
        'invalid_origin',
        'permission_required',
        'busy',
        'missing_key',
        'rate_limited',
        'budget_exceeded',
        'invalid_key',
        'api_error',
        'invalid_response',
        'forbidden',
        'stale',
        'invalid_policy'
      ]);
      reply({
        ok: false,
        error: known.has(error.message)
          ? error.message
          : error.name === 'TimeoutError'
            ? 'timeout'
            : 'connection_error'
      });
    }
  );
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  ready
    .then(() => locked(syncScripts))
    .then(() => refreshTabs())
    .catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ready.then(() => locked(syncScripts)).catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => {
  ready
    .then(() =>
      locked(async () => {
        const s = await chrome.storage.local.get(['globalAutomatic', 'globalRevision']);
        if (s.globalAutomatic && !(await chrome.permissions.contains({ origins: ALL_WEB })))
          await chrome.storage.local.set({
            globalAutomatic: false,
            globalRevision: (s.globalRevision || 0) + 1
          });
        await syncScripts();
      })
    )
    .then(() => refreshTabs())
    .catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  ready
    .then(() =>
      locked(async () => {
        const { manualPages = {} } = await chrome.storage.session.get('manualPages');
        delete manualPages[tabId];
        await chrome.storage.session.set({ manualPages });
      })
    )
    .catch(() => {});
});
