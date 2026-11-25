(() => {
  'use strict';
  const ns = globalThis.OmniHover ??= {};
  const SKIP = 'script,style,noscript,textarea,input,select,button,code,pre,[contenteditable]:not([contenteditable="false"]),[data-oht-ui], [aria-hidden="true"]';
  const abbreviation = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.$/i;

  function mergeAbbreviations(parts, text) {
    const merged = [];
    for (const part of parts) {
      const previous = merged.at(-1);
      if (previous && abbreviation.test(previous.text.trim())) {
        previous.end = part.end;
        previous.text = text.slice(previous.start, previous.end);
      } else merged.push({ ...part });
    }
    return merged;
  }

  function sentences(text) {
    if (typeof Intl.Segmenter === 'function') {
      const parts = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text),
        ({ segment, index }) => ({ text: segment, start: index, end: index + segment.length }));
      return mergeAbbreviations(parts, text);
    }
    const parts = [];
    // Abbreviations and decimals remain together in the fallback as well.
    const pattern = /[.!?]+["'”’)]*(?=\s|$)/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (abbreviation.test(text.slice(start, end))) continue;
      parts.push({ text: text.slice(start, end), start, end });
      start = end;
    }
    if (start < text.length) parts.push({ text: text.slice(start), start, end: text.length });
    return parts;
  }

  function sentenceAt(text, offset) {
    // ICU treats line breaks as sentence boundaries, even without punctuation.
    // Replace soft breaks one-for-one so every DOM offset remains valid.
    const segmentationText = text.replace(/[\r\n\t\u2028]/g, ' ');
    const part = sentences(segmentationText).find(part => offset >= part.start && offset < part.end);
    if (!part) return null;
    const leading = part.text.length - part.text.trimStart().length;
    const trailing = part.text.length - part.text.trimEnd().length;
    const start = part.start + leading, end = part.end - trailing;
    const source = text.slice(start, end);
    const result = {
      text: source.replace(/([A-Za-z])-\s*\n\s*(?=[a-z])/g, '$1').replace(/\s+/g, ' ').trim(),
      start, end
    };
    return offset >= result.start && offset < result.end && /\p{L}/u.test(result.text) ? result : null;
  }

  function paragraphFor(element, boundary) {
    if (!element || element.closest(SKIP)) return null;
    if (boundary) return boundary.contains(element) ? boundary : null;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const display = getComputedStyle(node).display;
      if (/^(block|list-item|table-cell|flex|grid|flow-root)$/.test(display)) {
        // Some sites put EACH visual line in its own DIV. Group only simple,
        // adjacent line containers, never semantic paragraphs or layout panels.
        const parent = node.parentElement;
        if (node.matches('div') && parent && !parent.matches('body,html') && parent.childElementCount > 1 && parent.childElementCount <= 80) {
          const siblings = [...parent.children];
          const boxes = siblings.map(item => item.getBoundingClientRect());
          const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || parseFloat(getComputedStyle(node).fontSize) * 1.3;
          const simple = siblings.every((item, index) => item.matches('div') && !item.querySelector('p,div,section,article,li,h1,h2,h3,table,img,button,input') &&
            boxes[index].height <= lineHeight * 2.5 && Math.abs(boxes[index].left - boxes[0].left) < 8 &&
            (index === 0 || (boxes[index].top >= boxes[index - 1].bottom - 2 && boxes[index].top - boxes[index - 1].bottom < lineHeight * .8)));
          if (simple) return parent;
        }
        return node;
      }
    }
    return element.parentElement || element;
  }

  function textMap(root, pdf = false) {
    const entries = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.parentElement.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (text.length > 60000) return null;
      // Preserve whitespace from the source; infer missing separators for BRs,
      // separate line DIVs and positioned PDF spans without splitting words.
      if (entries.length && !/\s$/.test(text) && !/^\s/.test(node.nodeValue)) {
        const previous = entries.at(-1).node;
        const a = document.createRange(), b = document.createRange();
        a.setStart(previous, previous.length - 1); a.setEnd(previous, previous.length);
        b.setStart(node, 0); b.setEnd(node, 1);
        const left = a.getBoundingClientRect(), right = b.getBoundingClientRect();
        const height = Math.max(left.height, right.height, 1);
        const newLine = Math.abs(left.top - right.top) > height * .6;
        const paragraphGap = right.top - left.bottom > height * 1.2;
        const columnJump = newLine && right.left > left.right + height * 2;
        if (pdf && (paragraphGap || columnJump)) text += '\u2029';
        else if (newLine) text += '\n';
        else if (right.left - left.right > height * .12) text += ' ';
      }
      entries.push({ node, start: text.length, end: text.length + node.length });
      text += node.nodeValue;
    }
    return { text, entries };
  }

  function rangeFor(map, start, end) {
    const first = map.entries.find(entry => start >= entry.start && start < entry.end);
    const last = map.entries.find(entry => end > entry.start && end <= entry.end);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }

  function sentenceCandidates(root, pdf = false) {
    const map = textMap(root, pdf);
    if (!map?.text.trim()) return [];
    const candidates = [];
    let paragraphStart = 0;
    while (paragraphStart <= map.text.length) {
      const separator = map.text.indexOf('\u2029', paragraphStart);
      const paragraphEnd = separator < 0 ? map.text.length : separator;
      const paragraph = map.text.slice(paragraphStart, paragraphEnd).replace(/[\r\n\t\u2028]/g, ' ');
      for (const part of sentences(paragraph)) {
        const leading = part.text.length - part.text.trimStart().length;
        const trailing = part.text.length - part.text.trimEnd().length;
        const start = paragraphStart + part.start + leading;
        const end = paragraphStart + part.end - trailing;
        const source = map.text.slice(start, end);
        const text = source.replace(/([A-Za-z])-\s*\n\s*(?=[a-z])/g, '$1').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 2500 || !/\p{L}/u.test(text)) continue;
        const range = rangeFor(map, start, end);
        if (range) candidates.push({ text, root, start, end, range, pdf });
      }
      if (separator < 0) break;
      paragraphStart = separator + 1;
    }
    return candidates;
  }

  function sentencesInDocument(root = document.body) {
    const roots = [], seen = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim() || node.parentElement.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      const block = paragraphFor(walker.currentNode.parentElement);
      if (block && !seen.has(block)) { seen.add(block); roots.push(block); }
    }
    return roots.flatMap(block => sentenceCandidates(block));
  }

  function containsPoint(rect, x, y, padding = 0) {
    return x >= rect.left - padding && x <= rect.right + padding && y >= rect.top - padding && y <= rect.bottom + padding;
  }

  function captureAtPoint(event, { boundary = null, pdf = false, mode = 'sentence' } = {}) {
    const element = event.target instanceof Element ? event.target : event.target?.parentElement;
    const root = paragraphFor(element, boundary);
    if (!root) return null;
    const map = textMap(root, pdf);
    if (!map?.text.trim()) return null;
    const atOffset = (entry, node, offset) => {
      if (!entry || node?.nodeType !== Node.TEXT_NODE || !Number.isFinite(offset)) return null;
      // At a glyph's right half the caret reports the NEXT position. Hit-test both sides.
      const offsets = [...new Set([Math.min(offset, node.length - 1), Math.max(0, offset - 1)])];
      for (const local of offsets) {
        if (local < 0 || /\s/.test(node.nodeValue[local])) continue;
        const glyph = document.createRange();
        glyph.setStart(node, local); glyph.setEnd(node, local + 1);
        if (![...glyph.getClientRects()].some(rect => containsPoint(rect, event.clientX, event.clientY, 0.5))) continue;
        return atGlyph(entry, local);
      }
      return null;
    };
    const atGlyph = (entry, local) => {
      const offsetInMap = entry.start + local;
      let sentence = sentenceAt(map.text, offsetInMap);
      if (mode === 'paragraph') {
        const from = map.text.lastIndexOf('\u2029', offsetInMap - 1) + 1;
        const until = map.text.indexOf('\u2029', offsetInMap);
        const block = map.text.slice(from, until < 0 ? map.text.length : until);
        const start = from + block.length - block.trimStart().length;
        const end = from + block.trimEnd().length;
        sentence = { start, end, text: map.text.slice(start, end).replace(/([A-Za-z])-\s*\n\s*(?=[a-z])/g, '$1').replace(/\s+/g, ' ').trim() };
      }
      if (!sentence || sentence.text.length > 2500) return null;
      const range = rangeFor(map, sentence.start, sentence.end);
      return range ? { ...sentence, root, range, pdf } : null;
    };

    for (const getCaret of [
      () => document.caretPositionFromPoint?.(event.clientX, event.clientY),
      () => document.caretRangeFromPoint?.(event.clientX, event.clientY)
    ]) {
      try {
        const caret = getCaret();
        const node = caret?.offsetNode || caret?.startContainer;
        const offset = caret?.offset ?? caret?.startOffset;
        const result = atOffset(map.entries.find(entry => entry.node === node), node, offset);
        if (result) return result;
      } catch { /* Continue with the other browser hit-testing API. */ }
    }

    // PDF.js text spans can be visually hit while browser caret APIs return null.
    for (const entry of map.entries) {
      const node = entry.node;
      const line = document.createRange();
      line.selectNodeContents(node);
      if (![...line.getClientRects()].some(rect => containsPoint(rect, event.clientX, event.clientY, 0.5))) continue;
      for (let offset = 0; offset < node.length; offset++) {
        const result = atOffset(entry, node, offset + 1);
        if (result) return result;
      }
    }
    return null;
  }

  ns.text = { sentences, sentenceAt, textMap, rangeFor, captureAtPoint, containsPoint, sentenceCandidates, sentencesInDocument };
})();
