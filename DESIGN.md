# Emage — Design Document

**Granular per-resolution encryption for JPEG 2000, with a key-blind server.**

Emage stores and serves JPEG 2000 (J2K) codestreams as a stack of independently
encrypted spatial resolution levels. A holder of a subset of the keys can
reconstruct exactly the coarse image that subset covers, and nothing finer. The
server that stores and serves those codestreams never holds a key, never learns
whether a file is encrypted, and never interprets the encryption — it parses
markers and copies byte ranges.

---

## 1. Core idea

JPEG 2000 decomposes an image with a wavelet transform into a pyramid of
resolution levels. Level `0` is the coarsest approximation (as few as one pixel);
level `E-1` is full resolution. Crucially, **a decoder reconstructs the image at
level `a` using only levels `0..a`** — the finer subbands are simply not
consulted.

That makes resolution levels a natural unit of *cryptographic access control*:

```
K0 = master key
K1 = SHA3-256(K0)
K2 = SHA3-256(K1)
...
```

Each level's packet payload is encrypted exactly once, under its own key from
that chain. Because the chain is a one-way function of the master key, and each
key unlocks exactly one level, **the number of keys a party holds is precisely
the finest resolution that party can see.** Access control is cryptographic, not
a server-side permission check.

The security model is therefore *graceful*: give someone keys `K0..Ka` and they
get a legitimately decodable small image. You never hand out a "thumbnail" that
is merely hidden — you hand out a smaller, real image.

### 1.1 One deliberate terminology trap

Throughout this project, **"layers" means DWT resolution levels, not JPEG 2000
quality layers.** The encoder always emits exactly one quality layer
(`tcp_numlayers = 1`, rate 0 = lossless). Quality layers are unused and
unsupported as an access axis. Every server response field named `layers`, every
`X-Emage-Layers` window bound, and every `accessLevel` in the client refers to
the resolution pyramid, numbered **coarse-first**.

> Level numbering is coarse-first throughout. See §7.2 for the wire protocol
> and §8.3 for how the client requests only the levels a grant can read.

---

## 2. Repository layout

The system is three cooperating repositories.

| Repo | Local path | Remote | Role |
|---|---|---|---|
| **EmageWasm** | `~/CLionProjects/EmageWasm` | `AutoVizz/Emage-Wasm` | C/C++ + Emscripten. Encodes, encrypts, decrypts, decodes. Vendors OpenJPEG and a trimmed Mbed TLS. |
| **EmageClient** | `~/CLionProjects/EmageClient` | `AutoVizz/Emage-Client` | ES-module JS library (`emage.js`) + three HTML demo pages. Owns key derivation and all crypto decisions. |
| **Emage** | `~/RiderProjects/Emage` | `AutoVizz/Emage-Server` | ASP.NET Core 10 API-only server. Parses J2K markers, slices layer windows, stores files. No codec dependency, no crypto. |

### 2.1 Why three

The split is a security boundary, not an organizational convenience:

- The **server** has no OpenJPEG and no AES. It cannot decode even a plaintext
  file — it only walks marker segments and copies byte ranges. Compromise of the
  server yields ciphertext (or, for unencrypted files, nothing useful that the
  uploader did not already publish) but never a key.
- The **crypto** lives in the WASM module, so keys exist only in browser memory
  and are never transmitted.
- The **client library** is the only component that holds both the key material
  and the server URL, and it is what decides which levels to fetch.

### 2.2 Data flow

```
   PNG bytes
      │  encodePixelData / encodeCanvas
      ▼
┌──────────────────────────────────────────────┐
│ EmageWasm (browser)                          │
│  OpenJPEG encode → PLT packet table          │
│  split payload into one zone per level       │
│  AES-256-CTR each zone under K(level)        │
│  patch SEC marker zone table                 │
└──────────────────────────────────────────────┘
      │  ciphertext codestream (SEC marker, no key material)
      ▼
┌──────────────────────────────────────────────┐
│ POST /image/{path}   X-Emage-Password: …     │
│ Emage server — validates EOC, parses markers │
│ writes file, returns {stored,layers,w,h,…}  │
└──────────────────────────────────────────────┘
      │                      ▲
      │  GET /image/{path}   │  server never sees keys
      │  X-Emage-Layers: 0:a │  (or "meta", "all", "n:m")
      ▼                      │
┌──────────────────────────────────────────────┐
│ Client derives K0..Ka locally, asks for     │
│ window 0:a, decrypts levels 0..a, truncates │
│ codestream, decodes at reduction             │
│ max(E-1-a, requested) → RGBA → Canvas       │
└──────────────────────────────────────────────┘
```

---

## 3. The SEC marker format

Emage uses the JPSEC security marker (**ISO/IEC 15444-8 / ITU-T T.807**, clause
5.5), marker code `0xFF 0x65`, in its registry-based form.

The segment is written into the **main header** and is always plaintext — the
encryption covers only the packet payload after `SOD`.

### 3.1 Byte layout

Offsets are relative to the marker code. One zone entry per resolution level,
so the segment is variable length.

| Offset | Field | Value / meaning |
|---|---|---|
| 0..1 | marker | `FF 65` |
| 2..3 | `Lsec` | segment length including itself: `7 + 10·E` |
| 4 | `Form` | `0x02` — registry-based |
| 5..6 | `T.sec` | `0x0002` — private AES-CTR tool |
| 7 | `E` | number of protected zones (= number of resolution levels) |
| 8 | `L` | length of zone info: `2 + 10·E` |
| 9.. | zone entries | 10 bytes each |

Each 10-byte zone entry:

| Offset | Field | Meaning |
|---|---|---|
| +0..1 | zone index | resolution level, `0` = coarsest |
| +2..5 | `Z` | start offset, **relative to the first byte of the packet payload** (i.e. `SOD + 2`) |
| +6..9 | `T` | size in bytes |

Implementation constants (`jpsec_aes.h`):

```
JPSEC_SEC_FORM_OFFSET   4      JPSEC_ZONE_ENTRY_BYTES  10
JPSEC_SEC_TSEC_OFFSET   5      JPSEC_MAX_ZONES         64
JPSEC_SEC_E_OFFSET      7      JPSEC_AES_KEY_BYTES     32   (AES-256)
JPSEC_SEC_L_OFFSET      8      JPSEC_AES_IV_BYTES      16
JPSEC_SEC_ZONE_OFFSET   9      (first zone entry)
```

### 3.2 Two design decisions worth calling out

**Payload-relative offsets.** `Z` is relative to `SOD+2`, not absolute in the
file. This is deliberate. The serving layer rebuilds the main header and drops
`TLM`/`PLM`/`PPM` (and `PLT`/`PPT` in tile-part headers), which shifts every
absolute offset in the file. Payload-relative offsets survive that rebuild
unchanged, so a window served by the server still carries a valid, correctly
aligned zone table.

**No key material.** The marker never carries a key, IV, digest, or even an
encryption flag. Its presence is the only signal, and the server ignores it
entirely (§7.3).

### 3.3 Resolution ceiling

One zone per level means the zone table is `10·E` bytes and `E` is a single
byte, so the pyramid is capped at **64 resolution levels**. Both sides enforce
this: the C encoder rejects `numResolutions` outside `1..64`, and `emage.js`
checks the same bound up front with a clearer error message.

### 3.4 Vendored OpenJPEG patches

Two changes to vendored OpenJPEG are required:

- `third_party/openjpeg/src/lib/openjp2/j2k.c` — `opj_j2k_write_sec()` rewritten
  to emit the variable-length zone table. The zone count is published through
  `jpsec_set_zone_count()`, because the SEC marker is written as a *header*
  procedure, before any per-tile parameters exist.
- `sec_marker.cc` — supplies the `j2k_read_sec` / `j2k_read_insec` handlers that
  the marker dispatcher expects when compiled with `USE_JPSEC`. These **validate
  and skip only**; they never act on the zone table. An encrypted codestream
  reaches OpenJPEG already decrypted by `jpsec_aes.c`.

The `PLT=YES` marker is emitted **unconditionally**. The packet length table is
the only way to know where one resolution level's payload ends and the next
begins — without it the encoder cannot split the payload into zones, and the
server cannot slice windows.

---

## 4. Cryptography

| Property | Choice |
|---|---|
| Block cipher | AES-256 (`JPSEC_AES_KEY_BYTES = 32`) |
| Mode | CTR (NIST SP 800-38A); encryption and decryption are the same operation |
| IV | 16 bytes, caller-supplied, shared across every level |
| Key derivation | `K(i+1) = SHA3-256(K(i))`, `K0 = master key` |

`jpsec_aes256_ctr_crypt()` and `jpsec_derive_level_keys()` are implemented over
a **minimally trimmed Mbed TLS** — only `aes.c`, `sha3.c`, `platform_util.c` are
compiled.

AES-256 and SHA3-256 are used as published, without runtime verification. A
build with a misconfigured `mbedtls_config.h` would produce silently wrong
ciphertext, since CTR has no checksum and a bad decode does not error — but
AES and SHA3 are not re-checked in the encode and decode paths. Correctness
rests on the vendored library and the test suites.

---

## 5. Encoder

Source: `encoder_bindings.cc`.

### 5.1 Encode options

| Option | Default | Notes |
|---|---|---|
| `width`, `height` | — | required, positive |
| `numComponents` | inferred | 1 (gray) or 3 (RGB); RGBA input is converted to RGB or gray |
| `precision` | 8 | bits per sample |
| `lossless` | `true` | → `irreversible = 0` |
| `numResolutions` | 6 | 1..64 |
| `numLayers` | 1 | 1..100, but always written as exactly 1 |
| `enablePterm`, `enableSegsym` | false | OpenJPEG mode bits `0x10`, `0x20` |
| `enableSop`, `enableEph` | false | `csty` bits `0x02`, `0x04` |
| `enableTlm` | true | `TLM=YES` when set |
| `enableSec` | true | `SEC=YES` when set; drives encryption |
| `key`, `iv` | — | 32 / 16 bytes; `null` means unencrypted |

### 5.2 Pipeline

1. **Validate.** Dimensions positive; `numLayers` 1..100 (bounded by OpenJPEG's
   fixed `tcp_rates[100]` array); `numResolutions` 1..64; pixel buffer size must
   equal `width·height·numComponents`.
2. **Build `opj_image_t`.** Interleaved JS buffer → planar per-component arrays.
3. **Configure.** `tcp_numlayers = 1`, `tcp_rates[0] = 0.0f` (lossless).
   Progression is left at OpenJPEG's default **LRCP** — with a single quality
   layer the layer index is constant, so LRCP and RLCP produce identical byte
   order. RLCP was deliberately not declared: it bought nothing and only
   invited RLCP-specific branches in the server parser.
4. **Extra options.** `TLM=YES` (optional), `PLT=YES` (always), `SEC=YES`
   (when `enableSec`).
5. **`jpsec_set_zone_count(numResolutions)`** — published before
   `opj_setup_encoder` so the header procedure can size the table.
6. **Encode** to `/tmp/encode_out.j2k` in MEMFS, read back, delete.
7. **`applyGranularSecurity()`** if `enableSec`.

### 5.3 Splitting the payload into zones

`computeLevelRanges()` reads the PLT packet-length table. PLT lengths are
**JPEG variable-length integers** — 7 bits per byte, big-endian, high bit set on
every byte except the last.

The zone split relies on a documented encoder invariant:

> This encoder always emits one tile, one quality layer and no precinct
> partition, so under LRCP each resolution level contributes exactly
> `numComponents` consecutive packets.

So the expected packet count is exactly `numResolutions · numComponents`, and
level `r` owns packets `[r·numComponents, (r+1)·numComponents)`. A mismatch
throws rather than silently mis-encrypting.

`applyGranularSecurity()` then:

1. Walks `SOC → SEC → SOT → PLT → SOD` markers.
2. Computes per-level `starts[r]` / `sizes[r]` relative to `payloadStart`.
3. **Locates EOC arithmetically** as `payloadStart + Σ sizes`, and verifies
   `FF D9` is really there. Scanning for `FF D9` would false-positive on
   arbitrary packet bytes; the PLT gives an exact extent.
4. Derives the chain and AES-256-CTR-encrypts each level's range **in place,
   once**. CTR over a contiguous range — no byte is encrypted twice.
5. `jpsec_patch_sec_zones()` overwrites the reserved zone table.

`deriveGranularKeys(key, count)` is exposed as a separate binding returning the
chain as lowercase hex strings, `K0` first. This is what the client uses to
*display and distribute* keys after upload.

---

## 6. Decoder

Source: `decoder_bindings.cc`.

```cpp
DecodeResult decodeRaw(uintptr_t ptr, size_t size,
                       val key, val iv,
                       int accessLevel,   // -1 = every level
                       int reduction);    // DWT halvings; 0 = full resolution
```

Returns `{ width, height, numComponents, reduction, numResolutions, rgbaPixels }`.

### 6.1 Polymorphic crypto

`decodeRaw` serves both the encrypted and plaintext flows. Key and IV are
required **only** when the codestream actually carries a SEC marker; for a
plaintext stream they are optional and ignored. Passing `null` explicitly means
"unencrypted" — this matters because the Emscripten binding declares the fields
as required, so omitting them throws "Missing field" rather than selecting the
clear path.

### 6.2 Locating the SEC marker

`computeSecurityZones()` scans **only `SOC..SOD`** — the main header, which is
always plaintext. Scanning into the payload would let a coincidental `FF 65`
pair inside packet data trigger spurious decryption.

It also tolerates a look-alike `FF 65` by stepping past it, and validates the
parsed table with `sec_ok_starts()`: offsets must never move backwards, and
zone 0 must start inside the payload we hold. Trailing zones are **allowed to
overrun**, because a stream previously truncated to fewer levels still carries
the full zone table — and OpenJPEG ignores SEC entirely, so the header stays
meaningful. The monotonicity arithmetic is done in 64 bits, since `Z` and `T` are
32-bit fields read straight out of the file and would otherwise be able to wrap.

**Every zone range is clamped to the bytes actually present** before it is used
for a read or a write. The SEC table is attacker-controlled input, and overrun
zones are a legitimate case rather than a malformed one, so the overrun has to
be tolerated in the *header* while being refused at the point of use (§6.3,
§6.5).

### 6.3 Decrypting only what you may read

`decryptAccessibleLevels()`:

1. Clamp `accessLevel` to the levels actually present (`-1` → last level).
2. Derive `K0..K_accessLevel`.
3. AES-256-CTR each zone `0..accessLevel` in place. Each zone's declared size is
   clamped to `payload - Z`; a zone beginning past the payload is treated as
   empty rather than trusted.
4. Return the number of payload bytes those levels occupy, itself capped at the
   payload length.

Everything finer stays ciphertext.

### 6.4 Reduction clamping — the important one

Levels are coarse-first, so the finest image reconstructible from levels
`0..granted` is the one at level `granted`, which requires

```
minReduction = total - 1 - granted
```

If the caller asked for a finer reduction, **it is clamped coarser, not
honoured**:

> OpenJPEG does not fail on a truncated payload — it synthesises the missing
> levels as empty and returns a plausible-looking but wrong image. Silently
> over-reading would be far worse than a coarser result.

The applied value is reported back in `DecodeResult::reduction`, so callers never
have to guess.

### 6.5 `truncateToLevels()`

When the caller holds fewer levels than the file contains, the codestream is
rebuilt around just the accessible prefix:

1. Copy everything through `payloadStart + keepBytes` (the end of the last
   accessible zone). `keepBytes` is clamped to the bytes actually held before it
   becomes an iterator range.
2. Patch `SOT`'s `Psot` to the new tile-part length (skipped when `Psot == 0`,
   which means "runs to end of file").
3. Append `EOC`.

**Headers are kept verbatim — `COD` included.** This is not laziness; it is
load-bearing:

> Resolution geometry comes from `SIZ` together with `COD`'s decomposition count.
> Rewriting `COD` to renumber the surviving levels makes OpenJPEG reinterpret the
> retained subbands at the wrong scale — a `0:0` window of a 512×512/6-level
> codestream would decode as 512×512 instead of 16×16.

Truncating the payload alone is sufficient, because the decode reduction factor
tells OpenJPEG to stop after the last level it can read. An earlier
decoder-side attempt to patch `COD` decomposition levels was **wrong and was
removed**.

### 6.6 Reduced-resolution decode

`readNumResolutions()` pulls the decomposition count out of
`opj_get_cstr_info()`'s tile-component coding parameters — `opj_image_t` does not
carry it. Then `opj_set_decoded_resolution_factor()` (after `opj_read_header`,
before `opj_decode`) makes OpenJPEG skip MQ-decoding the finer code blocks and
never allocate their coefficient arrays. The requested factor is clamped against
the header's own count, because the API rejects a factor not below it.

### 6.7 Planar → RGBA

OpenJPEG returns planar, and components may have **different sizes** (4:2:0 and
friends). Each component is sampled with its own stride and mapped onto the
component-0 grid — a shared index would read past the end of every subsampled
plane. Output is a `Uint8ClampedArray` ready for `ImageData`.

### 6.8 `describeSecurityZone()`

Reports `{ hasSec, zoneCount, starts, sizes }` **without decrypting** — lets the
UI show which levels are already readable and which are still ciphertext.

The native side leaves `starts`/`sizes` as `null` whenever the codestream has no
SEC marker, so the JS wrapper normalises them to `[]`. That case is *every
plaintext codestream*, not just an empty buffer — an earlier version only
guarded the empty stream and `Array.from(null)` threw on anything unencrypted.

---

## 7. Server

ASP.NET Core 10 (`net10.0`), API-only. One NuGet dependency:
`Microsoft.AspNetCore.OpenApi`. **No codec, no cryptography library.**

### 7.1 Endpoints

Routing is **spec-driven**: `SpecEndpointSource.Read()` parses `openapi.yaml` line
by line and maps each `operationId` to a handler. An endpoint exists only if the
spec declares it — the spec is the source of truth, not documentation of one.
`{path}` is rewritten to ASP.NET Core's catch-all `{**path}`.

| Method | Route | opId | Auth | Purpose |
|---|---|---|---|---|
| `GET` | `/image/{path}` | `getImage` | — | Layer window, or `meta` JSON |
| `POST` | `/image/{path}` | `uploadImage` | password | Store full codestream |
| `DELETE` | `/image/{path}` | `deleteImage` | password | Remove image |
| `GET` | `/image-info/{path}` | `getImageInfo` | — | Full marker-derived metadata |
| `GET` | `/images` | `listImages` | — | List stored files with metadata |
| `GET` | `/openapi/compare` | — | — | Diff live routes vs spec |
| `GET` | `/openapi/v1.json` | — | — | Generated OpenAPI document |

`/openapi/compare` is a small consistency check that reports `inSync`, plus
`onlyInSpec` and `onlyServed` — it catches a handler wired without a spec entry
or vice versa.

### 7.2 `X-Emage-Layers` window protocol

| Value | Result |
|---|---|
| `meta` | JSON `{ layers, width, height, bytes }` |
| `all` (or absent) | headers + all packets, EOC-terminated — self-contained |
| `n` | single layer `n` |
| `n:m` | layers `n..m` inclusive |
| anything else | `400` |

Framing rules:

- **`n == 0`** → `headers+packets`. Main headers (minus `TLM`/`PLM`/`PPM`) are
  copied verbatim, each tile-part's `SOT` is rebuilt with a corrected `Psot`, and
  the result is **EOC-terminated**.
- **`n > 0`** → `packets`. Raw packet bytes only, for splicing after the `0:x`
  window.

Response headers:

```
X-Emage-Framing:          headers+packets | packets
X-Emage-Layers:           <n>:<m>
X-Emage-TotalLayers:      <count>
X-Emage-RemainingLayers:  <TotalLayers - m - 1>
X-Emage-TilePsotOffsets:  <comma-separated offsets>   (only when headers included)
```

All five are listed in `WithExposedHeaders` — an unlisted response header is
invisible to cross-origin browser JS, and these are all read by the client.

### 7.3 The server is key-blind

This is a **contract, not an accident** (`openapi.yaml` §description):

> No header, query, or body field carries keys, IVs, or an encryption flag; the
> server must not be extended to require or accept one.

The server never learns whether a file is encrypted. `J2kCodestreamParser` treats
`FF 65` like any other marker; the payload after `SOD` is opaque bytes it copies.
`/image-info` reports structural facts (dimensions, progression, packet counts)
that hold equally for plaintext and ciphertext.

### 7.4 `J2kCodestreamParser`

Pure marker-walking — no decode. Structure:

```
Parse
├── main header walk (SOC..SOT/EOC)
│   ├── SIZ → Xsiz/Ysiz/XOsiz/YOsiz/XTsiz/YTsiz/XTOsiz/YTOsiz, Csiz, components
│   └── COD → Scod, progression order, quality layers, numResolutions, precincts
├── COC → per-component precinct sizes
└── per tile-part
    ├── SOT → Lsot, Isot, Psot, TPsot, TNsot
    ├── tile-part header segments (until SOD)
    ├── PLT → packet lengths (variable-length ints)
    └── packet table = offsets derived from cumulative PLT lengths
```

Constants recognised: `SOC 4F`, `SIZ 51`, `COD 52`, `COC 53`, `TLM 55`,
`PLM 57`, `PLT 58`, `POC 5F`, `PPM 60`, `PPT 61`, `SOT 90`, `SOD 93`, `EOC D9`.

Progression orders: `Lrcp=0`, `Rlcp=1`, `Rpcl=2`, `Pcrl=3`, `Cprl=4`.

**`NumLayers` is assigned `numRes` — the DWT count.** The single line
`NumLayers = numRes` in the parser is what makes the whole system's "layers"
vocabulary work; it is commented in three places because it is the most
misunderstood field in the codebase.

Validity checks that reject a stream: missing SIZ/COD, `numRes < 1`,
unsupported progression order, unterminated tile-part, corrupt tile-part length,
**PLT sum ≠ SOD payload length**, and **PLT packet count ≠ computed progression
combination count**.

The latter requires `PrecinctCountsPerResComp()` → `PrecinctCount()`, which
computes precinct counts per resolution/component from tile bounds and precinct
sizes, then `OrderedCombos()` sorts `(layer, res, comp, prec)` tuples by the
codestream's progression order. It is a real packet-count reconstruction, not an
assumption.

### 7.5 `J2kLayerExtractor`

`Slice(data, codestream, firstLayer, lastLayer)`:

**Guards:** range within `0..NumLayers-1`; no `POC`; PLT must be present.

**When `firstLayer == 0`:**
- Write `SOC`.
- Copy main-header segments **verbatim**, skipping `TLM`/`PLM`/`PPM`.
- Per tile-part: write `SOT` (recording each `Psot` field offset), copy
  tile-part header segments skipping `PLT`/`PPT`, write `SOD`, then copy packets
  with `Layer <= lastLayer`, then back-patch `Psot` to the real shortened length.

**When `firstLayer > 0`:** copy only packets in `[firstLayer, lastLayer]`, raw,
no framing.

### 7.6 EOC termination — non-obvious

> A window that starts at level 0 carries the main headers, so it is a
> codestream in its own right and is terminated with EOC. Without it OpenJPEG
> does not report a truncated tile-part, it keeps asking for the next tile-part
> and never returns.

`J2kSlice.WithEoc()` appends `FF D9`. Applied in `EndpointHandlers` when
`slice.IncludesHeaders`.

### 7.7 Storage, config, security

`J2kImageLibrary` — singleton, rooted at `Emage:ImageRoot` (default
`{ContentRoot}/images`). Recursive file enumeration, parsed codestreams cached
in a `ConcurrentDictionary` keyed by full path.

Path traversal is blocked in `TryResolve()`: rooted paths rejected, path
normalised, then a `StartsWith` check against the root **with a trailing
separator appended** — without that separator `/data/images-evil` would pass a
prefix test against `/data/images`.

Auth: `X-Emage-Password` compared to `Emage:UploadPassword` via
`CryptographicOperations.FixedTimeEquals`. If no password is configured,
upload and delete are **always** unauthorized. Required on `POST` and `DELETE`
only; reads are unauthenticated.

Upload validation: body ≥ 2 bytes; **must end with `FF D9`** (a layer slice is
rejected — only whole images are stored); must parse cleanly. Response is
`{ stored, layers, width, height, bytes }`. Request body size limit is lifted via
`IHttpMaxRequestBodySizeFeature`.

CORS: allow any origin/header/method, with the five `X-Emage-*` response headers
exposed.

Exception handling is registered **after** `UseCors` deliberately, so CORS
middleware still gets a say: an unhandled exception used to return a bare 500
with no `Access-Control-Allow-Origin`, which a browser reports as "CORS failed"
and hides the real status.

---

## 8. Client library (`emage.js`)

ES module, no dependencies, no build step. `EmageError` / `EmageServerError`
subclass `Error`.

### 8.1 Configuration

```js
await Emage.init({ wasmBase?, encoder?, decoder?, encoderUrl?, decoderUrl? })
  .setServer({ baseUrl, imagePath, password })
  .setCrypto({ key, iv, accessLevel });
```

`init()` resolves the Emscripten modules from (in order) an explicit factory,
`globalThis.J2KEncoder` / `globalThis.J2KDecoder`, or by injecting a `<script>`
tag. `wasmBase` defaults to `cmake-build-wasm/` resolved relative to
`import.meta.url`.

`accessLevel` accepts an integer or `"all"` / `-1`. The legacy `levels` alias is
accepted and ignored-with-meaning (it was the old cascade-round count and no
longer maps to anything). Key must be exactly 32 bytes, IV exactly 16.

### 8.2 API surface

| Method | Purpose |
|---|---|
| `encodePixelData(px, w, h, opts)` | Infer gray/RGB/RGBA, encode, return codestream |
| `encodeCanvas(canvas, opts)` | Encode from a canvas |
| `decode(stream, opts)` | Decrypt + decode → `{width,height,rgbaPixels,…}` |
| `decodeToCanvas` / `paintTo` | Decode and paint, optionally scaled into `dims` |
| `describeSecurityZone(stream)` | `{hasSec,zoneCount,starts,sizes}`, no decryption |
| `granularKeys(count?)` | Chain as hex strings |
| `meta()` | `GET` with `X-Emage-Layers: meta` |
| `list()` | `GET /images` |
| `upload(j2k, opts)` | `POST`, enriched client-side with `granularKeys` |
| `remove(opts)` | `DELETE` |
| `preview(opts)` | Single thumbnail-sized decode |
| `playAll(opts)` | Every resolution, coarsest first |
| `display(target, opts)` | Levels needed for a display size |

`resolveTarget()` accepts `200`, `'100px'`, `'10vw'`, `'30vh'`, `'50%'`,
`'all'`, `'100%'`.

### 8.3 Key-blindness in the client

`_stream()` is the only fetch of codestream bytes. It requests **only what the
grant can read**:

```js
const grant = this.crypto.accessLevel;
const spec = (grant == null || grant < 0) ? 'all' : '0:' + grant;
```

Finer levels would be transferred only to be discarded. Because the window
starts at 0, offsets in the SEC zone table for levels `0..a` remain valid.

`upload()` derives `granularKeys` **client-side after** the round trip and
attaches them to the response object:

```js
if (this.crypto.key && this.crypto.key.length) {
    out.granularKeys = this.granularKeys(out.layers || out.numResolutions || null);
}
```

Nothing derived is transmitted. When no key is configured, or the stream has no
SEC marker, `granularKeys` is `null`.

`upload()` also refuses any buffer not ending in `EOC` — a layer slice is not a
storable image — and sends `Content-Type: image/jp2` (the server ignores it, but
omitting it makes the browser send `text/plain`, which misdescribes the bytes).

### 8.4 Progressive resolution loading

`_loadResolutions()` walks a descending series of DWT levels.

**The codestream is fetched once in full.** Resolution levels are spatially
nested, not bandwidth-separable — a reduced-resolution decode still needs every
byte. What reduction buys is *work*: level `r` decodes
`ceil(W / 2^(E-r))` square, so the decoder never MQ-decodes the code blocks above
`r`, never allocates the finer subband coefficient arrays, and never runs the
high-pass synthesis path.

**Walking down is cheaper than decoding one-shot at the target.** Climbing
coarse→fine costs `1 + 1/4 + 1/16 + …` of the final decode and yields every
intermediate frame free, since each earlier frame has a quarter the samples of
the next. This is the opposite of quality-layer truncation, where the first
frame already costs a full-resolution raster and each later frame re-runs all its
predecessors' passes.

**Start-point selection** (`previewSteps`, default 2):
- Reduction 0 (full resolution) → start at the coarsest level. The classic
  progressive experience.
- Reduced target → start `previewSteps` early, skipping levels the target does
  not need.
- No known bound → start `previewSteps` past the target.

**The bound probe.** If the server does not report a level count, a progressive
pass probes with `reduction: 31`. Far past any real codestream, the native clamp
reduces it to the coarsest level — making the probe the cheapest possible decode
that also returns `numResolutions`. Without it the loop would overshoot and
re-decode a level that gets clamped away. A one-shot decode never probes; it just
lets the native side clamp and reports back.

`decodes` counts **real decoder invocations**, including a discovery decode
whether or not its level is reused — the figure stays honest. The probe's frame
is reused only when the loop starts at exactly that level; widening the sequence
to include it would paint a frame smaller than `previewSteps` asked for.

`_minResolutionForSize()` rounds **up**, landing on the coarsest level at or
below the target, so the raster is never more than 2× the target's area.
Rounding down would guarantee an upscale, or cost 4× the samples to decode a
level twice as large and let the browser discard three quarters of it.

`_yieldForPaint()` uses **double** `requestAnimationFrame` to guarantee the
current frame is composited before the next decode — otherwise progressive
frames are coalesced away and only the last one is seen.

---

## 9. Demo pages

Three standalone HTML pages, no build, sharing `emage.js`.

### Plaintext codestreams

Encryption is opt-out. `encodePixelData()` takes `enableSec` (default `true`);
clearing it writes a codestream with **no SEC marker** and leaves the packet
payload in the clear. Everything downstream already copes, because the crypto is
polymorphic end to end:

- `decode()` ignores a supplied key/IV when there is no SEC marker, and works
  with none at all — so a plaintext image needs no credentials.
- `describeSecurityZone()` reports `hasSec: 0`.
- `upload()` returns `granularKeys: null`, gated on the stream actually carrying
  a SEC marker rather than merely on a key being configured — otherwise a
  plaintext upload would advertise keys that describe nothing.
- The **server is unaffected**. Its parser has no notion of encryption, so
  plaintext is stored, listed and windowed exactly like ciphertext. That is the
  key-blind contract from §7.3, and it means one image store can hold both.

The tradeoff is that the access-level control has nothing to act on for a
plaintext image: without per-level keys there is no grant to enforce.

### `uploader.html` — encrypt & upload
Server URL/path/password; file picker; **Encode & decode** round trip; download
the encrypted `.j2k`; load and decrypt an uploaded file. An **`secInput`**
checkbox selects encrypted vs plaintext encoding and greys out the key/IV inputs
when cleared. `layerInput` (resolution count); **`accessInput`** (access level,
`all` default). Source and destination canvases with a stage label. Gallery:
refresh listing, open, delete. Upload / **Verify roundtrip** / delete on server.
A sticky **derived-keys table** on the right (`keysPanel`/`keysBody`/
`copyKeysBtn`) listing one row per level — key, level index, the resolution it
resolves to, and the key material — with rows inside the current access grant
highlighted.

### `downloader.html` — progressive viewer
Server URL/path; key/IV; `accessInput` for the grant. Breadcrumb file browser.
Fetch meta; load full; load for a display size (`10vw` etc.). Canvas with stage
label showing each progressive level. Every load reports the fetched stream's
protection in the status line — plaintext, or the zone count and active grant.

### `compare.html` — transfer strategy comparison
Runs progressive vs one-shot vs full load side by side, three canvases with
timing/value readouts, plus a summary table and a per-step table. This is the
page that surfaces the `decodes` / `pixels` / `assembledBytes` counters, and it
appends the stream's protection state to the metadata line.

---

## 10. Build, run, deploy

### WASM

CMake ≥ 3.25, C++20, **Emscripten toolchain required** (the build warns if
`EMSCRIPTEN` is unset, since it would silently produce a native binary).

```
add_subdirectory(third_party/openjpeg)   # BUILD_CODEC/BUILD_TESTING/SHARED off
target_compile_definitions(openjp2 PRIVATE USE_JPSEC)
```

Two targets, `EmageWasmEncoder` (`EXPORT_NAME=J2KEncoder`) and
`EmageWasmDecoder` (`EXPORT_NAME=J2KDecoder`). Common flags:

```
--bind  -sMODULARIZE=1  -sALLOW_MEMORY_GROWTH=1  -sENVIRONMENT=web
-sNO_EXIT_RUNTIME=1  -sEXPORTED_FUNCTIONS=_malloc,_free
-sEXPORTED_RUNTIME_METHODS=HEAPU8  -sDISABLE_EXCEPTION_CATCHING=0  -O3
```

`-sDISABLE_EXCEPTION_CATCHING=0` is deliberate: C++ exceptions surface as
catchable JS errors instead of aborting the module, which keeps the page alive
when a decode rejects a partial window.

A `POST_BUILD` step copies each `.js`/`.wasm` pair into
`../EmageClient/cmake-build-wasm/`, which is where `emage.js` looks by default.

### Server

```
make build   dotnet build Emage/Emage.csproj -c Release
make test    dotnet test Emage.slnx -c Release
make run     dotnet run --urls=http://localhost:3233
make up      docker compose up -d --build
make down    docker compose down
```

`DOTNET_ROOT=$HOME/.dotnet` is exported by the Makefile. This matters: the
system `dotnet` has no AspNetCore runtime, which makes `dotnet test` look broken.

Docker: single service, port `3233`, volume `emage-images:/data/images`,
`Emage__UploadPassword` from `${EMAGE_UPLOAD_PASSWORD:-}`, `restart:
unless-stopped`. `make seed` copies `images/encrypted.j2k` into the container and
fixes ownership to `$APP_UID`.

`.env` is git-ignored and `.dockerignore`d; it holds one variable,
`EMAGE_UPLOAD_PASSWORD`. **Keep it that way.**

---

## 11. Tests

| Suite | Location | Scope |
|---|---|---|
| `dotnet test` | `Emage.Tests/J2kTests.cs` | 13 xUnit tests over slicing, markers, traversal |
| `test_node.js` | EmageWasm | Polymorphic decode, granular crypto |
| `test_resolution.js` | EmageWasm | Reduction correctness and clamping |
| `test_granular.js` | EmageWasm | Pixel-exact access-level matrix |
| `test_progressive.mjs` | EmageClient | Level selection, ordering, decode counting |
| `test_granular_keys.mjs` | EmageClient | Public API: chain, clamping, window, keys |
| `test_chain.mjs` | EmageClient | 85 checks against the **live** server |

Fixtures: `encrypted.j2k`, `sample.lrcp.j2k`, `sample.rlcp.j2k`,
`sample.sop.j2k`, `sample.nopl.j2k`, `src.ppm`.

`test_granular.js` is the load-bearing one: it asserts a **pixel-exact**
matrix. For a 512×512/6-level image with granular keys, grants 0..5 must
reconstruct 16/32/64/128/256/512 px at reductions 5..0, and each grant's
windowed decode must be **byte-identical to the corresponding full-stream
decode**. That is what proves the SEC offsets, truncation, `Psot` patch and
reduction clamp all agree.

`test_chain.mjs` is the integration net: everything the unit suites stub
(emscripten encoder, HTTP upload, server marker parser, meta endpoint, stream
fetch, WASM decoder) runs for real against `localhost:3233`.

---

## 12. Known limitations and open items

### 12.1 Blocked / unverified

- **No browser automation** exercises the new UI controls (access-level inputs,
  key panel, copy button). The JS suites cover the library; the pages' wiring is
  only manually checked.
- **`encrypted.j2k`** (4802×4802, 6 levels) is in the discarded old single-zone
  format with no known key/IV. Unusable as a fixture.
- **RLCP + SOP packet offsets desync.** `J2kCodestreamParser` derives offsets
  from cumulative PLT lengths, which **exclude SOP markers**. A mid or prefix
  window of `sample.rlcp.j2k` is therefore assembled from wrong boundaries.
  Pre-existing, unrelated to SEC, but the fix is to teach the parser about
  SOP/EPH when deriving offsets from PLT.

### 12.2 Structural assumptions

These hold today because *this* encoder produces the files. Feeding a
third-party codestream would violate them:

- Single tile, single quality layer, no precinct partition, LRCP progression.
- Packets-per-resolution == `numComponents`.
- Encoder-written `Psot` is never `0`, so patching always applies.
- No `POC` (the extractor rejects it outright).

`PLT` is mandatory for slicing; a PLT-less stream is fine for `/image-info` but
rejected by `GET /image`.

### 12.3 Operational

- Auth is a single shared password compared with a fixed-time compare. No
  per-user identity, no rate limiting, no upload size ceiling (the body-size
  limit is explicitly lifted).
- CORS is wide open (`AllowAnyOrigin`) — required for the file:// and
  cross-port demo pages, inappropriate for deployment.
- `app.UseHttpsRedirection()` is active but the Docker port mapping is HTTP only.
- The parse cache has no eviction; it is keyed by full path and grows with
  distinct files.

---

## 13. Feature inventory

**Encoding**
- Lossless JPEG 2000 encode from pixel buffer, `ImageData`, or canvas
- 1 (gray) or 3 (RGB) components; automatic RGBA→RGB / RGBA→gray conversion
- Configurable resolution count (1–64, default 6) and bit precision
- Optional `TLM`, `PTERM`, `SEGSYM`, `SOP`, `EPH` markers
- Unconditional `PLT` (required for zone splitting)
- Round-trip decode for immediate verification

**Encryption**
- AES-256-CTR over the packet payload
- SHA3-256 hash-chain key derivation, one key per resolution level
- Per-level protected zones recorded in a JPSEC `SEC` marker
- Public API to list the derived keys as hex

**Access control**
- `accessLevel` selects the finest reconstructible resolution
- Coarse-first level numbering, coarse-first window fetching
- Finer-than-granted requests clamped, never fabricated
- Keys derivable and distributable per level, never transmitted to the server

**Decoding**
- Polymorphic decode (encrypted or plaintext through one entry point)
- Reduced-resolution decode without materializing finer subbands
- Zone introspection without decryption
- Truncation of a codestream to the accessible level prefix
- `Psot` correction and EOC termination
- Subsampled-component-aware planar→RGBA conversion

**Plaintext codestreams**
- Opt-out encryption per encode (`enableSec: false`)
- No SEC marker written; packet payload left in the clear
- Decode needs no key or IV; a supplied one is ignored
- Zone introspection degrades to `hasSec: 0` with empty arrays
- `upload()` reports no derived keys for an unencrypted stream
- One server image store holds encrypted and plaintext files indistinguishably

**Server**
- Marker-only codestream parsing (works on encrypted streams)
- Layer-window serving with correct framing and `Psot` patching
- Self-contained `0:n` windows; splicable `n:m` continuations
- `meta`, `/image-info`, and `/images` introspection
- Password-gated upload and delete; fixed-time compare
- Path-traversal hardening
- Spec-driven routing with a live-vs-spec drift check
- CORS with all custom response headers exposed

**Client library**
- Dependency-free ES module
- Modularize-style WASM loading from factory, global, or injected `<script>`
- Display targets in px, vw, vh, %, or `all`
- Progressive multi-level rendering with coalescing-proof paint yields
- Resolution-count probing when the server is silent
- Honest decoder-invocation accounting
- Hex/byte coercion, validation, and typed error classes

**Demo UI**
- Encrypt-and-upload page with gallery management and key display
- Progressive viewer with breadcrumb browser and staged rendering
- Side-by-side transfer-strategy comparison with timing tables
- Encrypted/plaintext toggle on the uploader; per-load protection reporting on
  the downloader and comparison pages
- Derived-key table with the granted rows highlighted