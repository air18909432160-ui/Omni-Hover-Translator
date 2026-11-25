(() => {
  'use strict';
  if (document.contentType === 'application/pdf' || globalThis.__omniWebInjector) return;
  globalThis.__omniWebInjector = true;
  const core = new OmniHover.TranslatorCore();
  let frame = 0, latest;
  const capture = event => {
    if (core.isUIEvent(event)) return;
    latest = event;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      core.hover(core.canHover(latest) ? OmniHover.text.captureAtPoint(latest, { mode: core.config.captureMode }) : null, latest);
    });
  };
  // mouseover covers node entry; mousemove resolves sentences inside the SAME text node.
  document.addEventListener('mouseover', capture, { passive: true });
  document.addEventListener('mousemove', capture, { passive: true });
  window.addEventListener('pagehide', () => { core.clear(); cancelAnimationFrame(frame); });
})();
