import { wasmDir } from './wasm_test_path.mjs';
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
const check = (c, m) => { if (!c) ++failed; console.log((c ? 'PASS  ' : 'FAIL  ') + m); };
const log = (m) => console.log('        ' + m);

const W = 512, H = 512, RES = 6;
const KEY = new Uint8Array(32).fill(0x11);
const IV = new Uint8Array(16).fill(0x22);
const PATH = 'progressive-probe.j2k';

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
log(`uploaded ${up.stored} ${up.width}x${up.height} layers=${up.layers}`);
check(up.layers === RES, `server parsed layers=${up.layers}`);

const realFetch = globalThis.fetch;
function install(stripLayers = false) {
    const reqs = [];
    globalThis.fetch = async (url, init) => {
        const mode = init?.headers?.['X-Emage-Layers'];
        reqs.push(mode);
        const r = await realFetch(url, init);
        if (stripLayers && mode === 'meta') {
            const data = await r.json();
            delete data.layers;
            delete data.numResolutions;
            return { ok: r.ok, status: r.status, text: async () => JSON.stringify(data) };
        }
        return r;
    };
    return reqs;
}
async function pass(label, target, opts, stripLayers = false) {
    const reqs = install(stripLayers);
    let res;
    try { res = await emage.display(target, opts); } finally { globalThis.fetch = realFetch; }
    const dims = res.steps.map((s) => `${s.width}x${s.height}`).join(' -> ');
    log(`${label}: ${dims} [decodes=${res.decodes} bytes=${res.transferredBytes} reqs=${reqs.join(', ')}]`);
    return { res, reqs };
}

const packets = (reqs) => reqs.filter((s) => s && s !== 'meta');
function checkIncremental(label, reqs) {
    const ps = packets(reqs).map((s) => s.split(':').map(Number));
    let ok = ps.length > 0 && ps[0][0] === 0;
    let prevM = ps.length ? ps[0][1] : -1;
    for (let i = 1; i < ps.length; ++i) {
        if (ps[i][0] !== prevM + 1 || ps[i][1] <= prevM) { ok = false; break; }
        prevM = ps[i][1];
    }
    check(ok, `${label}: ranges are incremental and cover every level once (${packets(reqs).join(', ') || 'none'})`);
    check(reqs[0] === 'meta' && reqs.filter((s) => s === 'meta').length === 1, `${label}: exactly one metadata request`);
}

{
    const { res, reqs } = await pass('progressive 256px', '256px', {});
    check(res.displaySize.width === 256 && res.displaySize.height === 256, 'progressive 256px lands on 256x256');
    check(res.reduction === 1, 'progressive 256px ends at reduction 1');
    check(res.numResolutions === RES, `loader learned numResolutions=${RES}`);
    check(res.steps.length >= 2, 'progressive 256px emitted more than one step');
    const sizes = res.steps.map((s) => s.width);
    check(sizes.every((w, i) => i === 0 || w > sizes[i - 1]), 'progressive steps strictly increase in size');
    check(new Set(sizes).size === sizes.length, 'progressive steps contain no duplicate level');
    check(res.steps.every((s, i) => s.complete === (i === res.steps.length - 1)), 'only the last step is marked complete');
    check(res.steps.every((s) => s.totalLayers === res.steps.length), 'totalLayers is the final step count');
    checkIncremental('progressive 256px', reqs);
    check(packets(reqs).length === res.steps.length, 'progressive 256px: one range request per frame');
    check(res.transferredBytes === res.stream.length, 'progressive 256px: transferred bytes equal the assembled stream (nothing re-fetched)');
}

let oneShot256 = 0;
{
    const { res, reqs } = await pass('one-shot 256px', '256px', { progressive: false });
    check(res.decodes === 1, 'one-shot 256px is exactly 1 decoder run');
    check(res.steps.length === 1, 'one-shot 256px emitted 1 step');
    check(res.displaySize.width === 256, 'one-shot 256px decoded at 256x256');
    check(packets(reqs).length === 1, 'one-shot 256px: a single range request (`0:last`)');
    oneShot256 = res.transferredBytes;
    log(`one-shot 256px bytes=${oneShot256}`);
}

{
    const { res, reqs } = await pass("one-shot 'all'", 'all', { progressive: false });
    check(res.decodes === 1, "one-shot 'all' is exactly 1 decoder run");
    check(res.displaySize.width === W && res.displaySize.height === H, "one-shot 'all' decoded at full size");
    check(res.loadMode === 'full', "one-shot 'all' reports loadMode=full");
    check(res.reduction === 0, "one-shot 'all' reports reduction 0");
    check(packets(reqs).length === 1, "one-shot 'all': a single range request");
}

{
    const { res, reqs } = await pass("progressive 'all'", 'all', {});
    const sizes = res.steps.map((s) => s.width);
    check(sizes.at(-1) === W, "progressive 'all' finishes at full width");
    check(sizes.every((w, i) => i === 0 || w > sizes[i - 1]), "progressive 'all' strictly increases");
    check(new Set(sizes).size === sizes.length, "progressive 'all' has no duplicate level");
    check(res.steps.length === RES, `progressive 'all' visited all ${RES} levels`);
    check(res.steps[0].width === W / 2 ** (RES - 1), "progressive 'all' starts at the coarsest level");
    check(res.loadMode === 'full', "progressive 'all' reports loadMode=full");
    checkIncremental("progressive 'all'", reqs);
    check(packets(reqs).length === RES, `progressive 'all': ${RES} incremental range requests`);
    check(res.decodes === RES, `progressive 'all' is exactly ${RES} decodes`);
}

{
    const { res } = await pass('progressive 256px (byte accounting)', '256px', {});
    check(res.transferredBytes === oneShot256,
        `progressive 256px downloads ${res.transferredBytes} B, the same as one-shot ${oneShot256} B`);
}

{
    const { res } = await pass('one-shot 8px (too small)', '8px', { progressive: false });
    check(res.decodedSize.width === W / 2 ** (RES - 1), 'over-fine target decodes at the coarsest size');
    check(res.reduction === RES - 1, 'over-fine target reports the max reduction');
    check(res.steps.length === 1, 'over-fine target still a single step');
}
{
    const { res, reqs } = await pass('progressive 8px (too small)', '8px', {});
    const sizes = res.steps.map((s) => s.width);
    check(sizes.at(-1) === W / 2 ** (RES - 1), 'progressive over-fine target ends at the coarsest size');
    check(new Set(sizes).size === sizes.length, 'progressive over-fine target has no duplicate level');
    check(res.steps.every((s, i) => i === 0 || s.width > res.steps[i - 1].width), 'progressive over-fine steps increase');
    checkIncremental('progressive 8px', reqs);
}

{
    const { res } = await pass('one-shot 2048px (larger than full)', '2048px', { progressive: false });
    check(res.displaySize.width === W, 'target larger than full decodes at full size');
    check(res.loadMode === 'full', 'target larger than full reports loadMode=full');
}
{
    const { res } = await pass("one-shot '25%'", '25%', { progressive: false });
    check(res.displaySize.width === Math.round(W * 0.25), "one-shot '25%' decoded at the percent size");
}

{
    const reqs = install();
    let res;
    try { res = await emage.preview({ thumbSize: 64 }); } finally { globalThis.fetch = realFetch; }
    log(`preview 64: ${res.decoded.width}x${res.decoded.height} [decodes=${res.decodes} reqs=${reqs.join(', ')}]`);
    check(res.decodes === 1, 'preview is exactly 1 decoder run');
    check(res.decoded.width === 64, 'preview 64 decoded at 64x64');
    check(packets(reqs).length === 1, 'preview uses a single range request');
}

console.log('\n-- legacy server (no `layers` in meta) --');
{
    const { res, reqs } = await pass('progressive 256px (legacy meta)', '256px', {}, true);
    check(res.numResolutions === RES, 'loader recovered the count by probing');
    const sizes = res.steps.map((s) => s.width);
    check(new Set(sizes).size === sizes.length, 'legacy path emits no duplicate level');
    check(sizes.at(-1) === 256, 'legacy path still lands on the target');
    check(res.decodes === res.steps.length, 'legacy path reuses the probe as its first frame');
    check(packets(reqs)[0] === '0:0', 'legacy path probes the coarsest window first');
    checkIncremental('progressive 256px (legacy)', reqs);
}
{
    const { res, reqs } = await pass("progressive 'all' (legacy meta)", 'all', {}, true);
    check(res.numResolutions === RES, 'legacy full path recovered the count');
    check(res.decodes === res.steps.length, 'legacy full path reuses the probe as its first frame');
    check(res.steps.length === RES, 'legacy full path still visits every level');
    check(packets(reqs).length === RES, 'legacy full path fetches each level once');
    checkIncremental("progressive 'all' (legacy)", reqs);
}

try { await emage.remove(); log('removed ' + PATH); } catch (e) { log('already gone: ' + PATH); }

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
