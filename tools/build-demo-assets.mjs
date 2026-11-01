import { wasmDir } from '../wasm_test_path.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Original, procedural artwork: ten different RGB images, with lossless PNG
// originals and encrypted lossless J2K counterparts. No downloads/dependencies.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Emage } from '../emage.js';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const directory = new URL('demo-assets/', root);
const wasm = pathToFileURL(path.resolve(wasmDir) + path.sep);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const build = hash(Buffer.concat([readFileSync(fileURLToPath(import.meta.url)), ...['EmageWasmEncoder.wasm', 'EmageWasmDecoder.wasm'].map(name => readFileSync(new URL(name, wasm)))]));
mkdirSync(directory, { recursive: true });
const manifestPath = new URL('manifest.json', directory);
if (!process.argv.includes('--force') && existsSync(manifestPath)) {
  const previous = JSON.parse(readFileSync(manifestPath));
  if (previous.build === build && previous.images.length === 10 && previous.images.every(image => ['png', 'j2k'].every(kind => existsSync(new URL(image[kind], root))))) {
    console.log('Ten demo image pairs are already built.');
    process.exit(0);
  }
}
const binary = name => 'data:application/wasm;base64,' + readFileSync(new URL(name, wasm)).toString('base64');
const engine = await Emage.init({
  encoder: () => require(fileURLToPath(new URL('EmageWasmEncoder.js', wasm)))({ locateFile: () => binary('EmageWasmEncoder.wasm') }),
  decoder: () => require(fileURLToPath(new URL('EmageWasmDecoder.js', wasm)))({ locateFile: () => binary('EmageWasmDecoder.wasm') }),
});
const width = 1024, height = 704, layers = 7;
const scenes = [
  ['tidal-light', 'Tidal light', [147, 191, 193], [242, 206, 158], [26, 66, 64]],
  ['ochre-ridge', 'Ochre ridge', [190, 176, 151], [245, 218, 177], [139, 65, 43]],
  ['blue-hour', 'Blue hour', [32, 52, 88], [159, 153, 179], [18, 39, 59]],
  ['alpine-lake', 'Alpine lake', [116, 169, 192], [223, 225, 202], [41, 77, 67]],
  ['moss-garden', 'Moss garden', [171, 186, 133], [222, 210, 145], [44, 78, 47]],
  ['salt-flats', 'Salt flats', [137, 177, 197], [240, 222, 199], [142, 146, 153]],
  ['copper-city', 'Copper city', [185, 141, 128], [246, 208, 158], [63, 55, 63]],
  ['lunar-coast', 'Lunar coast', [38, 58, 69], [138, 168, 169], [19, 48, 51]],
  ['dune-study', 'Dune study', [157, 186, 185], [245, 214, 169], [154, 82, 46]],
  ['violet-valley', 'Violet valley', [146, 148, 187], [229, 190, 183], [68, 58, 100]],
];
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
function artwork(index) {
  const [, , sky, horizon, ground] = scenes[index];
  const rgb = new Uint8Array(width * height * 3);
  let rng = 43987 + index * 9173;
  const sunX = .25 + (index % 4) * .16, sunY = .23 + (index % 3) * .035;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width, v = y / height;
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    const grain = ((rng >>> 24) / 255 - .5) * 5;
    let color = mix(sky, horizon, Math.min(1, v * 1.6));
    if (Math.hypot((u - sunX) * width, (v - sunY) * height) < 36 + index * 2) color = mix(horizon, [255, 244, 206], .8);
    for (let ridge = 0; ridge < 4; ridge++) {
      const edge = .45 + ridge * .125 + Math.sin(u * (5 + index * .3) + index + ridge * 1.3) * (.08 - ridge * .01)
        + Math.cos(u * 17 + index * 2 + ridge) * .015;
      if (v > edge) color = mix(horizon, ground, .35 + ridge * .21);
    }
    if (index % 3 === 0 && v > .68) {
      color = mix(ground, horizon, .25 + Math.sin(v * 120 + u * 4) * .08);
      if (Math.abs(u - sunX) < (v - .65) * .55 && Math.sin(v * 470) > .15) color = mix(color, horizon, .38);
    }
    if ([2, 6].includes(index) && v > .51) {
      const block = Math.floor(u * 24);
      const roof = .52 + ((block * 13 + index * 7) % 17) / 100;
      if (v > roof && v < .9) {
        color = mix(ground, [25, 35, 45], .35);
        if (x % 42 > 13 && x % 42 < 20 && y % 23 > 6 && y % 23 < 12 && (block + Math.floor(y / 23)) % 3) color = [232, 187, 114];
      }
    }
    if (index === 4) {
      const leaf = Math.sin(u * 48 + Math.cos(v * 12) * 4) + Math.cos(v * 50 + u * 18);
      if (v > .35 && leaf > 1.1) color = mix(ground, [129, 152, 76], v);
    }
    if ([1, 8, 9].includes(index) && v > .6) {
      const contour = Math.sin(v * 200 + Math.sin(u * 12 + index) * 12);
      color = mix(color, horizon, Math.max(0, contour) * .11);
    }
    const offset = (y * width + x) * 3;
    for (let channel = 0; channel < 3; channel++) rgb[offset + channel] = Math.max(0, Math.min(255, Math.round(color[channel] + grain)));
  }
  return rgb;
}
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const value of Buffer.concat([name, data])) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, data, checksum]);
}
function png(rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1);
    rows[start] = 1; // PNG Sub filter; reverse exactly, no loss of source pixels.
    for (let i = 0; i < width * 3; i++) rows[start + 1 + i] = (rgb[y * width * 3 + i] - (i >= 3 ? rgb[y * width * 3 + i - 3] : 0)) & 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const images = [];
for (let index = 0; index < scenes.length; index++) {
  const [id, title] = scenes[index];
  const rgb = artwork(index);
  const original = png(rgb);
  const masterKey = createHash('sha3-256').update('PUBLIC EMAGE BLOG SAMPLE v1 ' + id).digest('hex');
  engine.setCrypto({ key: masterKey, iv: randomBytes(16), accessLevel: 'all' });
  const encoded = engine.encodePixelData(rgb, width, height, { numComponents: 3, numResolutions: layers });
  const bytes = Emage.withMetadata(encoded, { ...Emage.readMetadata(encoded), demo: { id, build } });
  const decoded = engine.decode(bytes);
  for (let i = 0, p = 0; i < rgb.length; i += 3, p += 4) {
    if (rgb[i] !== decoded.rgbaPixels[p] || rgb[i + 1] !== decoded.rgbaPixels[p + 1] || rgb[i + 2] !== decoded.rgbaPixels[p + 2]) throw new Error('Lossless verification failed: ' + id);
  }
  writeFileSync(new URL(id + '.png', directory), original);
  writeFileSync(new URL(id + '.j2k', directory), bytes);
  images.push({ id, title, width, height, layers, serverPath: `blog-demo/v1/${id}.j2k`, png: `demo-assets/${id}.png`, j2k: `demo-assets/${id}.j2k`, pngBytes: original.length, j2kBytes: bytes.length, pixelSha256: hash(rgb), pngSha256: hash(original), j2kSha256: hash(bytes), masterKey, keys: engine.granularKeys(layers) });
  console.log(`${index + 1}/10 ${title}: PNG ${original.length} B; J2K ${bytes.length} B; lossless roundtrip verified.`);
}
writeFileSync(manifestPath, JSON.stringify({ version: 1, build, publicSamples: true, description: 'Ten distinct procedural artworks. Public demonstration keys; both encodings are lossless.', images }, null, 2) + '\n');
console.log('Built ten unique sample pairs and their public demo manifest.');
