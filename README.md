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

The portable deployment runs nginx, the client, API, transfer proxy and rebuild
controller with one Compose command. The site is `http://emage.gqvz.xyz/`;
`api-emage.gqvz.xyz` forwards directly to .NET on internal port 3233.
`api1`–`api4-emage.gqvz.xyz` forward to Python ports 3434–3437 respectively.
Other hosts matching `*-emage.gqvz.xyz` route to Python's first listener.
Nginx publishes HTTP on port 80. The client discovers service addresses from the
page's hostname and protocol. HTTPS can terminate at a reverse proxy in front
of nginx; forward the original Host and X-Forwarded-Proto headers.

The upload password is entered in the uploader and never embedded in the site.
`/admin` uses the same password to rebuild the server, client codecs and proxy;
health failures trigger the same checked rollout and rollback.

GitHub Pages remains an independent static client option. Enter a public HTTPS
API/proxy URL when using it remotely: browsers block remote HTTP endpoints from
an HTTPS page. Public repository variables `EMAGE_API_URL` and `EMAGE_DEMO_URL`
can override service defaults. `WASM_REF` selects a WASM branch, tag or commit;
the default is `main`. No application password belongs in repository variables.

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
from the Emage API. On the hosted article, enter its URL in **Proxy hostname**
and click **Connect**; it is saved for this browser tab. A bare hostname uses
HTTPS and port 3434 (the Emage domain uses api1 on standard HTTPS); a bare IP address uses HTTP and port 3434. Full HTTP URLs work for local testing. Connection errors appear beside
the field, and reconnecting does not reload the article.

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

Start the unified deployment and open `http://emage.gqvz.xyz/blog.html`. Connect it
to the public HTTPS proxy hostname. For local proxy development, generate the
fixtures and run `python3 tools/demo_server.py`; serve the static
client separately. The Docker deployment uses Python ports 3434–3437 and .NET port 3233.

Python listens only on **3434–3437**. Ports 3434–3435 carry the Emage row,
and 3436–3437 carry the PNG row. Port 3434 also serves `/demo/config` and run
cancellation, so no fifth proxy/control port is needed. All four listeners
forward API reads, uploads and deletes to the same fixed .NET upstream on 3233.
The client container serves the static site in the same Compose deployment.

Shaping is opt-in through request headers:

| Header | Meaning |
| --- | --- |
| `X-Demo-Latency-Ms` | Added delay per request, 0–10000 ms |
| `X-Demo-Bytes-Per-Second` | Response-body rate; 0 or absent means unlimited |
| `X-Demo-Run`, `X-Demo-Lane` | Optional run and strategy identifiers for a shared bandwidth budget |

With no shaping headers, the proxy adds no artificial delay or rate limit.
The blog sends these headers for its selected connection profile. URLs contain
only the resource path; run identifiers and network settings stay in headers.
No cache-busting URLs are generated.

The ten sample PNG/J2K pairs and sample keys are deliberately public. The proxy
seeds only reserved `blog-demo/v1/` API paths using `EMAGE_UPLOAD_PASSWORD` from
its private environment. It never puts the password in browser assets.

The page has a conventional article layout, with experiments embedded between
the explanatory sections. Experiments run one at a time so timings do not
silently compete with another experiment. A **Stop experiment** control stays
available during a run. It aborts metadata/packet and PNG fetches, clears unfinished
image display, interrupts paint waits, and tells the proxy to cancel that
run's reserved bandwidth. Then all settings and other experiments unlock.
WASM decoding is synchronous; Stop takes effect when the current decode yields
back to the browser. Cancelled runs keep completed frames and report **stopped**,
never successful completion.

- The three-way comparison measures progressive-to-target, one-shot-to-target,
  and one-shot-full, with an optional run across all four speeds. Passes run
  sequentially; results include first frame, completion, image-body bytes,
  requests, and final decoded dimensions.
- The gallery starts ten different Emage loads and ten corresponding normal
  PNG full-body fetches concurrently, then displays each body in an `<img>`. The Emage counter records first decoded
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
conditions are not emulated. Codec startup is outside measured intervals.

The proxy advertises four origins using the hostname/IP of the configuration
request and its four listening ports. Enter a host or IP in **Proxy hostname / IP**
and click Connect. `DEMO_TRANSPORT_ORIGINS` can override the four public URLs
when external TLS/port mappings differ. Every listener shares process-wide
budgets keyed by rate, run and strategy, so using more ports does not multiply
a row's bandwidth.

GitHub Pages uses HTTPS. Remote IP endpoints therefore need HTTPS too; browsers
block plain HTTP requests from the hosted article as mixed content. For raw HTTP
IP endpoints, use the separately served HTTP client instead. Loopback/local
browser restrictions can differ. CORS does not override mixed-content rules.

PNG requests use fetch so they can send shaping headers, then display the full
body through an object URL. PNG timing therefore measures full-body download
plus image decoding, not native progressive PNG painting. Stop cancels the
fetches and each run's server budget. CORS preflights are not counted as image
requests in the article's application telemetry.

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
