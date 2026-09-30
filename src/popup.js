import { $, send, notice, describe } from './ui.js';
import { supportedPage } from './core.js';
import { bindShared, renderShared } from './settings-ui.js';
let tab,
  supported = false,
  busy = false;
async function page(message) {
  return chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
}
async function render() {
  const s = await send({ type: 'GET_SETTINGS' });
  renderShared(s);
  $('toggle').disabled = busy || !supported;
  $('mode').disabled = s.globalAutomatic;
  $('toggle').textContent =
    !s.globalAutomatic && $('mode').value === 'diagnostic' ? '判定だけ実行' : '広告を削除';
  let state;
  try {
    state = await page({ type: 'PAGE_STATUS' });
  } catch {
    /* No scan on this document yet. */
  }
  $('tested').textContent = state?.tested || 0;
  $('removed').textContent = state?.removed || 0;
  $('status').textContent = !s.hasKey ? describe('missing_key') : describe(state?.status || 'off');
  $('undo').disabled = $('undoAll').disabled = !state?.removed;
  $('decisions').replaceChildren();
  for (const d of state?.records || []) {
    const row = document.createElement('div');
    row.className = 'decision';
    const label = document.createElement('span'),
      score = document.createElement('span');
    label.textContent = d.label || '広告候補';
    score.textContent = `${Math.round(d.probability * 100)}%`;
    row.append(label, score);
    $('decisions').append(row);
  }
}
$('toggle').onclick = async () => {
  if (busy || !supported) return;
  busy = true;
  try {
    const s = await send({ type: 'GET_SETTINGS' });
    if (!s.hasKey) throw Error(describe('missing_key'));
    $('toggle').disabled = true;
    await send({ type: 'SET_PAGE', tabId: tab.id, mode: s.globalAutomatic ? 'remove' : $('mode').value });
    const result = await page({ type: 'RESCAN' });
    if (!result?.ok) throw Error(describe(result?.error));
    notice('このページの判定を開始しました');
  } catch (e) {
    notice(e.message, true);
  } finally {
    busy = false;
    await render();
  }
};
for (const [id, all] of [
  ['undo', false],
  ['undoAll', true]
])
  $(id).onclick = async () => {
    try {
      const r = await page({ type: 'RESTORE', all });
      notice(r.failed ? describe('restore_failed') : `${r.restored}件を復元しました`, !!r.failed);
      await render();
    } catch {
      notice('ページを再読み込みしてください', true);
    }
  };
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('mode').onchange = () => render();
bindShared(render);
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  supported = supportedPage(tab?.url);
  $('origin').textContent = supported ? new URL(tab.url).hostname : 'このページでは利用できません';
  await render();
  setInterval(() => render().catch(() => {}), 1500);
} catch {
  notice('ページ情報を取得できませんでした', true);
}
