import { wasmDir } from './wasm_test_path.mjs';
// Per-file random IV: two encodes must not share a counter block, and the
// decoder must work without the caller supplying one.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const CLIENT = '/home/saturn/CLionProjects/EmageClient';
const WASM = wasmDir;
const { Emage } = await import(CLIENT + '/emage.js');

const dataUrl = (b) => 'data:application/wasm;base64,' +
    fs.readFileSync(WASM + '/' + b).toString('base64');

let failed = 0;
const check = (c, m) => { if (!c) failed++; console.log((c ? 'PASS  ' : 'FAIL  ') + m); };
const log = m => console.log('        ' + m);

const KEY = new Uint8Array(32).fill(0x7e);
const W = 128, H = 128, RES = 5;

const makeEmage = async () => Emage.init({
    encoder: () => require(WASM + '/EmageWasmEncoder.js')({
        locateFile: () => dataUrl('EmageWasmEncoder.wasm') }),
    decoder: () => require(WASM + '/EmageWasmDecoder.js')({
        locateFile: () => dataUrl('EmageWasmDecoder.wasm') }),
});

// Mirror what the page does: randomIvHex() from crypto.getRandomValues.
const randomIvHex = () => {
    const iv = new Uint8Array(16);
    globalThis.crypto.getRandomValues(iv);
    return Array.from(iv, (b) => b.toString(16).padStart(2, '0')).join('');
};

const px = new Uint8Array(W * H * 3);
for (let i = 0; i < px.length; ++i) px[i] = (i * 17 + (i % 211)) & 0xff;

// ---- 1. the generator itself produces fresh, well-formed IVs -----------
const seen = new Set();
for (let i = 0; i < 64; ++i) {
    const hex = randomIvHex();
    if (!/^[0-9a-f]{32}$/.test(hex)) { check(false, `IV ${i} malformed: ${hex}`); break; }
    seen.add(hex);
}
check(seen.size === 64, `64 generated IVs are all distinct (${seen.size}/64)`);

// ---- 2. two encodes get different IVs and different keystreams ---------
const emage = await makeEmage();
const ivA = randomIvHex();
const ivB = randomIvHex();
check(ivA !== ivB, 'two consecutive encodes are given different IVs');

const enc = async (ivHex) => {
    emage.setCrypto({ key: KEY, iv: ivHex, accessLevel: -1 });
    return emage.encodePixelData(px, W, H, {
        numComponents: 3, numResolutions: RES, numLayers: 1, enableSec: true,
    });
};
const a = await enc(ivA);
const b = await enc(ivB);

const za = emage.describeSecurityZone(a);
const zb = emage.describeSecurityZone(b);
const hex = (arr) => Buffer.from(arr).toString('hex');
check(hex(za.iv) === ivA, `stream A carries IV ${hex(za.iv)}`);
check(hex(zb.iv) === ivB, `stream B carries IV ${hex(zb.iv)}`);
check(hex(za.iv) !== hex(zb.iv), 'the two codestreams embed different IVs');

// Zone 0 of both is the same image and the same size, so its ciphertext offset
// is identical in both. Under one IV the keystream would cancel under XOR.
const off = 0;
const payload = (buf) => {
    const sod = Buffer.from(buf).indexOf(Buffer.from([0xff, 0x93]));
    return Buffer.from(buf).subarray(sod + 2 + off, sod + 2 + off + 24);
};
const pa = payload(a), pb = payload(b);
let xor = Buffer.alloc(24);
for (let i = 0; i < 24; ++i) xor[i] = pa[i] ^ pb[i];
check(xor.some((v) => v !== 0),
    'XOR of the same zone in both files is non-zero, so the keystream did not cancel');
check(!pa.equals(pb), 'zone 0 ciphertext differs between the two files');

// Same IV for comparison: now the keystream must cancel.
const c1 = await enc(ivA);
const c2 = await enc(ivA);
const q1 = payload(c1), q2 = payload(c2);
let xorSame = Buffer.alloc(24);
for (let i = 0; i < 24; ++i) xorSame[i] = q1[i] ^ q2[i];
check(xorSame.every((v) => v === 0),
    'control: reusing one IV makes the two files XOR to zero (the original bug)');

// ---- 3. decoding needs no caller-supplied IV ---------------------------
// A fresh instance with no IV configured at all: the reader is handed nothing
// but the master key and the codestream.
const reader = await makeEmage();
reader.setCrypto({ key: KEY, accessLevel: -1 });
check(reader.crypto.iv == null, 'reader has no IV configured');
let d;
try {
    d = await reader.decode(a);
    check(true, `decode with no IV supplied works: ${d.width}x${d.height}`);
} catch (err) {
    check(false, 'decode with no IV failed: ' + (err && err.message));
}

// A wrong caller IV must be ignored in favour of the marker's.
reader.setCrypto({ iv: new Uint8Array(16).fill(0x99) });
try {
    d = await reader.decode(a);
    check(d.width === W && d.height === H,
        'a wrong caller IV is ignored; the marker is authoritative');
} catch (err) {
    check(false, 'wrong caller IV broke the decode: ' + (err && err.message));
}

console.log(failed === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);