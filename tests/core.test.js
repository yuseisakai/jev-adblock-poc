import test from 'node:test';
import assert from 'node:assert/strict';
import { originOf, patternFor, supportedPage, validateBatch, buildRequest, parseResponse, retryAfterMs, judge as realJudge, endpoint } from '../src/core.js';
const gateway = { accountId: 'a'.repeat(32), gatewayId: 'default' };
const judge = (key, candidates, fetch) => realJudge(key, candidates, fetch, gateway);
const candidate = (id = 'c1') => ({ id, fingerprint: 'snapshot', features: { text: '広告: テスト', label: '広告', tag: 'aside', signal: 'ad attribute token', width: 300, height: 100, linkHost: 'example.com', frameHost: '' } });
test('only HTTP origins; permissions strip port but runtime origin preserves it', () => {
  assert.equal(originOf('chrome://extensions'), null);
  assert.equal(originOf('https://example.com/a?secret=1'), 'https://example.com');
  assert.equal(originOf('http://localhost:8787/a'), 'http://localhost:8787');
  assert.equal(patternFor('http://localhost:8787'), 'http://localhost/*');
  assert.equal(supportedPage('https://chromewebstore.google.com/detail/test'), false);
  assert.equal(supportedPage('chrome://extensions'), false);
  assert.equal(supportedPage('https://news.example/a'), true);
});
test('validation rejects oversized, duplicate, unsafe or malformed inputs', () => {
  assert.throws(() => validateBatch([]));
  assert.throws(() => validateBatch(Array.from({ length: 11 }, (_, n) => candidate(`c${n}`))));
  assert.throws(() => validateBatch([candidate(), candidate()]));
  for (const value of [NaN, Infinity, -1]) assert.throws(() => validateBatch([{ ...candidate(), features: { ...candidate().features, width: value } }]));
  assert.throws(() => validateBatch([{ ...candidate(), features: { ...candidate().features, linkHost: 'host/path?token=1' } }]));
  assert.throws(() => validateBatch([{ ...candidate(), features: { ...candidate().features, text: 'x'.repeat(501) } }]));
});
test('wire request excludes fingerprints, unknown fields and arbitrary URL', () => {
  const c = candidate(); c.secret = 'secret'; c.features.cookie = 'do-not-forward';
  const r = buildRequest([c]);
  assert.equal(r.questions.c1.type, 'noul');
  assert.equal(r.model, undefined);
  assert.ok(!JSON.stringify(r).includes('do-not-forward'));
  assert.ok(!JSON.stringify(r).includes('snapshot'));
});
test('missing and invalid probabilities never become removal decisions', () => {
  for (const p of [null, '1', NaN, Infinity, -0.1, 1.01]) assert.deepEqual(parseResponse({ answers: { c1: { type: 'noul', noul: p } } }, [candidate()]), []);
  const body = { answers: { c1: { type: 'noul', noul: 0.98 }, evil: { type: 'noul', noul: 1 } } };
  assert.deepEqual(parseResponse(body, [candidate(), candidate('c2')]), [{ id: 'c1', fingerprint: 'snapshot', probability: .98 }]);
});
test('Retry-After handles seconds, dates and missing values', () => {
  assert.equal(retryAfterMs('120'), 120000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120000);
  assert.equal(retryAfterMs(null), 60000);
  assert.equal(retryAfterMs('invalid'), 60000);
});
test('API uses fixed endpoint, no credentials and no redirects', async () => {
  let called = 0;
  const result = await judge('synthetic-key', [candidate()], async (url, options) => {
    called++; assert.equal(url, endpoint(gateway.accountId)); assert.equal(options.headers['cf-aig-gateway-id'], 'default'); assert.equal(JSON.parse(options.body).model, 'typesafe/jev'); assert.equal(JSON.parse(options.body).input.questions.c1.type, 'noul'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
    return new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } }, usage: { input_tokens: 30 } }));
  });
  assert.equal(called, 1); assert.equal(result.inputTokens, 30);
});
test('401, 429, server errors, malformed bodies fail closed without retry', async () => {
  for (const [code, message] of [[401, 'invalid_key'], [429, 'rate_limited'], [500, 'api_error']]) {
    let calls = 0;
    await assert.rejects(judge('key', [candidate()], async () => { calls++; return new Response('secret provider data', { status: code }); }), { message });
    assert.equal(calls, 1);
  }
  await assert.rejects(judge('key', [candidate()], async () => new Response('{}')), { message: 'invalid_response' });
});
test('Cloudflare envelope unwraps and explicit API failures are rejected', async () => {
  const result = await judge('key', [candidate()], async () => new Response(JSON.stringify({ success: true, result: { answers: { c1: { type: 'noul', noul: .97 } }, usage: { input_tokens: 42 } } })));
  assert.equal(result.decisions[0].probability, .97);
  assert.equal(result.inputTokens, 42);
  await assert.rejects(judge('key', [candidate()], async () => new Response(JSON.stringify({ success: false, result: { answers: { c1: { type: 'noul', noul: 1 } } } }))), { message: 'api_error' });
});
test('Invalid gateway cannot redirect credentials to an arbitrary host', async () => {
  let sent = false;
  await assert.rejects(realJudge('secret', [candidate()], async () => { sent = true; }, { accountId: '../evil', gatewayId: 'default' }), { message: 'invalid_gateway' });
  assert.equal(sent, false);
});
test('TypeSafe direct uses its endpoint and schema without Cloudflare headers', async () => {
  const result = await realJudge('typesafe-key', [candidate()], async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer typesafe-key');
    assert.equal(options.headers['cf-aig-gateway-id'], undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.c1.type, 'noul'); assert.equal(body.input, undefined);
    return new Response(JSON.stringify({ answers: { c1: { type: 'noul', noul: .99 } } }));
  }, undefined, 'typesafe');
  assert.equal(result.decisions[0].probability, .99);
});
test('Unknown provider fails before transmitting credentials', async () => {
  await assert.rejects(realJudge('secret', [candidate()], () => { assert.fail('must not fetch'); }, gateway, 'other'), { message: 'invalid_provider' });
});
