import { Emage } from '../emage.js';
import { escapeHtml, fmtBytes } from './common.js';

const $ = selector => document.querySelector(selector);
const profiles = {
  slow: 'Constrained · 96 KiB/s · 180 ms',
  balanced: 'Everyday · 512 KiB/s · 60 ms',
  demo: 'Demo · 2 MiB/s · 30 ms',
  fast: 'Fast · 4 MiB/s · 20 ms',
};
const strategies = [
  ['Progressive to target', 'Coarse first; request each next resolution as it is shown.'],
  ['One-shot at target', 'The same target window, fetched and decoded once.'],
  ['One-shot full', 'Every resolution, even when the display is smaller.'],
];
let engine, manifest, ready = false, busy = false, layerCache = null, activeRun = null;
let transport = null;
let comparisonRuns = [];
const ms = value => value == null ? '—' : `${value.toFixed(0)} ms`;
const runId = () => {
  const value = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  activeRun?.ids.add(value);
  return value;
};
const sample = selector => manifest.images.find(image => image.id === $(selector).value) || manifest.images[0];
const url = (path, origin = window.location.origin) => new URL(path, origin).href;
const route = (profile, run, lane) => `/demo/net/${profile}/${run}/${lane}`;
function status(id, text, error = false) {
  const element = $('#' + id);
  element.textContent = text;
  element.classList.toggle('error', error);
}
function key(value) {
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('Enter a 64-digit hexadecimal key from the owner pane, or another key you want to test.');
  return normalized;
}
function client(image, suppliedKey, profile, run, lane, origin) {
  const out = new Emage();
  out.encoder = engine.encoder;
  out.decoder = engine.decoder;
  out.setServer({ baseUrl: url(route(profile, run, lane) + '/api', origin), imagePath: image.serverPath.split('/').map(encodeURIComponent).join('/') });
  out.setCrypto({ key: key(suppliedKey), iv: null, accessLevel: 'all' });
  return out;
}
function sync() {
  document.querySelectorAll('button, input, select').forEach(element => {
    if (!element.matches('[data-theme-select]')) element.disabled = !ready || busy;
  });
  document.querySelectorAll('[data-layer-view]').forEach(button => {
    button.disabled = !ready || busy || !layerCache || Number(button.dataset.layerView) > layerCache.end;
  });
  document.querySelector('main').setAttribute('aria-busy', String(busy));
  $('#experimentControls').hidden = !busy;
  $('#stopExperiment').disabled = !busy || Boolean(activeRun?.controller.signal.aborted);
}
async function run(statusId, label, action) {
  if (!ready || busy) return;
  busy = true;
  const job = { controller: new AbortController(), ids: new Set(), statusId };
  activeRun = job;
  $('#activeExperiment').textContent = label;
  sync();
  status(statusId, label);
  try {
    await action(job.controller.signal);
    job.controller.signal.throwIfAborted();
  } catch (error) {
    status(statusId, job.controller.signal.aborted ? 'Experiment stopped. Change the settings or run another experiment.' : Emage.messageOf(error), !job.controller.signal.aborted);
  } finally {
    job.controller.abort();
    activeRun = null;
    busy = false;
    sync();
  }
}
$('#stopExperiment').onclick = () => {
  if (!activeRun || activeRun.controller.signal.aborted) return;
  activeRun.controller.abort(new DOMException('Experiment stopped', 'AbortError'));
  status(activeRun.statusId, 'Stopping downloads…');
  for (const id of activeRun.ids) {
    // This uses the control origin, outside the four busy gallery pools.
    fetch(url('/demo/cancel/' + id), { method: 'POST', keepalive: true }).catch(() => {});
  }
  sync();
};
function show(canvas) { canvas.closest('.surface').classList.add('has-frame'); }
function resetCanvas(id) {
  const canvas = $('#' + id);
  canvas.width = canvas.height = 0;
  canvas.closest('.surface').classList.remove('has-frame');
}
function target(selector) {
  const input = $(selector);
  const value = Number(input.value);
  const minimum = Number(input.min), maximum = Number(input.max);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const message = `Choose a whole-number display width from ${minimum} to ${maximum} pixels.`;
    input.setAttribute('aria-invalid', 'true');
    const error = document.getElementById(input.id + 'Error');
    if (error) { error.textContent = message; error.hidden = false; }
    throw new Error(message);
  }
  input.removeAttribute('aria-invalid');
  return value;
}
function comparisonPanels() {
  $('#comparisonPanels').innerHTML = strategies.map(([title, description], index) => `<section class="strategy"><div class="strategy-head"><span class="strategy-letter">${'ABC'[index]}</span><div><h4>${title}</h4><small>${description}</small></div></div><div class="surface"><canvas id="compareCanvas${index}" width="0" height="0" aria-label="${title} image"></canvas><span class="placeholder">Waiting for a measured run.</span></div><output id="compareLevel${index}" class="frame-level" aria-live="polite">Current level: waiting for a frame</output><div id="compareTelemetry${index}" class="telemetry">No frames yet.</div></section>`).join('');
}
function frameLabel(image, frame) {
  return `Current level: L${image.layers - 1 - frame.reduction} / L${image.layers - 1} · ${frame.width} × ${frame.height}`;
}
function resultsTable() {
  $('#compareResults').innerHTML = comparisonRuns.length ? comparisonRuns.map(result => `<tr><td>${escapeHtml(result.profile)} / ${result.strategy} · ${escapeHtml(result.title)}</td><td>${fmtBytes(result.bytes)}</td><td>${result.requests}</td><td>${ms(result.first)}</td><td>${ms(result.total)}</td><td>${result.width} × ${result.height}</td></tr>`).join('') : '<tr><td colspan="6">No runs yet.</td></tr>';
}
async function compare(profile, signal) {
  $('#compareSpeed').value = profile;
  const image = sample('#compareImage');
  const size = target('#compareSize');
  const run = runId();
  comparisonPanels();
  for (let index = 0; index < strategies.length; index++) {
    signal.throwIfAborted();
    const instance = client(image, image.masterKey, profile, run, 'compare-' + index);
    const canvas = $('#compareCanvas' + index);
    const start = performance.now();
    let first = null;
    status('compareStatus', `${profiles[profile]} · ${'ABC'[index]}. ${strategies[index][0]} running…`);
    const result = await instance.display(index === 2 ? 'all' : size, {
      signal,
      progressive: index === 0,
      canvas,
      onLayer: frame => {
        first ??= performance.now() - start;
        show(canvas);
        $('#compareLevel' + index).textContent = frameLabel(image, frame);
        $('#compareTelemetry' + index).textContent = `L${image.layers - 1 - frame.reduction} · ${frame.width} × ${frame.height} · ${ms(performance.now() - start)}`;
      },
    });
    const measured = { profile: profiles[profile].split(' · ')[0], strategy: 'ABC'[index], title: image.title, bytes: result.transferredBytes, requests: result.httpRequests, first, total: performance.now() - start, width: result.decoded.width, height: result.decoded.height };
    $('#compareTelemetry' + index).textContent = `${fmtBytes(measured.bytes)} · ${measured.requests} requests · first ${ms(measured.first)} · done ${ms(measured.total)}`;
    comparisonRuns.push(measured);
    resultsTable();
  }
  status('compareStatus', `Finished ${profiles[profile].split(' · ')[0].toLowerCase()} connection: three real decodes measured. A and B target ${size}px; C loads full resolution. Downloaded image verified.`);
}
$('#compareRun').onclick = () => run('compareStatus', 'Starting comparison…', signal => compare($('#compareSpeed').value, signal));
$('#compareAll').onclick = () => run('compareStatus', 'Starting all connection profiles…', async signal => {
  for (const profile of Object.keys(profiles)) await compare(profile, signal);
  status('compareStatus', 'All four connection profiles finished. Twelve measured runs are in the table.');
});
for (const id of ['compareImage', 'compareSpeed', 'compareSize']) $('#' + id).addEventListener('change', () => {
  comparisonPanels();
  status('compareStatus', 'Settings changed. Run a comparison to measure this setup.');
});

function galleryCards() {
  for (const kind of ['emage', 'png']) {
    $('#' + kind + 'Gallery').innerHTML = manifest.images.map((image, index) => `<figure class="gallery-card" data-sample="${image.id}"><div class="surface" id="${kind}Surface${index}">${kind === 'emage' ? `<canvas id="galleryCanvas${index}" width="0" height="0" aria-label="${escapeHtml(image.title)} progressive thumbnail"></canvas>` : ''}<span class="placeholder">${String(index + 1).padStart(2, '0')}</span></div><figcaption>${escapeHtml(image.title)}</figcaption><small class="gallery-state" id="${kind}State${index}">Waiting</small></figure>`).join('');
  }
}
$('#gallerySize').addEventListener('input', () => {
  $('#gallerySize').removeAttribute('aria-invalid');
  $('#gallerySizeError').hidden = true;
  $('#gallerySizeError').textContent = '';
});
$('#galleryRun').onclick = () => run('galleryStatus', 'Loading the two galleries…', async signal => {
  const profile = $('#gallerySpeed').value;
  const size = target('#gallerySize');
  const run = runId();
  galleryCards();
  const start = performance.now();
  const totals = { emage: { seen: new Set(), done: 0, bytes: 0, first: null, total: null, failed: 0 }, png: { seen: new Set(), done: 0, bytes: 0, first: null, total: null, failed: 0 } };
  function summary(kind) {
    const value = totals[kind];
    const progress = kind === 'emage' ? `${value.seen.size}/10 previews · ${value.done}/10 complete` : `${value.done}/10 loaded`;
    const firstLabel = kind === 'emage' ? 'first decoded preview' : 'first load event';
    $('#' + kind + 'Summary').textContent = `${progress} · ${fmtBytes(value.bytes)} completed image bodies · ${firstLabel} ${ms(value.first)}${value.total != null ? ' · all done ' + ms(value.total) : ''}${value.failed ? ' · ' + value.failed + ' failed' : ''}`;
  }
  function visible(kind, index) {
    totals[kind].seen.add(index);
    totals[kind].first ??= performance.now() - start;
    summary(kind);
  }
  function complete(kind, bytes) {
    totals[kind].done++;
    totals[kind].bytes += bytes;
    if (totals[kind].done === manifest.images.length) totals[kind].total = performance.now() - start;
    summary(kind);
  }
  summary('emage'); summary('png');
  const progressive = manifest.images.map(async (image, index) => {
    const instance = client(image, image.masterKey, profile, run, 'gallery-emage', transport.emageOrigins[index % 2]);
    const canvas = $('#galleryCanvas' + index);
    try {
      const result = await instance.display(size, { canvas, signal, onLayer: frame => {
        show(canvas);
        visible('emage', index);
        $('#emageState' + index).textContent = `L${image.layers - 1 - frame.reduction} · ${frame.width} × ${frame.height}`;
      } });
      $('#emageState' + index).textContent += ` · ${fmtBytes(result.transferredBytes)}`;
      complete('emage', result.transferredBytes);
    } catch (error) {
      if (signal.aborted) {
        $('#emageState' + index).textContent = 'Stopped';
        throw error;
      }
      totals.emage.failed++;
      $('#emageState' + index).textContent = 'Failed: ' + Emage.messageOf(error);
      summary('emage');
      throw error;
    }
  });
  // Ordinary <img> loads, not fetch-then-paint or fake progress indicators.
  const originals = manifest.images.map((image, index) => new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.alt = image.title + ' full-size PNG displayed as a thumbnail';
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    const source = url(route(profile, run, 'gallery-png') + '/png/' + image.id + '.png', transport.pngOrigins[index % 2]);
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      img.onload = img.onerror = null;
    };
    const abort = () => {
      cleanup();
      img.removeAttribute('src');
      $('#pngState' + index).textContent = 'Stopped';
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    img.onload = () => {
      cleanup();
      $('#pngSurface' + index).classList.add('has-frame');
      visible('png', index);
      const timing = performance.getEntriesByName?.(source).at(-1);
      // Same-origin resource timing where available; otherwise the exact PNG
      // file length declared in the generated/verified fixture manifest.
      const bytes = timing?.encodedBodySize || image.pngBytes;
      $('#pngState' + index).textContent = `${ms(performance.now() - start)} · ${fmtBytes(bytes)}`;
      complete('png', bytes);
      resolve();
    };
    img.onerror = () => {
      cleanup();
      totals.png.failed++;
      $('#pngState' + index).textContent = 'Image request failed';
      summary('png');
      reject(new Error('PNG image request failed.'));
    };
    $('#pngSurface' + index).append(img);
    img.src = source;
  }));
  const results = await Promise.allSettled([...progressive, ...originals]);
  signal.throwIfAborted();
  const failures = results.filter(result => result.status === 'rejected').length;
  status('galleryStatus', failures ? `${failures} loads failed. Completed-body totals exclude failed/partial transfers; check that the proxy and Emage API are running.` : `Twenty loads finished. Each row shared one ${profiles[profile].split(' · ')[1]} budget. Emage requested ${size}px targets; PNGs loaded their full-size originals.`, failures > 0);
});

function drawLayers() {
  const image = sample('#layerImage');
  $('#layerButtons').innerHTML = Array.from({ length: image.layers }, (_, level) => {
    const available = layerCache && level <= layerCache.end;
    return `<button type="button" data-layer-view="${level}" aria-pressed="${level === layerCache?.selected}" title="${available ? 'Render locally from downloaded bytes' : 'Stream this level first'}" ${!available || busy ? 'disabled' : ''}>L${level}</button>`;
  }).join('');
  $('#layerZones').innerHTML = Array.from({ length: image.layers }, (_, level) => `<span class="${layerCache && level <= layerCache.end ? 'fetched' : ''}" style="flex:${layerCache?.sizes[level] || 1}" title="L${level}${layerCache ? ': ' + fmtBytes(layerCache.sizes[level]) : ''}"></span>`).join('');
}
function clearLayers() {
  layerCache = null;
  resetCanvas('layerCanvas');
  const image = sample('#layerImage');
  $('#layerLimit').innerHTML = Array.from({ length: image.layers }, (_, level) => `<option value="${level}">L${level} · ${Math.ceil(image.width / 2 ** (image.layers - 1 - level))} × ${Math.ceil(image.height / 2 ** (image.layers - 1 - level))}</option>`).join('');
  $('#layerLimit').value = image.layers - 1;
  $('#layerStage').textContent = 'No bytes loaded';
  $('#layerTimeline').innerHTML = '<li>Waiting for a stream.</li>';
  drawLayers();
}
$('#layerImage').onchange = clearLayers;
$('#layerRun').onclick = () => run('layerStatus', 'Streaming image resolutions…', async signal => {
  const image = sample('#layerImage');
  const limit = Number($('#layerLimit').value);
  if (!Number.isInteger(limit) || limit < 0 || limit >= image.layers) throw new Error('Choose a valid resolution endpoint.');
  layerCache = null;
  resetCanvas('layerCanvas');
  $('#layerStage').textContent = 'Current level: waiting for a frame';
  drawLayers();
  $('#layerTimeline').replaceChildren();
  const instance = client(image, image.masterKey, $('#layerSpeed').value, runId(), 'layers');
  const start = performance.now();
  const canvas = $('#layerCanvas');
  const result = await instance.display('all', { accessLevel: limit, canvas, signal, onLayer: frame => {
    const level = image.layers - 1 - frame.reduction;
    const entry = document.createElement('li');
    entry.textContent = `L${level} · ${frame.width} × ${frame.height} · ${ms(performance.now() - start)}`;
    $('#layerTimeline').append(entry);
    $('#layerStage').textContent = frameLabel(image, frame);
    show(canvas);
  } });
  layerCache = { client: instance, stream: result.stream, end: image.layers - 1 - result.decoded.reduction, selected: image.layers - 1 - result.decoded.reduction, sizes: instance.describeSecurityZone(result.stream).sizes };
  drawLayers();
  status('layerStatus', `${result.steps.length} real progressive frames · ${fmtBytes(result.transferredBytes)} image bytes · ${result.httpRequests} requests · Image verified. Level buttons now render locally.`);
});
$('#layerButtons').onclick = event => {
  const button = event.target.closest('[data-layer-view]');
  if (!button || button.disabled || !layerCache || busy) return;
  const level = Number(button.dataset.layerView);
  const image = sample('#layerImage');
  try {
    const decoded = layerCache.client.decode(layerCache.stream, { accessLevel: level, reduction: image.layers - 1 - level });
    layerCache.client.paintTo($('#layerCanvas'), decoded, { width: image.width, height: image.height });
    layerCache.selected = level;
    $('#layerStage').textContent = frameLabel(image, decoded);
    drawLayers();
    status('layerStatus', `L${level} · ${decoded.width} × ${decoded.height} · rendered from downloaded bytes. No HTTP requests made.`);
  } catch (error) { status('layerStatus', Emage.messageOf(error), true); }
};

function ownerKeys() {
  const image = sample('#accessImage');
  const instance = client(image, image.masterKey, $('#accessSpeed').value, runId(), 'derive');
  const keys = instance.granularKeys(image.layers);
  $('#ownerKeys').innerHTML = keys.map((value, level) => `<div class="owner-key"><div class="key-heading"><strong>K<sub>${level}</sub></strong><span>${Math.ceil(image.width / 2 ** (image.layers - 1 - level))} × ${Math.ceil(image.height / 2 ** (image.layers - 1 - level))}${level === image.layers - 1 ? ' · MASTER' : ''}</span><button class="secondary" type="button" data-key-use="${level}" data-key="${value}">Use K<sub>${level}</sub></button></div><code>${value}</code></div>`).join('');
}
function clearReader() { resetCanvas('readerCanvas'); status('readerStatus', 'Key changed. Load to test the supplied key.'); }
$('#readerKey').addEventListener('input', clearReader);
$('#accessImage').onchange = () => {
  resetCanvas('ownerCanvas');
  $('#readerKey').value = '';
  clearReader();
  ownerKeys();
  status('ownerStatus', 'Image changed. Keys below were derived locally for this sample.');
};
$('#ownerKeys').onclick = event => {
  const button = event.target.closest('[data-key-use]');
  if (!button || button.disabled) return;
  $('#readerKey').value = button.dataset.key;
  clearReader();
  status('readerStatus', `Key for level ${button.dataset.keyUse} entered. Click Load using this key to test its grant.`);
};
async function accessView(side, signal) {
  resetCanvas(side + 'Canvas');
  const image = sample('#accessImage');
  // The reader has no fallback to the master. Only this input supplies its key.
  const suppliedKey = side === 'owner' ? image.masterKey : key($('#readerKey').value);
  const instance = client(image, suppliedKey, $('#accessSpeed').value, runId(), side);
  const canvas = $('#' + side + 'Canvas');
  const result = await instance.playAll({ canvas, signal, onLayer: frame => {
    show(canvas);
    status(side + 'Status', `Decoded ${frame.width} × ${frame.height} · level ${image.layers - 1 - frame.reduction}.`);
  } });
  instance.paintTo(canvas, result.decoded, { width: image.width, height: image.height });
  status(side + 'Status', `Key grants L0–L${result.decoded.keyLevel} · decoded ${result.decoded.width} × ${result.decoded.height} · ${fmtBytes(result.transferredBytes)} fetched · ${result.httpRequests} requests · Image verified.`);
}
$('#ownerRun').onclick = () => run('ownerStatus', 'Loading the owner view…', signal => accessView('owner', signal));
$('#readerRun').onclick = () => run('readerStatus', 'Testing the supplied key…', signal => accessView('reader', signal));

comparisonPanels();
sync();
try {
  const [loadedEngine, loadedManifest, config] = await Promise.all([
    Emage.init({ wasmBase: new URL('../cmake-build-wasm/', import.meta.url).href }),
    fetch(new URL('../demo-assets/manifest.json', import.meta.url), { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error('Sample manifest missing. Run node tools/build-demo-assets.mjs.'); return response.json(); }),
    fetch(url('/demo/config'), { cache: 'no-store' }).then(response => response.ok ? response.json() : null).catch(() => null),
  ]);
  engine = loadedEngine;
  manifest = loadedManifest;
  transport = config?.transport;
  if (manifest.images.length !== 10 || new Set(manifest.images.map(image => image.pixelSha256)).size !== 10) throw new Error('The gallery requires ten distinct sample images. Rebuild demo assets.');
  document.querySelectorAll('[data-image-select]').forEach(select => { select.innerHTML = manifest.images.map(image => `<option value="${image.id}">${escapeHtml(image.title)}</option>`).join(''); });
  document.querySelectorAll('[data-speed-select]').forEach(select => {
    select.innerHTML = Object.entries(profiles).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    select.value = 'demo';
  });
  galleryCards();
  clearLayers();
  ownerKeys();
  const origins = [...(transport?.emageOrigins || []), ...(transport?.pngOrigins || [])];
  ready = Boolean(config?.ready && config?.images === 10 && config?.profiles?.demo?.bytesPerSecond === 2 * 1024 * 1024 && transport?.emageOrigins?.length === 2 && transport?.pngOrigins?.length === 2 && new Set(origins).size === 4 && origins.every(origin => new URL(origin).origin !== window.location.origin));
  status('bootStatus', ready ? 'Experiments ready. Demo speed is 2 MiB/s. Use Stop experiment to switch tests or change settings.' : 'Start or restart the demo proxy with npm run blog in Emage-Client, then open http://localhost:8082/blog.html. This version needs the 2 MiB/s profile and independent gallery connections.', !ready);
} catch (error) {
  status('bootStatus', 'Demo setup failed: ' + Emage.messageOf(error), true);
}
sync();
