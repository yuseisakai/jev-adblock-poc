(() => {
  if (globalThis.__jevCleaner) return;
  globalThis.__jevCleaner = true;
  let epoch = crypto.randomUUID(),
    pageUrl = location.href,
    generation = 0,
    configSeq = 0;
  let policy = { enabled: false, automatic: false, mode: 'diagnostic', threshold: 0.8, revision: 0 },
    hasKey = false;
  let seen = new WeakMap(),
    protectedNodes = new WeakSet(),
    protectedPrints = new Set();
  let queue = [],
    records = [],
    removals = [],
    tested = 0,
    serial = 0,
    retainedNodes = 0;
  let flushTimer,
    scanTimer,
    sending = false,
    status = 'off',
    restoreFailures = 0;
  const roots = new Set();
  const deny =
    'html,body,article,main,nav,header,footer,form,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[role="main"],[role="navigation"]';
  const insideDeny =
    'article,main,h1,form,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="main"],[role="navigation"]';
  const labelRE =
    /^(広告|スポンサー(?:リンク|広告)?|PR|AD|広告掲載|sponsored|advertisement|promoted|anzeige|werbung)$/i;
  const tokenRE = /(^|[\s_-])(ad|ads|advert|advertisement|adsbygoogle|adslot|sponsored|promoted)([\s_-]|$)/i;
  const networkRE =
    /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|taboola\.com|outbrain\.com|criteo\.com)$/i;
  const message = (m) => chrome.runtime.sendMessage(m);
  function host(raw) {
    try {
      return new URL(raw, location.href).hostname;
    } catch {
      return '';
    }
  }
  function label(el) {
    const s = (el.textContent || '').trim();
    if (s.length <= 24 && labelRE.test(s)) return s;
    const aria = el.getAttribute('aria-label') || '';
    return labelRE.test(aria) ? aria : '';
  }
  function signal(el) {
    const evidence = [];
    const tokens = `${el.id} ${el.getAttribute('class') || ''}`;
    if (tokenRE.test(tokens)) evidence.push('ad attribute token');
    if ([...el.attributes].some((a) => /^data-ad(?:-|$)/.test(a.name))) evidence.push('ad data attribute');
    // Cross-origin creative text is inaccessible, but iframe attributes are public DOM evidence.
    // Do not forward raw ad IDs, URL paths or publisher/account identifiers.
    const frames = el.matches('iframe')
      ? [el]
      : evidence.length
        ? [...el.querySelectorAll('iframe')].slice(0, 8)
        : [];
    if (frames.some((f) => /^google_ads_iframe_/.test(f.id))) evidence.push('Google ad-serving iframe');
    if (frames.some((f) => /^(Advertisement|広告)$/i.test(f.getAttribute('aria-label') || '')))
      evidence.push('iframe labelled Advertisement');
    if (frames.some((f) => /^3rd party ad content$/i.test(f.getAttribute('title') || '')))
      evidence.push('third-party advertising content');
    if (frames.some((f) => networkRE.test(host(f.getAttribute('src'))))) evidence.push('ad network iframe');
    if (el.tagName === 'A' && networkRE.test(host(el.getAttribute('href')))) evidence.push('ad network link');
    return evidence.join('; ').slice(0, 160);
  }
  function safe(el) {
    if (
      !(el instanceof HTMLElement) ||
      !el.isConnected ||
      el.matches(deny) ||
      el.closest('article,form,[contenteditable]:not([contenteditable="false"])') ||
      el.querySelector(insideDeny)
    )
      return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.width * r.height > innerWidth * innerHeight * 0.4) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }
  function features(el, foundLabel = '') {
    // Bounded traversal, no form values, HTML, complete URLs or attribute values.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let parts = '',
      n,
      count = 0;
    while ((n = walker.nextNode()) && count++ < 250 && parts.length < 700) {
      if (
        n.parentElement?.closest(
          'script,style,noscript,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[hidden]'
        )
      )
        continue;
      let visible = true;
      for (let ancestor = n.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor);
        if (
          css.display === 'none' ||
          css.visibility === 'hidden' ||
          css.visibility === 'collapse' ||
          css.opacity === '0' ||
          css.contentVisibility === 'hidden'
        ) {
          visible = false;
          break;
        }
      }
      if (visible) parts += ` ${n.textContent}`;
    }
    const text = parts
      .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, '[URL]')
      .replace(/(?:\/|\?)[^\s<>]*[?=&][^\s<>]*/g, '[URL]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    const r = el.getBoundingClientRect();
    const a = el.matches('a') ? el : el.querySelector('a[href]');
    const frame = el.matches('iframe') ? el : el.querySelector('iframe[aria-label],iframe[title],iframe');
    const frameLabel =
      frame && /^(Advertisement|広告)$/i.test(frame.getAttribute('aria-label') || '')
        ? frame.getAttribute('aria-label')
        : '';
    return {
      text,
      label: foundLabel || frameLabel,
      tag: el.tagName.toLowerCase(),
      signal: signal(el),
      linkHost: a ? host(a.getAttribute('href')) : '',
      frameHost: frame ? host(frame.getAttribute('src')) : '',
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
  }
  function candidateFrom(el) {
    const l = label(el),
      sig = signal(el);
    if (!l && !sig) return null;
    let target = el;
    // Lift a short label into a bounded card, never a page-level container.
    if (l) {
      for (let i = 0; i < 3; i++) {
        const parent = target.parentElement;
        if (!parent || !safe(parent) || (parent.textContent || '').length > 1500) break;
        if (
          parent.matches('article,aside,li,[role="listitem"]') ||
          signal(parent) ||
          parent.querySelector('a[href],img') ||
          parent.children.length > 1
        ) {
          target = parent;
          break;
        }
        if (i < 2 && parent.children.length <= 5) target = parent;
        else break;
      }
      // A label with no actual card / creative content is not an ad container.
      if (target === el && !sig) return null;
    }
    return safe(target) ? { el: target, label: l } : null;
  }
  function consider(el) {
    if (tested + queue.length >= 50) return;
    const c = candidateFrom(el);
    if (!c || protectedNodes.has(c.el)) return;
    const f = features(c.el, c.label),
      fingerprint = JSON.stringify(f);
    if (protectedPrints.has(fingerprint) || seen.get(c.el) === fingerprint) return;
    // Prefer the already discovered enclosing card when it represents the same slot.
    if (queue.some((q) => q.el === c.el || q.el.contains(c.el))) return;
    queue = queue.filter((q) => !c.el.contains(q.el));
    seen.set(c.el, fingerprint);
    queue.push({ id: `c${++serial}`, el: c.el, label: c.label, features: f, fingerprint });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 300);
  }
  function schedule(root) {
    if (!policy.enabled || !hasKey || !root?.isConnected) return;
    roots.add(root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement);
    if (!scanTimer) scanTimer = setTimeout(scan, 300);
  }
  function scan() {
    scanTimer = null;
    const g = generation;
    const todo = [...roots].filter(Boolean);
    roots.clear();
    let walker = null,
      root = null;
    function chunk() {
      if (g !== generation || !policy.enabled || tested + queue.length >= 50) return;
      const start = performance.now();
      let steps = 0;
      while (steps++ < 150 && performance.now() - start < 6) {
        if (!walker) {
          root = todo.shift();
          if (!root) return;
          if (!root.isConnected) continue;
          walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          consider(root);
        }
        const node = walker.nextNode();
        if (node) consider(node);
        else walker = null;
      }
      setTimeout(chunk, 0);
    }
    chunk();
  }
  function changedPage() {
    if (location.href === pageUrl) return false;
    // Never insert old route nodes into the next SPA view.
    for (const r of removals) r.anchor.remove();
    removals = [];
    retainedNodes = 0;
    records = [];
    queue = [];
    roots.clear();
    seen = new WeakMap();
    protectedNodes = new WeakSet();
    protectedPrints.clear();
    tested = 0;
    restoreFailures = 0;
    generation++;
    epoch = crypto.randomUUID();
    pageUrl = location.href;
    if (policy.automatic) schedule(document.documentElement);
    return true;
  }
  function remove(c, probability) {
    const count = c.el.getElementsByTagName('*').length + 1;
    if (retainedNodes + count > 5000) {
      status = 'restore_limit';
      return;
    }
    const anchor = document.createComment('jev-ad-slot');
    c.el.before(anchor);
    c.el.remove();
    retainedNodes += count;
    removals.push({ ...c, anchor, count, probability });
  }
  async function flush() {
    if (sending || !policy.enabled || !hasKey || changedPage()) return;
    if (!queue.length) return;
    const batch = [];
    while (queue.length && batch.length < 10 && tested + batch.length < 50) {
      const c = queue.shift();
      if (!safe(c.el) || protectedNodes.has(c.el)) continue;
      const proposed = [...batch, c].map(({ id, fingerprint, features }) => ({ id, fingerprint, features }));
      if (new TextEncoder().encode(JSON.stringify(proposed)).length > 16384) {
        queue.unshift(c);
        break;
      }
      batch.push(c);
    }
    if (!batch.length) return;
    sending = true;
    tested += batch.length;
    status = 'checking';
    const g = generation,
      e = epoch,
      revision = policy.revision;
    try {
      const result = await message({
        type: 'CLASSIFY_BATCH',
        epoch: e,
        revision,
        candidates: batch.map(({ id, fingerprint, features }) => ({ id, fingerprint, features }))
      });
      if (changedPage() || generation !== g) return;
      if (!result?.ok) {
        status = result?.error || 'connection_error';
        return;
      }
      if (result.epoch !== e || result.revision !== revision) {
        status = 'stale';
        return;
      }
      // Read authoritative settings again before any DOM mutation.
      const config = await message({ type: 'GET_CONFIG' });
      if (
        changedPage() ||
        generation !== g ||
        !config?.ok ||
        !config.hasKey ||
        !config.policy.enabled ||
        config.policy.revision !== revision
      )
        return;
      status = 'ready';
      for (const c of batch) {
        const d = result.decisions?.find((d) => d.id === c.id && d.fingerprint === c.fingerprint);
        if (
          !d ||
          !Number.isFinite(d.probability) ||
          d.probability < 0 ||
          d.probability > 1 ||
          !safe(c.el) ||
          protectedNodes.has(c.el) ||
          JSON.stringify(features(c.el, c.label)) !== c.fingerprint
        )
          continue;
        records.push({
          id: c.id,
          label: c.features.label || c.features.signal,
          probability: d.probability,
          belowThreshold: d.probability < policy.threshold
        });
        if (policy.mode === 'remove' && d.probability >= policy.threshold) remove(c, d.probability);
      }
      if (tested >= 50) status = 'page_limit';
    } catch {
      if (generation === g) status = 'connection_error';
    } finally {
      sending = false;
      if (
        queue.length &&
        policy.enabled &&
        hasKey &&
        ![
          'invalid_key',
          'rate_limited',
          'budget_exceeded',
          'connection_error',
          'timeout',
          'api_error'
        ].includes(status)
      )
        flushTimer = setTimeout(flush, 300);
    }
  }
  function restore(all) {
    generation++;
    queue = [];
    roots.clear();
    const targets = all ? [...removals].reverse() : removals.slice(-1);
    let restored = 0,
      failed = 0;
    for (const r of targets) {
      protectedNodes.add(r.el);
      protectedPrints.add(r.fingerprint);
      if (r.anchor.isConnected && !r.el.isConnected) {
        r.anchor.replaceWith(r.el);
        removals = removals.filter((x) => x !== r);
        retainedNodes -= r.count;
        restored++;
      } else {
        failed++;
      }
    }
    restoreFailures = failed;
    status = failed ? 'restore_failed' : policy.enabled ? 'ready' : 'off';
    return { restored, failed };
  }
  const observer = new MutationObserver((mutations) => {
    if (!policy.automatic || changedPage()) return;
    // Stop automatic traffic after errors until a reload or explicit rescan.
    if (!['ready', 'checking'].includes(status)) return;
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1) schedule(n);
      } else schedule(m.target.nodeType === 3 ? m.target.parentElement : m.target);
    }
  });
  async function refresh() {
    const seq = ++configSeq;
    try {
      const result = await message({ type: 'GET_CONFIG' });
      if (seq !== configSeq || !result?.ok) return;
      observer.disconnect();
      const old = policy;
      policy = result.policy;
      hasKey = result.hasKey;
      generation++;
      queue = [];
      roots.clear();
      clearTimeout(scanTimer);
      scanTimer = null;
      clearTimeout(flushTimer);
      if (!hasKey || (policy.enabled && old.mode === 'remove' && policy.mode === 'diagnostic')) restore(true);
      seen = new WeakMap();
      status = !policy.enabled ? 'off' : !hasKey ? 'missing_key' : 'ready';
      if (policy.enabled && policy.automatic && hasKey) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'id', 'src', 'href', 'aria-label', 'data-ad-slot', 'style']
        });
        schedule(document.documentElement);
      }
    } catch {
      status = 'connection_error';
    }
  }
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (m.type === 'REFRESH') {
      refresh().then(() => reply({ ok: true }));
      return true;
    }
    if (!sender.url?.startsWith(chrome.runtime.getURL('src/'))) return;
    changedPage();
    if (m.type === 'PAGE_STATUS')
      reply({
        ok: true,
        epoch,
        status,
        tested,
        removed: removals.length,
        restoreFailures,
        records: records.slice(-10),
        mode: policy.mode
      });
    if (m.type === 'RESTORE') reply({ ok: true, ...restore(Boolean(m.all)) });
    if (m.type === 'RESCAN') {
      if (sending) {
        reply({ ok: false, error: 'busy' });
        return;
      }
      refresh().then(() => {
        tested = 0;
        records = [];
        status = 'ready';
        seen = new WeakMap();
        schedule(document.documentElement);
        reply({ ok: true });
      });
      return true;
    }
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) refresh();
  });
  setInterval(() => {
    if (policy.enabled && policy.automatic) changedPage();
  }, 1000);
  refresh();
})();
