import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { translate, validateText } from '../extension/translation-service.js';

const code = await readFile(new URL('../extension/shared/text-utils.js', import.meta.url), 'utf8');
const sandbox = { Intl }; vm.createContext(sandbox); vm.runInContext(code, sandbox);
const { sentenceAt } = sandbox.OmniHover.text;

test('sentence offsets preserve inline ranges and do not consume next sentence', () => {
  const text = 'First sentence. Second sentence! Third question?';
  const result = sentenceAt(text, text.indexOf('Second') + 2);
  assert.equal(result.text, 'Second sentence!');
  assert.equal(text.slice(result.start, result.end), result.text);
  assert.equal(sentenceAt(text, text.indexOf('Third')).text, 'Third question?');
  assert.equal(sentenceAt(text, 15), null);
  assert.equal(sentenceAt('纯中文内容。', 2).text, '纯中文内容。');
  assert.equal(sentenceAt('これは日本語です。次の文です。', 2).text, 'これは日本語です。');
});

test('English decimal and quoted punctuation are handled', () => {
  assert.equal(sentenceAt('It costs 3.14 dollars. Next.', 11).text, 'It costs 3.14 dollars.');
  assert.equal(sentenceAt('She said “Hello!” Next.', 11).text, 'She said “Hello!”');
  assert.equal(sentenceAt('Dr. Smith works here. Next.', 8).text, 'Dr. Smith works here.');
});

test('soft line breaks stay inside sentences while offsets and paragraph boundaries survive', () => {
  const text = 'A sentence begins here\nand finishes on the next line. Another sentence.';
  for (const offset of [5, text.indexOf('finishes')]) {
    const result = sentenceAt(text, offset);
    assert.equal(result.text, 'A sentence begins here and finishes on the next line.');
    assert.equal(text.slice(result.start, result.end), 'A sentence begins here\nand finishes on the next line.');
  }
  assert.equal(sentenceAt('A trans-\nlation crosses lines.', 12).text, 'A translation crosses lines.');
  assert.equal(sentenceAt('A separate heading\u2029A paragraph begins here.', 24).text, 'A paragraph begins here.');
});

test('request validates lengths, keeps Key in header and encodes text', async () => {
  assert.throws(() => validateText('a'.repeat(2501)));
  assert.throws(() => validateText(''));
  let calls = 0;
  const result = await translate('A & B?', { provider: 'deepl-free', apiKey: ' private-key ' }, undefined, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(init.headers.Authorization, 'DeepL-Auth-Key private-key');
    assert.equal(init.body.get('text'), 'A & B?');
    assert.equal(init.body.get('target_lang'), 'ZH');
    return { ok: true, json: async () => ({ translations: [{ text: '甲和乙？' }] }) };
  });
  assert.equal(calls, 1); assert.equal(result, '甲和乙？');
});

test('missing Key, quota errors, empty responses and aborts propagate', async () => {
  await assert.rejects(translate('Hello', { provider: 'deepl-free' }), /API Key/);
  const settings = { provider: 'deepl-pro', apiKey: 'key' };
  await assert.rejects(translate('Hello', settings, undefined, async () => ({ ok: false, status: 456 })), /额度/);
  await assert.rejects(translate('Hello', settings, undefined, async () => ({ ok: true, json: async () => ({}) })), /空译文/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(translate('Hello', settings, controller.signal, async () => { throw controller.signal.reason; }), { name: 'AbortError' });
});

test('DNR regex keeps signed query strings and avoids viewer subresource loops', async () => {
  const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const literal = background.match(/regexFilter: ('[^\n]+'),/)[1];
  const expression = new RegExp(vm.runInNewContext(literal), 'i');
  const url = 'https://example.test/report.PDF?sig=a%2Bb&expires=42';
  assert.equal(expression.exec(url)[0], url);
  assert.equal(expression.test('https://example.test/download?id=1'), false);
  assert.match(background, /resourceTypes: \['main_frame'\]/);
  assert.match(background, /#url=\\\\0/);
});

test('settings clamp numeric values, preserve legacy credentials and remove secrets from public settings', () => {
  const { sanitize, publicSettings, excluded } = globalThis.OmniHover.settings;
  const settings = sanitize({ apiKey: 'secret', libreKey: 'other-secret', hoverDelay: -1, bubbleOpacity: 999, fontSize: '22', targetLang: 'JA', highlightColor: 'red;invalid', nonsense: 'ignored' });
  assert.equal(settings.hoverDelay, 100); assert.equal(settings.bubbleOpacity, 100); assert.equal(settings.fontSize, 22);
  assert.equal(settings.apiKey, 'secret'); assert.equal(settings.targetLang, 'JA'); assert.equal(settings.highlightColor, '#dfbf56');
  assert.equal(settings.nonsense, undefined);
  assert.equal(publicSettings(settings).apiKey, undefined); assert.equal(publicSettings(settings).libreKey, undefined);
  assert.equal(excluded('sub.example.com', 'example.com\nelsewhere.org'), true);
  assert.equal(excluded('notexample.com', 'example.com'), false);
});

test('auto language omits DeepL source and sends the configured target', async () => {
  await translate('Bonjour.', { provider: 'deepl-free', apiKey: 'key', sourceLang: 'auto', targetLang: 'JA' }, undefined, async (_, request) => {
    assert.equal(request.body.has('source_lang'), false); assert.equal(request.body.get('target_lang'), 'JA');
    assert.equal(request.redirect, 'error');
    return { ok: true, json: async () => ({ translations: [{ text: 'こんにちは。' }] }) };
  });
});

test('LibreTranslate uses its separate credential and validated endpoint', async () => {
  const result = await translate('你好。', { provider: 'libre', libreUrl: 'http://127.0.0.1:5000/translate', libreKey: 'libre-only', apiKey: 'deepl-secret', sourceLang: 'ZH', targetLang: 'EN' }, undefined, async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:5000/translate');
    assert.equal(request.headers.Authorization, undefined);
    const body = JSON.parse(request.body);
    assert.deepEqual(body, { q: '你好。', source: 'zh', target: 'en', format: 'text', api_key: 'libre-only' });
    assert.equal(request.body.includes('deepl-secret'), false);
    return { ok: true, json: async () => ({ translatedText: 'Hello.' }) };
  });
  assert.equal(result, 'Hello.');
  for (const url of ['http://example.test/translate', 'https://user:password@example.test/translate', 'file:///test', 'https://example.test/translate?key=secret']) {
    await assert.rejects(translate('Hello.', { provider: 'libre', libreUrl: url }), /HTTPS|地址/);
  }
});
