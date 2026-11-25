import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makePDF } from '../fixture.mjs';

let context, worker, extensionId, server, origin, profile;
const extensionPath = path.resolve(process.env.OHT_EXTENSION_PATH || 'dist');
test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url.startsWith('/sample.pdf')) {
      response.setHeader('Content-Type', 'application/pdf'); response.end(makePDF());
    } else if (request.url.startsWith('/multiline')) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><style>body{padding:40px;font:18px/1.7 Arial;background:#e7e3d5;color:#26372e}p{width:330px;margin:20px 0}.lines{width:500px;margin:22px 0}.lines div{line-height:30px}</style>
        <p id="wrapped">A naturally wrapped sentence continues for several visual lines and must be translated as one complete sentence. Next sentence.</p>
        <p id="break">This sentence starts before<br>the break and ends after it. Next sentence.</p>
        <section class="lines"><div id="line-one">A sentence in separate line containers</div><div id="line-two">continues on this second line.</div></section>
        <p id="newline">Source newlines must not stop\na sentence before its punctuation.</p>
        <section><p>Independent paragraph without punctuation</p><p id="paragraph">Another paragraph remains separate.</p></section><p id="chinese">这是中文句子。另一句内容。</p><p id="japanese">これは日本語です。次の文です。</p>`);
    } else if (request.url.startsWith('/reading')) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><style>body{margin:0;font:20px/1.8 Arial}main{margin-top:1200px;width:480px;padding:24px}p{margin:20px 0}</style><main><p id="reading">Keyboard reading follows the document one sentence at a time, even when the whole sentence starts below the screen. A second sentence follows. A third sentence waits here.</p><input id="typing" aria-label="typing"></main>');
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><style>body{padding:60px;font:20px/2 Arial}p{max-width:680px}</style><p id="text">First <strong>English sentence.</strong> Second English sentence! Third one?</p><p id="other">Move here to dismiss.</p><p id="slow">Slow translation must be cancelled.</p>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(path.join(tmpdir(), 'oht-browser-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.OHT_BROWSER || 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ provider: 'deepl-free', apiKey: 'test-key', autoRedirect: true });
    const nativeFetch = globalThis.fetch;
    globalThis.testCalls = [];
    globalThis.testRequests = [];
    globalThis.testAborts = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://libre.example.test/translate') {
        globalThis.testCalls.push(JSON.parse(init.body).q);
        globalThis.testRequests.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ translatedText: 'Libre 测试译文。' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!String(url).startsWith('https://api-free.deepl.com/')) return nativeFetch(url, init);
      globalThis.testRequests.push({ url, body: Object.fromEntries(init.body) });
      globalThis.testCalls.push(init.body.get('text'));
      if (init.body.get('text').startsWith('Slow')) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 2000);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer); globalThis.testAborts++; reject(init.signal.reason);
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({ translations: [{ text: '这是测试译文。' }] }), { headers: { 'Content-Type': 'application/json' } });
    };
  });
});
test.beforeEach(async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ ...OmniHover.settings.defaults, apiKey: 'test-key', translationHistory: [] });
  });
});
test.afterAll(async () => {
  await context?.close(); await new Promise(resolve => server?.close(resolve));
  if (profile) {
    const resolved = path.resolve(profile);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() || !path.basename(resolved).startsWith('oht-browser-')) throw new Error('Unexpected temporary profile path');
    await rm(resolved, { recursive: true, force: true });
  }
});

test('web debounce, inline sentence range, popup transfer, copy and cleanup', async () => {
  const page = await context.newPage(); await page.goto(origin);
  await page.locator('#text strong').hover();
  await page.waitForTimeout(100);
  await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('First English sentence.');
  await expect(page.locator('[data-oht-ui] .target')).toHaveText('这是测试译文。');
  await page.screenshot({ path: 'test-results/web-hover.png' });
  await expect.poll(() => page.evaluate(() => [...CSS.highlights.values()][0]?.values().next().value.toString())).toBe('First English sentence.');
  await page.locator('[data-oht-ui] button', { hasText: '复制译文' }).hover();
  await page.waitForTimeout(250); await expect(page.locator('[data-oht-ui]')).toHaveCount(1);
  await page.locator('[data-oht-ui] button', { hasText: '复制译文' }).click();
  await expect(page.locator('[data-oht-ui] button', { hasText: '已复制' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
  await page.locator('#text').hover({ position: { x: 280, y: 20 } });
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('Second English sentence!');
  await page.mouse.move(1100, 700); await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await expect(page.locator('#text')).toHaveText('First English sentence. Second English sentence! Third one?');
  await page.close();
});

test('keyboard reading advances and reverses on web, scrolls a full sentence into view, and ignores inputs', async () => {
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#keyboardReading').check();
  await expect.poll(() => worker.evaluate(async () => chrome.storage.local.get('keyboardReading'))).toEqual({ keyboardReading: true });
  await options.close();
  const page = await context.newPage(); await page.setViewportSize({ width: 900, height: 500 }); await page.goto(`${origin}/reading`);
  await page.keyboard.press('Alt+j');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('Keyboard reading follows the document one sentence at a time, even when the whole sentence starts below the screen.');
  const rect = await page.locator('#reading').evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 'Keyboard reading follows the document one sentence at a time, even when the whole sentence starts below the screen.'.length);
    const bounds = range.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom, height: innerHeight };
  });
  expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(rect.height);
  await page.keyboard.press('Alt+j');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('A second sentence follows.');
  await page.keyboard.press('Alt+k');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('Keyboard reading follows the document one sentence at a time, even when the whole sentence starts below the screen.');
  await page.keyboard.press('Escape'); await page.locator('#typing').focus(); await page.keyboard.press('Alt+j');
  await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await page.close();
});

test('keyboard reading steps through PDF sentences and continues to the next page', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ keyboardReading: true }));
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html#url=${origin}/sample.pdf`);
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await page.keyboard.press('Alt+j'); await expect(page.locator('[data-oht-ui] .source')).toHaveText('First PDF sentence.');
  await page.keyboard.press('Alt+j'); await expect(page.locator('[data-oht-ui] .source')).toHaveText('Second PDF sentence!');
  await page.keyboard.press('Alt+j'); await expect(page.locator('[data-oht-ui] .source')).toHaveText('This sentence continues across two PDF lines and must stay together.');
  await page.keyboard.press('Alt+j'); await expect(page.locator('[data-oht-ui] .source')).toHaveText('A hyphenated translation also joins across lines.');
  await page.keyboard.press('Alt+j'); await expect(page.locator('[data-oht-ui] .source')).toHaveText('Another page has selectable English text.');
  await page.keyboard.press('Alt+k'); await expect(page.locator('[data-oht-ui] .source')).toHaveText('A hyphenated translation also joins across lines.');
  await page.close();
});

test('keyboard bubbles hand back to mouse hover and dismiss on web and PDF', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ keyboardReading: true, dismissDelay: 150 }));
  for (const pdf of [false, true]) {
    const page = await context.newPage();
    await page.goto(pdf ? `chrome-extension://${extensionId}/pdf-viewer.html#url=${origin}/sample.pdf` : origin);
    if (pdf) await expect(page.locator('.textLayer span').first()).toBeVisible();
    await page.keyboard.press('Alt+j');
    await expect(page.locator('[data-oht-ui] .source')).toHaveText(pdf ? 'First PDF sentence.' : 'First English sentence.');
    await expect(page.getByRole('button', { name: '固定气泡', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(250);
    await expect(page.locator('[data-oht-ui]')).toHaveCount(1);
    await page.keyboard.press('Alt+j');
    await expect(page.locator('[data-oht-ui] .source')).toHaveText(pdf ? 'Second PDF sentence!' : 'Second English sentence!');
    await hoverWord(page, pdf ? '.pdf-page[data-page="1"] .textLayer' : '#text', 'First');
    await expect(page.locator('[data-oht-ui] .source')).toHaveText(pdf ? 'First PDF sentence.' : 'First English sentence.');
    await page.locator('[data-oht-ui] button', { hasText: '复制译文' }).hover();
    await page.mouse.move(1150, 750);
    await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
    await page.close();
  }
});

test('three bubble sizes persist from settings and from the bubble, apply to web and PDF', async () => {
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#bubbleSize').selectOption('small');
  await expect.poll(() => worker.evaluate(() => chrome.storage.local.get(['bubbleSize', 'bubbleWidth', 'fontSize'])))
    .toEqual({ bubbleSize: 'small', bubbleWidth: 332, fontSize: 14 });
  await expect(options.locator('#preview')).toHaveCSS('padding', '14px');
  const web = await context.newPage(); await web.goto(origin);
  await web.locator('#text strong').hover();
  await expect(web.locator('[data-oht-ui] .panel')).toHaveCSS('width', '332px');
  await expect(web.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '14px');
  await web.getByRole('combobox', { name: '气泡大小', exact: true }).selectOption('large');
  await expect(web.locator('[data-oht-ui] .panel')).toHaveCSS('width', '552px');
  await expect(web.locator('[data-oht-ui] .panel')).toHaveCSS('padding', '24px');
  await expect(web.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '20px');
  await expect(options.locator('#bubbleSize')).toHaveValue('large');
  const pdf = await context.newPage(); await pdf.goto(`chrome-extension://${extensionId}/pdf-viewer.html#url=${origin}/sample.pdf`);
  await expect(pdf.locator('.textLayer span').first()).toBeVisible();
  await hoverWord(pdf, '.pdf-page[data-page="1"] .textLayer', 'First');
  await expect(pdf.locator('[data-oht-ui] .panel')).toHaveCSS('width', '552px');
  await pdf.getByRole('combobox', { name: '气泡大小', exact: true }).selectOption('medium');
  await expect(pdf.locator('[data-oht-ui] .panel')).toHaveCSS('width', '412px');
  await expect(pdf.locator('[data-oht-ui] .panel')).toHaveCSS('padding', '20px');
  await expect(pdf.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '16px');
  await options.reload(); await expect(options.locator('#bubbleSize')).toHaveValue('medium');
  await options.close(); await pdf.close(); await web.close();
});

test('brief hover makes no API request; dismiss aborts pending work and keeps Key outside DOM', async () => {
  const page = await context.newPage(); await page.goto(origin);
  const initial = await worker.evaluate(() => globalThis.testCalls.length);
  await page.locator('#slow').hover({ position: { x: 30, y: 20 } }); await page.waitForTimeout(80);
  await page.mouse.move(1100, 700); await page.waitForTimeout(220);
  expect(await worker.evaluate(() => globalThis.testCalls.length)).toBe(initial);
  await page.locator('#slow').hover({ position: { x: 30, y: 20 } });
  await expect.poll(() => worker.evaluate(() => globalThis.testCalls.length)).toBe(initial + 1);
  await page.mouse.move(1100, 700);
  await expect.poll(() => worker.evaluate(() => globalThis.testAborts)).toBe(1);
  await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('test-key');
  await page.close();
});

async function hoverWord(page, selector, word) {
  const point = await page.locator(selector).evaluate((element, word) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const offset = walker.currentNode.data.indexOf(word);
      if (offset < 0) continue;
      const range = document.createRange(); range.setStart(walker.currentNode, offset); range.setEnd(walker.currentNode, offset + 1);
      const box = range.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    throw new Error(`Missing word ${word}`);
  }, word);
  await page.mouse.move(point.x, point.y);
}

test('web sentences cross wrapped lines, BR, source newlines and simple line containers', async () => {
  const page = await context.newPage(); await page.goto(`${origin}/multiline`);
  const scenarios = [
    ['#wrapped', 'several', 'A naturally wrapped sentence continues for several visual lines and must be translated as one complete sentence.'],
    ['#break', 'after', 'This sentence starts before the break and ends after it.'],
    ['#line-two', 'second', 'A sentence in separate line containers continues on this second line.'],
    ['#newline', 'punctuation', 'Source newlines must not stop a sentence before its punctuation.'],
    ['#paragraph', 'remains', 'Another paragraph remains separate.']
  ];
  for (const [selector, word, sentence] of scenarios) {
    await hoverWord(page, selector, word);
    await expect(page.locator('[data-oht-ui] .source')).toHaveText(sentence);
    await expect(page.locator('[data-oht-ui] .target')).toHaveText('这是测试译文。');
    if (selector === '#wrapped') {
      expect(await page.evaluate(() => {
        const range = [...CSS.highlights.values()][0].values().next().value;
        return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
      })).toBeGreaterThan(1);
      await page.screenshot({ path: 'test-results/web-multiline.png' });
    }
    await page.keyboard.press('Escape');
  }
  await page.close();
});

test('PDF sentences join both lines and hyphenated words; reading themes persist', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html#url=${origin}/sample.pdf`);
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await hoverWord(page, '.pdf-page[data-page="1"] .textLayer', 'two PDF');
  const sentence = 'This sentence continues across two PDF lines and must stay together.';
  await expect(page.locator('[data-oht-ui] .source')).toHaveText(sentence);
  await expect(page.locator('[data-oht-ui] .target')).toHaveText('这是测试译文。');
  expect(await page.evaluate(() => {
    const range = [...CSS.highlights.values()][0].values().next().value;
    return new Set([...range.getClientRects()].filter(rect => rect.width).map(rect => Math.round(rect.top))).size;
  })).toBeGreaterThan(1);
  const count = await worker.evaluate(() => globalThis.testCalls.length);
  await hoverWord(page, '.pdf-page[data-page="1"] .textLayer', 'continues');
  await page.waitForTimeout(250);
  expect(await worker.evaluate(() => globalThis.testCalls.length)).toBe(count);
  await page.screenshot({ path: 'test-results/pdf-multiline-comfort.png' });
  await page.keyboard.press('Escape');
  await hoverWord(page, '.pdf-page[data-page="1"] .textLayer', 'lation also');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('A hyphenated translation also joins across lines.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#reading-theme')).toHaveValue('comfort');
  await page.locator('#reading-theme').selectOption('night');
  await expect(page.locator('html')).toHaveAttribute('data-reading-theme', 'night');
  await page.screenshot({ path: 'test-results/pdf-night.png' });
  await page.reload();
  await expect(page.locator('#reading-theme')).toHaveValue('night');
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await hoverWord(page, '.pdf-page[data-page="1"] .textLayer', 'two PDF');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText(sentence);
  await page.keyboard.press('Escape');
  await page.locator('#reading-theme').selectOption('original');
  await expect(page.locator('.pdf-page canvas').first()).toHaveCSS('filter', 'none');
  await page.locator('#reading-theme').selectOption('comfort');
  await page.close();
});

test('PDF real DNR redirect, text layer hover, outline, zoom and file picker', async () => {
  await expect.poll(() => worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)).toBe(1);
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const pdfURL = `${origin}/sample.pdf?sig=a%2Bb&expires=42`;
  await page.goto(pdfURL);
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/pdf-viewer.html#url=${pdfURL}`);
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await expect(page.locator('#page-count')).toHaveText('/ 2');
  const span = page.locator('.pdf-page[data-page="1"] .textLayer span').first();
  await span.hover({ position: { x: 35, y: 8 } });
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('First PDF sentence.');
  await expect(page.locator('[data-oht-ui] .target')).toHaveText('这是测试译文。');
  await page.screenshot({ path: 'test-results/pdf-hover.png' });
  await page.evaluate(() => {
    window.testSpoken = [];
    speechSynthesis.speak = utterance => window.testSpoken.push([utterance.text, utterance.lang]);
    speechSynthesis.cancel = () => {};
  });
  await page.getByRole('button', { name: '朗读原文' }).click();
  await page.getByRole('button', { name: '朗读译文' }).click();
  expect(await page.evaluate(() => window.testSpoken)).toEqual([['First PDF sentence.', 'en-US'], ['这是测试译文。', 'zh-CN']]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Second chapter' }).click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.locator('#zoom-in').click(); await expect(page.locator('#zoom')).toHaveText('125%');
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeVisible();
  await page.locator('#page-number').fill('1'); await page.locator('#page-number').press('Enter');
  await expect(page.locator('#page-number')).toHaveValue('1');
  await page.locator('#file').setInputFiles({ name: 'local.pdf', mimeType: 'application/pdf', buffer: makePDF() });
  await expect(page).toHaveTitle('local.pdf · Omni PDF');
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/pdf-reader.png', fullPage: true });
  await page.close();
});

test('settings persist and disabling redirects removes the dynamic rule', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#key')).toHaveValue('test-key');
  await page.locator('#redirect').uncheck(); await page.getByRole('button', { name: '保存设置' }).click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)).toBe(0);
  await page.locator('#test').click(); await expect(page.locator('#connection-status')).toHaveText('连接成功：这是测试译文。');
  await page.close();
});

test('settings UI changes delay, languages and bubble appearance on an already-open webpage', async () => {
  const page = await context.newPage(); await page.goto(origin);
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#sourceLang').selectOption('auto'); await options.locator('#targetLang').selectOption('JA');
  await options.locator('#hoverSeconds').fill('0.6');
  await options.locator('#bubbleTheme').selectOption('paper');
  await options.locator('#bubbleOpacity').fill('55'); await options.locator('#fontSize').fill('22'); await options.locator('#bubbleWidth').fill('500');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(options.locator('#status')).toContainText('已保存');
  const publicConfig = await options.evaluate(() => new Promise(resolve => {
    const port = chrome.runtime.connect({ name: 'oht-settings' });
    port.onMessage.addListener(config => { resolve(config); port.disconnect(); });
  }));
  expect(publicConfig.apiKey).toBeUndefined(); expect(publicConfig.libreKey).toBeUndefined();
  expect(publicConfig.hoverDelay).toBe(600);
  await page.bringToFront(); await page.locator('#text strong').hover();
  await page.waitForTimeout(280); await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await expect(page.locator('[data-oht-ui] .target')).toHaveText('这是测试译文。');
  await expect(page.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '22px');
  await expect(page.locator('[data-oht-ui] .panel')).toHaveCSS('background-color', 'rgba(232, 226, 209, 0.55)');
  await expect(page.locator('[data-oht-ui] .panel')).toHaveCSS('width', '500px');
  await expect(page.locator('[data-oht-ui] .badge')).toHaveText('自动检测 → 日语');
  const request = await worker.evaluate(() => globalThis.testRequests.at(-1));
  expect(request.body.target_lang).toBe('JA'); expect(request.body.source_lang).toBeUndefined();
  await page.screenshot({ path: 'test-results/custom-bubble.png' });
  await options.bringToFront();
  await options.locator('#sourceLang').selectOption('ZH'); await options.locator('#targetLang').selectOption('EN');
  await options.locator('#swap').click(); await expect(options.locator('#sourceLang')).toHaveValue('EN'); await expect(options.locator('#targetLang')).toHaveValue('ZH');
  await options.screenshot({ path: 'test-results/settings.png', fullPage: true });
  await options.close(); await page.close();
});

test('modifier trigger, pinning, pause and excluded sites take effect live', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ modifier: 'alt', selectionTranslation: false, dismissDelay: 100 }));
  const page = await context.newPage(); await page.goto(origin);
  await page.locator('#text strong').hover(); await page.waitForTimeout(350);
  await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await page.keyboard.down('Alt'); await page.mouse.move(130, 107);
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('First English sentence.');
  await page.getByRole('button', { name: '固定气泡', exact: true }).click();
  await page.keyboard.up('Alt'); await page.mouse.move(1100, 700); await page.waitForTimeout(300);
  await expect(page.locator('[data-oht-ui]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await worker.evaluate(() => chrome.storage.local.set({ modifier: 'none', enabled: false }));
  await page.locator('#text strong').hover(); await page.waitForTimeout(350); await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await worker.evaluate(() => chrome.storage.local.set({ enabled: true, excludedHosts: '127.0.0.1' }));
  await page.mouse.move(1100, 700); await page.locator('#text strong').hover(); await page.waitForTimeout(350); await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await page.close();
});

test('selection translation and paragraph mode capture the intended range', async () => {
  const page = await context.newPage(); await page.goto(`${origin}/multiline`);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#paragraph'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.querySelector('#paragraph').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('Another paragraph remains separate.');
  await expect(page.getByRole('button', { name: '取消固定' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await worker.evaluate(() => chrome.storage.local.set({ captureMode: 'paragraph', highlightEnabled: false, showOriginal: false }));
  await page.evaluate(() => getSelection().removeAllRanges());
  await hoverWord(page, '#wrapped', 'several');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('A naturally wrapped sentence continues for several visual lines and must be translated as one complete sentence. Next sentence.');
  await expect(page.locator('[data-oht-ui] .source')).toBeHidden();
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
  await page.close();
});

test('quick translation, cache languages, Libre service and optional local history', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.setViewportSize({ width: 388, height: 720 });
  const initial = await worker.evaluate(() => globalThis.testCalls.length);
  await page.locator('#text').fill('A unique quick translation.'); await page.locator('#translate').click();
  await expect(page.locator('#result')).toHaveText('这是测试译文。');
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('translationHistory')).translationHistory)).toEqual([]);
  await page.locator('#translate').click(); await expect(page.locator('#result')).toHaveText('这是测试译文。');
  expect(await worker.evaluate(() => globalThis.testCalls.length)).toBe(initial + 1);
  await page.locator('#targetLang').selectOption('JA'); await page.locator('#translate').click(); await expect(page.locator('#result')).toHaveText('这是测试译文。');
  expect(await worker.evaluate(() => globalThis.testCalls.length)).toBe(initial + 2);
  await worker.evaluate(() => chrome.storage.local.set({ historyEnabled: true, provider: 'libre', libreUrl: 'https://libre.example.test/translate', libreKey: 'libre-test-key' }));
  await page.locator('#translate').click(); await expect(page.locator('#result')).toHaveText('Libre 测试译文。');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('translationHistory')).translationHistory.length)).toBe(1);
  const history = await worker.evaluate(async () => (await chrome.storage.local.get('translationHistory')).translationHistory);
  expect(JSON.stringify(history)).not.toContain('key');
  const request = await worker.evaluate(() => globalThis.testRequests.at(-1));
  expect(request.body.api_key).toBe('libre-test-key'); expect(request.body.target).toBe('ja');
  await page.locator('#history-toggle').click(); await expect(page.locator('.history-item')).toHaveCount(1);
  await page.locator('#clear-history').click(); await expect(page.locator('#history-items')).toContainText('默认关闭');
  await page.screenshot({ path: 'test-results/quick-translate.png' });
  await page.close();
});

test('Chinese and Japanese hover use the selected language; PDF preferences update live', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ sourceLang: 'ZH', targetLang: 'EN', hoverDelay: 400 }));
  const page = await context.newPage(); await page.goto(`${origin}/multiline`);
  await hoverWord(page, '#chinese', '中文');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('这是中文句子。');
  await expect(page.locator('[data-oht-ui] .badge')).toHaveText('中文 → 英语');
  let request = await worker.evaluate(() => globalThis.testRequests.at(-1)); expect(request.body.source_lang).toBe('ZH'); expect(request.body.target_lang).toBe('EN');
  await worker.evaluate(() => chrome.storage.local.set({ sourceLang: 'JA' }));
  await hoverWord(page, '#japanese', '日本語');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('これは日本語です。');
  await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html#url=${origin}/sample.pdf`);
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await worker.evaluate(() => chrome.storage.local.set({ sourceLang: 'EN', targetLang: 'FR', bubbleOpacity: 70, fontSize: 20, readingTheme: 'night' }));
  await expect(page.locator('html')).toHaveAttribute('data-reading-theme', 'night');
  await hoverWord(page, '.pdf-page[data-page="1"] .textLayer', 'First');
  await expect(page.locator('[data-oht-ui] .badge')).toHaveText('英语 → 法语');
  await expect(page.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '20px');
  await expect(page.locator('[data-oht-ui] .panel')).toHaveCSS('background-color', 'rgba(36, 51, 47, 0.7)');
  await worker.evaluate(() => chrome.storage.local.set({ pdfEnabled: false }));
  await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await page.close();
});

test('reset keeps credentials and invalid hover delay is rejected by settings form', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('#hoverSeconds').fill('9');
  expect(await page.locator('#hoverSeconds').evaluate(node => node.checkValidity())).toBe(false);
  await page.locator('#fontSize').fill('24');
  await page.locator('#reset').click();
  await expect(page.locator('#hoverSeconds')).toHaveValue('0.2'); await expect(page.locator('#fontSize')).toHaveValue('16');
  await expect(page.locator('#key')).toHaveValue('test-key');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(page.locator('#status')).toContainText('已保存');
  await page.reload(); await expect(page.locator('#fontSize')).toHaveValue('16'); await expect(page.locator('#key')).toHaveValue('test-key');
  await page.close();
});

test('regression: preference changes persist without a separate save click', async () => {
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#hoverSeconds').fill('0.8');
  await options.locator('#bubbleOpacity').fill('51');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('bubbleOpacity')).bubbleOpacity)).toBe(51);
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('hoverDelay')).hoverDelay)).toBe(800);
  await options.reload(); await expect(options.locator('#hoverSeconds')).toHaveValue('0.8');
  await expect(options.locator('#bubbleOpacity')).toHaveValue('51'); await options.close();
});

test('regression: an older settings tab cannot overwrite newer language and pause changes', async () => {
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator('#targetLang')).toHaveValue('ZH');
  await worker.evaluate(() => chrome.storage.local.set({ targetLang: 'JA', enabled: false }));
  await options.locator('#bubbleOpacity').fill('63');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  const saved = await worker.evaluate(() => chrome.storage.local.get(['targetLang', 'enabled', 'bubbleOpacity']));
  expect(saved).toEqual({ targetLang: 'JA', enabled: false, bubbleOpacity: 63 });
  await options.close();
});

test('regression: autosave updates web and PDF without the save button or reload', async () => {
  const web = await context.newPage(); await web.goto(origin);
  const pdfPage = await context.newPage(); await pdfPage.goto(`chrome-extension://${extensionId}/pdf-viewer.html#url=${origin}/sample.pdf`);
  await expect(pdfPage.locator('.textLayer span').first()).toBeVisible();
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#targetLang').selectOption('FR'); await options.locator('#hoverSeconds').fill('0.9');
  await options.locator('#bubbleOpacity').fill('48'); await options.locator('#fontSize').fill('23');
  await options.locator('#readingTheme').selectOption('night');
  await expect(options.locator('#status')).toContainText('已保存');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('fontSize')).fontSize)).toBe(23);
  await web.bringToFront(); await web.locator('#text strong').hover();
  await web.waitForTimeout(400); await expect(web.locator('[data-oht-ui]')).toHaveCount(0);
  await expect(web.locator('[data-oht-ui] .badge')).toHaveText('英语 → 法语');
  await expect(web.locator('[data-oht-ui] .panel')).toHaveCSS('background-color', 'rgba(36, 51, 47, 0.48)');
  await expect(web.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '23px');
  await pdfPage.bringToFront(); await expect(pdfPage.locator('html')).toHaveAttribute('data-reading-theme', 'night');
  await hoverWord(pdfPage, '.pdf-page[data-page="1"] .textLayer', 'First');
  await expect(pdfPage.locator('[data-oht-ui] .badge')).toHaveText('英语 → 法语');
  await expect(pdfPage.locator('[data-oht-ui] .panel')).toHaveCSS('background-color', 'rgba(36, 51, 47, 0.48)');
  await expect(pdfPage.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '23px');
  await options.close(); await pdfPage.close(); await web.close();
});

test('regression: invalid waiting time does not block a valid opacity autosave', async () => {
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#hoverSeconds').fill('9'); await options.locator('#bubbleOpacity').fill('58');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('bubbleOpacity')).bubbleOpacity)).toBe(58);
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('hoverDelay')).hoverDelay)).toBe(200);
  await expect(options.locator('#status')).toContainText('部分输入无效');
  await options.locator('#hoverSeconds').fill('1.2');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('hoverDelay')).hoverDelay)).toBe(1200);
  await expect(options.locator('#status')).toContainText('已保存'); await options.close();
});

test('regression: one-shot settings snapshots never expose credentials', async () => {
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await worker.evaluate(() => chrome.storage.local.set({ apiKey: 'private-deepl', libreKey: 'private-libre', hoverDelay: 1300, enabled: false }));
  const response = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PUBLIC_SETTINGS' }));
  expect(response.ok).toBe(true); expect(response.settings.hoverDelay).toBe(1300); expect(response.settings.enabled).toBe(false);
  expect(response.settings.apiKey).toBeUndefined(); expect(response.settings.libreKey).toBeUndefined();
  expect(JSON.stringify(response)).not.toContain('private-'); await options.close();
});

test('regression: opening settings as a local HTML file clearly reports it is not connected', async () => {
  const page = await context.newPage();
  await page.goto(pathToFileURL(path.join(extensionPath, 'options.html')).href);
  await expect(page.locator('#runtime-status')).toBeVisible();
  await expect(page.locator('#runtime-status')).toContainText('未在扩展中运行');
  await expect(page.locator('#fontSize')).toBeDisabled();
  await page.close();
});

test('regression: PDF hover works when browser caret hit testing cannot see the text layer', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html#url=${origin}/sample.pdf`);
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await page.evaluate(() => {
    document.caretPositionFromPoint = () => null;
    document.caretRangeFromPoint = () => null;
  });
  await hoverWord(page, '.pdf-page[data-page="1"] .textLayer', 'First');
  await expect(page.locator('[data-oht-ui] .source')).toHaveText('First PDF sentence.');
  await page.close();
});

test('regression: settings recover after the background worker is restarted', async () => {
  const page = await context.newPage(); await page.goto(origin);
  await page.locator('#text strong').hover(); await expect(page.locator('[data-oht-ui] .target')).toHaveText('这是测试译文。');
  await page.keyboard.press('Escape');
  const session = await context.newCDPSession(page);
  const versions = new Map();
  session.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
  await session.send('ServiceWorker.enable');
  await expect.poll(() => [...versions.values()].find(item => item.scriptURL === worker.url())?.versionId).toBeTruthy();
  const versionId = [...versions.values()].find(item => item.scriptURL === worker.url()).versionId;
  await session.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(() => versions.get(versionId)?.runningStatus).toBe('stopped');
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PUBLIC_SETTINGS' }));
  worker = context.serviceWorkers().find(item => item.url() === `chrome-extension://${extensionId}/background.js`) || await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, request) => String(url).startsWith('https://api-free.deepl.com/') ? new Response(JSON.stringify({ translations: [{ text: '后台重启后的测试译文。' }] })) : nativeFetch(url, request);
    await chrome.storage.local.set({ hoverDelay: 700, bubbleOpacity: 61, fontSize: 21, targetLang: 'DE' });
  });
  await page.bringToFront(); await page.mouse.move(1100, 700); await page.locator('#text strong').hover();
  await page.waitForTimeout(300); await expect(page.locator('[data-oht-ui]')).toHaveCount(0);
  await expect(page.locator('[data-oht-ui] .target')).toHaveText('后台重启后的测试译文。');
  await expect(page.locator('[data-oht-ui] .panel')).toHaveCSS('background-color', 'rgba(36, 51, 47, 0.61)');
  await expect(page.locator('[data-oht-ui] .target')).toHaveCSS('font-size', '21px');
  await expect(page.locator('[data-oht-ui] .badge')).toHaveText('英语 → 德语');
  await session.detach(); await options.close(); await page.close();
});
