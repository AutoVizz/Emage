// Granular progressive keys, exercised through the public Emage API:
// key chain derivation, access-level clamping, the layer window the client
// requests, and the keys the upload result exposes.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const WASM = '/home/saturn/CLionProjects/EmageWasm/cmake-build-wasm';
const { Emage } = await import(path.join(here, 'emage.js'));

const encoderModule = require(path.join(WASM, 'EmageWasmEncoder.js'));
const decoderModule = require(path.join(WASM, 'EmageWasmDecoder.js'));
const dataUrl = (b) => 'data:application/wasm;base64,' +
    require('node:fs').readFileSync(path.join(WASM, b)).toString('base64');

const W = 256, H = 256, RES = 6;
const KEY = new Uint8Array(32).fill(0x11);
const IV = new Uint8Array(16).fill(0x22);

let fail = 0;
const check = (cond, label) => {
    console.log((cond ? 'ok   ' : 'FAIL ') + label);
    if (!cond) fail = 1;
};

const encoder = await encoderModule({ locateFile: () => dataUrl('EmageWasmEncoder.wasm') });
const decoder = await decoderModule({ locateFile: () => dataUrl('EmageWasmDecoder.wasm') });

const rgb = new Uint8Array(W * H * 3);
for (let y = 0; y < H; ++y) {
    for (let x = 0; x < W; ++x) {
        const i = (y * W + x) * 3;
        rgb[i] = (x * 3) & 0xff; rgb[i + 1] = (y * 5) & 0xff; rgb[i + 2] = ((x ^ y) * 7) & 0xff;
    }
}

const eptr = encoder._malloc(rgb.length);
encoder.HEAPU8.set(rgb, eptr);
const j2k = encoder.encodeRaw(eptr, rgb.length, {
    width: W, height: H, numComponents: 3, precision: 8, lossless: true,
    numResolutions: RES, numLayers: 1,
    enablePterm: false, enableSegsym: false, enableSop: false, enableEph: false,
    enableTlm: false, enableSec: true, key: KEY, iv: IV,
});
encoder._free(eptr);
console.log(`encoded ${W}x${H} -> ${j2k.length} B, ${RES} resolutions\n`);

const emage = new Emage();
emage.encoder = encoder;
emage.decoder = decoder;
emage.server = { baseUrl: 'https://example.invalid', imagePath: 'a.b', password: 'pw' };
emage.setCrypto({ key: KEY, iv: IV });

// --- 1. key chain derivation ---
const keys = emage.granularKeys(RES);
check(Array.isArray(keys) && keys.length === RES, `granularKeys returns one key per level (${keys?.length})`);
check(keys.every((k) => typeof k === 'string' && k.length === 64), 'each key is 32 bytes of hex');
check(new Set(keys).size === RES, 'every level gets a distinct key');
// K0 is the master key itself; the rest are its SHA3-256 chain.
check(keys[0] === Array.from(KEY).map((b) => b.toString(16).padStart(2, '0')).join(''),
    'level 0 key is the master key');
const nativeKeys = encoder.deriveGranularKeys(KEY, RES);
check(JSON.stringify(keys) === JSON.stringify(Array.from(nativeKeys)), 'chain matches the native derivation');

// --- 2. access level clamps the decode ---
// A coarser grant yields a coarser image, and a finer request is clamped.
const full = emage.decode(j2k, { accessLevel: 'all', reduction: 0 });
check(full.width === W && full.reduction === 0, 'access "all" decodes at full resolution');
for (let grant = 0; grant < RES; ++grant) {
    const minReduction = RES - 1 - grant;
    const got = emage.decode(j2k, { accessLevel: grant, reduction: 0 });
    const expectW = Math.ceil(W / Math.pow(2, minReduction));
    check(got.reduction === minReduction && got.width === expectW,
        `access ${grant} -> ${got.width}x${got.height} r=${got.reduction} (expected ${expectW} r=${minReduction})`);
}
// Asking for full resolution while holding only the coarsest level must not
// silently produce a wrong full-size image.
const coarse = emage.decode(j2k, { accessLevel: 0, reduction: 0 });
check(coarse.width < full.width, 'coarse grant cannot yield a full-size image');

// --- 3. the client only requests the levels it can read ---
const asked = [];
globalThis.fetch = async (url, init) => {
    const mode = init.headers['X-Emage-Layers'];
    asked.push(mode);
    if (mode === 'meta') {
        const m = { width: W, height: H, layers: RES, bytes: j2k.length };
        return { ok: true, status: 200, json: async () => m, text: async () => JSON.stringify(m) };
    }
    return {
        ok: true, status: 200,
        arrayBuffer: async () => j2k.buffer.slice(j2k.byteOffset, j2k.byteOffset + j2k.length),
    };
};
emage.crypto.accessLevel = 2;
await emage._stream();
check(asked.at(-1) === '0:2', `grant 2 requests layers 0:2 (asked ${asked.at(-1)})`);
emage.crypto.accessLevel = -1;
await emage._stream();
check(asked.at(-1) === 'all', 'unrestricted grant requests all layers');

// --- 4. upload surfaces the granular keys ---
globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') {
        const m = { width: W, height: H, layers: RES, bytes: j2k.length };
        return { ok: true, status: 201, json: async () => m, text: async () => JSON.stringify(m) };
    }
    throw new Error('unexpected request');
};
const up = await emage.upload(j2k);
check(Array.isArray(up.granularKeys) && up.granularKeys.length === RES,
    `upload result carries ${RES} granular keys`);
check(JSON.stringify(up.granularKeys) === JSON.stringify(keys), 'upload keys match the derived chain');
// Keys must be derived client-side, never put on the wire.
let sentKeys = false;
globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') {
        const body = Buffer.from(init.body);
        for (const k of keys) if (body.includes(Buffer.from(k, 'hex'))) sentKeys = true;
        const m = { width: W, height: H, layers: RES, bytes: j2k.length };
        return { ok: true, status: 201, json: async () => m, text: async () => JSON.stringify(m) };
    }
    throw new Error('unexpected request');
};
await emage.upload(j2k);
check(!sentKeys, 'no key material is sent in the upload body');

// --- 5. access level plumbing ---
emage.setCrypto({ accessLevel: 3 });
check(emage.crypto.accessLevel === 3, 'setCrypto stores accessLevel');
emage.setCrypto({ accessLevel: 'all' });
check(emage.crypto.accessLevel === -1, 'setCrypto accepts "all"');
let rejected = false;
try { emage.setCrypto({ accessLevel: -4 }); } catch (_) { rejected = true; }
check(rejected, 'setCrypto rejects a negative access level');

console.log(fail ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(fail);
