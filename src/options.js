import { $, send, notice } from './ui.js';
import { bindShared, renderShared } from './settings-ui.js';
let savedProvider = 'cloudflare',
  savedHasKey = false,
  initialized = false;
function providerUI() {
  const direct = $('provider').value === 'typesafe';
  $('gatewayFields').hidden = direct;
  $('keyLabel').textContent = direct ? 'TypeSafe APIキー ※必須' : 'Cloudflare APIトークン ※必須';
  $('providerHelp').textContent = direct
    ? ''
    : 'Workers AI / Read権限のトークンとAI Gatewayのクレジットが必要です。';
  $('providerHelp').hidden = direct;
  $('providerLink').href = direct ? 'https://console.typesafe.ai' : 'https://dash.cloudflare.com/';
  $('test').disabled = !savedHasKey || $('provider').value !== savedProvider;
}
async function render() {
  const s = await send({ type: 'GET_SETTINGS' });
  renderShared(s);
  savedProvider = s.provider;
  savedHasKey = s.hasKey;
  if (!initialized) {
    $('provider').value = s.provider;
    if (s.gateway) {
      $('account').value = s.gateway.accountId;
      $('gateway').value = s.gateway.gatewayId;
    }
    initialized = true;
  }
  $('keyState').textContent = s.hasKey
    ? `設定済み · ${s.provider === 'typesafe' ? 'TypeSafe' : 'Cloudflare'}`
    : 'キー未設定';
  $('clear').disabled = !s.hasKey;
  providerUI();
  $('usage').textContent =
    `${s.budget.requests} / 300 要求 · 入力 ${s.budget.inputTokens.toLocaleString()} トークン`;
}
$('provider').onchange = () => {
  $('key').value = '';
  $('consent').checked = false;
  providerUI();
};
$('connectionForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    if (!$('consent').checked) throw Error('外部送信と料金の説明を確認し、チェックを入れてください');
    await send({
      type: 'SET_KEY',
      provider: $('provider').value,
      key: $('key').value.trim(),
      gateway: { accountId: $('account').value.trim(), gatewayId: $('gateway').value.trim() }
    });
    $('key').value = '';
    await render();
    notice('接続キーを保存しました');
  } catch (e) {
    notice(e.message, true);
  }
};
$('clear').onclick = async () => {
  try {
    await send({ type: 'CLEAR_KEY' });
    await render();
    notice('接続キーを消去しました');
  } catch (e) {
    notice(e.message, true);
  }
};
$('test').onclick = async () => {
  $('test').disabled = true;
  notice('合成データで接続を確認中…');
  try {
    await send({ type: 'TEST_KEY' });
    notice('接続成功。Jevの判定結果を受信しました');
  } catch (e) {
    notice(e.message, true);
  } finally {
    await render();
  }
};
bindShared(render);
render().catch((e) => notice(e.message, true));
