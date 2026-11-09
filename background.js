// PCに保存したPDF（file:// のURL）を開いたとき、拡張機能のエディター（viewer.html）で開き直す。
// インターネット上のPDFは扱わない（ブラウザー標準のPDFビューアで開かれる）。
const VIEWER = chrome.runtime.getURL('viewer.html');
const viewerUrl = (u) => `${VIEWER}?file=${encodeURIComponent(u)}`;
function isLocalPdfUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'file:') return false;
    if (x.hash.includes('epa-skip')) return false;      // 「ブラウザーのPDFビューアで開き直す」を選んだとき
    return /\.pdf$/i.test(x.pathname);
  } catch { return false; }
}
chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0 || !isLocalPdfUrl(d.url)) return;
  const { autoOpen = true } = await chrome.storage.local.get('autoOpen');
  if (!autoOpen) return;
  chrome.tabs.update(d.tabId, { url: viewerUrl(d.url) });
}, { url: [{ schemes: ['file'] }] });
// ツールバーのアイコン: 表示中のローカルPDFをエディターで開く。それ以外のページでは、空のエディターを新しいタブで開く
chrome.action.onClicked.addListener((tab) => {
  if (tab.url && /^file:/i.test(tab.url)) chrome.tabs.update(tab.id, { url: viewerUrl(tab.url) });
  else chrome.tabs.create({ url: VIEWER });
});
