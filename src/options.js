import { $, send, notice } from './ui.js';
let savedProvider = 'cloudflare', savedHasKey = false;
function providerUI() {
  const direct = $('provider').value === 'typesafe';
  $('gatewayFields').hidden = direct;
  $('keyLabel').textContent = direct ? 'TypeSafe APIキー' : 'Cloudflare APIトークン';
  $('providerHelp').textContent = direct ? 'TypeSafeのAPIキーだけで利用できます。Cloudflareの設定は不要です。' : 'Workers AI / Read権限のトークンと、AI Gatewayのクレジットが必要です。';
  $('providerLink').href = direct ? 'https://console.typesafe.ai' : 'https://dash.cloudflare.com/';
  $('test').disabled = !savedHasKey || $('provider').value !== savedProvider;
}
$('automatic').onchange = async () => {
  const enabled = $('automatic').checked;
  try {
    if (enabled && !await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })) throw Error('すべてのサイトへのアクセスが許可されませんでした');
    await send({ type: 'SET_GLOBAL', enabled });
    notice(enabled ? 'すべてのサイトで常時オンにしました' : '手動実行に戻しました');
  } catch (e) { notice(e.message, true); }
  await render();
};
$('provider').onchange = () => { $('key').value = ''; $('consent').checked = false; providerUI(); notice('接続先のキーを入力して保存すると切り替わります'); };
async function render() {
  const s = await send({ type: 'GET_SETTINGS' });
  $('automatic').checked = Boolean(s.globalAutomatic);
  savedProvider = s.provider; savedHasKey = s.hasKey; $('provider').value = savedProvider;
  if (s.gateway && !$('account').value) { $('account').value = s.gateway.accountId; $('gateway').value = s.gateway.gatewayId; }
  $('keyState').textContent = s.hasKey ? `APIキー設定済み（${savedProvider === 'typesafe' ? 'TypeSafe' : 'Cloudflare'}・ブラウザ終了まで）` : 'APIキー未設定';
  $('clear').disabled = !s.hasKey; providerUI();
  $('usage').textContent = `${s.budget.requests} 要求 / 入力 ${s.budget.inputTokens.toLocaleString()} トークン（現在の集計枠）`;
  $('sites').replaceChildren();
  if (!Object.keys(s.policies).length) $('sites').textContent = 'まだ有効化したサイトはありません。';
  for (const [origin, p] of Object.entries(s.policies)) {
    const row = document.createElement('div'); row.className = 'site';
    const name = document.createElement('span'); name.textContent = `${origin} · ${s.globalAutomatic ? '全サイト自動実行中' : p.enabled ? '有効' : '停止中'} · ${p.mode === 'remove' ? '削除' : '診断'}`;
    const input = document.createElement('input'); input.type = 'number'; input.min = '.5'; input.max = '1'; input.step = '.01'; input.value = p.threshold; input.style.width = '85px'; input.setAttribute('aria-label', `${origin} の削除閾値`);
    const save = document.createElement('button'); save.textContent = '更新';
    save.onclick = () => action(async () => { await send({ type: 'SET_POLICY', origin, update: { ...p, threshold: Number(input.value) } }); notice('閾値を更新しました'); });
    const stop = document.createElement('button'); stop.textContent = '停止'; stop.disabled = s.globalAutomatic || !p.enabled;
    if (s.globalAutomatic) stop.title = '自動実行を停止するには全サイトの常時オンをOFFにします';
    stop.onclick = () => action(async () => { await send({ type: 'SET_POLICY', origin, update: { ...p, enabled: false } }); notice('このサイトを停止しました'); });
    row.append(name, input, save, stop); $('sites').append(row);
  }
}
async function action(fn) { try { await fn(); await render(); } catch (e) { notice(e.message, true); } }
$('save').onclick = () => action(async () => {
  if (!$('consent').checked) throw Error('外部送信とAPI料金について確認してください');
  await send({ type: 'SET_KEY', provider: $('provider').value, key: $('key').value.trim(), gateway: { accountId: $('account').value.trim(), gatewayId: $('gateway').value.trim() } }); $('key').value = ''; notice('APIキーを保存しました');
});
$('clear').onclick = () => action(async () => { await send({ type: 'CLEAR_KEY' }); notice('APIキーを消去しました'); });
$('test').onclick = () => action(async () => {
  $('test').disabled = true; notice('合成データでJevの判定を確認中…');
  try { await send({ type: 'TEST_KEY' }); notice('接続成功。Jevの判定結果を受信しました'); } finally { $('test').disabled = false; }
});
render().catch(e => notice(e.message, true));
