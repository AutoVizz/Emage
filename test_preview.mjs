import { wasmDir } from './wasm_test_path.mjs';
// Preview / thumbnail path across access levels, against the live server.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const CLIENT = '/home/saturn/CLionProjects/EmageClient';
const WASM = wasmDir;
const { Emage } = await import(CLIENT + '/emage.js');

const dataUrl = (b) => 'data:application/wasm;base64,' +
    fs.readFileSync(WASM + '/' + b).toString('base64');

const emage = await Emage.init({
    encoder: () => require(WASM + '/EmageWasmEncoder.js')({
        locateFile: () => dataUrl('EmageWasmEncoder.wasm') }),
    decoder: () => require(WASM + '/EmageWasmDecoder.js')({
        locateFile: () => dataUrl('EmageWasmDecoder.wasm') }),
});

let failed = 0;
const check = (c, m) => { if (!c) failed++; console.log((c ? 'PASS  ' : 'FAIL  ') + m); };
const log = m => console.log('        ' + m);

const W = 320, H = 240, RES = 6;
const KEY = new Uint8Array(32).fill(0x11);
const IV = new Uint8Array(16).fill(0x22);
const PATH = 'preview-probe.j2k';

// A smooth gradient plus a gradient ramp, so a coarse level is genuinely
// representative rather than noise.
const px = new Uint8Array(W * H * 3);
for (let y = 0; y < H; ++y) {
    for (let x = 0; x < W; ++x) {
        const i = (y * W + x) * 3;
        px[i] = Math.floor((x / W) * 255);
        px[i + 1] = Math.floor((y / H) * 255);
        px[i + 2] = 128;
    }
}

emage.setServer({
    baseUrl: process.env.EMAGE_BASE || 'http://localhost:3233',
    imagePath: PATH,
    password: process.env.EMAGE_PASSWORD || '',
});
emage.setCrypto({ key: KEY, iv: IV, accessLevel: -1 });

const stream = await emage.encodePixelData(px, W, H, {
    numComponents: 3, numResolutions: RES, numLayers: 1, enableSec: true,
});
const up = await emage.upload(stream);
check(Object.keys(up.metadata?.keyMap?.levels || {}).length === RES,
    'server returns the complete opaque lookup map from the image header');
log(`uploaded ${up.stored} ${up.width}x${up.height} layers=${up.layers} bytes=${up.bytes}`);
check(up.layers === RES, `server parsed layers=${up.layers}`);

const keys = emage.granularKeys(RES);

// ---- preview at every access level -------------------------------------
for (let a = 0; a < RES; ++a) {
    emage.setCrypto({ key: keys[a], iv: IV, accessLevel: a });
    let out;
    try {
        out = await emage.preview({ thumbSize: 64 });
    } catch (err) {
        check(false, `access ${a}: preview threw: ${err && err.message}`);
        continue;
    }
    const d = out.decoded;
    // The grant's ceiling: reduction >= RES-1-a
    const floor = RES - 1 - a;
    check(out.reduction >= floor,
        `access ${a}: preview ${d.width}x${d.height} at reduction ${out.reduction} ` +
        `(>= ${floor}, the grant's floor), 1 decode`);
}

// ---- preview with no IV configured, as the downloader does now ---------
for (let a = 0; a < RES; ++a) {
    emage.setCrypto({ key: keys[a], accessLevel: -1 });
    const realFetch = globalThis.fetch;
    const requests = [];
    let out;
    globalThis.fetch = (url, init) => {
        requests.push(init?.headers?.['X-Emage-Layers']);
        return realFetch(url, init);
    };
    try { out = await emage.playAll(); } finally { globalThis.fetch = realFetch; }
    const expected = 'meta,' + Array.from({ length: a + 1 }, (_, i) => `${i}:${i}`).join(',');
    check(requests.join(',') === expected,
        `automatic K${a} load uses metadata and incremental per-level packet requests`);
    check(out.decoded.keyLevel === a && out.decoded.width === Math.ceil(W / 2 ** (RES - 1 - a)),
        `automatic server load with K${a} finds its correct resolution without an access level`);
    check(out.steps.length === a + 1,
        `automatic server load with K${a} emits only its accessible resolution steps`);
}

const reader = await Emage.init({
    encoder: () => require(WASM + '/EmageWasmEncoder.js')({
        locateFile: () => dataUrl('EmageWasmEncoder.wasm') }),
    decoder: () => require(WASM + '/EmageWasmDecoder.js')({
        locateFile: () => dataUrl('EmageWasmDecoder.wasm') }),
});
reader.setServer({
    baseUrl: process.env.EMAGE_BASE || 'http://localhost:3233',
    imagePath: PATH,
    password: process.env.EMAGE_PASSWORD || '',
});
reader.setCrypto({ key: KEY });
check(reader.crypto.iv == null, 'reader has no IV configured (downloader shape)');
try {
    const out = await reader.preview({ thumbSize: 64 });
    check(out.decoded.width > 0,
        `preview works with no IV: ${out.decoded.width}x${out.decoded.height}`);
} catch (err) {
    check(false, 'preview with no IV failed: ' + (err && err.message));
}

// ---- display()/playAll(), the other two viewer entry points -------------
reader.setCrypto({ key: keys[2], accessLevel: 2 });
try {
    const out = await reader.display('64', { thumbSize: 64 });
    check(out.decoded.width > 0,
        `display('64') with grant 0..2 -> ${out.decoded.width}x${out.decoded.height} ` +
        `loadMode=${out.loadMode} steps=${out.steps.length}`);
} catch (err) {
    check(false, 'display failed: ' + (err && err.message));
}
reader.setCrypto({ key: KEY, accessLevel: -1 });
try {
    const out = await reader.playAll();
    check(out.steps.length === RES,
        `playAll walks all ${RES} levels in ${out.decodes} decodes`);
} catch (err) {
    check(false, 'playAll failed: ' + (err && err.message));
}

// ---- plaintext control through the same preview path -------------------
const plainPath = 'preview-probe-plain.j2k';
// Upload through the reader, whose imagePath is the plaintext one -- uploading
// via `emage` would overwrite the encrypted probe instead.
emage.setServer({ imagePath: plainPath });
reader.setCrypto({ key: KEY, accessLevel: -1 });
const plain = await emage.encodePixelData(px, W, H, {
    numComponents: 3, numResolutions: RES, numLayers: 1, enableSec: false,
});
const pup = await emage.upload(plain);
emage.setServer({ imagePath: PATH });
log(`plaintext control ${pup.stored} ${pup.width}x${pup.height} layers=${pup.layers}`);
const plains = await reader.preview({ thumbSize: 64 });
check(plains.decoded.width > 0,
    `plaintext preview through the same path: ${plains.decoded.width}x${plains.decoded.height}`);
check(pup.granularKeys == null, 'plaintext upload still reports no key material');
// Cleanup is best-effort: either probe may already be gone from an aborted
// earlier run, and a 404 on the way out is not a test failure.
for (const [inst, p] of [[reader, plainPath], [emage, PATH]]) {
    inst.setServer({ imagePath: p });
    try { await inst.remove(); log('removed ' + p); } catch (e) { log('already gone: ' + p); }
}

console.log(failed === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
