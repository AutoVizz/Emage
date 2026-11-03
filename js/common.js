import { Emage } from '../emage.js';
import { siteConfig } from './config.js';
export { Emage };
export const $ = (s, root = document) => root.querySelector(s);
export function serviceUrl(port, configured = '') {
  if (configured) return configured;
  const address = new URL(window.location.origin);
  if (address.hostname.endsWith('.github.io')) return port === 3233 ? 'http://localhost:3233' : '';
  if (address.hostname.startsWith('emage.')) {
    address.hostname = `${port === 3233 ? 'api' : 'api1'}.${address.hostname}`;
  } else address.port = String(port);
  return address.origin;
}
/* Shared helpers, data and sidebar for every Emage page. */
const ICONS = {
  up: 'M12 16V4M7 9l5-5 5 5M4 20h16', down: 'M12 4v12M7 11l5 5 5-5M4 20h16', bars: 'M5 20V11M12 20V4M19 20v-6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  lock: 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3', unlock: 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 7.5-2', copy: 'M9 9h11v11H9zM5 15V6a2 2 0 0 1 2-2h8',
  play: 'M7 5l12 7-12 7z', open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6L6 18',
  image: 'M4 4h16v16H4zM9 9h.01M20 15l-5-5L5 20', dice: 'M4 4h16v16H4zM9 9h.01M15 9h.01M9 15h.01M15 15h.01',
  key: 'M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 12l9-9M16 7l3 3', logo: 'M4 20a6 6 0 0 1 6-6M4 20a11 11 0 0 1 11-11M4 20A16 16 0 0 1 20 4'
};
export const icon = (n, s = 17, w = 1.8) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;
/* Sidebar: <aside id="side" data-active="upload|download|compare"></aside> */
function renderSidebar() {
  const side = $('#side'); if (!side) return;
  const pages = [['upload', 'index.html', 'up', 'Encrypt & upload'], ['download', 'downloader.html', 'down', 'Progressive download'], ['compare', 'compare.html', 'bars', 'Compare strategies'], ['blog', 'blog.html', 'bars', 'How Emage works']];
  side.className = 'side';
  side.innerHTML = `<div class="brand"><img class="logo" src="assets/emage-logo.png" width="38" height="38" alt="">Emage</div>
  <nav class="navwrap" aria-label="Pages"><span class="navlabel">WORKSPACE</span>${pages.map(p =>
    `<a class="nav" href="${p[1]}"${p[0] === side.dataset.active ? ' aria-current="page"' : ''}>${icon(p[2], 19)}${p[3].replace('&', '&amp;')}</a>`).join('')}</nav>
  <div class="apibox">API server<span><i class="dot"></i><b id="serverHost" class="mono">Not connected</b></span></div>`;
}

/* Fill every <i data-i="name" data-s="size"> placeholder with an icon. */
function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-i]').forEach(el => { el.outerHTML = icon(el.dataset.i, +el.dataset.s || 17); });
}

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmtBytes = n => {
  if (!Number.isFinite(n)) return '—';
  const unit = Math.min(3, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
  return `${(n / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};
export const dimensions = (meta, level) => {
  const scale = 2 ** (meta.layers - 1 - level);
  return `${Math.ceil(meta.width / scale)} × ${Math.ceil(meta.height / scale)}`;
};
export function setStatus(message, error = false) {
  $('#status span:last-child').textContent = message;
  $('#status').classList.toggle('error', error);
}
export function readStore(key, fallback, store = localStorage) {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function writeStore(key, value, store = localStorage) {
  try { store.setItem(key, JSON.stringify(value)); }
  catch { throw new Error('Browser storage is unavailable. Allow site storage to save keys.'); }
}
export function keyHex(value) {
  const key = value.trim().toLowerCase();
  if (key && !/^[a-f0-9]{64}$/.test(key)) throw new Error('Use a 64-digit hexadecimal AES-256 key, or leave it blank for plaintext.');
  return key;
}
export function loadKeys() {
  const saved = readStore('emage.keyring.v1', []);
  return (Array.isArray(saved) ? saved : []).filter(k => k && /^[a-f0-9]{64}$/i.test(k.key))
    .map(k => ({ id: k.key.toLowerCase(), key: k.key.toLowerCase(), label: String(k.label || 'Saved key') }));
}
export function lookupLevel(client, meta, key) {
  const map = meta?.metadata?.keyMap;
  if (!map || !key) return -1;
  try {
    const tag = client.keyLookupTag(key, map.iv);
    const level = Object.hasOwn(map.levels, tag) ? map.levels[tag] : -1;
    return Number.isInteger(level) && level >= 0 && level < meta.layers ? level : -1;
  } catch { return -1; }
}
export async function copyText(value, message = 'Copied to clipboard.') {
  try { await navigator.clipboard.writeText(value); setStatus(message); }
  catch { setStatus('Clipboard unavailable. Select the key text and copy it manually.', true); }
}

// Each operation gets its own configuration. Background browsing never changes
// a foreground upload path or the key used to encode the local codestream.
export class Page {
  constructor() {
    this.engine = null;
    this.busy = false;
    this.onSync = () => {};
    renderSidebar();
    hydrateIcons();
    const saved = readStore('emage.connection.v1', {}, sessionStorage);
    if (!saved.baseUrl) $('#serverUrl').value = serviceUrl(3233, siteConfig.apiUrl);
    for (const [id, name] of [['serverUrl', 'baseUrl'], ['imgPath', 'imagePath'], ['keyInput', 'key']]) {
      if (typeof saved[name] === 'string') $('#' + id).value = saved[name];
      $('#' + id).addEventListener('change', () => { this.remember(); this.updateHost(id === 'serverUrl' ? false : undefined); });
    }
    $('#retryInitBtn').onclick = () => { this.remember(); window.location.reload(); };
    this.updateHost();
    this.sync();
  }
  updateHost(connected) {
    const host = $('#serverHost');
    try { host.textContent = new URL($('#serverUrl').value).host; }
    catch { host.textContent = 'Invalid server URL'; }
    if (connected !== undefined) host.closest('.apibox').classList.toggle('connected', connected);
  }
  remember() {
    // Keep connection and current key across navigation in this tab. Passwords
    // are never persisted; the key ring is saved only through the Add action.
    try {
      sessionStorage.setItem('emage.connection.v1', JSON.stringify({ baseUrl: $('#serverUrl').value.trim(), imagePath: $('#imgPath').value.trim(), key: $('#keyInput').value.trim() }));
    } catch { /* the UI also works without storage */ }
  }
  client({ path = $('#imgPath').value.trim(), key = $('#keyInput').value.trim(), server = $('#serverUrl').value.trim(), password = $('#pwInput')?.value || '' } = {}) {
    if (!this.engine) throw new Error('WebAssembly codecs are still loading.');
    const url = new URL(server);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new Error('Enter an HTTP or HTTPS server URL without a query or fragment.');
    const client = new Emage();
    client.encoder = this.engine.encoder;
    client.decoder = this.engine.decoder;
    client.setServer({ baseUrl: server.replace(/\/+$/, ''), imagePath: path.split('/').map(encodeURIComponent).join('/'), password });
    client.setCrypto({ key: keyHex(key) || null, iv: null, accessLevel: 'all' });
    return client;
  }
  sync() {
    document.querySelectorAll('main button, main input').forEach(el => { el.disabled = !this.engine || this.busy; });
    if (!this.engine) { $('#serverUrl').disabled = false; $('#retryInitBtn').disabled = false; }
    if (this.engine && !this.busy) this.onSync();
    $('main').setAttribute('aria-busy', String(this.busy));
  }
  async init() {
    setStatus('Loading WebAssembly codecs…');
    try {
      this.engine = await Emage.init();
      this.sync();
      setStatus('Ready. Choose an image to get started.');
      return true;
    } catch (error) {
      $('#retryInitBtn').hidden = false;
      this.sync();
      setStatus('Could not load WebAssembly codecs: ' + Emage.messageOf(error) + '. Retry loading the page.', true);
      return false;
    }
  }
  async run(label, action) {
    if (!this.engine || this.busy) return;
    this.busy = true;
    this.remember();
    this.sync();
    setStatus(label);
    try { await action(); }
    catch (error) { setStatus(Emage.messageOf(error), true); }
    finally { this.busy = false; this.sync(); }
  }
}

// The API returns a flat list; folders are derived locally from its paths.
export class FileBrowser {
  constructor(page, { badges = false, onOpen, onSelect = () => {}, onUpdate = () => {} } = {}) {
    this.page = page;
    this.badges = badges;
    this.onOpen = onOpen;
    this.onSelect = onSelect;
    this.onUpdate = onUpdate;
    this.files = [];
    this.metas = new Map();
    this.cwd = '';
    this.selected = null;
    this.tick = 0;
    this.server = '';
    $('#serverUrl').addEventListener('change', () => {
      ++this.tick;
      this.files = [];
      this.metas.clear();
      this.cwd = '';
      this.selected = null;
      this.render();
      this.onUpdate();
    });
  }
  async refresh() {
    const tick = ++this.tick;
    const client = this.page.client({ key: '' });
    this.page.updateHost(false);
    // Clear stale paths even when the new server fails to respond.
    this.files = [];
    this.metas.clear();
    this.selected = null;
    this.render();
    const files = await client.list();
    if (tick !== this.tick) return;
    this.files = files.filter(f => typeof f.path === 'string');
    this.server = client.server.baseUrl;
    if (!this.files.some(f => f.path.startsWith(this.cwd))) this.cwd = '';
    this.page.updateHost(true);
    this.render();
    const queue = this.files.slice();
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && tick === this.tick) {
        const file = queue.shift();
        try {
          const meta = await client.meta({ imagePath: file.path.split('/').map(encodeURIComponent).join('/') });
          if (tick === this.tick) this.metas.set(file.path, meta);
        } catch { /* individual invalid codestreams remain visible */ }
      }
    }));
    if (tick !== this.tick) return;
    this.render();
    this.onUpdate();
    return this.files.length;
  }
  match(path) {
    const meta = this.metas.get(path);
    const current = $('#keyInput').value.trim();
    const candidates = [{ label: 'Current key', key: current }, ...loadKeys()];
    return candidates.find(k => lookupLevel(this.page.engine, meta, k.key) >= 0);
  }
  open(entry) {
    if (this.page.busy) return;
    if (entry.folder) {
      this.cwd = entry.path;
      this.selected = null;
      this.render();
      return;
    }
    this.selected = entry.path;
    $('#imgPath').value = entry.path;
    const match = this.match(entry.path);
    if (match) $('#keyInput').value = match.key;
    this.page.remember();
    this.render();
    this.onOpen?.(entry.path);
  }
  render() {
    const root = $('#fsView');
    root.replaceChildren();
    const folders = new Set();
    const entries = [];
    if (this.cwd) entries.push({ folder: true, name: '..', path: this.cwd.replace(/[^/]+\/$/, '') });
    for (const file of this.files) {
      if (!file.path.startsWith(this.cwd)) continue;
      const relative = file.path.slice(this.cwd.length);
      if (relative.includes('/')) folders.add(relative.split('/')[0]);
      else entries.push({ ...file, name: relative });
    }
    entries.splice(this.cwd ? 1 : 0, 0, ...[...folders].sort().map(name => ({ folder: true, name, path: this.cwd + name + '/' })));
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'row';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(entry.path === this.selected));
      const meta = this.metas.get(entry.path) || entry;
      const match = !entry.folder && this.match(entry.path);
      const badge = !this.badges || entry.folder ? '' : match
        ? `<span class="pill ok">${icon('unlock', 13)}${escapeHtml(match.label)}</span>`
        : meta.metadata?.keyMap ? `<span class="pill warn">${icon('lock', 13)}Locked</span>` : '<span class="pill">Unmapped</span>';
      const description = entry.folder ? 'Folder' : fmtBytes(meta.bytes) + (meta.width ? ` · ${meta.width} × ${meta.height} · ${meta.layers} levels` : '');
      button.innerHTML = `<span class="t">${icon(entry.folder ? 'folder' : 'image', 20)}</span><span class="n"><b class="mono">${escapeHtml(entry.name)}</b><span>${escapeHtml(description)}</span></span>${badge}`;
      button.onclick = () => {
        if (entry.folder) return this.open(entry);
        this.selected = entry.path;
        $('#imgPath').value = entry.path;
        this.page.remember();
        this.render();
        this.onSelect(entry.path);
      };
      button.ondblclick = () => this.open(entry);
      root.append(button);
    }
    if (!entries.length) root.innerHTML = '<p class="empty">No images in this folder.</p>';
    document.querySelectorAll('[data-cwd]').forEach(el => { el.textContent = '/' + this.cwd; });
    if ($('#count')) $('#count').textContent = `${entries.filter(e => e.name !== '..').length} entries`;
    this.page.sync();
  }
}

