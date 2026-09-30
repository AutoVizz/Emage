# Context — Granular per-level AES keys for Emage (resume brief)

## Objective
Implement granular per-DWT-resolution AES keys end to end: show derived keys on upload
and decode using only the user's access level. Implementation is complete and verified
end to end against the live server; remaining work is browser-level UI verification.

## Repositories
- WASM: `/home/saturn/CLionProjects/EmageWasm`
- Client: `/home/saturn/CLionProjects/EmageClient` (this dir)
- Server: `/home/saturn/RiderProjects/Emage`

## Important Details
- User decisions: always emit PLT; always use granular keys when `enableSec`; old
  single-zone files may be discarded (no back-compat needed).
- `layers` means DWT resolution count (numResolutions), NOT quality layers.
- Level 0 = coarsest, level `numResolutions-1` = finest.
- Keys: `K0 = master key`, `K(i+1) = SHA3-256(Ki)`. Same 16-byte IV reused per level.
- Access level `a` means holding `K0..Ka`; permits OpenJPEG reduction `r >= numResolutions-1-a`.
  A finer request is clamped (coarser) rather than fabricating pixels.
- Client requests only accessible levels: `X-Emage-Layers: 0:a`; `-1`/`all` -> `all`.
  The server has no keys (key-blind).
- SEC is now multi-zone: `E=numResolutions`; `Lsec=7+10E`; `L=2+10E`; each 10-byte entry
  = index(2) + Z(4, payload-relative) + T(4, size). No key material stored in SEC.
  Old fixed 46-byte single-zone layout removed.
- Zone offsets are relative to `SOD+2`; coarse-first windows preserve offsets for levels `0..a`.
- Encoder packet-range logic assumes single tile, single quality layer, no precincts,
  LRCP progression order; packets-per-resolution == numComponents.
- truncateToLevels: after decrypting `0..a`, copy prefix through the last accessible zone,
  patch SOT `Psot`, append EOC; leave COD/PLT headers intact.
  (An earlier decoder-side attempt to patch COD decomposition levels was wrong and was removed.)
- OpenJPEG silently synthesizes missing levels when reduced beyond actual content -> hence clamp.
- `describeSecurityZone` returns hasSec, zoneCount, starts, sizes.
- `decodeRaw(ptr,size,key,iv,accessLevel,reduction)`; accessLevel -1 = all.
- `deriveGranularKeys(key,count)` (WASM) / `granularKeys(count)` (JS) -> hex strings.
- Upload JSON enriched CLIENT-SIDE after HTTP response with `granularKeys` (array of hex
  strings). No key material is uploaded.
- Crypto is unauthenticated; same IV with different keys per level; no MAC.
- Existing `encrypted.j2k` (4802x4802, 6 levels) is old format, no known key/IV -> disposable.
- Live server: `http://localhost:3233`; upload password comes from `EMAGE_PASSWORD` in the
  environment (the same value is pre-filled in `uploader.html`). Without it, uploads get
  `HTTP 401 {"raw":""}`.
- Repos are dirty; keep untracked `test_progressive.mjs`, `test_chain.mjs`,
  `test_granular.js`, `test_granular_keys.mjs`.
- Both OpenAPI copies unchanged and in sync; `X-Emage-Layers: n:m` already documents `0:a`.
- A window must NOT renumber retained levels: resolution geometry comes from SIZ + COD
  decomposition count, so shrinking COD rescales the image (0:0 of 512x512/6 -> 512x512
  instead of 16x16). Keep COD verbatim; the decoder reduces by `NR-1-m`.
- A header-including window (`n == 0`) must end with EOC. Without it OpenJPEG loops
  forever asking for the next tile-part instead of reporting a short one.
- Build/test the server with `~/.dotnet/dotnet` (`DOTNET_ROOT=$HOME/.dotnet`); the
  system dotnet has no AspNetCore runtime, which is what made `dotnet test` look broken.

## Work State

### Completed
- Replaced cascade encryption in `jpsec_aes.h` / `jpsec_aes.c` with per-zone crypto,
  SHA3 key-chain derivation, multi-zone parsing and patching; removed `jpsec_aes256_ctr_cascade`.
- Reworked `opj_j2k_write_sec` in `third_party/openjpeg/src/lib/openjp2/j2k.c` to emit the
  variable-length zone table; zone count supplied via `jpsec_set_zone_count()`.
- Encoder (`encoder_bindings.cc`):
  - Always emits `PLT=YES`.
  - Parses PLT variable-length packet sizes.
  - Computes contiguous per-resolution payload ranges.
  - Encrypts each range once with its derived key.
  - Patches the SEC zone table.
  - Exposes `deriveGranularKeys(key,count)` as hex strings.
- Decoder (`decoder_bindings.cc`):
  - Parses valid multi-zone SEC markers.
  - Decrypts only levels `0..accessLevel`.
  - Truncates after last accessible zone, patches SOT `Psot`, leaves COD/PLT intact.
  - Clamps reduction to prevent OpenJPEG fabricating missing levels.
  - Exposes hasSec/zoneCount/starts/sizes via `describeSecurityZone`.
  - `decodeRaw` signature now `(pointer,size,key,iv,accessLevel,reduction)`, -1 = all.
- `emage.js`:
  - `crypto = { key, iv, accessLevel }`; `setCrypto({key,iv,accessLevel})`; legacy `levels`
    accepted as alias; `"all"` -> -1.
  - Added `granularKeys(count)`.
  - `_stream()` requests `0:accessLevel`.
  - `upload()` attaches client-derived `granularKeys`.
  - Removed `enablePlt`; passes ignored `levels: 0`.
  - Added JSDoc.
- UI: `uploader.html` (accessInput, keysPanel, keysList, copy button, showGranularKeys) and
  `downloader.html` (accessInput, setCrypto accessLevel).
- Passing tests: `test_node.js`, `test_resolution.js`, `test_granular.js`,
  `test_progressive.mjs`, `test_granular_keys.mjs`, `test_chain.mjs` (85 checks with
  `EMAGE_PASSWORD` set). Prior `dotnet test` 12/12 (before env broke).
- Prior progressive work complete: resolution-aware decode, server `layers=numRes`,
  CORS headers, upload content type.
- Server window semantics fixed and verified:
  - `J2kLayerExtractor` copies main headers verbatim (no COD decomposition rewrite);
    `J2kSlice.LayerCountOffset` and the `X-Emage-LayerCountOffset` header are gone.
  - `EndpointHandlers` terminates every header-including window with EOC.
  - openapi.yaml (both copies) documents the above; server tests 13/13.
  - Live-server per-grant matrix (512x512, 6 levels, granular keys), window decode vs
    full-stream decode: grants 0..5 -> 16/32/64/128/256/512 px, r5..r0, pixels identical.
- Client: `granularKeys()` with accessLevel 'all' now throws a clear "needs a level count"
  error instead of silently deriving 0; dead `Emage.finalizeStream` (COD layer-count
  patcher) removed.
- Dead-API sweep across all three repos: the ignored `levels` option is gone from
  `EncodeOptions`, `emage.js` and every test (it was the old cascade-round count);
  `J2kSlice.LayerCountOffset` is gone; `describeSecurityZone` in `emage.js` now
  reports the real `{hasSec, zoneCount, starts, sizes}` instead of the removed
  `{zoneStart, zoneSize, levels}`; the unused `Cod` marker constant is gone.
- Validation: encoder rejects `numResolutions` outside 1..64 (one SEC zone per level),
  and `emage.js` checks the same bound up front with a clearer message.
- `compare.html` restored the missing `<div id="status">` that made every `status()`
  call throw; verified all ids referenced by the three pages' scripts exist.
- Suites green: `dotnet test` 13/13, `test_chain.mjs` 85 checks, `test_granular_keys.mjs`,
  `test_progressive.mjs`, `test_node.js`, `test_resolution.js`, `test_granular.js`.
  Server image rebuilt and restarted via `docker compose up -d --build`.

### Active
- None. Every per-grant window now decodes pixel-identically to the full-stream decode.

### Blocked
- No browser automation verifies the new UI controls (access-level inputs, key panel).
- Existing `encrypted.j2k` uses discarded old format, no known key/IV.
- Server packet offsets desync for the RLCP+SOP fixture: the parser derives them from
  cumulative PLT lengths, which exclude SOP markers, so a mid/prefix window of
  `sample.rlcp.j2k` is assembled from wrong boundaries (pre-existing, unrelated to SEC).

## Next Move
1. Browser check of the new UI: uploader key panel/copy, downloader access-level input
   against the live server.
2. Optional: teach `J2kCodestreamParser` about SOP/EPH when deriving packet offsets from
   PLT, so RLCP+SOP windows are assembled from correct boundaries.

## Relevant Files
- `/home/saturn/CLionProjects/EmageWasm/jpsec_aes.h` — new multi-zone SEC layout + API.
- `/home/saturn/CLionProjects/EmageWasm/jpsec_aes.c` — zone parse/patch, AES-CTR, SHA3 chain.
- `/home/saturn/CLionProjects/EmageWasm/encoder_bindings.cc` — PLT parse, per-resolution
  encryption, `deriveGranularKeys`.
- `/home/saturn/CLionProjects/EmageWasm/decoder_bindings.cc` — access-level decryption,
  truncation, reduction clamp.
- `/home/saturn/CLionProjects/EmageWasm/third_party/openjpeg/src/lib/openjp2/j2k.c` —
  variable-length `opj_j2k_write_sec`.
- `/home/saturn/CLionProjects/EmageWasm/test_granular.js` — pixel-exact access matrix (new).
- `/home/saturn/CLionProjects/EmageWasm/test_node.js` — updated granular crypto checks.
- `/home/saturn/CLionProjects/EmageClient/emage.js` — key derivation, access level, window
  request, upload enrichment, JSDoc.
- `/home/saturn/CLionProjects/EmageClient/uploader.html` — access-level input, key display.
- `/home/saturn/CLionProjects/EmageClient/downloader.html` — access-level input.
- `/home/saturn/CLionProjects/EmageClient/test_granular_keys.mjs` — public-client tests (new).
- `/home/saturn/CLionProjects/EmageClient/test_chain.mjs` — 85-check live-server suite.
- `/home/saturn/RiderProjects/Emage/Emage/Imaging/J2k/J2kLayerExtractor.cs` — window slicing;
  `Slice(first,last)`; main headers copied verbatim (no COD rewrite).
- `/home/saturn/RiderProjects/Emage/Emage/Imaging/J2k/J2kCodestreamParser.cs` — layers = DWT count.
- `/home/saturn/RiderProjects/Emage/Emage/OpenApi/EndpointHandlers.cs` — upload/meta responses;
  must stay key-blind.
- `/home/saturn/RiderProjects/Emage/openapi.yaml` — authoritative server protocol.
- `/home/saturn/CLionProjects/EmageWasm/openapi.yaml` — synchronized protocol copy.
