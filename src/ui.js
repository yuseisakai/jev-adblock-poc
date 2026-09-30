export const $ = (id) => document.getElementById(id);
const errors = {
  off: 'このページは未判定です',
  ready: '判定が完了しました',
  checking: 'Jevで判定中…',
  missing_key: '設定画面でAPIキーを入力してください',
  invalid_threshold: '閾値は50〜100%で入力してください',
  invalid_provider: '接続先を選び直してください',
  invalid_gateway: 'Account IDとGateway IDを確認してください',
  invalid_key: '選択した接続先のAPIキー・トークンと権限を確認してください',
  rate_limited: 'APIの利用制限に達しました。時間を置いて再スキャンしてください',
  budget_exceeded: '1時間の上限（300要求）に達しました',
  connection_error: '接続できませんでした。ページはそのままです',
  timeout: '判定がタイムアウトしました',
  api_error: 'APIエラー。ページはそのままです',
  invalid_response: '判定結果を確認できませんでした',
  stale: 'ページが変わったため判定を破棄しました',
  page_limit: '今回の上限（50候補）に達しました',
  restore_failed: '元の位置が失われています。ページを再読み込みしてください',
  restore_limit: '復元用メモリの上限に達しました',
  permission_required: 'サイトへのアクセス許可が必要です',
  busy: 'ほかのタブを判定中です。再スキャンしてください'
};
export function describe(code) {
  return errors[code] || '操作を完了できませんでした';
}
export async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Error(describe(result?.error));
  return result;
}
export function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}
