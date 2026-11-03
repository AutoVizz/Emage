import { wasmDir } from './wasm_test_path.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Exercise the page event handlers with the real WASM codecs. The DOM canvas
// and HTTP transport are adapters so these checks do not require a browser,
// listening socket, or a running server. Server-style slices use actual PLT
// packet lengths; they do not decrypt or inspect key material.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Emage } from './emage.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const wasm = pathToFileURL(path.resolve(wasmDir) + path.sep);
const binary = name => 'data:application/wasm;base64,' + readFileSync(new URL(name, wasm)).toString('base64');
const engine = await Emage.init({
  encoder: () => require(new URL('EmageWasmEncoder.js', wasm).pathname)({ locateFile: () => binary('EmageWasmEncoder.wasm') }),
  decoder: () => require(new URL('EmageWasmDecoder.js', wasm).pathname)({ locateFile: () => binary('EmageWasmDecoder.wasm') }),
});
Emage.init = async () => engine;
const W = 128, H = 64;
const pixels = Uint8ClampedArray.from({ length: W * H * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 7) & 255);
let dom;
let requests = [];
let copied = '';
let downloaded = null;
let failListing = false;
const store = new Map();
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.innerWidth = 1280;
globalThis.innerHeight = 900;
globalThis.devicePixelRatio = 1;
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.Image = class {
  naturalWidth = W;
  naturalHeight = H;
  async decode() { if (this.src === 'blob:invalid') throw new Error('Invalid source image'); }
};
URL.createObjectURL = blob => { downloaded = blob; return 'blob:fixture'; };
URL.revokeObjectURL = () => {};

function record(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, layers, sot, payload;
  const packets = [];
  for (let offset = 2; offset < bytes.length;) {
    const marker = bytes[offset + 1];
    if (marker === 0x93) { payload = offset + 2; break; }
    const length = view.getUint16(offset + 2);
    if (marker === 0x51) {
      width = view.getUint32(offset + 6) - view.getUint32(offset + 14);
      height = view.getUint32(offset + 10) - view.getUint32(offset + 18);
    }
    if (marker === 0x52) layers = bytes[offset + 9] + 1;
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
  assert.equal(packets.length % layers, 0);
  const perLevel = packets.length / layers;
  const sizes = Array.from({ length: layers }, (_, i) => packets.slice(i * perLevel, (i + 1) * perLevel).reduce((a, b) => a + b, 0));
  assert.equal(payload + sizes.reduce((a, b) => a + b, 0) + 2, bytes.length);
  return { bytes, width, height, layers, sizes, sot, payload, metadata: Emage.readMetadata(bytes) };
}
function slice(image, first, last) {
  const start = image.payload + image.sizes.slice(0, first).reduce((a, b) => a + b, 0);
  const end = image.payload + image.sizes.slice(0, last + 1).reduce((a, b) => a + b, 0);
  if (first) return image.bytes.slice(start, end);
  const out = new Uint8Array(end + 2);
  out.set(image.bytes.subarray(0, end));
  out.set([0xff, 0xd9], end);
  new DataView(out.buffer).setUint32(image.sot + 6, end - image.sot);
  return out;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
globalThis.fetch = async (url, options = {}) => {
  const path = decodeURIComponent(new URL(url).pathname);
  requests.push({ path, ...options });
  if (path === '/images') {
    if (failListing) throw new Error('Server unavailable');
    return json([...store].map(([path, image]) => ({ path, width: image.width, height: image.height, layers: image.layers, bytes: image.bytes.length })));
  }
  assert.ok(path.startsWith('/image/'));
  const name = path.slice('/image/'.length);
  if (options.method === 'POST' || options.method === 'DELETE') {
    assert.equal(Object.keys(options.headers).some(key => /key|iv/i.test(key)), false, 'keys and IVs never appear as request headers');
    if (options.headers['X-Emage-Password'] !== 'fixture-password') return json('Unauthorized', 401);
    if (options.method === 'DELETE') { store.delete(name); return json({ deleted: name }); }
    const image = record(Uint8Array.from(options.body));
    store.set(name, image);
    return json({ stored: name, width: image.width, height: image.height, layers: image.layers, bytes: image.bytes.length, metadata: image.metadata });
  }
  const image = store.get(name);
  if (!image) return json('Not found', 404);
  const range = options.headers['X-Emage-Layers'];
  if (range === 'meta') return json({ width: image.width, height: image.height, layers: image.layers, bytes: image.bytes.length, metadata: image.metadata });
  const [first, last] = range === 'all' ? [0, image.layers - 1] : range.split(':').map(Number);
  const body = slice(image, first, last);
  return new Response(body, { headers: first === 0 ? { 'X-Emage-TilePsotOffsets': String(image.sot + 6) } : {} });
};

const $ = selector => document.querySelector(selector);
const status = () => $('#status').textContent.trim();
async function idle() {
  for (let i = 0; i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if ($('main').getAttribute('aria-busy') === 'false') return;
  }
  throw new Error('UI operation timed out: ' + status());
}
async function click(selector) {
  const button = $(selector);
  assert.ok(button, 'element exists: ' + selector);
  assert.equal(button.disabled, false, 'button enabled: ' + selector);
  button.click();
  await idle();
}
function change(selector, value) {
  $(selector).value = value;
  $(selector).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}
function file(selector, name, bytes) {
  const input = $(selector);
  Object.defineProperty(input, 'files', { configurable: true, value: [new dom.window.File([bytes], name)] });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}
async function openPage(name, pageUrl = 'http://localhost:8080/') {
  dom?.window.close();
  dom = new JSDOM(readFileSync(new URL(name === 'uploader' ? './index.html' : `./${name}.html`, import.meta.url), 'utf8'), { url: pageUrl, runScripts: 'outside-only' });
  dom.window.localStorage.setItem('emage:theme', 'dark');
  dom.window.eval(readFileSync(new URL('js/theme.js', import.meta.url), 'utf8'));
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.FileReader = dom.window.FileReader;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value; } } } });
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    return { getImageData: () => ({ data: pixels }), drawImage() {}, putImageData: data => { this.painted = data; } };
  };
  dom.window.HTMLAnchorElement.prototype.click = function () {};
  await import(`./js/${name}.js?test=${Date.now()}`);
  await idle();
  const theme = document.querySelector('[data-theme-select]');
  assert.equal(theme.disabled, false, name + ' theme control stays enabled after initialization');
  assert.equal(document.documentElement.dataset.theme, 'dark', name + ' honors the saved article theme');
  theme.value = 'light';
  theme.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.documentElement.dataset.theme, 'light', name + ' theme control works alongside page handlers');
  theme.value = 'dark';
  theme.dispatchEvent(new dom.window.Event('change'));
  assert.match(document.querySelector('.brand img').src, /assets\/emage-logo\.png$/, name + ' uses the transparent logo');
}
await openPage('uploader');
assert.equal($('#processBtn').disabled, true);
assert.equal($('#upBtn').disabled, true);
assert.match($('#keyInput').value, /^[0-9a-f]{64}$/);
const master = $('#keyInput').value;
file('#fileInput', 'source.png', [1, 2]);
await idle();
assert.equal($('#layerInput').max, '7');
assert.equal($('#sourceSize').textContent, '128 × 64');
await click('#processBtn');
assert.equal($('#dstCanvas').width, W);
assert.equal($('#dstCanvas').height, H);
assert.deepEqual($('#dstCanvas').painted.data, pixels);
assert.equal(document.querySelectorAll('[data-copy]').length, 6);
assert.match(status(), /MAC chain verified/);
const keys = [...document.querySelectorAll('[data-copy]')].map(button => button.dataset.copy);
await click('#copyKeysBtn');
assert.ok(copied.includes(keys[0]) && copied.includes(keys[5]));
change('#krLabel', '<img src=x onerror=alert(1)>');
await click('#krAddBtn');
assert.equal($('#krList img'), null, 'saved labels are escaped');
change('#imgPath', 'studio/special # &.j2k');
requests = [];
await click('#upBtn');
assert.match(status(), /Enter the server upload password/);
assert.equal(requests.length, 0, 'blank password is rejected before sending an upload');
change('#pwInput', 'wrong');
await click('#upBtn');
assert.match(status(), /401/);
assert.match(status(), /Password field/);
assert.equal(status().includes('raw'), false, 'empty unauthorized responses explain how to fix authentication');
assert.equal(store.size, 0);
change('#pwInput', 'fixture-password');
// Upload must retain the encoding key even after the input key changes.
change('#keyInput', keys[1]);
await click('#upBtn');
assert.equal(store.size, 1);
const encrypted = store.get('studio/special # &.j2k');
assert.deepEqual(engine.decode(encrypted.bytes, { key: master }).rgbaPixels, pixels);
assert.match(status(), /Uploaded/);
await click('#downloadBtn');
assert.equal(downloaded.size, encrypted.bytes.length);
await click('#decodeBtn');
assert.equal($('#dstCanvas').width, 8);
assert.equal(document.querySelectorAll('[data-copy]').length, 2, 'imported/restricted keys never display finer keys');
file('#j2kInput', 'existing.j2k', encrypted.bytes);
await idle();
await click('#decodeBtn');
assert.equal($('#dstCanvas').width, 8);
assert.match(status(), /MAC chain verified/);
// Encryption is an encoding option; plaintext works even with an invalid key.
$('#enc').checked = false;
$('#enc').dispatchEvent(new dom.window.Event('change'));
change('#keyInput', 'invalid');
await click('#processBtn');
assert.match(status(), /plaintext/);
assert.equal(document.querySelectorAll('[data-copy]').length, 0);
change('#imgPath', 'plain.j2k');
await click('#upBtn');
assert.equal(engine.describeSecurityZone(store.get('plain.j2k').bytes).hasSec, 0);
console.log('PASS uploader: real encode/decode, granular keys, import, upload authentication, downloads, plaintext, escaped saved keys');

change('#imgPath', 'studio/special # &.j2k');
change('#keyInput', keys[2]);
await openPage('downloader');
requests = [];
await click('#fullBtn');
assert.match(status(), /MAC chain verified/);
assert.equal($('#dstCanvas').width, 16);
assert.equal($('#levels [data-level="3"]').disabled, true);
assert.equal($('#levels [data-level="2"]').disabled, false);
assert.deepEqual(requests.map(r => r.headers?.['X-Emage-Layers']), ['meta', '0:0', '1:1', '2:2']);
const bytesText = $('#bytesText').textContent;
const zones = $('#zones').innerHTML;
requests = [];
await click('#levels [data-level="0"]');
assert.equal($('#dstCanvas').width, 4);
await click('#levels [data-level="1"]');
assert.equal($('#dstCanvas').width, 8);
await click('#levels [data-level="2"]');
assert.equal($('#dstCanvas').width, 16);
assert.equal($('#levels [data-level="2"]').getAttribute('aria-pressed'), 'true');
assert.equal(requests.length, 0, 'switching among downloaded levels makes no HTTP requests');
assert.equal($('#bytesText').textContent, bytesText, 'level selection preserves transfer totals');
assert.equal($('#zones').innerHTML, zones, 'viewing a coarser level does not discard downloaded zones');
change('#sizeInput', '200');
requests = [];
await click('#sizeBtn');
assert.equal($('#dstCanvas').width, 16, 'display scaling does not bypass the key resolution limit');
assert.equal($('#dstCanvas').style.width, '200px');
assert.equal($('#dstCanvas').style.height, '100px');
assert.equal($('#levels [data-level="3"]').disabled, true);
assert.deepEqual(requests.map(r => r.headers?.['X-Emage-Layers']), ['meta', '0:0', '1:1', '2:2']);
change('#keyInput', master);
change('#sizeInput', '8');
await click('#sizeBtn');
assert.equal($('#levels [data-level="2"]').dataset.locked, 'false');
assert.equal($('#levels [data-level="2"]').disabled, true, 'granted but unfetched levels require an explicit bottom load button');
assert.equal($('#dstCanvas').style.width, '8px');
assert.equal($('#dstCanvas').style.height, '4px');
change('#sizeInput', '11');
requests = [];
await click('#sizeBtn');
assert.equal($('#dstCanvas').width, 8, 'arbitrary display sizes retain the selected DWT raster');
assert.equal($('#dstCanvas').style.width, '11px', 'requested pixels control the displayed size');
assert.equal($('#dstCanvas').style.height, '6px', 'the display preserves the image aspect ratio');
assert.match($('#stageText').textContent, /11 × 6 displayed · 8 × 4 decoded/);
assert.deepEqual(requests.map(r => r.headers?.['X-Emage-Layers']), ['meta', '0:0', '1:1'], 'sizing does not fetch finer packets');
change('#sizeInput', '10vw');
await click('#sizeBtn');
assert.equal($('#dstCanvas').style.width, `${Math.round(window.innerWidth / 10)}px`);
const viewerStyle = document.createElement('style');
viewerStyle.textContent = readFileSync(new URL('css/style.css', import.meta.url), 'utf8');
document.head.append(viewerStyle);
assert.equal(window.getComputedStyle($('#dstCanvas')).position, 'static', 'the downloader no longer stretches the canvas across the preview');
assert.equal(window.getComputedStyle($('#dstCanvas')).padding, '0px');
change('#sizeInput', '8');
await click('#sizeBtn');

requests = [];
$('#levels [data-level="2"]').click();
await click('#levels [data-level="0"]');
await click('#levels [data-level="1"]');
assert.equal(requests.length, 0, 'local rendering after a partial download never refetches');
await click('#fullBtn');
assert.ok(requests.length > 0, 'Load full explicitly refetches');
assert.equal($('#dstCanvas').style.width, '128px', 'Load full resets the preview to the accessible native size');
assert.equal($('#levels [data-level="5"]').disabled, false);
requests = [];
await click('#metaBtn');
assert.equal(requests.length, 1);
assert.equal(requests[0].headers['X-Emage-Layers'], 'meta');
assert.ok([...document.querySelectorAll('#levels button')].every(button => button.disabled), 'metadata alone does not enable local level rendering');
requests = [];
const downloadFolder = [...document.querySelectorAll('#fsView button')].find(button => button.textContent.includes('studio'));
downloadFolder.click();
const downloadFile = [...document.querySelectorAll('#fsView button')].find(button => button.textContent.includes('special # &.j2k'));
downloadFile.click();
downloadFile.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
await idle();
assert.equal(requests.length, 0, 'selecting or double-clicking a file waits for a bottom load button');
change('#keyInput', 'ff'.repeat(32));
requests = [];
await click('#fullBtn');
assert.match(status(), /does not match/);
assert.equal(requests.length, 1, 'wrong key rejected before packet download');
assert.equal($('#dstCanvas').width, 0, 'stale image cleared on key change');
change('#imgPath', 'plain.j2k');
change('#keyInput', '');
change('#sizeInput', '200');
await click('#sizeBtn');
assert.match(status(), /plaintext/);
assert.equal($('#dstCanvas').style.width, '200px', 'plaintext also honors sizes larger than the source');
assert.equal($('#dstCanvas').style.height, '100px');
requests = [];
await click('#levels [data-level="1"]');
assert.equal($('#dstCanvas').width, 8);
assert.equal(requests.length, 0, 'plaintext resolution switching also uses downloaded bytes');
change('#sizeInput', 'nonsense');
await click('#sizeBtn');
assert.equal($('#status').classList.contains('error'), true);
change('#imgPath', 'missing.j2k');
await click('#metaBtn');
assert.match(status(), /404/);
console.log('PASS downloader: real packet windows, restricted and wrong keys, level selection, plaintext, invalid target, missing image');

change('#imgPath', 'studio/special # &.j2k');
change('#keyInput', keys[2]);
await openPage('compare');
change('#sizeInput', '8');
requests = [];
await click('#runBtn');
assert.match(status(), /all decoded MAC chains verified/);
assert.equal($('#canvas0').width, 8);
assert.equal($('#canvas1').width, 8);
assert.equal($('#canvas2').width, 16);
assert.equal(requests.filter(request => request.headers?.['X-Emage-Layers'] === 'meta').length, 3);
assert.deepEqual(requests.map(request => request.headers?.['X-Emage-Layers']), ['meta', '0:0', '1:1', 'meta', '0:1', 'meta', '0:2']);
assert.ok($('#tbl').textContent.includes('Best'));
assert.ok(!$('#tele0').textContent.includes('No measurements'));
change('#imgPath', 'plain.j2k');
change('#keyInput', '');
await click('#runBtn');
assert.match(status(), /plaintext image/);
console.log('PASS compare: three real sequential strategies, target and granted dimensions, measured telemetry, plaintext');

await openPage('uploader');
change('#pwInput', 'fixture-password');
const folder = [...document.querySelectorAll('#fsView button')].find(button => button.textContent.includes('studio'));
folder.click();
const image = [...document.querySelectorAll('#fsView button')].find(button => button.textContent.includes('special # &.j2k'));
image.click();
await click('#delBtn');
assert.equal(store.has('studio/special # &.j2k'), false);
assert.match(status(), /Deleted/);
failListing = true;
await click('#galleryBtn');
assert.match(status(), /Server unavailable/);
assert.equal($('#delBtn').disabled, true);
assert.equal($('#fsView').textContent.includes('special # &.j2k'), false);
change('#serverUrl', 'http://other-server:3233');
assert.equal($('#fsView button'), null, 'switching server clears stale selection');
console.log('PASS browser: real listing, folder navigation, saved-key coverage, delete, server failure, server switch');
globalThis.sessionStorage = storage();
failListing = false;
await openPage('uploader', 'http://203.0.113.10:3433/');
assert.equal($('#serverUrl').value, 'http://203.0.113.10:3233', 'raw-IP deployment infers the API host');
console.log('PASS cohosted client: API defaults to the page host on port 3233');
globalThis.sessionStorage = storage();
await openPage('uploader', 'https://emage.gqvz.xyz/');
assert.equal($('#serverUrl').value, 'https://api-emage.gqvz.xyz');
const { serviceUrl } = await import('./js/common.js');
assert.equal(serviceUrl(3434), 'https://api1-emage.gqvz.xyz');
dom.window.close();
console.log('ALL UI INTEGRATION CHECKS PASSED');
