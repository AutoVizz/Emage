# Emage Client — Frontend

## What this project is

Emage Client is the browser-side frontend for **Emage**, a system that stores
JPEG 2000 codestreams as per-resolution-level encrypted zones. The frontend is
plain, dependency-free HTML/CSS/JavaScript (ES modules) — no build step, no
framework, no bundler. It is served as static files (conventionally on
`http://localhost:3433`) and talks to the Emage API server (default
`http://localhost:3233`).

The heavy lifting (JPEG 2000 encode/decode, AES-256-CTR zone encryption, SHA3-256
MACs, key derivation) lives in two Emscripten WebAssembly modules,
`EmageWasmEncoder` and `EmageWasmDecoder`, served by the static client under `/wasm/`.
The frontend wraps those modules in a small library, `emage.js`, and drives it
from three demo pages. The end-to-end format and security model are documented in
`DESIGN.md`; `context.md` summarizes the implementation state.

Repository layout:

| Path | Role |
|---|---|
| `emage.js` | The client library. Wraps the WASM modules, HTTP, crypto, and the image pipeline |
| `uploader.html` | Encrypt & upload page (encode, key material, server browser) |
| `downloader.html` | Progressive download / decryption page |
| `compare.html` | Transfer-strategy benchmark page |
| `vendor/noble-sha3.js` | Vendored SHA3-256, used for local key-coverage lookups |
| `test_*.mjs` | Node test suites for the library and live server round-trips |

## What it does

In one sentence: it turns a PNG/JPG into an encrypted, progressively loadable
JPEG 2000 image, or fetches and decrypts one back, at a resolution level allowed
by the key it was given.

- **Encode → encrypt → upload.** A source bitmap is encoded to a JPEG 2000
  codestream at a chosen number of DWT resolution levels. When encryption is on,
  each resolution level is protected under its own derived key and a SEC marker
  is written carrying the per-file IV, the zone map, and the cumulative MAC
  chain. The result can be downloaded as `.j2k` and/or uploaded to the server.
- **Key material.** One master key per image; finer/coarser levels derive from it
  via `K(i+1) = SHA3-256(K(i))`. Holding key `Ki` unlocks levels `0..i` and
  nothing finer. The page displays every derived key immediately after encoding,
  without uploading anything.
- **Progressive download.** Given any granted key, the client fetches only the
  byte window needed to decode up to that key's level (and only as fine as the
  requested display size), verifies the cumulative SHA3 MAC chain, then renders.
  Coarser previews arrive layer by layer and stop at the accessible endpoint.
- **Key ring.** The uploader keeps a local ring of keys and indexes server
  images by the public lookup tags in their metadata, so it can show, per image,
  whether it is plaintext, locked, or decryptable by a specific saved key — and
  switch to that key in one click.
- **Server browser.** A read view over the server's image listing, presented as a
  virtual filesystem with folders, breadcrumbs, inline thumbnails, and per-file
  protection badges.
- **Comparison.** Three side-by-side load strategies (progressive,
  one-shot-at-target, one-shot-full) measured on bytes transferred, HTTP
  requests, time to first frame, and total time.

## UI elements

All three pages share a dark theme and a `.card` layout. Each page opens with the
same three-link nav (`uploader.html`, `downloader.html`, `compare.html`). Common
controls are text inputs for the server base URL and image path, and a status
line (`#status`) in monospace blue.

### `uploader.html` — Encrypt & Upload

Two-column grid (`.layout`): the pipeline on the left, a sticky sidebar of key
material on the right (collapses to one column under 1200px).

Left column:

- **0. Server connection** — text inputs `#serverUrl`, `#imgPath`; password input
  `#pwInput` (needed for upload/delete).
- **1. Local pipeline (PNG → encrypted J2K)**
  - `#fileInput` (`type=file`, `accept=image/*`) — choose the source image.
  - `#processBtn` — Encode & decode (PNG → J2K).
  - `#downloadBtn` — Download encrypted `.j2k` (creates a Blob + anchor click).
  - `#j2kFileInput` (`accept=.j2k,.j2c`) — load an existing codestream.
  - `#decodeBtn` — Decrypt the uploaded file.
  - `#secInput` (checkbox, checked) — toggle encryption; when cleared the key
    input is disabled and a plaintext stream is produced.
  - `#keyInput` (hex AES-256 key) and `#keyGenBtn` — Random key.
  - `#layerInput` (`type=number`, 1–64) plus `#layerRange` readout — DWT
    resolution count; blank means the image's maximum, and `max`/range update
    when a file is loaded.
  - `#srcCanvas` (original) and `#dstCanvas` (decoded) side by side, with
    `#stageLabel` describing the current stage.
- **2. Server images (virtual filesystem)**
  - `#galleryBtn` — Refresh listing.
  - `#gOpenBtn` — Open selected; `#gDelBtn` — Delete selected (confirm dialog);
    `#upBtn` — Upload current J2K.
  - `#fsCrumbs` breadcrumb, `#gCount` count, `#fsView` listing. Rows show a
    `canvas` thumbnail, name, protection badges (`plain` / `locked` /
    clickable key badges), human-readable size/dimensions/layers. Single-click
    selects, double-click opens.
  - `#status` line.

Right sidebar (sticky):

- **Granular progressive keys** — a `table.keys-table` (`#keysBody`) with one row
  per level: key name (`K0`…), level index, resolved resolution, and the 64-hex
  key material. `#keysEmpty` placeholder and `#copyKeysBtn` (Copy all keys).
- **Key ring & image coverage** — `#krLabel` (label input), `#krAddBtn` (Add
  current key), `#krScanBtn` (Rescan), and `#krList` of `.kr-item` cards. Each
  card shows the label, a truncated fingerprint, a decryptable-image count, a
  Use/Active button, a remove (✕) button, and clickable image paths it unlocks.
  `#krEmpty` placeholder.

### `downloader.html` — Progressive Downloader

- **0. Server connection** — `#serverUrl`, `#imgPath`.
- **1. Decryption key** — `#keyInput` (AES key hex).
- **2. Image browser (virtual filesystem)** — `#browseBtn` (Refresh listing),
  `#fsCrumbs` breadcrumbs, `#fsView` listing (folders first, `..` parent entry,
  per-file size/dimensions/layers). Click selects, double-click opens and loads.
- **3. Progressive load** — `#metaBtn` (Fetch meta), `#fullBtn` (Load full),
  `#sizeInput` (display size, e.g. `200`, `10vw`), `#sizeBtn` (Load for size).
  `#dstCanvas` displays the requested longest-edge size and preserves the
  aspect ratio; large images scroll within the preview. `#stageText` distinguishes
  displayed dimensions from the decoded resolution; `#status` reports dimensions, step count, bytes, and protection.

### `compare.html` — Transfer-Strategy Comparison

- **0. Server connection** — `#serverUrl`, `#imgPath`, `#keyInput`, `#runBtn`
  (Run comparison), `#sizeInput` (progressive display size), `#imgMeta` summary.
- **1. Render** — three `<canvas>` panels side by side: `#cvsProg`
  (A. Progressive), `#cvsOnce` (B. One-shot @ target), `#cvsFull`
  (C. One-shot full), each with a monospace telemetry line
  (`#progTv`, `#onceTv`, `#fullTv`).
- **2. Results** — a `table#tbl` (hidden until a run starts) comparing final
  image size, bytes transferred, HTTP request count, time to first frame, and
  total time across the three columns.
- `#status` line.

## How the pages use the library

All three import `Emage` and `EmageError` from `./emage.js`; the uploader also
imports `sha3_256` from `./vendor/noble-sha3.js` for local key-coverage indexing.
They initialize with `Emage.init()`, then
push UI state into the library before each action via `emage.setServer({...})`
and `emage.setCrypto({ key, iv })`.

Library operations surfaced by the UI include: `encodeCanvas`,
`granularKeys`, `keyLookupTag`, `describeSecurityZone`, `decode`, `paintTo`,
`playAll` (progressively load all layers), `display` (load to a requested
display size), `meta`, `list`, `upload`, `remove`, plus statics `readBytes`,
`readMetadata`, `hexToBytes`, and `messageOf`. The library handles the HTTP
ranges, key-level detection, MAC verification, and the WASM exception/stack
handling behind these calls.

## Running it

Serve the directory over HTTP (ES modules do not load from `file://`):

```sh
python3 -m http.server 3433
```

Then open `http://localhost:3433/uploader.html` (or the other two pages) with
the API server reachable at the configured base URL. For plain static hosting, build the EmageWasm repository to populate the client’s `wasm/` directory.
Node tests use the client’s `wasm/` assets by default; set
`EMAGE_WASM_DIR` to use a different asset directory. Node test suites live alongside the pages (`test_*.mjs`); live suites need
`EMAGE_PASSWORD` set from the server's upload password.

See `DESIGN.md` for the SEC marker format, key chain, MAC construction, and the
metadata COM envelope, and `HANDOFF.md` for a snapshot of an in-progress
debugging session.

The hosted client is https://autovizz.github.io/Emage/. Its Pages workflow
checks out the public `Emage-Wasm` repository, compiles the codecs, runs tests,
and publishes the allowlisted `_site/` output. Public repository variables
`EMAGE_API_URL` and `EMAGE_DEMO_URL` set service defaults. No application password
or backend `.env` is included in the site. Assets and WASM use project-relative
URLs so `/Emage/` works without root-path rewrites.

The optional client-only Docker Compose setup builds WASM from `WASM_SOURCE`
(default `../EmageWasm`) and publishes a static nginx container on `CLIENT_PORT`
(default 3433). It does not run backend services. The backend console also defaults
to local port 3433; use a different `CLIENT_PORT` when running both locally.

The portable deployment runs four containers in one Compose project: static
client on 3433, .NET API on 3233, Python proxy on 3434–3437, and an internal
rebuild controller. `/admin` is proxied through the client on 3433. Python has
no listener on 443 or 8082. The client/WASM image builds independently from
the server image, using the public Emage-Wasm source.

For a raw-IP HTTP deployment, the API and proxy addresses are inferred from
the page host. The demo allows that same host's client origin automatically.
`EMAGE_API_URL`, `EMAGE_DEMO_URL`, `DEMO_PUBLIC_ORIGIN` and
`DEMO_TRANSPORT_ORIGINS` are optional overrides. The blog hostname/IP field
uses the shared form style, inline validation and reconnection without reload.

`EMAGE_UPLOAD_PASSWORD` is the only application password. It authenticates
uploads, deletes and rebuilds at `/admin`. Rebuilds compile the API, WASM/client
and proxy, deploy them, verify health and roll back failures. The controller
itself stays running. No Anubis, site password or separate admin password is used.

The Pages deployment remains available separately. It needs public HTTPS
endpoints for remote API/proxy access; raw HTTP endpoints work when opening
the HTTP-hosted client. Network shaping uses request headers, with no added
latency or bandwidth cap when they are absent.
