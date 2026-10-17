// Real WASM codecs, generated fixtures, and page handlers. In-process DOM and
// protocol adapters keep this runnable without sockets. Proxy pacing is tested
// separately in Python; these timings are test timings, never article results.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { setMaxListeners } from 'node:events';
import { Emage } from './emage.js';

const require = createRequire(import.meta.url);
setMaxListeners(0);
const { JSDOM } = require('jsdom');
const root = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('demo-assets/manifest.json', root)));
const hash = value => createHash('sha256').update(value).digest('hex');
const wasm = new URL('cmake-build-wasm/', root);
const binary = name => 'data:application/wasm;base64,' + readFileSync(new URL(name, wasm)).toString('base64');
const engine = await Emage.init({
  encoder: () => require(new URL('EmageWasmEncoder.js', wasm).pathname)({ locateFile: () => binary('EmageWasmEncoder.wasm') }),
  decoder: () => require(new URL('EmageWasmDecoder.js', wasm).pathname)({ locateFile: () => binary('EmageWasmDecoder.wasm') }),
});
Emage.init = async () => engine;

function pngPixels(bytes) {
  const idat = [];
  let width, height;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') { width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12); assert.equal(bytes[offset + 16], 8); assert.equal(bytes[offset + 17], 2); }
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1);
    assert.equal(raw[start], 1);
    for (let x = 0; x < width * 3; x++) pixels[y * width * 3 + x] = (raw[start + 1 + x] + (x >= 3 ? pixels[y * width * 3 + x - 3] : 0)) & 255;
  }
  return pixels;
}
function record(bytes, image) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sot, payload;
  const packets = [];
  for (let offset = 2; offset < bytes.length;) {
    const marker = bytes[offset + 1];
    if (marker === 0x93) { payload = offset + 2; break; }
    const length = view.getUint16(offset + 2);
    if (marker === 0x90) sot = offset;
    if (marker === 0x58) {
      let packet = 0;
      for (let index = offset + 5; index < offset + length + 2; index++) {
        packet = packet * 128 + (bytes[index] & 127);
        if (!(bytes[index] & 128)) { packets.push(packet); packet = 0; }
      }
    }
    offset += length + 2;
  }
  assert.equal(packets.length, image.layers * 3);
  const sizes = Array.from({ length: image.layers }, (_, i) => packets.slice(i * 3, i * 3 + 3).reduce((a, b) => a + b, 0));
  assert.equal(payload + sizes.reduce((a, b) => a + b, 0) + 2, bytes.length);
  return { ...image, bytes, sizes, sot, payload, metadata: Emage.readMetadata(bytes) };
}
const images = new Map();
assert.equal(manifest.images.length, 10);
assert.equal(new Set(manifest.images.map(image => image.pixelSha256)).size, 10);
for (const image of manifest.images) {
  const png = readFileSync(new URL(image.png, root));
  const bytes = new Uint8Array(readFileSync(new URL(image.j2k, root)));
  assert.equal(hash(png), image.pngSha256);
  assert.equal(hash(bytes), image.j2kSha256);
  assert.equal(png.length, image.pngBytes);
  assert.equal(bytes.length, image.j2kBytes);
  assert.equal(hash(pngPixels(png)), image.pixelSha256);
  const decoded = engine.decode(bytes, { key: image.masterKey });
  const rgb = Buffer.alloc(image.width * image.height * 3);
  for (let i = 0, j = 0; i < decoded.rgbaPixels.length; i += 4, j += 3) rgb.set(decoded.rgbaPixels.subarray(i, i + 3), j);
  assert.equal(hash(rgb), image.pixelSha256, 'PNG and J2K encode the same source pixels');
  assert.ok(!Buffer.from(bytes).includes(Buffer.from(image.masterKey, 'hex')), 'raw key is absent from uploaded codestream');
  images.set(image.serverPath, record(bytes, image));
}
console.log('PASS blog assets: ten distinct sources, independently reconstructed PNG pixels, real lossless J2K roundtrips, no raw keys in codestreams');
function slice(image, first, last) {
  const start = image.payload + image.sizes.slice(0, first).reduce((a, b) => a + b, 0);
  const end = image.payload + image.sizes.slice(0, last + 1).reduce((a, b) => a + b, 0);
  if (first) return image.bytes.slice(start, end);
  const out = new Uint8Array(end + 2);
  out.set(image.bytes.subarray(0, end)); out.set([0xff, 0xd9], end);
  new DataView(out.buffer).setUint32(image.sot + 6, end - image.sot);
  return out;
}

let dom, requests = [], active = 0, peak = 0, configured = true;
let blockRequest = () => false;
const held = new Set(), cancelledRuns = [];
const transport = { emageOrigins: ['http://127.0.0.1:18001', 'http://127.0.0.1:18002'], pngOrigins: ['http://127.0.0.1:18003', 'http://127.0.0.1:18004'] };
const pools = new Map(), originPeaks = new Map();
async function connection(origin, signal) {
  signal?.throwIfAborted();
  const pool = pools.get(origin) || { count: 0, queue: [] };
  pools.set(origin, pool);
  if (pool.count < 6) pool.count++;
  else await new Promise((resolve, reject) => {
    const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
    const abort = () => { pool.queue.splice(pool.queue.indexOf(waiter), 1); reject(signal.reason); };
    pool.queue.push(waiter);
    signal?.addEventListener('abort', abort, { once: true });
  });
  originPeaks.set(origin, Math.max(originPeaks.get(origin) || 0, pool.count));
  return () => {
    if (pool.queue.length) pool.queue.shift().resolve();
    else pool.count--;
  };
}
function responseDelay(record, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const gate = { finish, record };
    const cleanup = () => { held.delete(gate); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    if (blockRequest(record)) held.add(gate);
    else setImmediate(finish);
  });
}
function releaseHeld() {
  blockRequest = () => false;
  for (const gate of [...held]) gate.finish();
}
const json = value => new Response(JSON.stringify(value));
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.pathname.endsWith('/demo-assets/manifest.json')) return json(manifest);
  if (url.pathname === '/demo/config') return configured ? json({ ready: true, images: 10, profiles: configured === 'old-profiles' ? {} : { demo: { bytesPerSecond: 2 * 1024 * 1024 } }, ...(configured === 'legacy' ? {} : { transport }) }) : new Response('No proxy', { status: 404 });
  if (url.pathname.startsWith('/demo/cancel/')) {
    assert.equal(options.method, 'POST');
    assert.equal(url.origin, window.location.origin, 'Stop uses a control origin outside gallery pools');
    cancelledRuns.push(url.pathname.split('/').at(-1));
    return json({ stopped: true });
  }
  const match = /^\/demo\/net\/([^/]+)\/([^/]+)\/([^/]+)\/(api|png)\/(.+)$/.exec(url.pathname);
  assert.ok(match, 'all demo image traffic uses the throttle proxy: ' + url.pathname);
  const [, profile, run, lane, kind, resource] = match;
  assert.ok(['slow', 'balanced', 'demo', 'fast'].includes(profile));
  assert.equal(options.method ?? 'GET', 'GET');
  assert.deepEqual(Object.keys(options.headers || {}), kind === 'api' ? ['X-Emage-Layers'] : [], 'no keys, passwords, or IVs are transmitted in headers');
  const record = { origin: url.origin, profile, run, lane, kind, resource, signal: options.signal, range: options.headers?.['X-Emage-Layers'], renderedFrames: lane === 'layers' ? document.querySelectorAll('#layerTimeline li').length : null };
  requests.push(record);
  const release = await connection(url.origin, options.signal);
  peak = Math.max(peak, ++active);
  try { await responseDelay(record, options.signal); }
  finally { --active; release(); }
  if (kind === 'png') {
    const image = manifest.images.find(image => resource === image.id + '.png');
    return new Response(readFileSync(new URL(image.png, root)));
  }
  const image = images.get(decodeURIComponent(resource).slice('image/'.length));
  assert.ok(image, 'request refers to a real sample');
  if (options.headers['X-Emage-Layers'] === 'meta') return json({ width: image.width, height: image.height, layers: image.layers, bytes: image.bytes.length, metadata: image.metadata });
  const range = options.headers['X-Emage-Layers'];
  const [first, last] = range === 'all' ? [0, image.layers - 1] : range.split(':').map(Number);
  return new Response(slice(image, first, last), { headers: first === 0 ? { 'X-Emage-TilePsotOffsets': String(image.sot + 6) } : {} });
};
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
const $ = selector => document.querySelector(selector);
async function idle() {
  for (let i = 0; i < 1000; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if ($('main').getAttribute('aria-busy') === 'false') return;
  }
  throw new Error('Blog UI operation timed out');
}
async function until(condition) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for network/experiment state');
}
async function click(selector) {
  assert.ok($(selector), selector + ' exists');
  assert.equal($(selector).disabled, false, selector + ' is enabled');
  $(selector).click();
  await idle();
}
function change(selector, value) {
  $(selector).value = value;
  $(selector).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}
async function open() {
  dom?.window.close();
  dom = new JSDOM(readFileSync(new URL('blog.html', root), 'utf8'), { url: 'http://localhost:8082/blog.html' });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    return { putImageData: value => { this.painted = value; }, drawImage: source => { this.painted = source.painted; } };
  };
  // The browser's ordinary image decoder is an adapter here; its actual file
  // bytes and pixels were validated independently above, not timed in tests.
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'src', {
    configurable: true,
    set(value) {
      this.download?.abort();
      this.download = new AbortController();
      this.setAttribute('src', value);
      fetch(value, { signal: this.download.signal }).then(response => response.arrayBuffer()).then(() => this.onload?.()).catch(() => this.onerror?.());
    },
    get() { return this.getAttribute('src'); },
  });
  const removeAttribute = dom.window.HTMLImageElement.prototype.removeAttribute;
  dom.window.HTMLImageElement.prototype.removeAttribute = function (name) {
    if (name === 'src') this.download?.abort();
    return removeAttribute.call(this, name);
  };
  await import(`./js/blog.js?test=${Date.now()}`);
  await idle();
}
await open();
assert.match($('#bootStatus').textContent, /Experiments ready/);
for (const select of document.querySelectorAll('[data-speed-select]')) assert.equal(select.value, 'demo', '2 MiB/s is the default for every experiment');
await click('#compareAll');
assert.equal($('#compareStatus').classList.contains('error'), false, $('#compareStatus').textContent);
const rows = [...document.querySelectorAll('#compareResults tr')];
assert.equal(rows.length, 12);
for (let index = 0; index < 12; index += 3) {
  assert.equal(rows[index].children[1].textContent, rows[index + 1].children[1].textContent, 'progressive and one-shot target transfer identical body bytes');
  assert.equal(rows[index].children[5].textContent, '256 × 176');
  assert.equal(rows[index + 2].children[5].textContent, '1024 × 704');
}
for (const index of [0, 1]) assert.match($(`#compareLevel${index}`).textContent, /Current level: L4 \/ L6 · 256 × 176/, 'target level remains visible after timing replaces telemetry');
assert.match($('#compareLevel2').textContent, /Current level: L6 \/ L6 · 1024 × 704/);
assert.deepEqual(requests.filter(request => request.range === 'meta').map(request => request.lane), Array.from({ length: 4 }, () => ['compare-0', 'compare-1', 'compare-2']).flat());
assert.deepEqual([...new Set(requests.map(request => request.profile))], ['slow', 'balanced', 'demo', 'fast']);
console.log('PASS blog comparison: twelve measured passes, four profiles including 2 MiB/s default, real target/full resolutions, bounded request ranges, equal A/B bytes');

requests = []; peak = 0;
originPeaks.clear();
blockRequest = request => request.kind === 'png';
$('#galleryRun').click();
await until(() => held.size === 10 && /10\/10 complete/.test($('#emageSummary').textContent));
assert.equal($('#pngGallery img').getAttribute('src') !== null, true);
assert.equal($('main').getAttribute('aria-busy'), 'true');
assert.equal($('[data-theme-select]').disabled, false, 'theme remains available during an experiment');
assert.match($('#pngSummary').textContent, /0\/10 loaded/);
assert.equal($('#stopExperiment').disabled, false);
assert.deepEqual(new Set(requests.filter(request => request.kind === 'api').map(request => request.origin)), new Set(transport.emageOrigins));
assert.deepEqual(new Set(requests.filter(request => request.kind === 'png').map(request => request.origin)), new Set(transport.pngOrigins));
for (const origin of [...transport.emageOrigins, ...transport.pngOrigins]) assert.equal(originPeaks.get(origin), 5, 'five images per independent HTTP/1.1 connection pool');
releaseHeld();
await idle();
assert.equal($('#galleryStatus').classList.contains('error'), false, $('#galleryStatus').textContent);
assert.ok(peak >= 20, 'all twenty loads are initiated without serializing individual images');
assert.equal(new Set(requests.filter(request => request.lane === 'gallery-emage').map(request => request.resource)).size, 10);
assert.equal(new Set(requests.filter(request => request.lane === 'gallery-png').map(request => request.resource)).size, 10);
assert.equal(new Set(requests.map(request => request.run)).size, 1, 'both galleries belong to one comparison run');
assert.match($('#emageSummary').textContent, /10\/10 previews · 10\/10 complete/);
assert.match($('#pngSummary').textContent, /10\/10 loaded/);
assert.equal(document.querySelectorAll('#pngGallery img').length, 10, 'normal baseline uses ten actual image elements');
console.log('PASS blog galleries: six-slot HTTP/1.1 pools enforced, four origins with five images each, all Emage levels finish while ten PNG transfers remain occupied');

requests = [];
change('#gallerySize', '2048');
await click('#galleryRun');
assert.equal(requests.length, 0, 'invalid widths do not start network work');
assert.equal($('#gallerySize').getAttribute('aria-invalid'), 'true');
assert.equal($('#gallerySizeError').hidden, false);
assert.match($('#gallerySizeError').textContent, /32 to 1024/);
assert.equal($('#galleryRun').disabled, false, 'validation does not leave the experiment locked');
change('#gallerySize', '1024');
$('#gallerySize').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
assert.equal($('#gallerySizeError').hidden, true, 'editing clears the inline error');
assert.equal($('#gallerySize').checkValidity(), true, 'full sample width is accepted by the HTML field');
await click('#galleryRun');
assert.equal($('#galleryStatus').classList.contains('error'), false, $('#galleryStatus').textContent);
assert.match($('#emageSummary').textContent, /10\/10 previews · 10\/10 complete/);
assert.match($('#pngSummary').textContent, /10\/10 loaded/);
for (let index = 0; index < 10; index++) {
  const image = manifest.images[index];
  assert.equal($('#galleryCanvas' + index).painted.width, image.width, '1024 target decodes the full source width');
  assert.equal($('#galleryCanvas' + index).painted.height, image.height);
  assert.match($('#emageState' + index).textContent, /L6 · 1024 × 704/);
  const imageRequests = requests.filter(request => request.kind === 'api' && request.resource.endsWith(image.id + '.j2k'));
  assert.deepEqual(imageRequests.map(request => request.range), ['meta', '0:0', '1:1', '2:2', '3:3', '4:4', '5:5', '6:6'], 'full-size target preserves progressive windows');
}
change('#gallerySize', '256');
console.log('PASS gallery width: inline validation recovers, 1024 loads all ten full-resolution images progressively and all ten PNGs');

// Stop must cancel real pending work, release all slots, and allow another test.
requests = [];
blockRequest = request => request.kind === 'png' || request.range === '1:1';
$('#galleryRun').click();
await until(() => held.size === 20);
const oldRun = requests[0].run;
await click('#stopExperiment');
assert.match($('#galleryStatus').textContent, /Experiment stopped/);
assert.equal($('#galleryStatus').classList.contains('error'), false);
assert.equal(active, 0);
assert.equal(held.size, 0);
assert.ok(requests.every(request => request.signal.aborted));
assert.ok(cancelledRuns.includes(oldRun));
assert.ok([...document.querySelectorAll('#pngGallery img')].every(img => !img.hasAttribute('src')), 'Stop removes all unfinished image sources');
assert.equal($('#experimentControls').hidden, true);
assert.equal($('#compareRun').disabled, false);
assert.equal($('#gallerySpeed').disabled, false);
const countAfterStop = requests.length;
releaseHeld();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(requests.length, countAfterStop, 'stopped gallery never requests later zones');
assert.match($('#galleryStatus').textContent, /Experiment stopped/, 'stopped callbacks cannot overwrite the result');

requests = [];
blockRequest = request => request.range === '1:1';
$('#compareAll').click();
await until(() => held.size === 1);
assert.match($('#compareLevel0').textContent, /Current level: L0 \/ L6 · 16 × 11/, 'current level reflects decoded frame while L1 is still downloading');
assert.match($('#compareLevel1').textContent, /waiting for a frame/, 'a pass that has not started does not claim a decoded level');
await click('#stopExperiment');
assert.match($('#compareLevel0').textContent, /Current level: L0 \/ L6/, 'stopped run retains the level of its last visible frame');
assert.equal(new Set(requests.map(request => request.profile)).size, 1, 'Stop prevents future profiles in a comparison batch');
assert.match($('#compareStatus').textContent, /Experiment stopped/);
releaseHeld();
console.log('PASS blog Stop: active PNG and packet transfers abort, proxy run is cancelled, six-slot pools release, settings and other experiments unlock, later profiles never start');

requests = [];
change('#layerLimit', '3');
await click('#layerRun');
assert.equal($('#layerStatus').classList.contains('error'), false, $('#layerStatus').textContent);
assert.deepEqual(requests.map(request => request.range), ['meta', '0:0', '1:1', '2:2', '3:3']);
assert.deepEqual(requests.slice(1).map(request => request.renderedFrames), [0, 1, 2, 3], 'each prior frame is decoded and painted before requesting the next zone');
assert.equal(document.querySelectorAll('#layerTimeline li').length, 4);
assert.match($('#layerStage').textContent, /Current level: L3 \/ L6 · 128 × 88/);
assert.equal($('#layerButtons [data-layer-view="4"]').disabled, true);
requests = [];
for (let level = 0; level <= 3; level++) {
  await click(`#layerButtons [data-layer-view="${level}"]`);
  assert.equal($('#layerCanvas').painted.width, 1024 / 2 ** (6 - level));
  assert.match($('#layerStage').textContent, new RegExp(`Current level: L${level} / L6`), 'cached replay updates the displayed current level');
}
assert.equal(requests.length, 0, 'layer buttons never fetch');
console.log('PASS blog layers: incremental real progressive frames, no duplicate windows, local-only replay, unfetched levels disabled');

for (const button of ['#layerRun', '#ownerRun', '#readerRun']) {
  requests = [];
  blockRequest = () => true;
  if (button === '#readerRun') $('#readerKey').value = manifest.images[0].masterKey;
  $(button).click();
  await until(() => held.size === 1);
  await click('#stopExperiment');
  assert.equal(active, 0);
  assert.equal(held.size, 0);
  assert.ok(requests.every(request => request.signal.aborted));
  releaseHeld();
}
// Even a paused rendering loop must not prevent Stop from settling a run.
const paintController = new AbortController();
const raf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = () => 99999;
const paint = engine._yieldForPaint(paintController.signal);
paintController.abort();
await assert.rejects(paint, { name: 'AbortError' });
globalThis.requestAnimationFrame = raf;
console.log('PASS blog Stop: layer and both access panes cancel metadata, and abort breaks a paused animation-frame wait');

await click('#ownerRun');
assert.match($('#ownerStatus').textContent, /Key grants L0–L6/);
assert.equal(document.querySelectorAll('[data-key-use]').length, 7);
assert.equal(document.querySelectorAll('#ownerKeys .key-heading strong sub').length, 7, 'key indices are rendered as subscripts');
for (let level = 0; level < 7; level++) {
  requests = [];
  await click(`[data-key-use="${level}"]`);
  assert.equal(requests.length, 0, 'selecting an owner key only fills the reader input');
  await click('#readerRun');
  assert.equal($('#readerStatus').classList.contains('error'), false, $('#readerStatus').textContent);
  assert.match($('#readerStatus').textContent, new RegExp(`Key grants L0–L${level}`));
  assert.equal($('#readerCanvas').painted.width, 1024 / 2 ** (6 - level));
  assert.deepEqual(requests.map(request => request.range), ['meta', ...Array.from({ length: level + 1 }, (_, n) => `${n}:${n}`)]);
}
$('#readerKey').value = 'ff'.repeat(32);
$('#readerKey').dispatchEvent(new dom.window.Event('input'));
requests = [];
await click('#readerRun');
assert.equal($('#readerStatus').classList.contains('error'), true);
assert.match($('#readerStatus').textContent, /does not match/);
assert.deepEqual(requests.map(request => request.range), ['meta']);
assert.equal($('#readerCanvas').width, 0, 'failed grants never show the previous authenticated image');
$('#readerKey').value = '';
requests = [];
await click('#readerRun');
assert.equal(requests.length, 0, 'empty key never falls back to the master');
console.log('PASS blog access: owner derives seven keys, every reader grant is enforced, unrelated key stops before packets, blank key never substitutes master');

// Cancellation must still work after fetch has resolved its response headers
// and the browser is waiting for the rest of the body.
const ordinaryFetch = globalThis.fetch;
try {
  const image = manifest.images[0];
  const instance = new Emage();
  instance.encoder = engine.encoder;
  instance.decoder = engine.decoder;
  instance.setServer({ baseUrl: 'http://localhost:8082', imagePath: image.serverPath });
  instance.setCrypto({ key: image.masterKey });
  for (const phase of ['meta', 'packets']) {
    const controller = new AbortController();
    let bodySignal = null;
    globalThis.fetch = async (_, options) => {
      if (phase === 'packets' && options.headers['X-Emage-Layers'] === 'meta') {
        const stored = images.get(image.serverPath);
        return json({ width: stored.width, height: stored.height, layers: stored.layers, bytes: stored.bytes.length, metadata: stored.metadata });
      }
      bodySignal = options.signal;
      assert.equal(bodySignal, controller.signal);
      return new Response(new ReadableStream({ start(stream) {
        bodySignal.addEventListener('abort', () => stream.error(bodySignal.reason), { once: true });
      } }));
    };
    const pending = phase === 'meta' ? instance.meta({ signal: controller.signal }) : instance.display(256, { signal: controller.signal, progressive: false });
    await until(() => bodySignal !== null);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
} finally { globalThis.fetch = ordinaryFetch; }
console.log('PASS cancellation after response headers: both metadata and packet body reads abort');

configured = false;
await open();
assert.match($('#bootStatus').textContent, /npm run blog/);
assert.equal($('#compareRun').disabled, true);
assert.equal($('#galleryRun').disabled, true);
assert.ok(document.querySelector('#protocol').textContent.includes('Protocol overview'));
configured = 'legacy';
await open();
assert.equal($('#galleryRun').disabled, true, 'old single-origin proxies fail closed instead of silently recreating contention');
assert.match($('#bootStatus').textContent, /restart/);
configured = 'old-profiles';
await open();
assert.equal($('#galleryRun').disabled, true, 'an old proxy without the new profile explains that a restart is required');
assert.match($('#bootStatus').textContent, /restart.*2 MiB\/s/);
dom.window.close();
console.log('PASS blog setup: plain static hosting leaves readable article and explains the missing proxy');
console.log('ALL BLOG CHECKS PASSED');
