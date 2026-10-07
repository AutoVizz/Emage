// Granular progressive keys, exercised through the public Emage API:
// key chain derivation, access-level clamping, the layer window the client
// requests, and the keys the upload result exposes.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
check(keys[RES - 1] === Buffer.from(KEY).toString('hex'),
    'finest key is the master key');
for (const count of [1, 2, RES, 64]) {
    const chain = emage.granularKeys(count);
    let expected = Buffer.from(KEY);
    for (let i = count - 1; i >= 0; --i) {
        check(chain[i] === expected.toString('hex'), `independent SHA3 vector: ${count} levels, K${i}`);
        expected = createHash('sha3-256').update(expected).digest();
    }
}
const nativeKeys = encoder.deriveGranularKeys(KEY, RES);
check(JSON.stringify(keys) === JSON.stringify(Array.from(nativeKeys)), 'chain matches the native derivation');

// --- 2. access level clamps the decode ---
// A coarser grant yields a coarser image, and a finer request is clamped.
const full = emage.decode(j2k, { accessLevel: 'all', reduction: 0 });
check(full.width === W && full.reduction === 0, 'access "all" decodes at full resolution');
for (let grant = 0; grant < RES; ++grant) {
    const minReduction = RES - 1 - grant;
    const got = emage.decode(j2k, { key: keys[grant], accessLevel: grant, reduction: 0 });
    const expectW = Math.ceil(W / Math.pow(2, minReduction));
    check(got.reduction === minReduction && got.width === expectW,
        `access ${grant} -> ${got.width}x${got.height} r=${got.reduction} (expected ${expectW} r=${minReduction})`);
    emage.setCrypto({ key: keys[grant], accessLevel: grant });
    check(JSON.stringify(emage.granularKeys()) === JSON.stringify(keys.slice(0, grant + 1)),
        `K${grant} derives exactly the correct coarser keys`);
    if (grant < RES - 1) {
        for (const claimed of [grant + 1, 'all']) {
            const limited = emage.decode(j2k, { accessLevel: claimed });
            check(limited.keyLevel === grant && limited.reduction === minReduction,
                `K${grant} automatically caps claimed access ${claimed}`);
        }
        const relabelled = emage.granularKeys(RES);
        check(relabelled[grant + 1] !== keys[grant + 1],
            `increasing derivation count cannot recover K${grant + 1}`);
    }
}
for (let level = 0; level < RES; ++level) {
    const detected = emage.decode(j2k, { key: keys[level], accessLevel: 'all' });
    check(detected.keyLevel === level && detected.reduction === RES - 1 - level,
        `automatically identifies K${level} and its finest resolution`);
    const capped = emage.decode(j2k, { key: keys[level], accessLevel: 0 });
    check(capped.keyLevel === level && capped.reduction === RES - 1,
        `K${level} also decodes a lower explicit resolution limit`);
}
emage.setCrypto({ key: KEY, accessLevel: 'all' });
// Asking for full resolution while holding only the coarsest level must not
// silently produce a wrong full-size image.
const coarse = emage.decode(j2k, { key: keys[0], accessLevel: 0, reduction: 0 });
check(coarse.width < full.width, 'coarse grant cannot yield a full-size image');
for (let i = 0; i < 12; ++i) {
    const wrong = new Uint8Array(KEY);
    wrong[0] ^= i + 1;
    let rejected = false;
    try { emage.decode(j2k, { key: wrong }); } catch (_) { rejected = true; }
    check(rejected, `unknown key ${i + 1} is rejected`);
}
check(emage.decode(j2k).width === W, 'valid decode works after repeated unknown keys');
const zones = emage.describeSecurityZone(j2k);
const payloadStart = j2k.length - 2 - zones.sizes.reduce((sum, size) => sum + size, 0);
for (const level of [0, RES - 1]) {
    const damaged = j2k.slice();
    damaged[payloadStart + zones.starts[level]] ^= 1;
    let rejected = false;
    try { emage.decode(damaged); } catch (_) { rejected = true; }
    check(rejected, `modified level ${level} is rejected without downgrading the master key`);
}

// --- 3. the client only requests the levels it can read ---
const asked = [];
const transferred = [];
let sot = 2;
while (j2k[sot] !== 0xff || j2k[sot + 1] !== 0x90) {
    sot += 2 + (j2k[sot + 2] << 8 | j2k[sot + 3]);
}
const windowBytes = (first, last) => {
    const end = payloadStart + zones.starts[last] + zones.sizes[last];
    if (first > 0) return j2k.slice(payloadStart + zones.starts[first], end);
    const bytes = new Uint8Array(end + 2);
    bytes.set(j2k.subarray(0, end));
    bytes.set([0xff, 0xd9], end);
    new DataView(bytes.buffer).setUint32(sot + 6, end - sot);
    return bytes;
};
globalThis.fetch = async (url, init) => {
    const mode = init.headers['X-Emage-Layers'];
    asked.push(mode);
    if (mode === 'meta') {
        const m = { width: W, height: H, layers: RES, bytes: j2k.length };
        return { ok: true, status: 200, json: async () => m, text: async () => JSON.stringify(m) };
    }
    const [first, last] = mode === 'all' ? [0, RES - 1] : mode.split(':').map(Number);
    const bytes = windowBytes(first, last);
    transferred.push({ mode, bytes: bytes.length });
    return {
        ok: true, status: 200,
        headers: { get: name => name === 'X-Emage-TilePsotOffsets' && first === 0
            ? String(sot + 6) : name === 'X-Emage-TotalLayers' ? String(RES) : null },
        arrayBuffer: async () => bytes.buffer,
    };
};
emage.crypto.accessLevel = 2;
await emage._stream();
check(asked.slice(-2).join(',') === '0:0,1:2', 'grant 2 requests only level 0 then levels 1:2');
emage.crypto.accessLevel = -1;
await emage._stream();
check(asked.slice(-2).join(',') === '0:0,1:5', 'master requests remaining levels after the coarsest probe');
for (let level = 0; level < RES; ++level) {
    emage.setCrypto({ key: keys[level], accessLevel: 'all' });
    const before = transferred.length;
    const progressive = await emage.playAll();
    const transfers = transferred.slice(before);
    check(transfers.map(t => t.mode).join(',') === (level === 0 ? '0:0' : `0:0,1:${level}`),
        `K${level} downloads no packets above its authenticated level`);
    check(transfers.reduce((sum, t) => sum + t.bytes, 0) === progressive.stream.length,
        `K${level} transfers every required codestream byte only once`);
    check(progressive.decoded.keyLevel === level && progressive.steps.length === level + 1,
        `automatic K${level} loading visits only its ${level + 1} accessible levels`);
    check(new Set(progressive.steps.map(step => step.width)).size === progressive.steps.length,
        `automatic K${level} loading has no duplicate frames`);
    const once = await emage.playAll({ progressive: false });
    check(once.decodes === 1 && once.decoded.width === Math.ceil(W / 2 ** (RES - 1 - level)),
        `one-shot K${level} automatically loads its finest image in one decode`);
}
emage.setCrypto({ key: KEY, accessLevel: 'all' });
for (const [target, last] of [[64, 3], [8, 0]]) {
    const before = transferred.length;
    const preview = await emage.preview({ thumbSize: target });
    const transfers = transferred.slice(before);
    check(transfers.map(t => t.mode).join(',') === (last === 0 ? '0:0' : `0:0,1:${last}`),
        `master preview ${target}px downloads only through level ${last}`);
    check(transfers.reduce((sum, t) => sum + t.bytes, 0) === preview.stream.length,
        `preview ${target}px reuses the coarsest probe without duplicate bytes`);
}
const beforeWrong = transferred.length;
let wrongRejected = false;
try {
    await emage.playAll({ key: new Uint8Array(32).fill(0xff) });
} catch (_) { wrongRejected = true; }
check(wrongRejected && transferred.slice(beforeWrong).map(t => t.mode).join(',') === '0:0',
    'wrong key downloads only the coarsest zone and stops');

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
