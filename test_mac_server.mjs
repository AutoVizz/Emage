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

let failed = 0;
const check = (c, m) => { if (!c) failed++; console.log((c ? 'PASS  ' : 'FAIL  ') + m); };
const log = m => console.log('        ' + m);

const W = 256, H = 256, RES = 6;
const KEY = new Uint8Array(32).fill(0x21);
const IV = new Uint8Array(16).fill(0x64);
const PATH = 'mac-server-probe.j2k';

const px = new Uint8Array(W * H * 3);
for (let i = 0; i < px.length; ++i) px[i] = (i * 31 + (i % 97)) & 0xff;

emage.setServer({
    baseUrl: process.env.EMAGE_BASE || 'http://localhost:3233',
    imagePath: PATH,
    password: process.env.EMAGE_PASSWORD || '',
});
emage.setCrypto({ key: KEY, iv: IV, accessLevel: -1 });

// ---- encode + upload ------------------------------------------------------
const stream = await emage.encodePixelData(px, W, H, {
    numComponents: 3, numResolutions: RES, numLayers: 1, enableSec: true,
});
log(`encoded ${stream.length} bytes, ${RES} levels`);

const local = emage.describeSecurityZone(stream);
check(local.hasSec === 1, `local SEC marker present, ${local.zoneCount} zones`);

const keys = emage.granularKeys(RES);

let uploaded = false;
try {
    const up = await emage.upload(stream);
    log(`uploaded -> ${up.stored} ${up.width}x${up.height} layers=${up.layers}`);
    check(up.layers === RES, `server parsed layers=${up.layers}`);
    check(Array.isArray(up.granularKeys) && up.granularKeys.length === RES,
        `upload exposed ${(up.granularKeys || []).length} derived keys`);
    uploaded = true;
} catch (err) {
    check(false, 'upload: ' + (err && err.message));
}

if (uploaded) {
    // ---- the property under test ------------------------------------------
    // For each grant, the client fetches ONLY the window 0:a. The server drops
    // TLM/PLM/PPM and PLT/PPT and rebuilds SOT/Psot, so every absolute offset
    // moves. If the cumulative MAC still verifies, the zone table survived the
    // rewrite -- which it can only do because Z is payload-relative and the SEC
    // segment itself is copied verbatim.
    for (let a = 0; a < RES; ++a) {
        emage.setCrypto({ key: keys[a], iv: IV, accessLevel: a });
        let framed;
        try {
            framed = await emage._stream();
        } catch (err) {
            check(false, `access ${a}: window fetch failed: ${err && err.message}`);
            continue;
        }
        const served = emage.describeSecurityZone(framed);
        const ivOk = Array.isArray(served.iv) &&
            Buffer.from(served.iv).equals(Buffer.from(IV));
        check(served.hasSec === 1 && ivOk,
            `access ${a}: served window carries SEC + the IV (${framed.length} bytes)`);

        let d;
        try {
            d = await emage.decode(framed, { accessLevel: a });
            check(true, `access ${a}: MAC chain verifies through the served window -> ${d.width}x${d.height}`);
        } catch (err) {
            check(false, `access ${a}: decode/MAC failed: ${err && err.message}`);
        }
    }

    // ---- plaintext control: same server, no SEC marker --------------------
    emage.setCrypto({ key: KEY, iv: IV, accessLevel: -1 });
    const plainPath = 'mac-probe-plain.j2k';
    emage.setServer({ imagePath: plainPath });
    const plain = await emage.encodePixelData(px, W, H, {
        numComponents: 3, numResolutions: RES, numLayers: 1, enableSec: false,
    });
    const plainUp = await emage.upload(plain);
    log(`plaintext control -> ${plainUp.stored} ${plainUp.width}x${plainUp.height} layers=${plainUp.layers}`);
    check(plainUp.layers === RES, 'server reports the same layers for a plaintext file');
    check(plainUp.granularKeys == null, 'plaintext upload reports no key material');
    const plainServed = emage.describeSecurityZone(await emage._stream());
    check(plainServed.hasSec === 0,
        'server served the plaintext file with no SEC marker (identical header logic)');
    const plainDec = await emage.decode(await emage._stream());
    check(plainDec.width === W && plainDec.height === H,
        `plaintext decodes through the same window path: ${plainDec.width}x${plainDec.height}`);
    await emage.remove();
    log('cleaned up plaintext probe');

    emage.setServer({ imagePath: PATH });
    await emage.remove();
    log('cleaned up encrypted probe');
}

console.log(failed === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);