(() => {
  'use strict';
  const ns = globalThis.OmniHover ??= {};
  let sequence = 0;
  class TranslatorCore {
    constructor() {
      this.config = { ...ns.settings.defaults };
      this.isPDF = location.protocol === 'chrome-extension:';
      this.connectSettings();
      this.onVisible = () => { if (!document.hidden) { this.connectSettings(); void this.refreshSettings(); } };
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('focus', this.onVisible);
      window.addEventListener('pageshow', this.onVisible);
      this.id = `oht-sentence-${++sequence}`;
      this.onLeave = () => this.scheduleDismiss();
      this.onViewportChange = event => {
        if (this.navigatingSentence || this.isUIEvent(event)) return;
        if (event.type === 'scroll' && this.current?.keyboard) { this.position(); return; }
        this.clear();
      };
      this.onKey = event => { if (event.key === 'Escape') this.clear(); };
      this.onReadingKey = event => {
        if (event.isComposing) return;
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (target?.closest('[data-oht-ui],input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
        const direction = ns.settings.keyboardDirection(event);
        if (!direction) return;
        if (!this.settingsReady) {
          this.waitingKeyboardDirection = direction;
          this.connectSettings(); void this.refreshSettings();
          event.preventDefault(); event.stopImmediatePropagation();
          return;
        }
        if (!this.config.keyboardReading || !this.allowed()) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void this.navigateSentence(direction);
      };
      window.addEventListener('scroll', this.onViewportChange, true);
      window.addEventListener('resize', this.onViewportChange);
      window.addEventListener('blur', this.onViewportChange);
      document.addEventListener('keydown', this.onKey);
      document.addEventListener('keydown', this.onReadingKey, true);
      document.documentElement.addEventListener('mouseleave', this.onLeave);
      this.onSelection = event => {
        if (event.button !== 0 || this.isUIEvent(event) || !this.config.selectionTranslation) return;
        setTimeout(async () => {
          if (!this.settingsReady) await this.refreshSettings();
          if (this.settingsReady && this.config.selectionTranslation) this.translateSelection();
        }, 0);
      };
      document.addEventListener('mouseup', this.onSelection);
      this.onModifierUp = event => {
        if (this.config.modifier !== 'none' && event.key.toLowerCase() === ({ ctrl: 'control', alt: 'alt', shift: 'shift' }[this.config.modifier])) this.scheduleDismiss();
      };
      document.addEventListener('keyup', this.onModifierUp);
    }

    connectSettings() {
      if (this.settingsPort || this.destroyed) return;
      try {
        const port = chrome.runtime.connect({ name: 'oht-settings' }); this.settingsPort = port;
        port.onMessage.addListener(config => {
          if (this.settingsPort === port) this.applySettings(config);
        });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (this.settingsPort === port) { this.settingsPort = null; this.settingsReady = false; }
        });
      } catch { this.settingsReady = false; }
      // A one-shot request also wakes a suspended worker and covers a lost Port snapshot.
      void this.refreshSettings();
    }

    applySettings(config) {
      if (this.destroyed) return;
      const next = ns.settings.sanitize(config);
      const changed = JSON.stringify(next) !== JSON.stringify(this.config);
      const first = !this.settingsReady;
      const waiting = this.waitingHover;
      const current = this.current, pinned = this.pinned;
      this.config = next; this.settingsReady = true;
      this.settingsEpoch = (this.settingsEpoch || 0) + 1;
      if (changed) {
        this.clear();
        if (!next.keyboardReading) this.readingCursor = null;
        if (current?.range.startContainer.isConnected && this.allowed() && (!current.keyboard || next.keyboardReading)) this.show({ ...current, pinned });
      }
      if (changed || first) this.onConfig?.(this.config);
      this.waitingHover = null;
      if (waiting) this.hover(waiting.candidate, waiting.event);
      if (this.waitingKeyboardDirection) {
        const direction = this.waitingKeyboardDirection;
        this.waitingKeyboardDirection = 0;
        if (this.config.keyboardReading) void this.navigateSentence(direction);
      }
    }

    refreshSettings() {
      if (this.settingsRequest || this.destroyed) return this.settingsRequest;
      const epoch = this.settingsEpoch || 0;
      let timer;
      this.settingsRequest = Promise.race([
        Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'GET_PUBLIC_SETTINGS' })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Settings timeout')), 2500); })
      ]).then(response => {
        if (response?.ok && (this.settingsEpoch || 0) === epoch) this.applySettings(response.settings);
      }).catch(() => {}).finally(() => { clearTimeout(timer); this.settingsRequest = null; });
      return this.settingsRequest;
    }

    allowed() {
      let host = location.hostname.toLowerCase();
      if (this.isPDF && location.hash.startsWith('#url=')) {
        try { host = new URL(location.hash.slice(5)).hostname.toLowerCase(); } catch { /* Local document. */ }
      }
      return this.config.enabled && (this.isPDF ? this.config.pdfEnabled : this.config.webEnabled) &&
        !ns.settings.excluded(host, this.config.excludedHosts);
    }

    canHover(event) {
      return this.allowed() && (this.config.modifier === 'none' || event?.[`${this.config.modifier}Key`]);
    }

    navigationCandidates() {
      if (this.isPDF) {
        return [...document.querySelectorAll('.pdf-page .textLayer')]
          .flatMap(layer => ns.text.sentenceCandidates(layer, true));
      }
      return ns.text.sentencesInDocument(document.body);
    }

    scrollViewport(element) {
      for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`) &&
            (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) return node;
      }
      return document.scrollingElement || document.documentElement;
    }

    visibleBounds(scroller) {
      return scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body
        ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
        : scroller.getBoundingClientRect();
    }

    async revealSentence(candidate) {
      const scroller = this.scrollViewport(candidate.range.startContainer.parentElement);
      const bounds = this.visibleBounds(scroller);
      const rects = [...candidate.range.getClientRects()].filter(rect => rect.width && rect.height);
      if (!rects.length) return;
      const first = rects[0], last = rects.at(-1), inset = 20;
      let deltaY = 0, deltaX = 0;
      if (first.top < bounds.top + inset) deltaY = first.top - bounds.top - inset;
      else if (last.bottom > bounds.bottom - inset) deltaY = last.bottom - bounds.bottom + inset;
      if (first.left < bounds.left + inset) deltaX = first.left - bounds.left - inset;
      else if (last.right > bounds.right - inset) deltaX = last.right - bounds.right + inset;
      if (deltaY || deltaX) {
        if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
          window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
        } else {
          scroller.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }

    initialSentenceIndex(candidates, direction) {
      if (!candidates.length) return -1;
      const scroller = this.scrollViewport(candidates[0].range.startContainer.parentElement);
      const bounds = this.visibleBounds(scroller);
      if (direction > 0) {
        const visible = candidates.findIndex(candidate => candidate.range.getBoundingClientRect().bottom > bounds.top + 8);
        return visible < 0 ? 0 : visible;
      }
      for (let index = candidates.length - 1; index >= 0; index--) {
        if (candidates[index].range.getBoundingClientRect().top < bounds.bottom - 8) return index;
      }
      return candidates.length - 1;
    }

    async navigateSentence(direction) {
      if (this.navigationRunning || !this.config.keyboardReading || !this.allowed()) return;
      this.navigationRunning = true;
      try {
        let candidates = this.navigationCandidates();
        let index = candidates.findIndex(candidate => candidate.root === this.readingCursor?.root &&
          candidate.start === this.readingCursor.start && candidate.end === this.readingCursor.end && candidate.text === this.readingCursor.text);
        if (index < 0) index = this.initialSentenceIndex(candidates, direction);
        else index += direction;

        let candidate = candidates[index];
        if (!candidate && this.isPDF && this.loadNavigationPage) {
          const currentPage = Number(this.readingCursor?.root.closest('.pdf-page')?.dataset.page) ||
            Number(candidates.at(direction > 0 ? -1 : 0)?.root.closest('.pdf-page')?.dataset.page) || 0;
          const nextPage = currentPage + direction;
          if (nextPage > 0 && await this.loadNavigationPage(nextPage)) {
            candidates = this.navigationCandidates();
            const inPage = candidates.map((item, itemIndex) => ({ item, itemIndex }))
              .filter(({ item }) => Number(item.root.closest('.pdf-page')?.dataset.page) === nextPage);
            candidate = direction > 0 ? inPage[0]?.item : inPage.at(-1)?.item;
          }
        }
        if (!candidate) {
          this.onNavigationStatus?.(candidates.length ? '已到文档末尾。' : '当前页面没有可导航的文字。');
          return;
        }

        this.navigatingSentence = true;
        this.clear();
        await this.revealSentence(candidate);
        this.readingCursor = { root: candidate.root, start: candidate.start, end: candidate.end, text: candidate.text };
        this.show({ ...candidate, keyboard: true });
        this.onNavigationStatus?.('');
      } finally {
        this.navigatingSentence = false;
        this.navigationRunning = false;
      }
    }

    translateSelection() {
      if (!this.allowed() || document.activeElement?.matches('input,textarea,[contenteditable]:not([contenteditable="false"])')) return;
      const selection = getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0).cloneRange();
      const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      if (!element || element.closest('[data-oht-ui],input,textarea,[contenteditable]:not([contenteditable="false"])')) return;
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 2500) return;
      this.clear(); this.show({ text, root: element, start: range.startOffset, end: range.endOffset, range, pinned: true });
    }

    hover(candidate, event) {
      const previousPointer = this.pointerPosition;
      if (event?.type === 'mousemove') this.pointerPosition = { x: event.clientX, y: event.clientY };
      if (!this.settingsReady) {
        this.waitingHover = candidate ? { candidate, event: { altKey: event?.altKey, ctrlKey: event?.ctrlKey, shiftKey: event?.shiftKey } } : null;
        this.connectSettings(); void this.refreshSettings(); return;
      }
      if (this.pinned) return;
      if (this.current?.keyboard) {
        // Scrolling can fire mouseover under a stationary pointer. Only an actual
        // pointer movement hands control back from keyboard reading to hovering.
        const moved = event?.type === 'mousemove' && (!previousPointer || previousPointer.x !== event.clientX || previousPointer.y !== event.clientY);
        if (!moved && !event?.movementX && !event?.movementY) return;
        this.current.keyboard = false;
      }
      if (!this.canHover(event)) { this.clear(); return; }
      if (!candidate) { this.scheduleDismiss(); return; }
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
      if (candidate && this.same(candidate, this.current)) return;
      if (candidate && this.same(candidate, this.pending)) return;
      clearTimeout(this.hoverTimer);
      this.pending = null;
      this.clear();
      this.pending = candidate;
      this.hoverTimer = setTimeout(() => {
        this.pending = null;
        if (candidate.range.startContainer.isConnected) this.show(candidate);
      }, this.config.hoverDelay);
    }

    same(a, b) {
      return b && a.root === b.root && a.start === b.start && a.end === b.end && a.text === b.text;
    }

    isUIEvent(event) { return this.host && event.composedPath().includes(this.host); }

    scheduleDismiss() {
      if (this.pinned || this.current?.keyboard) return;
      clearTimeout(this.hoverTimer);
      this.pending = null;
      // Allow the pointer to cross the gap from the sentence to its popup.
      this.dismissTimer ??= setTimeout(() => this.clear(), this.config.dismissDelay);
    }

    show(candidate) {
      this.current = candidate;
      this.pinned = !!candidate.pinned;
      this.host = document.createElement('div');
      this.host.dataset.ohtUi = '';
      this.host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;';
      const shadow = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host { color-scheme:dark; } * { box-sizing:border-box; }
        .panel { position:fixed; width:min(412px,calc(100vw - 24px)); max-height:min(500px,calc(100vh - 24px)); overflow:auto; pointer-events:auto; background:#24332f; color:#e4e9dd; border:1px solid #485a50; border-radius:16px; box-shadow:0 16px 48px #0d171b48; padding:20px; font:14px/1.75 system-ui,sans-serif; text-align:left; scrollbar-width:thin; scrollbar-color:#60796b transparent; }
        .heading {display:flex;align-items:center;gap:9px;margin-bottom:16px;}
        .logo {display:grid;place-items:center;width:27px;height:27px;border:1px solid #7d9b7b;border-radius:9px;color:#c3d4a5;font-size:14px;font-weight:700;}
        .title {font-size:13px;font-weight:600;letter-spacing:.04em;} .badge {margin-left:auto;color:#b4c49f;font-size:11px;letter-spacing:.06em;}
        p { margin:0;white-space:pre-wrap;overflow-wrap:anywhere; } .label {display:block;color:#92a99a;font-size:10px;letter-spacing:.12em;margin-bottom:6px;}
        .source {color:#bac8bc;font-size:13px;line-height:1.75;} .translation {border-top:1px solid #425348;margin-top:16px;padding-top:15px;}
        .target {font-size:16px;line-height:1.85;color:#edeada;} .error {color:#f0b8a5;}
        .actions {display:flex;gap:7px;flex-wrap:wrap;border-top:1px solid #425348;padding-top:14px;margin-top:17px;}
        button {font:12px system-ui;cursor:pointer;background:#30433a;border:1px solid #4a6051;border-radius:8px;padding:7px 9px;color:#d1ddce;transition:background .15s,border-color .15s;}
        button:hover {background:#415849;border-color:#7d9375;} button:focus-visible {outline:2px solid #c6cc95;outline-offset:3px;}
        button.primary {background:#b9c89b;border-color:#b9c89b;color:#213127;font-weight:600;} button.primary:hover {background:#cad5b0;}
        button:disabled {opacity:.45;cursor:default;} button.close {border:0;background:transparent;padding:2px 4px;color:#9db19e;font-size:20px;line-height:1;}
        .mark {position:fixed;background:rgba(223,191,86,.28);pointer-events:none;border-radius:3px;}
        @media(prefers-reduced-motion:reduce) {button {transition:none;}}
      `;
      shadow.append(style);
      // CSS Custom Highlight preserves all page nodes and text selection.
      if (this.config.highlightEnabled && globalThis.CSS?.highlights && globalThis.Highlight) {
        const sheet = document.createElement('style');
        sheet.textContent = `::highlight(${this.id}) { background-color:${this.config.highlightColor}${Math.round(this.config.highlightOpacity / 100 * 255).toString(16).padStart(2, '0')}; color:inherit; }`;
        document.documentElement.append(sheet);
        CSS.highlights.set(this.id, new Highlight(candidate.range));
        this.highlightStyle = sheet;
      } else if (this.config.highlightEnabled) {
        for (const rect of candidate.range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const mark = document.createElement('div');
          mark.className = 'mark';
          Object.assign(mark.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, background: this.config.highlightColor, opacity: this.config.highlightOpacity / 100 });
          shadow.append(mark);
        }
      }
      const panel = document.createElement('section');
      panel.className = 'panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '悬停翻译');
      panel.style.width = `min(${this.config.bubbleWidth}px,calc(100vw - 24px))`;
      const dimensions = ns.settings.bubbleSizes[this.config.bubbleSize];
      panel.style.padding = `${dimensions.padding}px`;
      panel.style.maxHeight = `min(${dimensions.maxHeight}px,calc(100vh - 24px))`;
      const rgb = { forest: '36,51,47', night: '31,35,42', paper: '232,226,209' }[this.config.bubbleTheme];
      panel.style.background = `rgba(${rgb},${this.config.bubbleOpacity / 100})`;
      if (this.config.bubbleTheme === 'paper') {
        style.textContent += '.panel{color:#29362b;border-color:#acae95}.source{color:#4e5d4c}.target{color:#263524}.label,.badge{color:#52644a}.translation,.actions{border-color:#b9bea4}.title{color:#2e3d29}button{background:#d6ddbf;color:#30402c;border-color:#a8b897}';
      }
      const heading = document.createElement('header'); heading.className = 'heading';
      const logo = document.createElement('span'); logo.className = 'logo'; logo.textContent = '译';
      const title = document.createElement('span'); title.className = 'title'; title.textContent = '悬停翻译';
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = `${ns.settings.language(this.config.sourceLang)[1]} → ${ns.settings.language(this.config.targetLang)[1]}`;
      const size = document.createElement('select'); size.setAttribute('aria-label', '气泡大小');
      size.style.cssText = 'font:12px system-ui;background:transparent;color:inherit;border:1px solid #71836a;border-radius:6px;padding:3px;cursor:pointer';
      for (const [value, preset] of Object.entries(ns.settings.bubbleSizes)) {
        const option = document.createElement('option'); option.value = value; option.textContent = preset.label; size.append(option);
      }
      size.value = this.config.bubbleSize;
      size.addEventListener('change', () => {
        const patch = ns.settings.bubbleSizePatch(size.value);
        // Content scripts cannot write the trusted storage that contains API keys.
        chrome.runtime.sendMessage({ type: 'SET_BUBBLE_SIZE', size: patch.bubbleSize }).catch(() => {});
      });
      const close = document.createElement('button'); close.className = 'close'; close.type = 'button';
      close.textContent = '×'; close.setAttribute('aria-label', '关闭'); close.title = '关闭 · Esc'; close.addEventListener('click', () => this.clear());
      heading.append(logo, title, badge, size, close);
      const label = text => { const node = document.createElement('span'); node.className = 'label'; node.textContent = text; return node; };
      const original = document.createElement('div');
      const source = document.createElement('p'); source.className = 'source'; source.textContent = candidate.text;
      original.append(label('原文'), source); original.hidden = !this.config.showOriginal;
      const translated = document.createElement('div'); translated.className = 'translation';
      const target = document.createElement('p'); target.className = 'target'; target.textContent = '正在翻译…'; target.setAttribute('aria-live', 'polite');
      target.style.fontSize = `${this.config.fontSize}px`;
      target.dir = 'auto'; source.dir = 'auto';
      translated.append(label('译文'), target);
      const actions = document.createElement('div'); actions.className = 'actions';
      const button = (text, handler) => {
        const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
        node.addEventListener('click', handler); actions.append(node); return node;
      };
      const copy = button('复制译文', async () => {
        try {
          await navigator.clipboard.writeText(this.translation);
          copy.textContent = '已复制';
        } catch { copy.textContent = '复制失败'; }
      });
      copy.disabled = true;
      copy.className = 'primary';
      button('复制原文', async () => {
        try { await navigator.clipboard.writeText(candidate.text); } catch { target.textContent = '复制失败，请检查浏览器权限。'; }
      });
      const speak = (text, lang) => {
        if (!globalThis.speechSynthesis) return;
        speechSynthesis.cancel();
        this.utterance = new SpeechSynthesisUtterance(text); this.utterance.lang = lang;
        this.utterance.rate = this.config.ttsRate;
        speechSynthesis.speak(this.utterance);
      };
      button('朗读原文', () => speak(candidate.text, ns.settings.language(this.config.sourceLang)[2] || document.documentElement.lang || 'en-US'));
      const tts = button('朗读译文', () => speak(this.translation, ns.settings.language(this.config.targetLang)[2])); tts.disabled = true;
      const pin = button(this.pinned ? '取消固定' : '固定气泡', () => {
        this.pinned = !this.pinned; this.current.keyboard = false;
        pin.textContent = this.pinned ? '取消固定' : '固定气泡'; pin.setAttribute('aria-pressed', String(this.pinned));
      });
      pin.setAttribute('aria-pressed', String(this.pinned));
      button('设置', () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {}));
      panel.append(heading, original, translated, actions); shadow.append(panel);
      const keepOpen = () => { clearTimeout(this.dismissTimer); this.dismissTimer = null; };
      panel.addEventListener('pointerenter', keepOpen);
      panel.addEventListener('pointerleave', () => this.scheduleDismiss());
      panel.addEventListener('focusin', keepOpen);
      document.documentElement.append(this.host);
      this.panel = panel;
      const rects = [...candidate.range.getClientRects()].filter(rect => rect.width && rect.height);
      let anchor = rects.find(rect => rect.bottom >= 0 && rect.top < innerHeight) || candidate.range.getBoundingClientRect();
      const last = rects.at(-1);
      if (last && last.bottom < innerHeight - 80) anchor = { left: anchor.left, top: anchor.top, bottom: last.bottom };
      this.position(anchor);
      try {
        const port = chrome.runtime.connect({ name: 'oht-translation' }); this.port = port;
        port.onMessage.addListener(response => {
          if (this.port !== port || !this.current) return;
          if (response.ok) {
            this.translation = response.translation; target.textContent = response.translation;
            copy.disabled = false; tts.disabled = false;
            if (this.config.autoSpeak) speak(response.translation, ns.settings.language(this.config.targetLang)[2]);
          } else { target.textContent = response.error || '翻译失败'; target.classList.add('error'); }
          this.position(anchor);
          this.port = null; port.disconnect();
        });
        port.onDisconnect.addListener(() => {
          if (this.port !== port) return;
          this.port = null; target.textContent = '翻译连接已断开，请重试或重新加载页面。'; target.classList.add('error');
        });
        port.postMessage({ type: 'TRANSLATE', text: candidate.text });
      } catch { target.textContent = '扩展已更新，请重新加载页面。'; }
    }

    position(anchor) {
      const panel = this.panel;
      if (!panel) return;
      if (this.current?.keyboard) {
        const rects = [...this.current.range.getClientRects()].filter(rect => rect.width && rect.height);
        if (rects.length) anchor = { left: rects[0].left, top: rects[0].top, bottom: rects.at(-1).bottom };
      }
      if (!anchor) return;
      const size = panel.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.left, innerWidth - size.width - 12));
      const below = anchor.bottom + 8;
      const top = below + size.height <= innerHeight - 12 ? below : Math.max(12, anchor.top - size.height - 8);
      panel.style.left = `${left}px`; panel.style.top = `${top}px`;
    }

    clear() {
      clearTimeout(this.hoverTimer); clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
      this.pending = null; this.current = null; this.translation = '';
      this.pinned = false;
      this.waitingHover = null;
      const port = this.port; this.port = null; port?.disconnect();
      if (this.utterance && globalThis.speechSynthesis) speechSynthesis.cancel();
      this.utterance = null;
      globalThis.CSS?.highlights?.delete(this.id);
      this.highlightStyle?.remove(); this.highlightStyle = null;
      this.host?.remove(); this.host = null; this.panel = null;
    }

    destroy() {
      this.destroyed = true;
      this.clear();
      window.removeEventListener('scroll', this.onViewportChange, true);
      window.removeEventListener('resize', this.onViewportChange);
      window.removeEventListener('blur', this.onViewportChange);
      document.removeEventListener('keydown', this.onKey);
      document.removeEventListener('keydown', this.onReadingKey, true);
      document.documentElement.removeEventListener('mouseleave', this.onLeave);
      document.removeEventListener('mouseup', this.onSelection);
      document.removeEventListener('keyup', this.onModifierUp);
      this.settingsPort?.disconnect();
      document.removeEventListener('visibilitychange', this.onVisible);
      window.removeEventListener('focus', this.onVisible);
      window.removeEventListener('pageshow', this.onVisible);
    }
  }
  ns.TranslatorCore = TranslatorCore;
})();
