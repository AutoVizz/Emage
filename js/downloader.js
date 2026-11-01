import { $, Page, FileBrowser, icon, dimensions, fmtBytes, lookupLevel, setStatus } from './common.js';

const page = new Page();
const canvas = $('#dstCanvas');
let metadata = null;
let granted = null;
let loadedLevel = -1;
let loadingLevel = -1;
let zoneSizes = [];
let hasSecurity = false;
let cached = null;
const browser = new FileBrowser(page, {
  onOpen: () => {
    clear();
    setStatus('Image selected. Use Load for size or Load full to fetch image bytes.');
  },
  onSelect: () => clear(),
});

function clear() {
  metadata = null;
  granted = null;
  loadedLevel = -1;
  loadingLevel = -1;
  zoneSizes = [];
  hasSecurity = false;
  cached = null;
  canvas.width = canvas.height = 0;
  canvas.style.width = canvas.style.height = '';
  $('#decodedEmpty').hidden = false;
  $('#stageText').textContent = 'No image loaded';
  $('#fileName').textContent = $('#imgPath').value.trim() || 'Choose an image';
  $('#accessBadge').textContent = 'Load an image to check access';
  $('#bytesText').textContent = '';
  drawLevels();
  drawZones();
}
function showSize(width, height, dimension = null) {
  const scale = dimension > 0 ? dimension / Math.max(width, height) : 1;
  const shown = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  canvas.style.width = `${shown.width}px`;
  canvas.style.height = `${shown.height}px`;
  return shown;
}
function stageText(level, decoded, shown) {
  const size = `${shown.width} × ${shown.height}`;
  return `Level ${level} · ${size}${shown.width !== decoded.width || shown.height !== decoded.height ? ` displayed · ${decoded.width} × ${decoded.height} decoded` : ''}`;
}
function drawLevels() {
  $('#levels').innerHTML = !metadata ? '<span class="sub">Fetch metadata or load an image to see its levels.</span>' : Array.from({ length: metadata.layers }, (_, level) => {
    const locked = granted !== null && level > granted;
    const available = Boolean(cached) && level <= loadedLevel;
    const hint = locked ? 'Locked by key' : available ? 'View downloaded level' : 'Not downloaded. Use Load for size or Load full';
    return `<button class="lvl${level <= loadedLevel ? ' loaded' : ''}" type="button" data-level="${level}" data-locked="${locked}" data-available="${available}" aria-pressed="${level === loadingLevel}" title="${dimensions(metadata, level)} · ${hint}" ${locked || !available || page.busy ? 'disabled' : ''}>${locked ? icon('lock', 13) : ''}L${level}</button>`;
  }).join('');
}
function drawZones() {
  $('#zones').replaceChildren();
  $('#zoneNote').textContent = hasSecurity ? 'Zone widths follow protected packet bytes.' : 'Zone widths are schematic.';
  if (!metadata) return;
  for (let level = 0; level < metadata.layers; level++) {
    const zone = document.createElement('div');
    zone.className = granted !== null && level > granted ? 'lock' : level <= loadedLevel ? 'on' : '';
    zone.style.flex = `${zoneSizes[level] || 1} 1 0`;
    zone.title = `Level ${level}${zoneSizes[level] !== undefined ? ': ' + fmtBytes(zoneSizes[level]) : ''}`;
    $('#zones').append(zone);
  }
  $('#zones').setAttribute('aria-label', `${Math.max(0, loadedLevel + 1)} of ${metadata.layers} resolution zones fetched${hasSecurity ? '; widths proportional to protected packet bytes' : '; zone widths schematic'}`);
}
page.onSync = () => {
  $('#levels').querySelectorAll('button').forEach(button => { button.disabled = button.dataset.locked === 'true' || button.dataset.available !== 'true'; });
};
function showMeta(client, meta) {
  metadata = meta;
  $('#fileName').textContent = $('#imgPath').value.trim();
  if (meta.metadata?.keyMap) {
    granted = lookupLevel(client, meta, $('#keyInput').value.trim());
    $('#accessBadge').textContent = granted >= 0 ? `Key lookup: levels 0 to ${granted} of ${meta.layers - 1}` : 'Key does not match image metadata';
  } else {
    granted = null;
    $('#accessBadge').textContent = 'Decode to check protection and access';
  }
  drawLevels();
  drawZones();
}
function load(target) {
  return page.run('Loading image resolutions…', async () => {
    clear();
    const client = page.client();
    if (!$('#imgPath').value.trim()) throw new Error('Choose an image or enter its server path.');
    const result = await client.display(target, {
      canvas,
      onLayer: frame => {
        showSize(canvas.width, canvas.height);
        $('#decodedEmpty').hidden = true;
        $('#stageText').textContent = `${frame.width} × ${frame.height} · ${frame.complete ? 'Final frame' : `Frame ${frame.layer} of ${frame.totalLayers}`}`;
        setStatus(`Decoded ${frame.width} × ${frame.height}${frame.complete ? '.' : ' — fetching the next resolution…'}`);
      },
    });
    const decoded = result.decoded;
    page.updateHost(true);
    const security = client.describeSecurityZone(result.stream);
    metadata = result.meta;
    hasSecurity = Boolean(security.hasSec);
    zoneSizes = security.sizes;
    granted = hasSecurity ? decoded.keyLevel : metadata.layers - 1;
    loadedLevel = metadata.layers - 1 - decoded.reduction;
    loadingLevel = loadedLevel;
    cached = { client, stream: result.stream, transferredBytes: result.transferredBytes, httpRequests: result.httpRequests, displayDimension: result.targetDimension };
    // Keep the authenticated raster and size its on-screen display independently.
    client.paintTo(canvas, decoded);
    const shown = showSize(decoded.width, decoded.height, result.targetDimension);
    $('#decodedEmpty').hidden = true;
    $('#fileName').textContent = $('#imgPath').value.trim();
    $('#accessBadge').textContent = hasSecurity ? `Key opens levels 0 to ${granted} of ${metadata.layers - 1}` : `Plaintext · ${metadata.layers} accessible levels`;
    $('#stageText').textContent = stageText(loadedLevel, decoded, shown);
    $('#bytesText').textContent = `${fmtBytes(result.transferredBytes)} fetched · ${fmtBytes(metadata.bytes)} file`;
    drawLevels();
    drawZones();
    setStatus(`${$('#imgPath').value.trim()} · ${loadedLevel + 1} of ${metadata.layers} levels loaded · ${fmtBytes(result.transferredBytes)} fetched · ${result.httpRequests} HTTP requests · ${hasSecurity ? 'MAC chain verified' : 'plaintext'}.`);
  });
}
$('#levels').onclick = event => {
  const button = event.target.closest('[data-level]');
  if (!button || button.disabled || !cached) return;
  const level = Number(button.dataset.level);
  page.run('Rendering downloaded resolution…', async () => {
    const decoded = cached.client.decodeToCanvas(canvas, cached.stream, {
      accessLevel: level,
      reduction: metadata.layers - 1 - level,
    });
    loadingLevel = level;
    const shown = showSize(decoded.width, decoded.height, cached.displayDimension);
    $('#stageText').textContent = stageText(level, decoded, shown);
    drawLevels();
    setStatus(`Level ${level} · ${decoded.width} × ${decoded.height} · rendered from downloaded bytes · ${cached.httpRequests} HTTP requests from the last load · ${hasSecurity ? 'MAC chain verified' : 'plaintext'}.`);
  });
};
$('#sizeBtn').onclick = () => load($('#sizeInput').value.trim());
$('#fullBtn').onclick = () => load('all');
$('#metaBtn').onclick = () => page.run('Fetching image metadata…', async () => {
  clear();
  const client = page.client();
  if (!$('#imgPath').value.trim()) throw new Error('Choose an image or enter its server path.');
  const meta = await client.meta();
  page.updateHost(true);
  showMeta(client, meta);
  setStatus(`${meta.width} × ${meta.height} · ${meta.layers} resolution levels · ${fmtBytes(meta.bytes)}. Metadata fetched; no image packets downloaded.`);
});
const refresh = () => page.run('Refreshing server listing…', async () => {
  const count = await browser.refresh();
  setStatus(`Found ${count} server images. Select an image, then use the load buttons.`);
});
$('#browseBtn').onclick = refresh;
for (const id of ['serverUrl', 'imgPath', 'keyInput']) $('#' + id).addEventListener('change', clear);
clear();
if (await page.init()) refresh();
