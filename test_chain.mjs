// Full-chain verification against the live Emage server.
//
// Everything the other suites stub is exercised for real here: the emscripten
// encoder, the HTTP upload, the server's marker parser, the meta endpoint, the
// codestream fetch, and the WASM decoder's reduced-resolution path. A wrong
// field name, a type mismatch, or a disagreement between what the server parses
// and what OpenJPEG reports shows up here and nowhere else.
import fs from 'node:fs';
import path from 'node:path';
import { wasmDir } from './wasm_test_path.mjs';
import { Emage } from './emage.js';

const build = wasmDir;
const BASE = process.env.EMAGE_BASE || 'http://localhost:3233';
const PASSWORD = process.env.EMAGE_PASSWORD || '';
const IMAGE = 'chain-verify.j2k';
const W = 1600, H = 1600, NUM_RESOLUTIONS = 6, NUM_LAYERS = 8;

const failures = [];
const check = (cond, what) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}`);
    if (!cond) failures.push(what);
};

const dataUrl = (bin) => 'data:application/wasm;base64,' +
    fs.readFileSync(path.join(build, bin)).toString('base64');
const loadFactory = async (bin, wasm) => {
    const mod = await import(path.join(build, bin));
    return (mod.default ?? mod)({ locateFile: () => dataUrl(wasm) });
};

const encoder = await loadFactory('EmageWasmEncoder.js', 'EmageWasmEncoder.wasm');
const decoder = await loadFactory('EmageWasmDecoder.js', 'EmageWasmDecoder.wasm');

const emage = new Emage();
emage.encoder = encoder;
emage.decoder = decoder;
emage.setServer({ baseUrl: BASE, imagePath: IMAGE, password: PASSWORD });

// A gradient plus some structure, so a reduced decode is visually meaningful.
const pixels = new Uint8Array(W * H * 4);
for (let y = 0; y < H; ++y) {
    for (let x = 0; x < W; ++x) {
        const i = (y * W + x) * 4;
        pixels[i + 0] = (x * 255 / W) | 0;
        pixels[i + 1] = (y * 255 / H) | 0;
        pixels[i + 2] = (128 + 100 * Math.sin(x / 120) * Math.cos(y / 120)) | 0;
        pixels[i + 3] = 255;
    }
}

console.log(`=== chain: ${BASE}, ${W}x${H}, ${NUM_RESOLUTIONS} resolutions, ${NUM_LAYERS} layers ===\n`);

// ---- 1. encode -> upload ----------------------------------------------------
console.log('1. encode and upload');
emage.encodePixelData(pixels, W, H, {
    numResolutions: NUM_RESOLUTIONS, numLayers: NUM_LAYERS,
    enableSec: false, lossless: true, enableTlm: true,
});
check(emage.j2k instanceof Uint8Array && emage.j2k.length > 0, `encoder produced ${emage.j2k.length} bytes`);
check(emage.j2k[emage.j2k.length - 2] === 0xff && emage.j2k[emage.j2k.length - 1] === 0xd9,
    'codestream ends with EOC (client upload guard agrees)');

const up = await emage.upload();
check(up.stored === IMAGE, `upload stored at ${up.stored}`);
check(up.width === W && up.height === H, `server parsed dimensions ${up.width}x${up.height}`);
check(up.layers === NUM_RESOLUTIONS, `server reported ${up.layers} layers (== DWT resolution levels)`);
check(!('resolutions' in up), 'upload response no longer carries the redundant resolutions field');

// ---- 2. meta round trip -----------------------------------------------------
console.log('\n2. meta endpoint');
const meta = await emage.meta();
check(meta.width === W && meta.height === H, `meta reports ${meta.width}x${meta.height}`);
check(meta.layers === NUM_RESOLUTIONS, `meta reports ${meta.layers} layers (== DWT resolution levels)`);
check(meta.bytes === up.bytes, `meta byte count matches upload (${meta.bytes})`);
check(typeof meta.layers === 'number', 'meta.layers is a number, not a string');
check(!('resolutions' in meta), 'meta no longer carries the redundant resolutions field');

// The client's discovery fallback must not trigger when the server is truthful.
{
    let decodes = 0;
    const real = emage.decode.bind(emage);
    emage.decode = (...a) => { ++decodes; return real(...a); };
    const res = await emage.display('all');
    emage.decode = real;
    check(res.decodes === res.steps.length, 'no discovery decode when the server reports layers');
    check(res.numResolutions === NUM_RESOLUTIONS, 'loader used the server-reported count');
    void decodes;
}

// ---- 3. fetch + reduced decode ---------------------------------------------
console.log('\n3. codestream fetch and reduced decode');
// The server rebuilds the codestream from parsed segments and deliberately omits
// TLM/PLM/PPM, so the served body is smaller than the stored file. meta.bytes
// describes the stored file, so the two are not expected to match -- what must
// hold is that the served stream decodes to the same image.
const stream = await emage._stream();
check(stream.length <= meta.bytes,
    `served ${stream.length} bytes <= stored ${meta.bytes} (TLM/PLM/PPM omitted by design)`);
check(stream[stream.length - 2] === 0xff && stream[stream.length - 1] === 0xd9,
    'X-Emage-Layers: all returned a self-contained codestream (EOC present)');
{
    const localPtr = decoder._malloc(emage.j2k.length);
    decoder.HEAPU8.set(emage.j2k, localPtr);
    const localOut = decoder.decodeRaw(localPtr, emage.j2k.length, null, null, 0, 0);
    const servedOut = emage.decode(stream, { reduction: 0 });
    decoder._free(localPtr);
    check(localOut.width === servedOut.width && localOut.height === servedOut.height,
        `served stream has the same dimensions (${servedOut.width}x${servedOut.height})`);
    check(Buffer.compare(Buffer.from(localOut.rgbaPixels), Buffer.from(servedOut.rgbaPixels)) === 0,
        'served stream decodes pixel-identically to the locally encoded codestream');
}

const expectW = (r) => Math.ceil(W / 2 ** r);
for (let r = 0; r < NUM_RESOLUTIONS; ++r) {
    const out = emage.decode(stream, { reduction: r });
    const ew = expectW(r);
    check(out.width === ew && out.height === ew,
        `reduction ${r} -> ${out.width}x${out.height} (expected ${ew}x${ew})`);
    check(out.numResolutions === NUM_RESOLUTIONS, `reduction ${r} reports numResolutions=${out.numResolutions}`);
    check(out.reduction === r, `reduction ${r} reports applied=${out.reduction}`);
    check(out.rgbaPixels.length === out.width * out.height * 4, `reduction ${r} RGBA length is consistent`);
    check(out.rgbaPixels.every((v, i) => i % 4 !== 3 || v === 255), `reduction ${r} stays opaque`);
}

// Out-of-range must clamp, not throw, all the way past the server's count.
for (const r of [NUM_RESOLUTIONS, NUM_RESOLUTIONS + 5, 99]) {
    const out = emage.decode(stream, { reduction: r });
    const max = NUM_RESOLUTIONS - 1;
    check(out.reduction === max && out.width === expectW(max),
        `reduction ${r} clamped to ${max} -> ${out.width}x${out.width}`);
}

// The full-resolution decode must be byte-identical to a fresh decode, i.e. the
// server's stored bytes are self-consistent.
{
    const a = emage.decode(stream, { reduction: 0 });
    const b = emage.decode(stream, { reduction: 0 });
    check(Buffer.compare(Buffer.from(a.rgbaPixels), Buffer.from(b.rgbaPixels)) === 0,
        'full-resolution decode is deterministic against live server bytes');
}

// ---- 4. the three compare.html passes --------------------------------------
console.log('\n4. compare.html passes (A progressive / B one-shot target / C one-shot full)');
const target = 400;
{
    const a = await emage.display(target + 'px', {});
    const b = await emage.display(target + 'px', { progressive: false });
    const c = await emage.display('all', { progressive: false });
    console.log(`   A: ${a.steps.map((s) => s.width + 'x' + s.height).join(' -> ')}`);
    console.log(`   B: ${b.steps.map((s) => s.width + 'x' + s.height).join(' -> ')}`);
    console.log(`   C: ${c.steps.map((s) => s.width + 'x' + s.height).join(' -> ')}`);

    const sizes = a.steps.map((s) => s.width);
    check(sizes.every((w, i) => i === 0 || w > sizes[i - 1]), 'A strictly increases');
    check(new Set(sizes).size === sizes.length, 'A has no duplicate level');
    check(a.displaySize.width === target, `A lands on the ${target}px target`);
    check(a.decodes === a.steps.length, 'A spends no wasted decode');

    check(b.decodes === 1 && b.steps.length === 1, 'B is exactly one decoder run');
    check(b.displaySize.width === target, `B decoded at ${target}px`);
    check(b.loadMode === 'size', 'B reports loadMode=size');

    check(c.decodes === 1 && c.steps.length === 1, 'C is exactly one decoder run');
    check(c.displaySize.width === W, 'C decoded at full resolution');
    check(c.loadMode === 'full', 'C reports loadMode=full');

    check(a.stream.length === b.stream.length && b.stream.length < c.stream.length,
        'target-sized passes transfer the same reduced window, smaller than the full image');
    check(a.numResolutions === b.numResolutions && b.numResolutions === c.numResolutions,
        'all three passes agree on the resolution count');
}

// ---- 5. percent target and preview ----------------------------------------
console.log('\n5. percent target and preview');
{
    const p = await emage.display('25%', { progressive: false });
    check(p.displaySize.width === Math.ceil(W * 0.25) || p.displaySize.width === expectW(2),
        `'25%' resolved to ${p.displaySize.width}px`);
    check(p.decodes === 1, "'25%' is one decoder run");
    // preview targets the coarsest level that still carries the thumb, which is
    // a power-of-two step, so it can land slightly below thumbSize rather than
    // at it. What matters is that it is a real level and the smallest sensible.
    const pv = await emage.preview({ thumbSize: 64 });
    const pvIsLevel = [...Array(NUM_RESOLUTIONS).keys()].some((r) => expectW(r) === pv.decoded.width);
    check(pvIsLevel, `preview(64) landed on a real DWT level: ${pv.decoded.width}px`);
    check(pv.decoded.width > 0 && pv.decoded.width < W,
        `preview(64) is smaller than the full image (${pv.decoded.width} < ${W})`);
    check(pv.decodes === 1, 'preview is one decoder run');
}

// ---- 6. per-component geometry against the server's own parse --------------
console.log('\n6. server/OpenJPEG agreement');
{
    const info = await (await fetch(`${BASE}/image-info/${IMAGE}`)).json();
    check(info.width === W && info.height === H, `/info agrees on ${info.width}x${info.height}`);
    check(info.layers === NUM_RESOLUTIONS, `/info agrees on ${info.layers} layers`);
    check(!('resolutions' in info), '/info no longer carries the redundant resolutions field');
    // The encoder always writes a single lossless quality layer (encoder_bindings.cc
    // sets tcp_numlayers = 1) and this project does not use quality layers at all,
    // so the server reports the DWT resolution count as `layers` unconditionally.
    check(info.layers === NUM_RESOLUTIONS,
        `/info layers (${info.layers}) is the DWT resolution count, as the server defines it`);
    check(info.components.every((c) => c.dx === 1 && c.dy === 1),
        'all components are unsubsampled, so the shared-stride path is correct here');
    const full = emage.decode(stream, { reduction: 0 });
    check(full.numComponents === info.components.length,
        `decoder reports ${full.numComponents} components, server reports ${info.components.length}`);
    check(full.width === info.width && full.height === info.height,
        'decoder and server agree on full dimensions');
}

// ---- 7. upload a subsampled-friendly case: 1-resolution ---------------------
console.log('\n7. degenerate codestream (1 resolution)');
{
    emage.setServer({ imagePath: 'chain-verify-flat.j2k' });
    const fw = 512, fh = 512;
    const flatPixels = new Uint8Array(fw * fh * 4);
    for (let i = 0; i < flatPixels.length; i += 4) {
        flatPixels[i] = 90; flatPixels[i + 1] = 140; flatPixels[i + 2] = 200; flatPixels[i + 3] = 255;
    }
    emage.encodePixelData(flatPixels, fw, fh, {
        numResolutions: 1, numLayers: 1, enableSec: false, lossless: true,
    });
    const flatUp = await emage.upload();
    check(flatUp.layers === 1, `server reports ${flatUp.layers} layer (= 1 resolution)`);
    const flatMeta = await emage.meta();
    check(flatMeta.layers === 1, 'meta reports 1 layer (= 1 resolution)');
    // A reduced request against a flat stream must clamp to full, not fail.
    const flat = await emage.display('16px', { progressive: false });
    check(flat.displaySize.width === 512, `flat stream clamps to full 512px, got ${flat.displaySize.width}`);
    check(flat.reduction === 0, 'flat stream reports reduction 0');
    check(flat.decodes === 1, 'flat stream is one decoder run');
    // Progressive against a flat stream must not loop forever or duplicate.
    const flatProg = await emage.display('all', {});
    check(flatProg.steps.length === 1, `flat progressive emits 1 step, got ${flatProg.steps.length}`);
    check(flatProg.displaySize.width === 512, 'flat progressive ends at full resolution');
}

// ---- 8. cleanup -------------------------------------------------------------
console.log('\n8. cleanup');
for (const p of [IMAGE, 'chain-verify-flat.j2k']) {
    const r = await fetch(`${BASE}/image/${p}`, { method: 'DELETE', headers: { 'X-Emage-Password': PASSWORD } });
    check(r.ok, `deleted ${p} (${r.status})`);
}
const list = await (await fetch(`${BASE}/images`)).json();
check(!list.some((i) => i.path === IMAGE), 'uploaded image is gone from the listing');

console.log(`\n${failures.length ? failures.length + ' CHECK(S) FAILED' : 'ALL CHAIN CHECKS PASSED'}`);
process.exit(failures.length ? 1 : 0);
