# Emage client

The UI from `files.zip` uses `emage.js` and the existing WebAssembly codecs.
Open `index.html` for uploads, `downloader.html` for progressive downloads, and
`compare.html` for measured comparisons. `uploader.html` also opens the upload UI.

## GitHub Pages client

The client is published at **https://autovizz.github.io/Emage/** from the public
`AutoVizz/Emage` repository. Pushes to `main` or a manual run of
`.github/workflows/pages.yml` compile the public `AutoVizz/Emage-Wasm` source,
run the checks and deploy the static site. No repository secret or application
password is needed for the Pages build.

Only public HTML, styles, browser scripts, images and the four compiled WASM
artifacts are uploaded. Backend code, the rebuild console, `.env` files and Git
credentials are excluded. Asset URLs work under the `/Emage/` project path.

The server deploys separately. Enter its URL in the **Server URL** field;
`http://localhost:3233` works when the API runs on the visitor's machine.
For a remote server, use its public HTTPS URL. The upload password is entered
in the uploader and is never embedded in the site.

Repository variables `EMAGE_API_URL` and `EMAGE_DEMO_URL` can set default public
API and demo-control addresses during the Pages build. They are URLs, not
secrets. `WASM_REF` can select a WASM branch, tag or commit; the default is `main`.
The manual workflow also accepts a WASM ref. A WASM-only change can be published
by manually running the Pages workflow without rebuilding the server.

## Run the client locally

Start the separate Emage backend, then either use GitHub Pages or build a local
static client with the sibling WASM checkout:

```sh
docker compose up --build -d --remove-orphans
```

Open `http://localhost:3433/`. This Compose file runs only the client. It does
not run the image API, demo proxy or rebuild controller. If the backend console
already uses local port 3433, set `CLIENT_PORT=3438` for this optional local client.
`EMAGE_API_URL` and `EMAGE_DEMO_URL` are public build-time service addresses.

For another static host, compile the codecs into `wasm/`, run
`npm run build:site`, and publish only `_site/`. The source and codec directories
are not themselves the publication artifact.

Choose a source image, encode it, save the generated keys, and upload using the
server password. Existing `.j2k`/`.j2c` codestreams can also be loaded, decoded,
downloaded, and uploaded. Resolution counts depend on the source dimensions.
The encryption switch controls encoding; plaintext images need no decryption key.

Click a file to select it. Open folders with a click and images with a double-click
or **Open selected**. Refresh scans public lookup metadata for key matches. Files
without lookup metadata display **Unmapped**; decode them to check their protection.
Saved keys stay in this browser's local storage. The
current key and connection carry across pages in this tab's session storage;
passwords are not saved. Keys are never sent to the API.

The downloader caps resolution at the supplied key's authenticated grant. Its
level buttons render locally from the last downloaded codestream and never make
HTTP requests. Levels not yet downloaded stay disabled. Use **Load for size**,
**Fetch meta**, or **Load full** to fetch image data or metadata; selecting a file
does not load it automatically. The
comparison runs three sequential loads and reports image body bytes, request
counts (including metadata), and elapsed time. Its full-resolution pass also
respects the key's grant. Measurements reflect the browser's current cache and
connection.

## Checks

With Node.js 22+ and the WASM artifacts available:

```sh
npm install
npm test
```

`test_key_metadata.mjs` verifies header lookup and key access. `test_ui.mjs`
exercises the three pages using jsdom and the real WASM codecs. It substitutes
canvas rendering and HTTP transport, with server-style packet slices generated
from the codestream's PLT lengths. It covers encoding, plaintext, imports,
authentication failures, key persistence, restricted/wrong keys, comparison
requests, folder browsing, deletion, and server failures. A browser check against
a running API is still needed to verify rendering, CORS, and the live deployment.

## Interactive article

`blog.html` is the project write-up with four working experiments, a protocol
overview, and possible applications. The workspace sidebar links to it as
**How Emage works**. Network experiments use a separate Python proxy that streams real responses
from the Emage API. On the hosted article, enter its URL in **Demo proxy URL**
and click **Connect**; it is saved for this browser tab.

The comparison's current-level readouts follow each decoded frame and remain
visible beside the completed timing measurements. The level viewer also reports
the current level when streaming or replaying downloaded bytes.

The article links to a matching static documentation collection, available from
`docs.html`: local setup (`running-locally.html`), packet framing and the browser
library (`protocol.html`), key derivation and authentication
(`resolution-keys.html`), and bandwidth/timing methodology
(`experiment-methodology.html`). These pages use the same stylesheet and work
without the API or WASM. Article navigation links to readable pages rather than
source files or raw Markdown.

The supplied wizard-hat logo is used as a transparent PNG in page headers and
workspace branding, with a transparent favicon. The original supplied ICO is
retained alongside the background-removed version.
Articles explain the behavior at a high level, with key indices typeset as subscripts.

Every workspace, article, and documentation page shares a Theme selector with System, Light, and
Dark options. System is the default; explicit choices are saved in local storage
and applied before the page paints. Shared color variables in `css/theme.css`
keep surfaces, controls, and feedback consistent. The selector stays usable during experiments.

Start the API, then from `Emage` run:

```sh
npm run blog
```

Open `http://localhost:8082/blog.html`. This command builds/verifies ten distinct
sample image pairs, uploads missing samples to `blog-demo/v1/` on the real API,
and starts the article server. Uploads use `EMAGE_UPLOAD_PASSWORD` from the
environment or `Emage-Server/.env`; the password is not placed in any served file.
The sample master keys and PNG originals are deliberately public demonstration
data. Existing user image paths are not modified.

The generated assets are included, so the server can also be started directly:

```sh
python3 tools/demo_server.py --port 8085 --api http://localhost:3233
```

Use `--skip-seed` only when these fixtures are already present on that API.
A plain static server displays the article, but disables network experiments
with instructions to start the proxy. The proxy listens on loopback, accepts
only GETs for the known sample images plus a local run-cancellation endpoint,
and forwards no decryption keys. Restart the proxy after updating it; an older
single-origin proxy cannot run the revised gallery experiment.

The page has a conventional article layout, with experiments embedded between
the explanatory sections. Experiments run one at a time so timings do not
silently compete with another experiment. A **Stop experiment** control stays
available during a run. It aborts metadata/packet fetches, removes unfinished
PNG image sources, interrupts paint waits, and tells the proxy to cancel that
run's reserved bandwidth. Then all settings and other experiments unlock.
WASM decoding is synchronous; Stop takes effect when the current decode yields
back to the browser. Cancelled runs keep completed frames and report **stopped**,
never successful completion.

- The three-way comparison measures progressive-to-target, one-shot-to-target,
  and one-shot-full, with an optional run across all four speeds. Passes run
  sequentially; results include first frame, completion, image-body bytes,
  requests, and final decoded dimensions.
- The gallery starts ten different Emage loads and ten corresponding normal
  PNG `<img>` loads concurrently. The Emage counter records first decoded
  previews; the PNG counter records load events, not browser-dependent partial
  PNG paints. Each row shares one bandwidth budget, so
  ten connections do not receive ten times the configured speed. PNG body sizes
  come from timing-enabled resource entries or the exact fixture manifest lengths.
- The layer viewer streams one resolution window per frame, yielding for paint
  before requesting the next. Level buttons reuse downloaded bytes without HTTP.
- The owner pane derives every key locally. The reader uses only its typed key,
  automatically caps at its authenticated grant, and rejects unrelated keys.

Profiles add body pacing plus a per-request delay: 96 KiB/s + 180 ms,
512 KiB/s + 60 ms, 2 MiB/s + 30 ms (the default Demo profile), and
4 MiB/s + 20 ms. Each run/strategy has its own budget.
Browser scheduling, CPU, TCP behavior, packet loss, and real mobile-network
conditions are not emulated. Responses use `Cache-Control: no-store` and fresh
run URLs; codec startup is outside measured intervals.

The proxy is HTTP/1.1. Putting twenty requests on one origin allowed six long
PNG requests to occupy Chrome's connection pool and starve Emage's subsequent
resolution requests. Starting promises or moving code to workers does not
remove that transport limit. The revised gallery uses four independent local
origins: two per row, five images per origin. Auxiliary ports are allocated by
the OS to avoid conflicts; the main page/control port remains 8082 by default.
All four servers share the same bandwidth state, keyed by run and strategy,
so using two origins does not double a row's throughput. CORS permits only the
article origin and exposes the required framing and timing headers. Ordinary
PNG `<img>` loading is preserved; no fetch-to-blob conversion is involved.

This is a deliberately sharded HTTP/1.1 experiment, not single-origin HTTP/2.
Browser-wide connection limits and CPU still apply. Application request counts
cover metadata/packet GETs, not browser-generated CORS preflights. The Stop
endpoint uses the main origin so it is not queued behind the gallery transfers.
See [Chrome's connection queueing documentation](https://developer.chrome.com/docs/devtools/network/reference/).

Both sample formats are lossless. They depict original procedural artworks,
not a photographic benchmark. Their full J2K files are larger than their PNGs;
thumbnail transfer savings come from selecting resolution windows. The article
does not claim superiority over responsive variants or modern lossy formats.

`tools/build-demo-assets.mjs --force` regenerates the fixtures using the existing
WASM codecs and Node built-ins. It verifies every full-size roundtrip against the
source pixels. No image service, Pillow, or additional build dependency is needed.
`npm run test:blog` checks real-codec page wiring, fixture distinctness and pixel
equality, progressive request ranges, local level switching, gallery concurrency,
reader grants, and proxy pacing/allowlists using in-process transport adapters.
The transport adapter enforces six slots per origin and proves that Emage
finishes while all ten PNG transfers remain occupied. Cancellation checks cover
every experiment, response bodies, paused paint waits, future comparison profiles,
and proxy-side pacing. Live socket/browser checks remain separate from these tests.
