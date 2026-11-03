import { $, Emage, Page, escapeHtml, fmtBytes, setStatus } from './common.js';

const page = new Page();
const strategies = [
  { title: 'Progressive', description: 'Coarse resolutions first, each one sharpening the last.', color: 'var(--green)', foreground: 'var(--on-accent)' },
  { title: 'One-shot at target', description: 'Fetch the packet window needed for the target size.', color: 'var(--lime)', foreground: 'var(--highlight-ink)' },
  { title: 'One-shot full', description: 'Fetch the entire accessible resolution window.', color: 'var(--zone)', foreground: 'var(--ink)' },
];
let runs = [];
function drawPanels() {
  $('#panels').innerHTML = strategies.map((strategy, index) => `<figure class="panel"><div class="hd"><span class="badge mono" style="background:${strategy.color};color:${strategy.foreground}">${String.fromCharCode(65 + index)}</span><div>${strategy.title}<small>${strategy.description}</small></div></div><div class="scene preview"><canvas id="canvas${index}" width="0" height="0" aria-label="${strategy.title} result"></canvas><span id="empty${index}">Waiting to run</span></div><div id="tele${index}" class="tele mono">No measurements yet</div></figure>`).join('');
  page.sync();
}
function drawResults() {
  const metrics = [
    ['Final decoded size', run => run.width * run.height, run => `${run.width} × ${run.height}`, false],
    ['Bytes transferred', run => run.bytes, run => fmtBytes(run.bytes), true],
    ['HTTP requests', run => run.requests, run => String(run.requests), true],
    ['Time to first frame', run => run.first, run => `${run.first.toFixed(1)} ms`, true],
    ['Total time', run => run.total, run => `${run.total.toFixed(1)} ms`, true],
  ];
  const head = `<div class="tr th" role="row"><span role="columnheader">METRIC</span>${strategies.map((s, i) => `<span role="columnheader">${String.fromCharCode(65 + i)}. ${s.title}</span>`).join('')}</div>`;
  $('#tbl').innerHTML = head + metrics.map(([name, value, format, compare]) => {
    const values = runs.filter(Boolean).map(value);
    const minimum = Math.min(...values);
    const maximum = Math.max(1, ...values);
    return `<div class="tr" role="row"><span role="rowheader">${name}</span>${strategies.map((_, index) => {
      const run = runs[index];
      if (!run) return '<div class="cell" role="cell">—</div>';
      const best = compare && runs.filter(Boolean).length === 3 && value(run) === minimum;
      return `<div class="cell" role="cell"><div class="mono">${format(run)}${best ? '<span class="best">Best</span>' : ''}</div><div class="meter"><i class="${best ? 'best' : ''}" style="width:${Math.max(4, value(run) / maximum * 100)}%"></i></div></div>`;
    }).join('')}</div>`;
  }).join('');
}
function clear() {
  runs = [];
  drawPanels();
  drawResults();
  $('#imgMeta').innerHTML = '<span class="pill">Run a comparison to inspect this image</span>';
}
$('#runBtn').onclick = () => page.run('Running comparison…', async () => {
  clear();
  if (!$('#imgPath').value.trim()) throw new Error('Enter the server path of an image to compare.');
  const clients = strategies.map(() => page.client());
  const target = $('#sizeInput').value.trim();
  const results = [];
  for (let index = 0; index < strategies.length; index++) {
    const start = performance.now();
    let first = null;
    const client = clients[index];
    const canvas = $('#canvas' + index);
    $('#empty' + index).textContent = 'Loading…';
    const result = await client.display(index === 2 ? 'all' : target, {
      canvas,
      progressive: index === 0,
      onLayer: frame => {
        first ??= performance.now() - start;
        $('#empty' + index).hidden = true;
        $('#tele' + index).textContent = `${frame.width} × ${frame.height} · frame ${frame.layer} of ${frame.totalLayers}`;
        setStatus(`${String.fromCharCode(65 + index)}. ${strategies[index].title}: decoded ${frame.width} × ${frame.height}.`);
      },
    }).catch(error => {
      $('#empty' + index).textContent = 'Load failed';
      $('#tele' + index).textContent = Emage.messageOf(error);
      throw error;
    });
    const total = performance.now() - start;
    client.paintTo(canvas, result.decoded);
    const run = { bytes: result.transferredBytes, requests: result.httpRequests, first: first ?? total, total, width: result.decoded.width, height: result.decoded.height };
    runs[index] = run;
    results.push(result);
    $('#tele' + index).textContent = `${fmtBytes(run.bytes)} · ${run.requests} requests · first ${run.first.toFixed(1)} ms · total ${run.total.toFixed(1)} ms`;
    drawResults();
  }
  const meta = results[0].meta;
  page.updateHost(true);
  const security = clients[0].describeSecurityZone(results[0].stream);
  const protection = security.hasSec ? `Encrypted · key grants levels 0 to ${results[0].decoded.keyLevel}` : 'Plaintext';
  $('#imgMeta').innerHTML = [`${meta.width} × ${meta.height}`, `${meta.layers} levels`, fmtBytes(meta.bytes), protection].map(label => `<span class="pill mono">${escapeHtml(label)}</span>`).join('');
  setStatus(`Compared three strategies · ${security.hasSec ? 'all decoded MAC chains verified' : 'plaintext image'}. Bytes count image response bodies. HTTP requests include metadata. Timings use this browser's current cache and connection.`);
});
for (const id of ['serverUrl', 'imgPath', 'keyInput', 'sizeInput']) $('#' + id).addEventListener('change', clear);
clear();
await page.init();
