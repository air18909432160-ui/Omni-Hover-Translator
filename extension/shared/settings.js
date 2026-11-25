(() => {
  const ns = globalThis.OmniHover ??= {};
  const languages = [
    ['EN', '英语', 'en-US'], ['ZH', '中文', 'zh-CN'], ['JA', '日语', 'ja-JP'],
    ['KO', '韩语', 'ko-KR'], ['DE', '德语', 'de-DE'], ['FR', '法语', 'fr-FR'],
    ['ES', '西班牙语', 'es-ES'], ['PT', '葡萄牙语', 'pt-PT'], ['IT', '意大利语', 'it-IT'],
    ['RU', '俄语', 'ru-RU'], ['AR', '阿拉伯语', 'ar-SA'], ['NL', '荷兰语', 'nl-NL'],
    ['PL', '波兰语', 'pl-PL'], ['UK', '乌克兰语', 'uk-UA']
  ];
  const defaults = Object.freeze({
    enabled: true, webEnabled: true, pdfEnabled: true,
    provider: 'deepl-free', apiKey: '', libreUrl: '', libreKey: '',
    sourceLang: 'EN', targetLang: 'ZH', hoverDelay: 200, dismissDelay: 250,
    modifier: 'none', captureMode: 'sentence', selectionTranslation: true,
    keyboardReading: false,
    bubbleSize: 'medium', bubbleOpacity: 96, bubbleWidth: 412, fontSize: 16, bubbleTheme: 'forest',
    showOriginal: true, highlightEnabled: true, highlightColor: '#dfbf56',
    highlightOpacity: 32, ttsRate: 1, autoSpeak: false,
    autoRedirect: true, readingTheme: 'comfort', cacheEnabled: true,
    excludedHosts: '', historyEnabled: false
  });
  const secretKeys = new Set(['apiKey', 'libreKey']);
  const enums = {
    provider: ['deepl-free', 'deepl-pro', 'libre'],
    sourceLang: ['auto', ...languages.map(item => item[0])], targetLang: languages.map(item => item[0]),
    modifier: ['none', 'alt', 'ctrl', 'shift'], captureMode: ['sentence', 'paragraph'],
    bubbleSize: ['small', 'medium', 'large'],
    bubbleTheme: ['forest', 'night', 'paper'], readingTheme: ['comfort', 'night', 'original']
  };
  const limits = { hoverDelay: [100, 5000], dismissDelay: [100, 3000], bubbleOpacity: [35, 100],
    bubbleWidth: [300, 640], fontSize: [12, 26], highlightOpacity: [5, 70], ttsRate: [.5, 2] };
  function sanitize(input = {}) {
    const result = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const value = input[key];
      if (value === undefined) continue;
      if (enums[key]) { if (enums[key].includes(value)) result[key] = value; }
      else if (limits[key]) {
        const n = Number(value);
        if (Number.isFinite(n)) result[key] = Math.max(limits[key][0], Math.min(limits[key][1], n));
      } else if (typeof defaults[key] === 'boolean') { if (typeof value === 'boolean') result[key] = value; }
      else if (typeof value === 'string') result[key] = value.slice(0, 4000);
    }
    if (!/^#[0-9a-f]{6}$/i.test(result.highlightColor)) result.highlightColor = defaults.highlightColor;
    return result;
  }
  const publicSettings = input => Object.fromEntries(Object.entries(sanitize(input)).filter(([key]) => !secretKeys.has(key)));
  const language = code => languages.find(item => item[0] === code) || ['auto', '自动检测', ''];
  const bubbleSizes = Object.freeze({
    small: { label: '小', bubbleWidth: 332, fontSize: 14, padding: 14, maxHeight: 360 },
    medium: { label: '中', bubbleWidth: 412, fontSize: 16, padding: 20, maxHeight: 500 },
    large: { label: '大', bubbleWidth: 552, fontSize: 20, padding: 24, maxHeight: 640 }
  });
  function bubbleSizePatch(size) {
    const preset = bubbleSizes[size] || bubbleSizes.medium;
    return { bubbleSize: bubbleSizes[size] ? size : 'medium', bubbleWidth: preset.bubbleWidth, fontSize: preset.fontSize };
  }
  function keyboardDirection(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
    const key = event.key.toLowerCase();
    return key === 'j' ? 1 : key === 'k' ? -1 : 0;
  }
  function excluded(host, list) {
    return list.split(/[\s,;]+/).some(value => {
      const name = value.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
      return name && (host === name || host.endsWith(`.${name}`));
    });
  }
  ns.settings = { defaults, languages, sanitize, publicSettings, language, excluded, keyboardDirection, bubbleSizes, bubbleSizePatch };
})();
