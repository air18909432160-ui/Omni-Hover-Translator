import './shared/settings.js';
export const DEFAULTS = globalThis.OmniHover.settings.defaults;
export const ENDPOINTS = Object.freeze({
  'deepl-free': 'https://api-free.deepl.com/v2/translate',
  'deepl-pro': 'https://api.deepl.com/v2/translate'
});

export function validateText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2500) {
    throw new Error('请输入或选择不超过 2500 字符的文字。');
  }
  return text.trim();
}

export async function translate(text, settings, signal, fetcher = fetch) {
  text = validateText(text);
  settings = globalThis.OmniHover.settings.sanitize(settings);
  let endpoint = ENDPOINTS[settings.provider];
  const libre = settings.provider === 'libre';
  if (libre) {
    let url;
    try { url = new URL(settings.libreUrl); } catch { throw new Error('请填写 LibreTranslate 服务的完整 /translate 地址。'); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash || url.search) {
      throw new Error('LibreTranslate 需要 HTTPS 地址；本机 localhost 可使用 HTTP。地址不要包含密码或查询参数。');
    }
    endpoint = url.href;
  }
  if (!endpoint) throw new Error('请选择有效的翻译服务。');
  const key = settings.apiKey?.trim();
  if (!libre && !key) throw new Error('请先在扩展设置中填写 DeepL API Key。');
  const body = new URLSearchParams({ text, target_lang: settings.targetLang });
  if (settings.sourceLang !== 'auto') body.set('source_lang', settings.sourceLang);
  const libreBody = { q: text, source: settings.sourceLang.toLowerCase(), target: settings.targetLang.toLowerCase(), format: 'text' };
  if (settings.libreKey.trim()) libreBody.api_key = settings.libreKey.trim();
  let response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: libre ? { 'Content-Type': 'application/json' } : { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: libre ? JSON.stringify(libreBody) : body,
      redirect: 'error',
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接翻译服务，请检查网络和服务地址。');
  }
  if (!response.ok) {
    const errors = { 403: 'API Key 无效，或 Free / Pro 服务类型不匹配。', 429: '请求过于频繁，请稍后重试。', 456: 'DeepL 翻译额度已用尽。' };
    throw new Error(errors[response.status] || `翻译服务返回错误（${response.status}）。请检查语言支持与配置。`);
  }
  const data = await response.json();
  const result = libre ? data.translatedText : data.translations?.[0]?.text;
  if (typeof result !== 'string' || !result.trim()) throw new Error('翻译服务返回了空译文。');
  return result;
}
