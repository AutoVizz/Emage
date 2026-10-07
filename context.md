# Context — current Emage implementation

## Repositories

- Client: `/home/saturn/CLionProjects/EmageClient`
- WASM: `/home/saturn/CLionProjects/EmageWasm`
- Server: `/home/saturn/RiderProjects/Emage`

`DESIGN.md` is the detailed format and implementation reference. The OpenAPI
specs in the server and WASM repositories describe the same deployed API.

## Keys and integrity

- Levels are DWT spatial resolutions, coarse-first. `layers` never means JPEG
  2000 quality layers; the encoder uses one quality layer.
- `K(E-1)` is the master and `K(m-1) = SHA3-256(Km)`. Ka derives its own and all
  coarser keys, never finer keys. The previous forward-chain implementation was
  insecure and its files must be re-encoded.
- A reader supplies any granted key. Its level is detected automatically;
  `accessLevel` is an optional lower resolution ceiling. Blank / `all` / `-1`
  means automatic access through the supplied key's level.
- AES-256-CTR protects one zone per resolution. A random 16-byte IV per file is
  carried in SEC and overrides a supplied decoder IV.
- Every level has a cumulative SHA3-256 MAC covering the previous tag, its key,
  level index, payload-relative start/size, and plaintext. Requested zones are
  verified before truncation. Tampering does not trigger a silent downgrade.
- Native key-level identification authenticates the coarsest zone against
  MAC[0]. The decoder reports `keyLevel`, applied `reduction`, and total
  `numResolutions`.

## Metadata inside image headers

- Generic metadata uses a binary COM marker (`FF 64`, Rcom=0) before SOT.
  Payload: ASCII `EMAGE-META`, one NUL byte, then a UTF-8 JSON object.
- Encrypted client encodes immediately embed `keyMap: {iv, levels}`. `iv` is
  32 lowercase hex digits; `levels` maps each 64-digit SHA3-256(IV || Ka) tag
  to its resolution index. Hash inputs are raw bytes, not hex strings.
- Only public lookup tags and the IV are stored, never raw keys. All intermediate
  keys are displayed locally immediately after encoding, without an upload.
- The server reads only the generic COM envelope and returns it as `metadata`
  in upload and meta responses. It does not inspect its fields, SEC, keys, IVs,
  or determine whether an image is plaintext/encrypted. There are no sidecars
  and no special HTTP metadata upload header.
- Generic COM metadata also works on plaintext. Resolution windows preserve it.
  Upload invalidates the combined byte/parse/metadata cache.

## Low-bandwidth downloads

- New mapped images: fetch meta, match a locally computed lookup tag, then fetch
  exactly `0:b`, where b is capped by the key, requested size and explicit limit.
  A wrong key is rejected from metadata without downloading image packets.
- Thumbnails using a master key still download only their needed packet window.
- Native MAC checks remain authoritative; a map that disagrees with the detected
  key level is rejected.
- Older reversed-chain files without a map: fetch `0:0` for key discovery, then
  only `1:b` if needed. Single-tile framing reuses the coarsest bytes and patches
  Psot; other framing can request the needed `0:b` prefix. No full-image trial
  download is used for key detection.
- Progressive frames reuse the same downloaded window and stop at its accessible
  endpoint. `transferredBytes` counts image response bodies; `httpRequests`
  includes metadata and packet requests. New mapped images normally use two.

## Structural assumptions and validation

- Encrypted encoder: single tile, one quality layer, no precinct partition, LRCP.
  PLT is always emitted; one resolution contains one packet per component.
- Zone offsets remain relative to SOD+2. COD stays unchanged during slicing;
  changing its decomposition count would incorrectly rescale the image.
- Header-including windows end in EOC; packet-only suffixes omit framing.
- The JS decoder restores its WASM stack and releases caught C++ exceptions.
- Local server runs on localhost:3233; client on localhost:8080. The server was
  rebuilt with header-metadata support, and the new WASM bundles are published
  into the client's `cmake-build-wasm` directory.
- Server tests cover generic metadata on plaintext/encrypted fixtures, byte-exact
  storage, restart persistence, and preservation across resolution windows.
- Client tests cover independent SHA3 vectors, restricted access, exact request
  ranges, wrong-key zero-packet rejection, metadata tampering, progressive
  loading, random IVs, and live server roundtrips.

## Running checks

WASM suites: `node test_node.js`, `test_resolution.js`, `test_granular.js`,
`test_mac.js` from the WASM repository. Client offline suites:
`test_key_metadata.mjs`, `test_granular_keys.mjs`, `test_progressive.mjs`, and
`test_random_iv.mjs`. Live suites: `test_preview.mjs`, `test_mac_server.mjs`,
`test_chain.mjs`, and `test_cache_stale.mjs` with `EMAGE_PASSWORD` set from the
server's `EMAGE_UPLOAD_PASSWORD` environment setting. Do not log that value.
Server: `dotnet test Emage.slnx -c Release`.
