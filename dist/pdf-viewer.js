import * as pdfjsLib from './vendor/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');
const $ = id => document.getElementById(id);
const core = new OmniHover.TranslatorCore();
const viewport = $('viewport');
let documentTask, pdf, records = [], zoom = 1, generation = 0, openSequence = 0;
let renderQueue = Promise.resolve(), observer, pageObserver;
const visible = new Map();
const report = message => { $('status').textContent = message; };
const themes = new Set(['comfort', 'night', 'original']);
function applyTheme(theme) {
  const value = themes.has(theme) ? theme : 'comfort';
  document.documentElement.dataset.readingTheme = value;
  $('reading-theme').value = value;
}
chrome.storage.local.get({ readingTheme: 'comfort' }).then(({ readingTheme }) => applyTheme(readingTheme));
core.onConfig = config => {
  applyTheme(config.readingTheme);
  document.querySelector('.footer-hint').textContent = config.keyboardReading
    ? 'Alt+J 下一句 · Alt+K 上一句 · Esc 收起翻译'
    : `Esc 收起 · 悬停 ${(config.hoverDelay / 1000).toFixed(1)}s`;
};
$('reading-theme').addEventListener('change', () => {
  const value = $('reading-theme').value;
  applyTheme(value);
  chrome.storage.local.set({ readingTheme: value }).catch(() => report('配色已切换，本次未能保存。'));
});

function stopRendering() {
  generation++;
  core.readingCursor = null;
  core.clear(); observer?.disconnect(); pageObserver?.disconnect(); visible.clear();
  for (const record of records) {
    record.near = false;
    record.renderTask?.cancel(); record.textLayer?.cancel();
  }
}

function updateCurrentPage() {
  if (!visible.size) return;
  const page = [...visible.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (document.activeElement !== $('page-number')) $('page-number').value = String(page);
}

async function render(record, version) {
  if (!record.near || version !== generation || record.done) return;
  const page = await pdf.getPage(record.number);
  if (!record.near || version !== generation) return;
  const view = page.getViewport({ scale: zoom });
  record.element.style.width = `${view.width}px`;
  record.element.style.height = `${view.height}px`;
  record.element.style.setProperty('--scale-factor', view.scale);
  record.element.style.setProperty('--user-unit', page.userUnit || 1);
  const canvas = document.createElement('canvas');
  // Bound raster allocation, including very large engineering drawings.
  const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (view.width * view.height)));
  canvas.width = Math.max(1, Math.floor(view.width * ratio));
  canvas.height = Math.max(1, Math.floor(view.height * ratio));
  const layer = document.createElement('div'); layer.className = 'textLayer';
  record.element.replaceChildren(canvas, layer);
  try {
    record.renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: view, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
    await record.renderTask.promise;
    if (!record.near || version !== generation) return;
    // Canvas alone has no text. TextLayer creates selectable, position-aligned spans.
    record.textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(), container: layer, viewport: view
    });
    await record.textLayer.render();
    if (!record.near || version !== generation) return;
    record.done = true;
    if (!layer.textContent.trim()) {
      layer.setAttribute('aria-label', '此页没有可提取文字，需要 OCR 才能翻译。');
    }
  } finally {
    record.renderTask = null;
    if (!record.near || version !== generation) {
      record.textLayer?.cancel(); record.textLayer = null;
      canvas.width = 0; canvas.height = 0;
      record.element.replaceChildren(); record.done = false;
    }
  }
}

function enqueue(record, version) {
  if (record.queued || record.done) return;
  record.queued = true;
  renderQueue = renderQueue.then(() => render(record, version)).catch(error => {
    if (version !== generation || !record.near || /cancel/i.test(error.name)) return;
    const message = document.createElement('p'); message.className = 'render-error';
    message.textContent = `第 ${record.number} 页渲染失败：${error.message}`;
    record.element.replaceChildren(message);
  }).finally(() => {
    record.queued = false;
    // A page may re-enter the viewport while its cancelled render is settling.
    if (record.near && !record.done && version === generation && !record.element.querySelector('.render-error')) enqueue(record, version);
  });
}

core.loadNavigationPage = async number => {
  const record = records[number - 1], version = generation;
  if (!pdf || !record) return false;
  if (record.done) return true;
  const top = record.element.getBoundingClientRect().top + viewport.scrollTop - viewport.getBoundingClientRect().top;
  viewport.scrollTo({ top: Math.max(0, top - 24), behavior: 'instant' });
  record.near = true;
  enqueue(record, version);
  return new Promise(resolve => {
    let attempts = 0;
    const check = () => {
      if (record.done) { resolve(true); return; }
      if (version !== generation || !pdf || record.element.querySelector('.render-error') || attempts++ > 400) { resolve(false); return; }
      if (record.near && !record.queued) enqueue(record, version);
      setTimeout(check, 25);
    };
    check();
  });
};

async function layout(targetPage = 1) {
  stopRendering();
  const version = generation;
  records = [];
  $('pages').replaceChildren();
  $('zoom').value = `${Math.round(zoom * 100)}%`;
  const first = await pdf.getPage(1);
  if (version !== generation) return;
  const initial = first.getViewport({ scale: zoom });
  const fragment = document.createDocumentFragment();
  for (let number = 1; number <= pdf.numPages; number++) {
    const element = document.createElement('section');
    element.className = 'pdf-page'; element.dataset.page = String(number);
    element.setAttribute('aria-label', `第 ${number} 页`);
    Object.assign(element.style, { width: `${initial.width}px`, height: `${initial.height}px` });
    records.push({ number, element, near: false, done: false, queued: false });
    fragment.append(element);
  }
  $('pages').append(fragment);
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records[Number(entry.target.dataset.page) - 1];
      if (!record || record.element !== entry.target) continue;
      record.near = entry.isIntersecting;
      if (record.near) enqueue(record, version);
      else {
        record.renderTask?.cancel(); record.textLayer?.cancel();
        if (!record.queued) {
          const canvas = record.element.querySelector('canvas');
          if (canvas) { canvas.width = 0; canvas.height = 0; }
          record.element.replaceChildren(); record.done = false; record.textLayer = null;
        }
      }
    }
  }, { root: viewport, rootMargin: '800px 0px' });
  pageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const number = Number(entry.target.dataset.page);
      if (entry.isIntersecting) visible.set(number, entry.intersectionRatio);
      else visible.delete(number);
    }
    updateCurrentPage();
  }, { root: viewport, threshold: [0, .1, .25, .5, .75, 1] });
  records.forEach(record => { observer.observe(record.element); pageObserver.observe(record.element); });
  goTo(targetPage);
}

function goTo(number) {
  if (!pdf) return;
  const page = Math.max(1, Math.min(pdf.numPages, Number(number) || 1));
  const record = records[page - 1];
  if (!record) return;
  core.clear();
  viewport.scrollTo({ top: record.element.offsetTop - 24, behavior: 'instant' });
  $('page-number').value = String(page);
}

async function goToDestination(destination, version) {
  try {
    const dest = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
    if (!dest || version !== generation) return;
    const index = Number.isInteger(dest[0]) ? dest[0] : await pdf.getPageIndex(dest[0]);
    if (version === generation) goTo(index + 1);
  } catch { report('此目录目标无法定位。'); }
}

async function loadOutline(doc, sequence) {
  const items = await doc.getOutline();
  if (sequence !== openSequence) return;
  const nav = $('outline-items'); nav.replaceChildren();
  if (!items?.length) { nav.textContent = '此文档没有目录。'; return; }
  const makeList = entries => {
    const list = document.createElement('ul');
    for (const entry of entries) {
      const li = document.createElement('li');
      const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.title || '未命名章节';
      button.disabled = !entry.dest;
      button.addEventListener('click', () => goToDestination(entry.dest, generation));
      li.append(button);
      if (entry.items?.length) li.append(makeList(entry.items));
      list.append(li);
    }
    return list;
  };
  nav.append(makeList(items));
}

async function openPDF(source, name) {
  const sequence = ++openSequence;
  stopRendering(); records = []; pdf = null;
  $('pages').replaceChildren(); $('empty').hidden = false; $('empty-message').textContent = '正在打开 PDF…';
  $('outline-items').textContent = '正在读取目录…';
  $('page-count').textContent = '/ 0'; $('page-number').value = '1';
  report(`正在加载 ${name}…`);
  try {
    const previous = documentTask; documentTask = null;
    if (previous) await previous.destroy();
    if (sequence !== openSequence) return;
    const task = pdfjsLib.getDocument({
      ...(typeof source === 'string' ? { url: source, withCredentials: true } : { data: source }),
      cMapUrl: chrome.runtime.getURL('vendor/cmaps/'), cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('vendor/standard_fonts/'),
      wasmUrl: chrome.runtime.getURL('vendor/wasm/'),
      isEvalSupported: false, enableXfa: false
    });
    documentTask = task;
    task.onPassword = (updatePassword, reason) => {
      const password = prompt(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? '密码错误，请重新输入 PDF 密码：' : '请输入 PDF 密码：');
      if (password === null) { task.destroy(); if (sequence === openSequence) report('已取消打开加密 PDF。'); }
      else updatePassword(password);
    };
    const doc = await task.promise;
    if (sequence !== openSequence) return;
    pdf = doc;
    document.title = `${name} · Omni PDF`;
    $('empty').hidden = true; $('page-count').textContent = `/ ${doc.numPages}`; $('page-number').max = String(doc.numPages);
    await layout(1);
    if (sequence !== openSequence) return;
    await loadOutline(doc, sequence);
    if (sequence === openSequence) report(`${name} · ${doc.numPages} 页 · 悬停或选择文字翻译；扫描图片需要 OCR。`);
  } catch (error) {
    if (sequence !== openSequence) return;
    $('empty').hidden = false; $('empty-message').textContent = 'PDF 打开失败。可以下载文件后使用“打开文件”。';
    report(`打开失败：${error.message}。登录、签名失效或防盗链链接请下载后打开。`);
  }
}

function openURL(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含用户名和密码的 HTTP(S) PDF 地址。');
    $('url').value = url.href;
    // Keep literal query bytes; do not parse the source URL as viewer query params.
    history.replaceState(null, '', `#url=${url.href}`);
    const segment = url.pathname.split('/').pop() || 'PDF';
    let name = segment;
    try { name = decodeURIComponent(segment); } catch { /* Invalid URL escapes can be literal names. */ }
    void openPDF(url.href, name);
  } catch (error) { report(error.message || '请输入有效的 PDF 地址。'); }
}

$('file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    history.replaceState(null, '', location.pathname); $('url').value = '';
    await openPDF(bytes, file.name);
  } catch (error) { report(`无法读取文件：${error.message}`); }
  event.target.value = '';
});
$('url-form').addEventListener('submit', event => { event.preventDefault(); openURL($('url').value); });
$('previous').addEventListener('click', () => goTo(Number($('page-number').value) - 1));
$('next').addEventListener('click', () => goTo(Number($('page-number').value) + 1));
$('page-number').addEventListener('change', () => goTo($('page-number').value));
$('page-number').addEventListener('keydown', event => { if (event.key === 'Enter') { goTo($('page-number').value); $('page-number').blur(); } });
let zooming = false;
async function changeZoom(delta) {
  if (!pdf || zooming) return;
  const next = Math.max(.5, Math.min(3, Math.round((zoom + delta) * 100) / 100));
  if (zoom === next) return;
  zooming = true; zoom = next;
  try { await layout(Number($('page-number').value)); }
  catch (error) { report(`缩放失败：${error.message}`); }
  finally { zooming = false; }
}
$('zoom-in').addEventListener('click', () => changeZoom(.25));
$('zoom-out').addEventListener('click', () => changeZoom(-.25));
$('toggle-outline').addEventListener('click', () => {
  $('outline').hidden = !$('outline').hidden;
  $('toggle-outline').setAttribute('aria-expanded', String(!$('outline').hidden)); core.clear();
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
let frame = 0, latest;
function capture(event) {
  if (core.isUIEvent(event)) return;
  latest = event;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const boundary = latest.target.closest?.('.textLayer');
    core.hover(boundary && core.canHover(latest) ? OmniHover.text.captureAtPoint(latest, { boundary, pdf: true, mode: core.config.captureMode }) : null, latest);
  });
}
document.addEventListener('mouseover', capture, { passive: true });
document.addEventListener('mousemove', capture, { passive: true });
window.addEventListener('pagehide', () => { stopRendering(); void documentTask?.destroy(); });
if (location.hash.startsWith('#url=')) openURL(location.hash.slice(5));
