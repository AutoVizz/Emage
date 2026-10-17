// Loaded in the head so a saved preference applies before the page is painted.
(() => {
  const storageKey = 'emage:theme';
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  const normalize = value => ['light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem(storageKey)); } catch {}

  function apply() {
    document.documentElement.dataset.theme = preference === 'system'
      ? (system?.matches ? 'dark' : 'light') : preference;
    document.querySelectorAll('[data-theme-select]').forEach(select => { select.value = preference; });
  }
  apply();
  function bind() {
    apply();
    document.querySelectorAll('[data-theme-select]').forEach(select => {
      select.addEventListener('change', () => {
        preference = normalize(select.value);
        try {
          if (preference === 'system') localStorage.removeItem(storageKey);
          else localStorage.setItem(storageKey, preference);
        } catch {}
        apply();
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  system?.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) {
      preference = normalize(event.newValue);
      apply();
    }
  });
})();
