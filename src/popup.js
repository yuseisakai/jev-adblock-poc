import { $, send, notice, describe } from './ui.js';
import { DEFAULT_POLICY, originOf, patternFor, supportedPage } from './core.js';
let tab, origin, policy = { ...DEFAULT_POLICY };
async function page(message) { return chrome.tabs.sendMessage(tab.id, message, { frameId: 0 }); }
async function render() {
  const settings = await send({ type: 'GET_SETTINGS' });
  policy = { ...DEFAULT_POLICY, ...settings.policies[origin], ...(settings.globalAutomatic ? { enabled: true, automatic: true, mode: 'remove' } : {}) };
  $('toggle').textContent = 'このページを判定・広告を削除';
  $('toggle').disabled = !origin || !settings.hasKey;
  $('mode').value = policy.mode;
  $('thresholdInfo').textContent = `広告確率${Math.round(policy.threshold * 100)}%以上の要素を削除します。`;
  $('automatic').checked = Boolean(settings.globalAutomatic);
  $('automatic').disabled = false;
  $('mode').disabled = !origin || Boolean(settings.globalAutomatic);
  let s;
  try { s = await page({ type: 'PAGE_STATUS' }); } catch { /* not enabled yet */ }
  $('tested').textContent = s?.tested || 0; $('removed').textContent = s?.removed || 0;
  $('status').textContent = !settings.hasKey ? describe('missing_key') : describe(s?.status || 'off');
  if (settings.hasKey && s?.status === 'ready' && s.records?.length && !s.removed && s.records.every(d => d.probability < policy.threshold)) $('status').textContent = `判定完了：広告確率が削除閾値${Math.round(policy.threshold * 100)}%未満のため、削除していません。`;
  $('undo').disabled = $('undoAll').disabled = !s?.removed;
  $('rescan').disabled = !origin || !policy.enabled || !settings.hasKey;
  $('decisions').replaceChildren();
  for (const d of s?.records || []) {
    const row = document.createElement('div'); row.className = 'decision';
    const label = document.createElement('span'), score = document.createElement('span');
    label.textContent = d.label || '広告候補'; score.textContent = `${Math.round(d.probability * 100)}%`;
    row.append(label, score); $('decisions').append(row);
  }
}
async function save(enabled, mode, automatic = false) {
  await send({ type: 'SET_POLICY', origin, update: { enabled, mode, automatic, threshold: policy.threshold } });
  await render();
}
$('toggle').onclick = async () => {
  try {
    if (!policy.enabled && !await chrome.permissions.request({ origins: [patternFor(origin)] })) { notice('サイトへのアクセスが許可されませんでした', true); return; }
    $('toggle').disabled = true;
    await save(true, 'remove');
    const result = await page({ type: 'RESCAN' });
    if (!result?.ok) throw Error(describe(result?.error));
    notice('Jevによる広告判定を開始しました');
  } catch (e) { notice(e.message, true); } finally { $('toggle').disabled = false; }
};
$('automatic').onchange = async () => {
  const automatic = $('automatic').checked;
  $('automatic').disabled = true;
  try {
    if (automatic && !await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })) throw Error('すべてのサイトへのアクセスが許可されませんでした');
    await send({ type: 'SET_GLOBAL', enabled: automatic });
    await render();
    notice(automatic ? '全サイトで常時オンにしました。新しく開くサイトでも自動実行します' : '手動実行に戻しました');
  } catch (e) { notice(e.message, true); await render(); }
};
$('mode').onchange = async () => { try { await save(policy.enabled, $('mode').value); notice('次の再スキャンに適用します'); } catch (e) { notice(e.message, true); } };
for (const [id, all] of [['undo', false], ['undoAll', true]]) $(id).onclick = async () => {
  try { const r = await page({ type: 'RESTORE', all }); notice(r.failed ? describe('restore_failed') : `${r.restored}件を復元しました`, !!r.failed); await render(); } catch { notice('ページを再読み込みしてください', true); }
};
$('rescan').onclick = async () => { try { const result = await page({ type: 'RESCAN' }); if (!result?.ok) throw Error(describe(result?.error)); notice('選択したモードで再スキャンしました（1回50候補まで）'); } catch { notice('ページを再読み込みしてください', true); } };
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.globalAutomatic) render().catch(e => notice(e.message, true));
});
$('settings').onclick = () => chrome.runtime.openOptionsPage();
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); origin = supportedPage(tab?.url) ? originOf(tab.url) : null;
  $('origin').textContent = origin || 'このページでは利用できません';
  await render(); setInterval(() => render().catch(() => {}), 1500);
} catch { notice('サイト情報を取得できませんでした', true); }
