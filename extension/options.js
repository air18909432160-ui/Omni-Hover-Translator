const { defaults, languages, sanitize } = OmniHover.settings;
const $ = id => document.getElementById(id);
if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.runtime?.id || !chrome.storage?.local) {
  const status = $('runtime-status');
  status.hidden = false;
  status.style.cssText = 'padding:14px 18px;margin-bottom:20px;border:1px solid #d49a64;border-radius:8px;background:#3b3024;color:#f1d2a8';
  document.querySelectorAll('#settings input, #settings select, #settings button').forEach(control => { control.disabled = true; });
} else {
const aliases = { apiKey: 'key', autoRedirect: 'redirect', hoverDelay: 'hoverSeconds', dismissDelay: 'dismissSeconds' };
const controlFor = key => $(aliases[key] || key);
const keyFor = control => Object.keys(defaults).find(key => controlFor(key) === control);
let saved = sanitize(await chrome.storage.local.get(defaults));
const dirty = new Map();
let serial = 0, saveTimer, saveQueue = Promise.resolve();
for (const id of ['sourceLang', 'targetLang']) {
  if (id === 'sourceLang') $(id).add(new Option('自动检测', 'auto'));
  languages.forEach(([code, name]) => $(id).add(new Option(name, code)));
}
function writeControl(key, value) {
  const control = controlFor(key);
  if (!control) return;
  if (control.type === 'checkbox') control.checked = value;
  else control.value = ['hoverDelay', 'dismissDelay'].includes(key) ? value / 1000 : value;
}
function fill(config) {
  for (const key of Object.keys(defaults)) writeControl(key, config[key]);
  preview();
}
function valueFor(key) {
  const control = controlFor(key);
  let value = control.type === 'checkbox' ? control.checked : control.value;
  if (['hoverDelay', 'dismissDelay'].includes(key)) value = Number(value) * 1000;
  return sanitize({ [key]: value })[key];
}
function read() {
  return sanitize(Object.fromEntries(Object.keys(defaults).map(key => [key, valueFor(key)])));
}
function preview() {
  const config = read();
  $('deepl-fields').hidden = config.provider === 'libre'; $('libre-fields').hidden = config.provider !== 'libre';
  for (const [key, suffix] of Object.entries({ fontSize: 'px', bubbleOpacity: '%', bubbleWidth: 'px', highlightOpacity: '%', ttsRate: '×' })) $(key + '-value').textContent = config[key] + suffix;
  const colors = { forest: ['36,51,47', '#e1e7d4'], night: ['31,35,42', '#dee1e6'], paper: ['232,226,209', '#2f402b'] }[config.bubbleTheme];
  Object.assign($('preview').style, { background: `rgba(${colors[0]},${config.bubbleOpacity / 100})`, color: colors[1], width: `${config.bubbleWidth}px` });
  $('preview').style.padding = OmniHover.settings.bubbleSizes[config.bubbleSize].padding + 'px';
  $('preview-target').style.fontSize = config.fontSize + 'px'; $('preview-source').hidden = !config.showOriginal;
}
fill(saved);
function mark(key) { dirty.set(key, ++serial); }
function save({ explicit = false } = {}) {
  clearTimeout(saveTimer);
  const operation = async () => {
    const invalid = [...dirty.keys()].filter(key => !controlFor(key).checkValidity());
    const entries = [...dirty.entries()].filter(([key]) => !invalid.includes(key));
    if (explicit && invalid.length) {
      controlFor(invalid[0]).reportValidity();
      throw new Error('输入超出允许范围，已保留编辑内容，请修正后保存。');
    }
    if (entries.length) {
      const patch = Object.fromEntries(entries.map(([key]) => [key, valueFor(key)]));
      $('status').textContent = '正在保存…';
      await chrome.storage.local.set(patch);
      const actual = await chrome.storage.local.get(Object.keys(patch));
      for (const [key, revision] of entries) {
        if (dirty.get(key) !== revision) continue;
        if (actual[key] !== patch[key]) throw new Error('设置未能写入，请重试。');
        dirty.delete(key);
      }
      saved = sanitize({ ...saved, ...actual });
    }
    $('status').textContent = invalid.length ? '部分输入无效，未保存该项；其他有效更改已保存。' : dirty.size ? '正在等待保存…' : '已保存 · 修改已自动保存并发送到网页和 PDF。';
  };
  const result = saveQueue.then(operation);
  saveQueue = result.catch(error => { $('status').textContent = `保存失败：${error.message}`; });
  return result;
}
function scheduleSave(control) {
  const key = keyFor(control);
  if (!key) return;
  if (key === 'bubbleSize') {
    for (const [field, value] of Object.entries(OmniHover.settings.bubbleSizePatch(control.value))) {
      writeControl(field, value); mark(field);
    }
  }
  mark(key); preview();
  $('status').textContent = control.checkValidity() ? '正在等待自动保存…' : '此项输入无效，请检查范围；其他设置仍可保存。';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void save().catch(() => {}); }, 250);
}
$('settings').addEventListener('input', event => scheduleSave(event.target));
$('settings').addEventListener('change', event => {
  scheduleSave(event.target);
  if (event.target.checkValidity()) void save().catch(() => {});
});
$('settings').addEventListener('submit', async event => { event.preventDefault(); try { await save({ explicit: true }); } catch { /* The persistent status explains the failure. */ } });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(defaults)) {
    if (!changes[key]) continue;
    const value = sanitize({ [key]: changes[key].newValue })[key];
    saved[key] = value;
    if (!dirty.has(key)) writeControl(key, value);
  }
  preview();
});
window.addEventListener('pagehide', () => { if (dirty.size) void save().catch(() => {}); });
$('swap').addEventListener('click', () => {
  if ($('sourceLang').value === 'auto') { $('status').textContent = '请先选择具体源语言再交换。'; return; }
  const value = $('sourceLang').value; $('sourceLang').value = $('targetLang').value; $('targetLang').value = value;
  mark('sourceLang'); mark('targetLang'); void save().catch(() => {});
});
$('reader').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('pdf-viewer.html') }));
$('test').addEventListener('click', async () => {
  $('test').disabled = true; let port;
  try {
    await save({ explicit: true }); $('connection-status').textContent = '正在测试…';
    port = chrome.runtime.connect({ name: 'oht-translation' });
    const response = await new Promise((resolve, reject) => {
      port.onMessage.addListener(resolve); port.onDisconnect.addListener(() => reject(new Error('连接已断开。')));
      port.postMessage({ type: 'TRANSLATE', text: saved.sourceLang === 'ZH' ? '你好，世界！' : 'Hello, world!' });
    });
    $('connection-status').textContent = response.ok ? `连接成功：${response.translation}` : response.error;
  } catch (error) { $('connection-status').textContent = error.message; }
  finally { port?.disconnect(); $('test').disabled = false; }
});
$('clear-cache').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }); $('status').textContent = '翻译缓存已清空。'; });
$('clear-history').addEventListener('click', async () => { await chrome.storage.local.set({ historyEnabled: false }); await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }); $('historyEnabled').checked = false; dirty.delete('historyEnabled'); $('status').textContent = '全部本地历史已删除，记录功能已关闭。'; });
$('reset').addEventListener('click', () => {
  clearTimeout(saveTimer);
  const config = read(); fill({ ...defaults, provider: config.provider, apiKey: config.apiKey, libreUrl: config.libreUrl, libreKey: config.libreKey });
  for (const key of Object.keys(defaults)) if (!['provider', 'apiKey', 'libreUrl', 'libreKey'].includes(key)) mark(key);
  void save({ explicit: true }).catch(() => {});
});
}
