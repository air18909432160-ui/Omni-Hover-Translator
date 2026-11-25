import { DEFAULTS, translate, validateText } from './translation-service.js';

const RULE_ID = 1001;
const cache = new Map();
const settingsPorts = new Set();
let historyQueue = Promise.resolve();
let active = 0;
let settingsRevision = 0;
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function settings() {
  await ready;
  return OmniHover.settings.sanitize(await chrome.storage.local.get(DEFAULTS));
}

async function syncRedirect() {
  const { autoRedirect } = await settings();
  const addRules = autoRedirect ? [{
    id: RULE_ID, priority: 1,
    action: {
      type: 'redirect',
      // A fragment preserves the complete original query, including '&' and '%'.
      redirect: { regexSubstitution: `${chrome.runtime.getURL('pdf-viewer.html')}#url=\\0` }
    },
    condition: {
      regexFilter: '^https?://[^?#]+\\.pdf(\\?[^#]*)?$',
      isUrlFilterCaseSensitive: false,
      resourceTypes: ['main_frame'], requestMethods: ['get']
    }
  }] : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules });
}

function openViewer(url = '') {
  let fragment = '';
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol)) fragment = `#url=${url}`;
  } catch { /* Empty viewer offers a file picker and URL form. */ }
  return chrome.tabs.create({ url: `${chrome.runtime.getURL('pdf-viewer.html')}${fragment}` });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'oht-pdf', title: '使用 Omni PDF 阅读器打开链接', contexts: ['link'] });
  });
  syncRedirect().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => syncRedirect().catch(console.error));
let redirectUpdate = Promise.resolve();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some(key => key in DEFAULTS)) return;
  cache.clear();
  settingsRevision++;
  settings().then(config => {
    for (const port of settingsPorts) {
      try { port.postMessage(OmniHover.settings.publicSettings(config)); } catch { settingsPorts.delete(port); }
    }
  }).catch(console.error);
  if (changes.autoRedirect) redirectUpdate = redirectUpdate.then(syncRedirect).catch(console.error);
});
chrome.commands.onCommand.addListener(async command => {
  if (command === 'toggle-translator') {
    const config = await settings(); await chrome.storage.local.set({ enabled: !config.enabled });
  }
});
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'oht-pdf') openViewer(info.linkUrl).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'SET_BUBBLE_SIZE' && _sender.id === chrome.runtime.id) {
    if (!Object.hasOwn(OmniHover.settings.bubbleSizes, message.size)) { respond({ ok: false }); return; }
    chrome.storage.local.set(OmniHover.settings.bubbleSizePatch(message.size))
      .then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (message?.type === 'GET_PUBLIC_SETTINGS' && _sender.id === chrome.runtime.id) {
    settings().then(config => respond({ ok: true, settings: OmniHover.settings.publicSettings(config) }), () => respond({ ok: false }));
    return true;
  }
  if (message?.type === 'CLEAR_HISTORY' && _sender.url?.startsWith(chrome.runtime.getURL(''))) {
    const clear = async () => { await chrome.storage.local.set({ historyEnabled: false, translationHistory: [] }); };
    historyQueue = historyQueue.then(clear, clear);
    historyQueue.then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (message?.type === 'CLEAR_CACHE') {
    cache.clear(); respond({ ok: true }); return;
  }
  if (message?.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage().then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'oht-settings' && port.sender?.id === chrome.runtime.id) {
    settingsPorts.add(port);
    settings().then(config => { if (settingsPorts.has(port)) port.postMessage(OmniHover.settings.publicSettings(config)); }).catch(() => {});
    port.onDisconnect.addListener(() => settingsPorts.delete(port));
    return;
  }
  if (port.name !== 'oht-translation' || port.sender?.id !== chrome.runtime.id) { port.disconnect(); return; }
  const controller = new AbortController();
  let used = false, disconnected = false;
  port.onDisconnect.addListener(() => { disconnected = true; controller.abort(); });
  const send = response => { if (!disconnected) port.postMessage(response); };
  port.onMessage.addListener(async message => {
    if (used) return;
    used = true;
    let timeout, counted = false;
    try {
      if (message?.type !== 'TRANSLATE') throw new Error('未知请求。');
      const text = validateText(message.text);
      const config = await settings();
      // Quick translation can override only languages, never a service or credential.
      if (message.sourceLang && OmniHover.settings.sanitize({ sourceLang: message.sourceLang }).sourceLang === message.sourceLang) config.sourceLang = message.sourceLang;
      if (message.targetLang && OmniHover.settings.sanitize({ targetLang: message.targetLang }).targetLang === message.targetLang) config.targetLang = message.targetLang;
      if (disconnected) return;
      if (config.provider !== 'libre' && !config.apiKey?.trim()) throw new Error('请先在扩展设置中填写 DeepL API Key。');
      const revision = settingsRevision;
      const cacheKey = JSON.stringify([config.provider, config.libreUrl, config.sourceLang, config.targetLang, text]);
      if (config.cacheEnabled && cache.has(cacheKey)) { send({ ok: true, translation: cache.get(cacheKey) }); return; }
      if (active >= 4) throw new Error('翻译请求较多，请稍后重试。');
      active++; counted = true;
      timeout = setTimeout(() => controller.abort(new Error('timeout')), 20000);
      const translation = await translate(text, config, controller.signal);
      if (disconnected) return;
      if (config.cacheEnabled && revision === settingsRevision) cache.set(cacheKey, translation);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      send({ ok: true, translation });
      if (config.historyEnabled) {
        historyQueue = historyQueue.then(async () => {
          const current = await settings();
          if (!current.historyEnabled) return;
          const { translationHistory = [] } = await chrome.storage.local.get('translationHistory');
          const history = [{ text, translation, sourceLang: config.sourceLang, targetLang: config.targetLang, time: Date.now() }, ...translationHistory].slice(0, 100);
          await chrome.storage.local.set({ translationHistory: history });
        }).catch(console.error);
      }
    } catch (error) {
      send({ ok: false, error: controller.signal.aborted ? '翻译超时，请稍后重试。' : error.message || '翻译失败。' });
    } finally {
      clearTimeout(timeout);
      if (counted) active--;
    }
  });
});
