const { defaults, sanitize, languages } = OmniHover.settings;
const $ = id => document.getElementById(id);
let config = sanitize(await chrome.storage.local.get(defaults)), translation = '', port, requestSettings;
for (const id of ['sourceLang', 'targetLang']) {
  if (id === 'sourceLang') $(id).add(new Option('自动检测', 'auto'));
  languages.forEach(([code, name]) => $(id).add(new Option(name, code)));
  $(id).value = config[id];
  $(id).addEventListener('change', async () => {
    await chrome.storage.local.set({ [id]: $(id).value });
    $('status').textContent = '语言已同步到网页和 PDF。';
  });
}
$('enabled').checked = config.enabled;
$('provider-label').textContent = ({ 'deepl-free': 'DeepL Free', 'deepl-pro': 'DeepL Pro', libre: 'LibreTranslate' })[config.provider];
$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('reader').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('pdf-viewer.html') }));
$('swap').addEventListener('click', async () => {
  if ($('sourceLang').value === 'auto') { $('status').textContent = '请先选择具体源语言。'; return; }
  const previous = $('sourceLang').value; $('sourceLang').value = $('targetLang').value; $('targetLang').value = previous;
  await chrome.storage.local.set({ sourceLang: $('sourceLang').value, targetLang: $('targetLang').value });
  $('status').textContent = '语言已交换并保存。';
});
$('quick-form').addEventListener('submit', event => {
  event.preventDefault(); port?.disconnect(); translation = ''; $('copy').disabled = true;
  $('result').textContent = '正在翻译…'; $('translate').disabled = true;
  const request = chrome.runtime.connect({ name: 'oht-translation' }); port = request;
  requestSettings = { sourceLang: $('sourceLang').value, targetLang: $('targetLang').value, provider: config.provider };
  request.onMessage.addListener(response => {
    if (port !== request) return;
    translation = response.ok ? response.translation : '';
    $('result').textContent = response.ok ? translation : response.error;
    $('copy').disabled = !response.ok; $('translate').disabled = false;
    port = null; request.disconnect();
  });
  request.onDisconnect.addListener(() => {
    if (port !== request) return;
    port = null; $('result').textContent = '连接已断开，请重试。'; $('translate').disabled = false;
  });
  request.postMessage({ type: 'TRANSLATE', text: $('text').value, sourceLang: $('sourceLang').value, targetLang: $('targetLang').value });
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(translation); $('status').textContent = '译文已复制。'; }
  catch { $('status').textContent = '复制失败，请检查浏览器权限。'; }
});
async function showHistory() {
  const { translationHistory = [], historyEnabled = false } = await chrome.storage.local.get(['translationHistory', 'historyEnabled']);
  const container = $('history-items'); container.replaceChildren();
  if (!translationHistory.length) { container.textContent = historyEnabled ? '还没有翻译记录。' : '历史记录默认关闭，可在完整设置中开启。'; return; }
  for (const item of translationHistory.slice(0, 20)) {
    const button = document.createElement('button'); button.className = 'history-item';
    const source = document.createElement('span'); source.textContent = item.text;
    const target = document.createElement('span'); target.textContent = item.translation;
    button.append(source, target);
    button.addEventListener('click', () => { $('text').value = item.text; translation = item.translation; $('result').textContent = item.translation; $('copy').disabled = false; });
    container.append(button);
  }
}
$('history-toggle').addEventListener('click', () => {
  $('history').hidden = !$('history').hidden;
  $('history-toggle').setAttribute('aria-expanded', String(!$('history').hidden));
  if (!$('history').hidden) void showHistory();
});
$('clear-history').addEventListener('click', async () => {
  await chrome.storage.local.set({ historyEnabled: false });
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  await showHistory(); $('status').textContent = '历史已清空，记录已关闭。';
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  config = sanitize({ ...config, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.newValue])) });
  $('provider-label').textContent = ({ 'deepl-free': 'DeepL Free', 'deepl-pro': 'DeepL Pro', libre: 'LibreTranslate' })[config.provider];
  if (port && (['sourceLang', 'targetLang', 'provider'].some(key => changes[key] && changes[key].newValue !== requestSettings[key]) || changes.apiKey || changes.libreKey || changes.libreUrl)) {
    const previous = port; port = null; previous.disconnect();
    $('translate').disabled = false; $('result').textContent = '配置已更新，请重新翻译。';
  }
  if (changes.enabled) $('enabled').checked = changes.enabled.newValue;
  for (const key of ['sourceLang', 'targetLang']) if (changes[key]) $(key).value = changes[key].newValue;
  if (changes.translationHistory && !$('history').hidden) void showHistory();
});
window.addEventListener('pagehide', () => port?.disconnect());
