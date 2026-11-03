import { $, Emage, Page, FileBrowser, icon, escapeHtml, fmtBytes, dimensions, setStatus, keyHex, loadKeys, readStore, writeStore, lookupLevel, copyText } from './common.js';

const page = new Page();
const source = $('#srcCanvas');
const destination = $('#dstCanvas');
let sourceReady = false;
let codestream = null;
let encodedKey = null;
let lastKeys = [];
let ring = loadKeys();
let active = readStore('emage.activeKey.v1', null);
const browser = new FileBrowser(page, {
  badges: true,
  onOpen: () => openSelected(),
  onSelect: () => page.sync(),
  onUpdate: () => drawRing(),
});

function authenticatedClient(options) {
  if (!$('#pwInput').value.trim()) {
    throw new Error('Enter the server upload password in the Password field before uploading or deleting.');
  }
  return page.client(options);
}

function syncEncryption() {
  const encrypted = $('#enc').checked;
  $('#keyWrap').style.opacity = encrypted ? 1 : .55;
  $('#keyGenBtn').disabled = !encrypted;
  $('#encNote').textContent = encrypted ? 'AES-256-CTR zones, SHA3-256 MAC chain' : 'Plaintext codestream, no SEC marker';
}
page.onSync = () => {
  syncEncryption();
  $('#processBtn').disabled = !sourceReady;
  for (const id of ['downloadBtn', 'upBtn', 'decodeBtn']) $('#' + id).disabled = !codestream;
  for (const id of ['openBtn', 'delBtn']) $('#' + id).disabled = !browser.selected;
  $('#copyKeysBtn').disabled = !lastKeys.length;
};

function drawKeys(keys = [], meta) {
  lastKeys = keys;
  $('#keysBody').innerHTML = keys.length ? keys.map((key, level) => `<div class="keyitem"><div class="top"><span class="tag mono">K<sub>${level}</sub></span><span class="g">Level ${level}</span><span class="mono sub">${dimensions(meta, level)}</span><button class="btn icon ghost" type="button" data-copy="${key}" aria-label="Copy key K${level}">${icon('copy', 16)}</button></div><span class="hex mono">${key}</span></div>`).join('') : '<p class="empty">Encode an encrypted image to see its resolution keys.</p>';
  page.sync();
}
function drawRing() {
  $('#krEmpty').hidden = ring.length > 0;
  $('#krList').innerHTML = ring.map(key => {
    const paths = browser.files.filter(file => lookupLevel(page.engine, browser.metas.get(file.path), key.key) >= 0).map(file => file.path);
    return `<div class="ring${key.key === active ? ' on' : ''}"><div class="top"><span class="tile">${icon('key', 18)}</span><span class="g">${escapeHtml(key.label)}<small class="mono">${key.key.slice(0, 4)}…${key.key.slice(-4)}</small></span><button class="btn small${key.key === active ? ' primary' : ''}" type="button" data-use="${key.key}">${key.key === active ? 'Active' : 'Use'}</button><button class="btn icon ghost" type="button" data-rm="${key.key}" aria-label="Remove saved key">${icon('x', 16)}</button></div><div class="stack"><span class="lbl sub">Matches ${paths.length} ${paths.length === 1 ? 'image' : 'images'}</span><div class="chips">${paths.map(path => `<span class="mono">${escapeHtml(path)}</span>`).join('')}</div></div></div>`;
  }).join('');
  page.sync();
}
function paint(decoded, label) {
  page.engine.paintTo(destination, decoded);
  $('#decodedEmpty').hidden = true;
  $('#stageLabel').textContent = label || `${decoded.width} × ${decoded.height}`;
}
function clearDecoded() {
  destination.width = destination.height = 0;
  $('#decodedEmpty').hidden = false;
  $('#stageLabel').textContent = 'No decoded image';
}
function randomKey() {
  $('#keyInput').value = Emage.bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  active = null;
  page.remember();
  drawRing();
  browser.render();
}

$('#enc').onchange = syncEncryption;
$('#keyGenBtn').onclick = () => { randomKey(); setStatus('Generated a random master key. Save it before sharing the image.'); };
$('#keyInput').addEventListener('change', () => { active = null; drawRing(); browser.render(); });
$('#fileInput').onchange = () => page.run('Loading source image…', async () => {
  const file = $('#fileInput').files[0];
  if (!file) return;
  sourceReady = false;
  source.width = source.height = 0;
  $('#sourceEmpty').hidden = false;
  $('#sourceSize').textContent = 'No source image';
  $('#fileName').textContent = file.name;
  codestream = null;
  drawKeys();
  clearDecoded();
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    source.width = image.naturalWidth;
    source.height = image.naturalHeight;
    source.getContext('2d').drawImage(image, 0, 0);
    sourceReady = true;
    $('#sourceEmpty').hidden = true;
    $('#fileName').textContent = file.name;
    $('#sourceSize').textContent = `${source.width} × ${source.height}`;
    const maximum = Math.min(64, Math.floor(Math.log2(Math.min(source.width, source.height))) + 1);
    $('#layerInput').max = maximum;
    if ($('#layerInput').value) $('#layerInput').value = Math.min(maximum, Number($('#layerInput').value) || 1);
    $('#layerHint').textContent = `1 to ${maximum} for this image. Blank uses the maximum.`;
    if (!$('#imgPath').value.trim()) $('#imgPath').value = file.name.replace(/\.[^.]+$/, '') + '.j2k';
    page.remember();
    setStatus(`Loaded ${file.name} · ${source.width} × ${source.height}. Ready to encode.`);
  } finally { URL.revokeObjectURL(url); }
});
$('#processBtn').onclick = () => page.run('Encoding and decoding locally…', async () => {
  const encrypted = $('#enc').checked;
  const client = page.client({ key: encrypted ? $('#keyInput').value : '' });
  const levels = $('#layerInput').value.trim() === '' ? Number($('#layerInput').max) : Number($('#layerInput').value);
  if (!Number.isInteger(levels) || levels < 1 || levels > Number($('#layerInput').max)) throw new Error(`Choose 1 to ${$('#layerInput').max} resolution levels, or leave the field blank.`);
  if (encrypted && !client.crypto.key) throw new Error('Enter or generate a master key before encrypting.');
  client.setCrypto({ iv: encrypted ? crypto.getRandomValues(new Uint8Array(16)) : null });
  const bytes = client.encodeCanvas(source, { enableSec: encrypted, numResolutions: levels });
  codestream = bytes;
  encodedKey = encrypted ? $('#keyInput').value.trim() : null;
  clearDecoded();
  drawKeys(encrypted ? client.granularKeys(levels) : [], { width: source.width, height: source.height, layers: levels });
  const decoded = client.decode(bytes);
  paint(decoded, `Level ${levels - 1} of ${levels - 1}`);
  setStatus(`Encoded ${source.width} × ${source.height} at ${levels} resolution levels · ${fmtBytes(bytes.length)} · ${encrypted ? 'encrypted; MAC chain verified' : 'plaintext'}. Ready to download or upload.`);
});
$('#j2kInput').onchange = () => page.run('Reading codestream…', async () => {
  const file = $('#j2kInput').files[0];
  if (!file) return;
  codestream = null;
  encodedKey = null;
  drawKeys();
  clearDecoded();
  const bytes = await Emage.readBytes(file);
  if (bytes[0] !== 0xff || bytes[1] !== 0x4f || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Choose a complete JPEG 2000 codestream (.j2k or .j2c).');
  page.engine.describeSecurityZone(bytes);
  codestream = bytes;
  $('#j2kName').textContent = file.name;
  if (!$('#imgPath').value.trim()) $('#imgPath').value = file.name;
  page.remember();
  setStatus(`Loaded ${file.name} · ${fmtBytes(bytes.length)}. Decode with a granted key, or upload the codestream.`);
});
$('#decodeBtn').onclick = () => page.run('Decoding loaded codestream…', async () => {
  clearDecoded();
  const client = page.client();
  const decoded = client.decode(codestream);
  paint(decoded);
  const zones = client.describeSecurityZone(codestream);
  const keys = zones.hasSec && decoded.keyLevel >= 0 ? client.granularKeys(decoded.keyLevel + 1) : [];
  drawKeys(keys, { width: decoded.width, height: decoded.height, layers: keys.length });
  setStatus(`Decoded ${decoded.width} × ${decoded.height} · ${zones.hasSec ? `key grants levels 0 to ${decoded.keyLevel}; MAC chain verified` : 'plaintext'}.`);
});
$('#downloadBtn').onclick = () => {
  const url = URL.createObjectURL(new Blob([codestream], { type: 'image/jp2' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = $('#imgPath').value.split('/').pop() || 'image.j2k';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Downloaded codestream · ${fmtBytes(codestream.length)}.`);
};
$('#upBtn').onclick = () => page.run('Uploading codestream…', async () => {
  if (!$('#imgPath').value.trim()) throw new Error('Enter an image path for the upload.');
  const client = authenticatedClient({ key: encodedKey || '' });
  const result = await client.upload(codestream);
  codestream = client.j2k || codestream;
  const message = `Uploaded ${result.stored} · ${result.width} × ${result.height} · ${fmtBytes(result.bytes)}.`;
  try { await browser.refresh(); setStatus(message); }
  catch (error) { setStatus(message + ' Listing refresh failed: ' + Emage.messageOf(error), true); }
});
const refresh = () => page.run('Refreshing server listing and key matches…', async () => {
  const count = await browser.refresh();
  setStatus(`Found ${count} server images. Key matches checked locally.`);
});
$('#galleryBtn').onclick = $('#krScanBtn').onclick = refresh;
function openSelected() {
  return page.run('Opening server image…', async () => {
    $('#imgPath').value = browser.selected;
    const match = browser.match(browser.selected);
    if (match) $('#keyInput').value = match.key;
    page.remember();
    clearDecoded();
    const client = page.client({ path: browser.selected, server: browser.server });
    const result = await client.playAll({ canvas: destination, onLayer: frame => {
      $('#decodedEmpty').hidden = true;
      $('#stageLabel').textContent = `${frame.width} × ${frame.height}`;
    } });
    const zones = client.describeSecurityZone(result.stream);
    setStatus(`Opened ${browser.selected} · ${result.decoded.width} × ${result.decoded.height} · ${fmtBytes(result.transferredBytes)} fetched · ${zones.hasSec ? 'MAC chain verified' : 'plaintext'}.`);
  });
}
$('#openBtn').onclick = openSelected;
$('#delBtn').onclick = () => page.run('Deleting selected server image…', async () => {
  const path = browser.selected;
  const client = authenticatedClient({ path, server: browser.server, key: '' });
  await client.remove();
  try { await browser.refresh(); setStatus(`Deleted ${path}.`); }
  catch (error) { setStatus(`Deleted ${path}. Listing refresh failed: ${Emage.messageOf(error)}`, true); }
});
$('#copyKeysBtn').onclick = () => copyText(lastKeys.map((key, i) => `K${i}\t${key}`).join('\n'), `Copied ${lastKeys.length} keys.`);
$('#keysBody').onclick = event => { const button = event.target.closest('[data-copy]'); if (button) copyText(button.dataset.copy); };
$('#krAddBtn').onclick = () => page.run('Saving current key…', async () => {
  const key = keyHex($('#keyInput').value);
  if (!key) throw new Error('Enter a key to save.');
  const label = $('#krLabel').value.trim();
  if (!label) throw new Error('Add a label so you can find this key later.');
  const next = [...ring.filter(k => k.key !== key), { id: key, key, label }];
  writeStore('emage.keyring.v1', next);
  writeStore('emage.activeKey.v1', key);
  ring = next;
  active = key;
  $('#krLabel').value = '';
  drawRing();
  browser.render();
  setStatus(`Saved ${label} to this device's key ring.`);
});
$('#krList').onclick = event => {
  const use = event.target.closest('[data-use]');
  const remove = event.target.closest('[data-rm]');
  page.run('Updating key ring…', async () => {
    if (use) {
      writeStore('emage.activeKey.v1', use.dataset.use);
      active = use.dataset.use;
      $('#keyInput').value = active;
      page.remember();
      setStatus('Selected saved key.');
    } else if (remove) {
      const next = ring.filter(k => k.key !== remove.dataset.rm);
      writeStore('emage.keyring.v1', next);
      ring = next;
      if (active === remove.dataset.rm) { active = null; writeStore('emage.activeKey.v1', null); }
      setStatus('Removed saved key from this device.');
    }
    drawRing();
    browser.render();
  });
};

drawKeys();
drawRing();
if (await page.init()) {
  if (!$('#keyInput').value) {
    const saved = ring.find(k => k.key === active);
    if (saved) $('#keyInput').value = saved.key;
    else randomKey();
  }
  page.sync();
  refresh();
}
