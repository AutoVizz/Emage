import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const script = readFileSync(new URL('js/theme.js', import.meta.url), 'utf8');
function open({ saved, dark = false, blocked = false, html } = {}) {
  const dom = new JSDOM(html ?? '<!doctype html><select data-theme-select><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>', { url: 'http://localhost:8082/blog.html', runScripts: 'outside-only' });
  const { window } = dom;
  const media = { matches: dark, addEventListener: (_event, handler) => { media.changed = handler; } };
  window.matchMedia = () => media;
  if (saved) window.localStorage.setItem('emage:theme', saved);
  if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  window.eval(script);
  const theme = () => window.document.documentElement.dataset.theme;
  assert.equal(theme(), saved === 'light' || saved === 'dark' ? saved : dark ? 'dark' : 'light', 'theme applies before DOMContentLoaded');
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const select = window.document.querySelector('[data-theme-select]');
  const choose = value => { select.value = value; select.dispatchEvent(new window.Event('change')); };
  return { window, media, theme, select, choose, close: () => window.close() };
}

const page = open({ dark: true });
assert.equal(page.select.value, 'system');
page.choose('light');
assert.equal(page.theme(), 'light');
assert.equal(page.window.localStorage.getItem('emage:theme'), 'light');
page.media.matches = true;
page.media.changed();
assert.equal(page.theme(), 'light', 'explicit preference wins over system');
page.choose('dark');
const nextPage = open({ saved: page.window.localStorage.getItem('emage:theme') });
assert.equal(nextPage.theme(), 'dark', 'saved choice carries to another page');
nextPage.close();
page.choose('system');
assert.equal(page.window.localStorage.getItem('emage:theme'), null);
page.media.matches = false;
page.media.changed();
assert.equal(page.theme(), 'light', 'system preference changes are followed');
page.window.dispatchEvent(new page.window.StorageEvent('storage', { key: 'emage:theme', newValue: 'dark' }));
assert.equal(page.theme(), 'dark', 'another tab updates the current page');
assert.equal(page.select.value, 'dark');
page.window.dispatchEvent(new page.window.StorageEvent('storage', { key: null }));
assert.equal(page.theme(), 'light', 'clearing storage restores system preference');
page.close();

for (const options of [{ saved: 'invalid', dark: true }, { blocked: true }]) {
  const fallback = open(options);
  fallback.choose('dark');
  assert.equal(fallback.theme(), 'dark', 'theme switching works with invalid or unavailable storage');
  fallback.close();
}
console.log('PASS themes: early application, saved choice, system updates, cross-tab changes, unavailable storage');

for (const name of ['index.html', 'uploader.html', 'downloader.html', 'compare.html', 'blog.html', 'docs.html', 'running-locally.html', 'protocol.html', 'resolution-keys.html', 'experiment-methodology.html']) {
  const actual = open({ html: readFileSync(new URL(name, import.meta.url), 'utf8'), saved: 'dark' });
  assert.ok(actual.window.document.querySelector('head script[src="js/theme.js"]:not([defer]):not([async])'), name + ' loads the theme before paint');
  assert.ok(actual.window.document.querySelector('link[href="css/theme.css"]'), name + ' shares the same palette');
  assert.equal(actual.select.value, 'dark');
  actual.choose('light');
  assert.equal(actual.theme(), 'light', name + ' can change the shared theme');
  assert.equal(actual.window.localStorage.getItem('emage:theme'), 'light');
  actual.choose('system');
  actual.media.matches = true;
  actual.media.changed();
  assert.equal(actual.theme(), 'dark', name + ' follows system changes');
  actual.close();
}
console.log('PASS theme integration: all ten application/article pages load the shared palette and retain working saved/system theme controls');
