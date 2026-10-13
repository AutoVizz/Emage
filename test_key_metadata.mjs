// Header lookup must choose a bounded window without downloading trial packets.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Emage } from './emage.js';

const require = createRequire(import.meta.url);
const wasm = new URL('./cmake-build-wasm/', import.meta.url);
const binary = name => 'data:application/wasm;base64,' + readFileSync(new URL(name, wasm)).toString('base64');
const emage = await Emage.init({
    encoder: () => require(new URL('EmageWasmEncoder.js', wasm).pathname)({ locateFile: () => binary('EmageWasmEncoder.wasm') }),
    decoder: () => require(new URL('EmageWasmDecoder.js', wasm).pathname)({ locateFile: () => binary('EmageWasmDecoder.wasm') }),
});
const W = 256, H = 128, RES = 6;
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const IV = new Uint8Array(16).fill(0x37);
emage.setCrypto({ key: KEY, iv: IV, accessLevel: 'all' });
emage.setServer({ baseUrl: 'https://example.invalid', imagePath: 'header-test.j2k', password: 'test' });
const pixels = Uint8Array.from({ length: W * H * 3 }, (_, i) => (i * 7) & 255);
const encoded = emage.encodePixelData(pixels, W, H, { numComponents: 3, numResolutions: RES });
const keys = emage.granularKeys(RES);
let failures = 0;
const check = (condition, label) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`); if (!condition) ++failures; };
const embedded = Emage.readMetadata(encoded);
check(Object.keys(embedded.keyMap.levels).length === RES, 'all lookup tags are stored inside the encoded image header');
for (let level = 0; level < RES; ++level) {
    const tag = createHash('sha3-256').update(Buffer.concat([Buffer.from(IV), Buffer.from(keys[level], 'hex')])).digest('hex');
    check(embedded.keyMap.levels[tag] === level, `K${level} lookup matches independent SHA3(IV || key)`);
}
const updated = Emage.withMetadata(encoded, { ...embedded, callerField: 'opaque' });
check(Emage.readMetadata(updated).callerField === 'opaque', 'generic metadata can be replaced without losing the lookup map');
check(emage.decode(updated).width === W, 'replacing a COM header preserves SEC offsets and MACs');

const zones = emage.describeSecurityZone(encoded);
const payloadStart = encoded.length - 2 - zones.sizes.reduce((sum, n) => sum + n, 0);
let sot = 2;
while (encoded[sot + 1] !== 0x90) sot += 2 + (encoded[sot + 2] << 8 | encoded[sot + 3]);
const prefix = last => {
    const end = payloadStart + zones.starts[last] + zones.sizes[last];
    const data = new Uint8Array(end + 2);
    data.set(encoded.subarray(0, end));
    data.set([0xff, 0xd9], end);
    new DataView(data.buffer).setUint32(sot + 6, end - sot);
    return data;
};
let metadata = embedded;
let requests = [];
let uploaded = null;
globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') {
        uploaded = init.body;
        const result = { width: W, height: H, layers: RES, bytes: uploaded.length, metadata: Emage.readMetadata(uploaded) };
        return { ok: true, text: async () => JSON.stringify(result) };
    }
    const mode = init.headers['X-Emage-Layers'];
    requests.push(mode);
    if (mode === 'meta') {
        return { ok: true, text: async () => JSON.stringify({ width: W, height: H, layers: RES, bytes: encoded.length, metadata }) };
    }
    const m = /^(\d+):(\d+)$/.exec(mode);
    if (!m) throw new Error('Unexpected packet request: ' + mode);
    const first = Number(m[1]);
    const last = Number(m[2]);
    if (first > 0) {
        const data = encoded.slice(
            payloadStart + zones.starts[first],
            payloadStart + zones.starts[last] + zones.sizes[last]);
        return { ok: true, arrayBuffer: async () => data.buffer };
    }
    const data = prefix(last);
    return {
        ok: true,
        arrayBuffer: async () => data.buffer,
        headers: { get: (k) => (k === 'X-Emage-TilePsotOffsets' ? String(sot + 6) : null) },
    };
};
for (let level = 0; level < RES; ++level) {
    emage.setCrypto({ key: keys[level], accessLevel: 'all' });
    requests = [];
    const out = await emage.playAll();
    const expected = 'meta,' + Array.from({ length: level + 1 }, (_, i) => `${i}:${i}`).join(',');
    check(requests.join(',') === expected, `K${level}: metadata lookup then one incremental window per accessible level`);
    check(out.decoded.keyLevel === level && out.decoded.width === Math.ceil(W / 2 ** (RES - 1 - level)),
        `K${level}: automatic load resolves to its authenticated resolution`);
    check(out.steps.length === level + 1, `K${level}: progressive loading stops at its accessible level`);
}
emage.setCrypto({ key: KEY, accessLevel: 'all' });
requests = [];
await emage.preview({ thumbSize: 32 });
check(requests.join(',') === 'meta,0:2', 'master thumbnail downloads only the levels needed for 32px');
requests = [];
let rejected = false;
try { await emage.playAll({ key: new Uint8Array(32).fill(0xff) }); } catch (_) { rejected = true; }
check(rejected && requests.join(',') === 'meta', 'unknown key is rejected from metadata without downloading image packets');
const tag = emage.keyLookupTag(KEY, IV);
metadata = { keyMap: { ...embedded.keyMap, levels: { ...embedded.keyMap.levels, [tag]: 0 } } };
rejected = false;
try { await emage.playAll(); } catch (_) { rejected = true; }
check(rejected, 'a remapped lookup entry is rejected by authenticated key-level verification');
metadata = embedded;
const up = await emage.upload(encoded);
check(Emage.readMetadata(uploaded).keyMap.iv === embedded.keyMap.iv, 'upload carries the lookup map only inside the image header');
check(up.granularKeys.length === RES, 'upload still exposes the full key chain locally');
check(keys.every(key => !Buffer.from(uploaded).includes(Buffer.from(key, 'hex'))), 'image header contains no raw key material');

const plain = emage.encodePixelData(pixels, W, H, { numComponents: 3, numResolutions: RES, enableSec: false });
check(Emage.readMetadata(plain) === null, 'plaintext encoding does not fabricate a key map');
const plainWithMetadata = Emage.withMetadata(plain, { callerField: 'opaque' });
check(emage.decode(plainWithMetadata).width === W, 'the same generic metadata envelope works for plaintext');
console.log(failures ? `FAILED (${failures})` : 'ALL HEADER LOOKUP CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
