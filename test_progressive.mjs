// End-to-end verification of the resolution-level loading path in emage.js,
// against the real WASM encoder/decoder with only `fetch` stubbed.
//
// The native side is covered by EmageWasm/test_resolution.js; this covers the
// JavaScript that drives it: level selection, clamping, progressive ordering,
// step de-duplication, and the decoder-run count that compare.html reports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Emage } from './emage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(here, 'cmake-build-wasm');
const dataUrl = (bin) => 'data:application/wasm;base64,' +
    fs.readFileSync(path.join(build, bin)).toString('base64');

const W = 1024, H = 1024, NUM_RESOLUTIONS = 6;

const failures = [];
const check = (cond, what) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}`);
    if (!cond) failures.push(what);
};

const fill = (x, y, out, i) => {
    out[i] = (x * 255 / W) | 0;
    out[i + 1] = (y * 255 / H) | 0;
    out[i + 2] = (128 + 100 * Math.sin(x / 96) * Math.cos(y / 96)) | 0;
};

// The emscripten glue is CommonJS, so a dynamic import hands back the factory
// on `default`.
const loadFactory = async (bin, wasm) => {
    const mod = await import(path.join(build, bin));
    return (mod.default ?? mod)({ locateFile: () => dataUrl(wasm) });
};
const encoder = await loadFactory('EmageWasmEncoder.js', 'EmageWasmEncoder.wasm');
const decoder = await loadFactory('EmageWasmDecoder.js', 'EmageWasmDecoder.wasm');

const rgb = new Uint8Array(W * H * 3);
for (let y = 0; y < H; ++y) for (let x = 0; x < W; ++x) fill(x, y, rgb, (y * W + x) * 3);
const eptr = encoder._malloc(rgb.length);
encoder.HEAPU8.set(rgb, eptr);
const j2k = encoder.encodeRaw(eptr, rgb.length, {
    width: W, height: H, numComponents: 3, precision: 8, lossless: true,
    numResolutions: NUM_RESOLUTIONS, numLayers: NUM_RESOLUTIONS,
    enablePterm: false, enableSegsym: false, enableSop: false, enableEph: false,
    enableTlm: true, enableSec: false,
    key: null, iv: null,
});
encoder._free(eptr);
console.log(`encoded ${W}x${H} -> ${j2k.length} B, ${NUM_RESOLUTIONS} resolutions\n`);

const emage = new Emage();
emage.decoder = decoder;
emage.server = { baseUrl: 'https://example.invalid', imagePath: 'a.b', password: '' };

// Count real decoder invocations so the one-shot paths can be proven to be one
// decode, which is the whole point of the comparison in compare.html.
let decodes = 0;
const realDecode = emage.decode.bind(emage);
emage.decode = (...a) => { ++decodes; return realDecode(...a); };

// Two server variants: one that reports the decomposition count (current
// server, openapi.yaml MetaResponse) and a legacy one that does not, so the
// discovery path stays exercised.
let META = { width: W, height: H, layers: NUM_RESOLUTIONS, bytes: 0 };
let requests = 0;
globalThis.fetch = async (url, init) => {
    ++requests;
    const mode = init.headers['X-Emage-Layers'];
    if (mode === 'meta') {
        return { ok: true, status: 200, json: async () => META, text: async () => JSON.stringify(META) };
    }
    return {
        ok: true, status: 200,
        arrayBuffer: async () => j2k.buffer.slice(j2k.byteOffset, j2k.byteOffset + j2k.length),
    };
};

const dims = (steps) => steps.map((s) => `${s.width}x${s.height}`).join(' -> ');

async function pass(label, target, opts) {
    decodes = 0;
    const events = [];
    const res = await emage.display(target, { ...opts, onLayer: (e) => events.push(e) });
    console.log(`${label}: ${dims(res.steps)}` +
        `  [decodes=${decodes} reduction=${res.reduction} numRes=${res.numResolutions} ` +
        `mode=${res.loadMode} events=${events.length} bytes=${res.steps.at(-1).assembledBytes}]`);
    return { res, events, decodes };
}

// A progressive pass must walk strictly upward in resolution, land on the
// target, and never repeat a level.
{
    const { res, events } = await pass('progressive 256px', '256px', {});
    check(res.displaySize.width === 256 && res.displaySize.height === 256, 'progressive 256px lands on 256x256');
    check(res.reduction === 2, 'progressive 256px ends at reduction 2');
    check(res.numResolutions === NUM_RESOLUTIONS, 'loader learned numResolutions=6');
    check(res.steps.length >= 2, 'progressive 256px emitted more than one step');
    const sizes = res.steps.map((s) => s.width);
    check(sizes.every((w, i) => i === 0 || w > sizes[i - 1]), 'progressive steps strictly increase in size');
    check(new Set(sizes).size === sizes.length, 'progressive steps contain no duplicate level');
    check(res.steps.every((s, i) => s.complete === (i === res.steps.length - 1)), 'only the last step is marked complete');
    check(res.steps.every((s) => s.totalLayers === res.steps.length), 'totalLayers is the final step count');
    check(events.length === res.steps.length, 'onLayer fired once per step');
    check(events.every((e, i) => e.layer === i + 1), 'onLayer layer numbers are 1..n');
    check(res.loadMode === 'size', 'loadMode is size');
}

// One-shot at the target must be exactly one decode and no extra steps.
{
    const { res } = await pass('one-shot 256px', '256px', { progressive: false });
    check(decodes === 1, 'one-shot 256px is exactly 1 decoder run');
    check(res.steps.length === 1, 'one-shot 256px emitted 1 step');
    check(res.displaySize.width === 256, 'one-shot 256px decoded at 256x256');
}

// One-shot full must also be exactly one decode, and must not probe.
{
    const { res } = await pass("one-shot 'all'", 'all', { progressive: false });
    check(decodes === 1, "one-shot 'all' is exactly 1 decoder run");
    check(res.displaySize.width === W && res.displaySize.height === H, "one-shot 'all' decoded at full size");
    check(res.loadMode === 'full', "one-shot 'all' reports loadMode=full");
    check(res.reduction === 0, "one-shot 'all' reports reduction 0");
}

// Full progressive: every level from the coarsest to full, ascending, no repeats.
{
    const { res } = await pass("progressive 'all'", 'all', {});
    const sizes = res.steps.map((s) => s.width);
    check(sizes.at(-1) === W, "progressive 'all' finishes at full width");
    check(sizes.every((w, i) => i === 0 || w > sizes[i - 1]), "progressive 'all' strictly increases");
    check(new Set(sizes).size === sizes.length, "progressive 'all' has no duplicate level");
    check(res.steps.length === NUM_RESOLUTIONS, `progressive 'all' visited all ${NUM_RESOLUTIONS} levels`);
    check(res.steps[0].width === 32, 'progressive \'all\' starts at the coarsest level (32x32)');
    check(res.loadMode === 'full', "progressive 'all' reports loadMode=full");
}

// A target finer than the codestream supports must clamp, not fail or repeat.
{
    const { res } = await pass('one-shot 8px (too small)', '8px', { progressive: false });
    check(res.displaySize.width === 32, 'over-fine target clamped to 32x32');
    check(res.reduction === NUM_RESOLUTIONS - 1, 'over-fine target reports the max reduction');
    check(res.steps.length === 1, 'over-fine target still a single step');
}
{
    const { res } = await pass('progressive 8px (too small)', '8px', {});
    const sizes = res.steps.map((s) => s.width);
    check(sizes.at(-1) === 32, 'progressive over-fine target ends at 32x32');
    check(new Set(sizes).size === sizes.length, 'progressive over-fine target has no duplicate level');
    check(res.steps.every((s, i) => i === 0 || s.width > res.steps[i - 1].width), 'progressive over-fine steps increase');
}

// A target coarser than the full image must be one decode, and above full must
// be full.
{
    const { res } = await pass('one-shot 2048px (larger than full)', '2048px', { progressive: false });
    check(res.displaySize.width === W, 'target larger than full decodes at full size');
    check(res.loadMode === 'full', 'target larger than full reports loadMode=full');
}

// Percent targets go through the same path.
{
    const { res } = await pass("one-shot '25%'", '25%', { progressive: false });
    check(res.displaySize.width === 256, "one-shot '25%' decoded at 256x256");
}

// preview() shares the path and must stay a single decode.
{
    decodes = 0;
    const res = await emage.preview({ thumbSize: 64 });
    console.log(`preview 64: ${res.displaySize ? res.displaySize.width + 'x' + res.displaySize.height : '-'} ` +
        `[decodes=${decodes} reduction=${res.reduction}]`);
    check(decodes === 1, 'preview is exactly 1 decoder run');
    check(res.decoded.width === 64, 'preview 64 decoded at 64x64');
}

// The reported decoder-run count must match reality, including the discovery
// decode, because compare.html reports it as a headline metric.
{
    const { res } = await pass('progressive 256px (decodes metric)', '256px', {});
    check(res.decodes === decodes, `res.decodes (${res.decodes}) matches the real count (${decodes})`);
    check(res.decodes >= res.steps.length, 'decodes is never less than the number of frames');
}
{
    const { res } = await pass("one-shot 'all' (decodes metric)", 'all', { progressive: false });
    check(res.decodes === 1, "one-shot 'all' reports decodes=1");
}

// With the server reporting the count, the progressive path must not spend a
// discovery decode on the level it is going to decode anyway.
{
    const { res } = await pass('progressive 256px (server reports count)', '256px', {});
    check(res.decodes === res.steps.length, 'no discovery decode when the server reports the count');
}
{
    const { res } = await pass("progressive 'all' (server reports count)", 'all', {});
    check(res.decodes === NUM_RESOLUTIONS, `progressive 'all' is exactly ${NUM_RESOLUTIONS} decodes`);
}

// A server that omits the count must still work, via the discovery decode, and
// must not produce a duplicated coarsest frame. The probe decodes the
// absolute coarsest level, so when the target's start is finer than that the
// probe's frame is not one the caller asked for and cannot be reused; the extra
// decode is the cost of the fallback, and it is reported honestly.
{
    META = { width: W, height: H, layers: 0, bytes: 0 };
    console.log('\n-- legacy server (no `layers` in meta) --');
    const { res } = await pass('progressive 256px (legacy meta)', '256px', {});
    check(res.numResolutions === NUM_RESOLUTIONS, 'loader recovered the count by probing');
    const sizes = res.steps.map((s) => s.width);
    check(new Set(sizes).size === sizes.length, 'legacy path emits no duplicate level');
    check(sizes.at(-1) === 256, 'legacy path still lands on the target');
    check(res.decodes === res.steps.length + 1, 'legacy path costs exactly one extra probe decode');
    check(res.steps[0].width === 64, 'legacy path still starts at the previewSteps level');
}
{
    // When the target is the full image the probe *is* the coarsest frame.
    META = { width: W, height: H, layers: 0, bytes: 0 };
    const { res } = await pass("progressive 'all' (legacy meta)", 'all', {});
    check(res.numResolutions === NUM_RESOLUTIONS, 'legacy full path recovered the count');
    check(res.decodes === res.steps.length, 'legacy full path reuses the probe as its first frame');
    check(res.steps.length === NUM_RESOLUTIONS, 'legacy full path still visits every level');
    META = { width: W, height: H, layers: NUM_RESOLUTIONS, bytes: 0 };
}

// Bytes come from one request; the levels are not separately addressable.
check(requests > 0, 'the loader used fetch');
console.log(`\ntotal HTTP requests: ${requests} (1 codestream fetch per display call + 1 meta fetch each)`);
console.log(failures.length ? `\n${failures.length} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
