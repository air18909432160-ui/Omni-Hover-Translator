if (location.protocol !== 'chrome-extension:') {
  const status = document.getElementById('runtime-status');
  if (status) {
    status.hidden = false;
    status.style.cssText = 'padding:14px 18px;margin-bottom:20px;border:1px solid #d49a64;border-radius:8px;background:#3b3024;color:#f1d2a8';
  }
  document.querySelectorAll('#settings input, #settings select, #settings button').forEach(control => { control.disabled = true; });
}
