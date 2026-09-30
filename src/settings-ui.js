import { $, send, notice } from './ui.js';
let thresholdDirty = false;
export function renderShared(s) {
  $('automatic').checked = Boolean(s.globalAutomatic);
  $('automaticState').textContent = s.globalAutomatic
    ? s.hasKey
      ? 'ページを開くと自動で削除します'
      : 'APIキーを設定すると開始します'
    : 'ボタンを押したときだけ削除します';
  if (!thresholdDirty) $('threshold').value = Math.round(s.threshold * 100);
  if ($('thresholdInfo'))
    $('thresholdInfo').textContent = `現在の削除閾値：${Math.round(s.threshold * 100)}%`;
}
export function bindShared(refresh) {
  $('threshold').oninput = () => {
    thresholdDirty = true;
    $('threshold').removeAttribute('aria-invalid');
    $('thresholdError').textContent = '';
  };
  $('thresholdForm').onsubmit = async (e) => {
    e.preventDefault();
    const value = $('threshold').value.trim(),
      n = Number(value);
    if (!value || !Number.isInteger(n) || n < 50 || n > 100) {
      $('thresholdError').textContent = '＊50〜100の整数を入力してください。';
      $('threshold').setAttribute('aria-invalid', 'true');
      $('threshold').focus();
      return;
    }
    try {
      await send({ type: 'SET_THRESHOLD', threshold: n / 100 });
      thresholdDirty = false;
      await refresh();
      notice(`削除閾値を${n}%に保存しました`);
    } catch (e) {
      notice(e.message, true);
    }
  };
  $('automatic').onchange = async () => {
    const enabled = $('automatic').checked;
    try {
      if (enabled && !(await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })))
        throw Error('すべてのサイトへのアクセスが許可されませんでした');
      await send({ type: 'SET_GLOBAL', enabled });
      notice(enabled ? '自動判定をオンにしました' : '自動判定をオフにしました。削除済みの要素は復元できます');
    } catch (e) {
      notice(e.message, true);
    }
    await refresh();
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.threshold || changes.globalAutomatic))
      refresh().catch((e) => notice(e.message, true));
  });
}
