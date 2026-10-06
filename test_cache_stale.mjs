// Does the server serve stale bytes after a re-upload to the same path?
// J2kImageLibrary caches the parsed codestream keyed by full path; UploadImage
// writes the file but may not invalidate that entry.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const CLIENT = '/home/saturn/CLionProjects/EmageClient';
const WASM = CLIENT + '/cmake-build-wasm';
const { Emage } = await import(CLIENT + '/emage.js');

const dataUrl = (b) => 'data:application/wasm;base64,' +
    fs.readFileSync(WASM + '/' + b).toString('base64');

const emage = await Emage.init({
    encoder: () => require(WASM + '/EmageWasmEncoder.js')({
        locateFile: () => dataUrl('EmageWasmEncoder.wasm') }),
    decoder: () => require(WASM + '/EmageWasmDecoder.js')({
        locateFile: () => dataUrl('EmageWasmDecoder.wasm') }),
});

const PATH = 'cache-probe.j2k';
const base = process.env.EMAGE_BASE || 'http://localhost:3233';
emage.setServer({ baseUrl: base, imagePath: PATH, password: process.env.EMAGE_PASSWORD || '' });
emage.setCrypto({ accessLevel: -1 });

// Two clearly different images: 64x64 solid-ish vs 128x128.
const solid = new Uint8Array(64 * 64 * 3).fill(200);
const grad = new Uint8Array(128 * 128 * 3);
for (let i = 0; i < grad.length; ++i) grad[i] = (i * 7) & 0xff;

const enc1 = await emage.encodePixelData(solid, 64, 64, {
    numComponents: 3, numResolutions: 4, numLayers: 1, enableSec: false });
const enc2 = await emage.encodePixelData(grad, 128, 128, {
    numComponents: 3, numResolutions: 4, numLayers: 1, enableSec: false });

const up1 = await emage.upload(enc1);
console.log(`        upload #1 -> ${up1.width}x${up1.height} bytes=${up1.bytes}`);

// Populate the server's parse cache.
const m1 = await emage.meta();
const s1 = await emage._stream();
console.log(`        meta     -> ${m1.width}x${m1.height}, fetch ${s1.length} bytes`);
const d1 = await emage.decode(s1);
console.log(`        decoded  -> ${d1.width}x${d1.height}`);

// Re-upload a DIFFERENT image to the same path.
const up2 = await emage.upload(enc2);
console.log(`        upload #2 -> ${up2.width}x${up2.height} bytes=${up2.bytes}`);

const m2 = await emage.meta();
const s2 = await emage._stream();
const d2 = await emage.decode(s2);
console.log(`        meta     -> ${m2.width}x${m2.height}, fetch ${s2.length} bytes`);
console.log(`        decoded  -> ${d2.width}x${d2.height}`);

console.log('');
const staleMeta = !(m2.width === 128 && m2.height === 128);
const staleBytes = s2.length === s1.length;
console.log(staleMeta || staleBytes
    ? 'RESULT: STALE — the server is still serving the first upload'
    : 'RESULT: FRESH — the cache is correctly invalidated on upload');

if (staleMeta) console.log(`        meta still reports ${m2.width}x${m2.height}, expected 128x128`);
if (staleBytes) console.log(`        fetch still returns ${s2.length} bytes, same as before the re-upload`);
console.log(`        stored on disk: ${(await (await fetch(`${base}/image/${PATH}`, {headers:{'X-Emage-Layers':'meta'}})).text()).slice(0,120)}`);

await emage.remove();
