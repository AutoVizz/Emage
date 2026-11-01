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
K(E-1) = master key
K(m-1) = SHA3-256(Km)
...
K0 = SHA3-256(K1)
```

Each level's packet payload is encrypted exactly once, under its own key from
that chain. Because the chain is a one-way function of the master key, and each
key unlocks exactly one level, **a party holding Ka derives all coarser keys,
but cannot derive any finer key.** Access control is cryptographic, not
a server-side permission check.

The security model is therefore *graceful*: give someone key `Ka` and they
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

Emage uses the JPSEC security marker (**ISO/IEC 15444-8 / ITU-T T.807**),
marker code `0xFF 0x65`, as a single tool block registered in the
**user-defined** tool-id range. The segment is written into the **main
header** and is always plaintext — the encryption covers only the packet
payload after `SOD`.

### 3.1 Byte layout

Offsets are relative to the marker code. The segment is variable length: one
zone entry and one MAC per resolution level.

| Offset | Field | Width | Value / meaning |
|---|---|---|---|
| 0..1 | marker | | `FF 65` |
| 2..3 | `Lsec` | 16 | segment length, **including itself**: `14 + LPID` |
| 4..5 | `Zsec` | 16 | index of this SEC marker; `0` for the first |
| 6..7 | `Psec` | 16 | bits 15–8 reserved (`0`), bit 7 = `FPSEC`, bits 6–0 = `Ntools` |
| 8..11 | `ID` | 32 | tool id, `0x80000002` |
| 12..13 | `LZOI` | 16 | length of the Zone of Influence; `0` — skipped |
| 14..15 | `LPID` | 16 | length of the tool-specific parameters |
| 16.. | `PID` | `LPID` | opaque to the SEC parser; our payload |

`PID`, which is the only part with Emage-specific structure:

| Offset | Field | Width | Meaning |
|---|---|---|---|
| +0..1 | `E` | 16 | number of protected zones (= resolution levels) |
| +2..17 | `IV` | 16 | the counter block used for every level |
| +18.. | zone entries | 10·E | see below |
| +18+10E.. | MAC table | 32·E | cumulative SHA3-256 tag per level |

Each 10-byte zone entry:

| Offset | Field | Meaning |
|---|---|---|
| +0..1 | zone index | resolution level, `0` = coarsest |
| +2..5 | `Z` | start offset, **relative to the first byte of the packet payload** (i.e. `SOD + 2`) |
| +6..9 | `T` | size in bytes |

So `LPID = 18 + 42·E` and `Lsec = 14 + LPID`. At the 64-level ceiling
`Lsec` is 2720, comfortably inside 16 bits. Both length fields had to be
16-bit: the previous one-byte `L` overflowed at 7 levels once MACs made each
level cost 42 bytes.

Implementation constants (`jpsec_aes.h`):

```
JPSEC_SEC_ID_OFFSET      8      JPSEC_ZONE_ENTRY_BYTES  10
JPSEC_SEC_LZOI_OFFSET   12      JPSEC_MAC_ENTRY_BYTES   32   (SHA3-256)
JPSEC_SEC_LPID_OFFSET   14      JPSEC_MAX_ZONES         64
JPSEC_SEC_PID_OFFSET    16      JPSEC_AES_KEY_BYTES     32   (AES-256)
JPSEC_SEC_E_OFFSET      16      JPSEC_AES_IV_BYTES      16
JPSEC_SEC_IV_OFFSET     18
JPSEC_SEC_ZONE_OFFSET   34      JPSEC_TOOL_ID           0x80000002
JPSEC_SEC_FIXED_BYTES   16      JPSEC_PSEC_FPSEC        0x0080
```

### 3.2 Four design decisions worth calling out

**User-defined tool id.** `ID = 0x80000002` sits in `0x80000000..0xEFFFFFFF`,
the user-defined range. Registered tools live in `0x00000000..0x7FFFFFFF`
and are assigned by the JPSEC Registration Authority, so an id there would
need registration and could collide with a normative tool.

**`FPSEC` is set.** `Psec = 0x0081`. The flag asks a transcoding or rewriting
process that does not understand the tool to forward the segment **as-is**.
Clearing it would let such a process discard or alter the zone table and MACs
— which is precisely what the serving layer must not do to a window it does
not decrypt.

**`LZOI = 0`.** The standard Zone of Influence is skipped and granularity is
carried by our own table inside the opaque `PID`, which is permitted for a
user-defined tool.

**Payload-relative offsets.** `Z` is relative to `SOD+2`, not absolute in the
file. This is deliberate and load-bearing. The serving layer rebuilds the main
header and drops `TLM`/`PLM`/`PPM` (and `PLT`/`PPT` in tile-part headers),
which shifts every absolute offset in the file. Payload-relative offsets
survive that rebuild unchanged — and because the MACs cover `Z` and `T`, they
survive it too. §11.1 records the end-to-end test that proves it.

**The IV travels in the marker, and is random per file.** Publishing it means
a reader can decrypt a served window without being handed the counter block out
of band — the decoder takes it from the marker and requires nothing but the key
and the codestream.

Per-file randomness is a correctness requirement, not hygiene. CTR keystream is
a function of `(key, IV, offset)`, so two files sharing a master key *and* an IV
share a keystream at every level, and `C_A ⊕ C_B = P_A ⊕ P_B` — a two-time pad
that hands an attacker the XOR of two plaintexts with no key knowledge. Because
the IV rides in the marker there is no transport burden, so the uploader simply
draws 16 bytes from `crypto.getRandomValues` **per encode** rather than asking
for one. It is not secret (SP 800-38A treats it as public); it must merely not
repeat.

**No key material.** The marker never carries a key. Its presence is the only
signal, and the server ignores it entirely (§7.3).

### 3.3 Resolution ceiling

Each level costs 42 bytes of header, so the pyramid is capped at **64
resolution levels**. Both sides enforce this: the C encoder rejects
`numResolutions` outside `1..64`, and `emage.js` checks the same bound up front
with a clearer message.

### 3.4 Vendored OpenJPEG patches

Two changes to vendored OpenJPEG are required:

- `third_party/openjpeg/src/lib/openjp2/j2k.c` — `opj_j2k_write_sec()` rewritten
  to emit the single tool block with both tables. The zone count and IV are
  published through `jpsec_set_zone_count()` / `jpsec_set_iv()`, because the SEC
  marker is written as a *header* procedure, before any per-tile parameters
  exist. The buffer is zeroed in full: `Z`, `T` and the MACs are patched
  post-encode, and indeterminate stack content must not reach the codestream
  even transiently.
- `sec_marker.cc` — supplies the `j2k_read_sec` / `j2k_read_insec` handlers that
  the marker dispatcher expects when compiled with `USE_JPSEC`. These **validate
  and skip only**; they never act on the zone table. An encrypted codestream
  reaches OpenJPEG already decrypted by `jpsec_aes.c`.

The `PLT=YES` marker is emitted **unconditionally**. The packet length table is
the only way to know where one resolution level's payload ends and the next
begins — without it the encoder cannot split the payload into zones, and the
server cannot slice windows.

---

### 3.5 Opaque metadata in the image header

Caller metadata is stored inside the image, never in a separate file or an HTTP
upload header. It uses a binary JPEG 2000 COM marker in the main header, before
SOT. SEC continues to carry the IV, zones and cumulative MACs unchanged.

| Field | Bytes | Value |
|---|---|---|
| Marker | 2 | `FF 64` |
| Lcom | 2 | big-endian length including Lcom, Rcom and payload |
| Rcom | 2 | `0`, binary comment |
| Envelope prefix | 11 | ASCII `EMAGE-META` followed by one NUL byte |
| Metadata | variable | UTF-8 JSON object |

The payload fits one COM segment (`Lcom <= 65535`). Other comments remain
untouched. Replacing metadata removes the previous envelope and preserves SIZ,
COD, SEC, packet data and payload-relative zone offsets. The same envelope can
carry arbitrary metadata on a plaintext image.

Encrypted client encodes add this client-defined lookup object:

```json
{
  "keyMap": {
    "iv": "<16-byte IV as 32 lowercase hex digits>",
    "levels": {
      "<SHA3-256(IV || K0), 64 hex digits>": 0,
      "<SHA3-256(IV || K1), 64 hex digits>": 1
    }
  }
}
```

There is one entry per resolution. SHA3 hashes the concatenated **raw bytes**,
IV first and key second, rather than their hex strings. These tags reveal no raw
key material. The random per-image IV also prevents the same key from producing
the same tag across different encodes.

The server recognizes only the generic COM envelope and returns its JSON as
`metadata` on upload and `X-Emage-Layers: meta`. It never interprets `keyMap`,
IVs, SEC or encryption state. Resolution windows preserve the COM marker.
A client hashes its supplied key locally, selects the matching level, and then
fetches the needed packet window. An unmatched key needs no image download.

Lookup metadata selects a download; it is not an authenticity guarantee. The
native decoder still checks MACs and authenticates the supplied key's level.
The client rejects a map entry that disagrees with that authenticated level.
Modified requested zones cannot cause a silent fallback to a coarser image.
Files lacking a map use the coarsest-zone discovery described in §8.3.

## 4. Cryptography

| Property | Choice |
|---|---|
| Block cipher | AES-256 (`JPSEC_AES_KEY_BYTES = 32`) |
| Mode | CTR (NIST SP 800-38A); encryption and decryption are the same operation |
| IV | 16 bytes, **random per file**, shared across every level, carried in the SEC marker |
| Key derivation | `K(m-1) = SHA3-256(Km)`, `K(E-1) = master key` |
| Integrity | cumulative SHA3-256 MAC chain, one tag per level |

`jpsec_aes256_ctr_crypt()` and `jpsec_derive_level_keys()` are implemented over
a **minimally trimmed Mbed TLS** — only `aes.c`, `sha3.c`, `platform_util.c` are
compiled.

### 4.1 The cumulative MAC chain

Each level carries a tag, chained from the one below it so a reader holding
`K0..Ka` can authenticate everything they can see:

```
MAC[-1] = 32 zero bytes
MAC[r]  = SHA3-256( MAC[r-1] || K_r || r || Z_r || T_r || plaintext[r] )
```

Binding `K_r` in means a party without the key cannot forge the tag. Binding
`Z` and `T` in means the tag also pins each zone's position and extent, so a
**relocated or resized zone is rejected**, not just flipped bytes. Chaining
means verifying level `a` transitively authenticates `0..a-1`.

The decoder recomputes the chain over the plaintext of levels `0..accessLevel`
after decrypting and compares it against the stored tags with a constant-time
compare, before any truncation — so a tampered zone is rejected instead of
being decoded into a plausible-looking image. AES-256-CTR on its own detects
neither.

Two consequences worth being explicit about:

- A **coarser grant does not authenticate finer levels.** A holder of `K0..K0`
  cannot detect corruption of level 1, because they lack `K1`. Their own
  reconstruction is still fully verified.
- The tags for *all* levels are plaintext in the header, so an attacker can
  confirm a guess about a level above their grant. Infeasible in practice —
  the key is unknown and a level's plaintext is a large structured body — but
  it is a verification oracle, not a confidentiality leak.

### 4.2 What a reader needs

Only a granted key Ka and the codestream or its server path. There is no need to
enter the key's resolution or its IV. With server metadata available, the client
finds a locally computed `SHA3-256(IV || Ka)` tag in the image's header map
before fetching image packets. The decoder independently authenticates a by
hashing toward K0 and checking MAC[0] against the coarsest zone.

Full access uses K(E-1), the master. An optional `accessLevel` limits the
requested resolution further; `all` / `-1` selects the key's level automatically.
The IV comes from SEC, and a supplied IV is length-checked then superseded.

### 4.3 Verification

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
7. **`applyGranularSecurity()`** if `enableSec`. It locates `SOC → SEC → SOT →
   PLT → SOD`, computes the per-level ranges from the packet table, then
   computes the **MAC chain over the plaintext first**, encrypts, and patches
   both tables. Order matters: the payload is plaintext only once.

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
chain as lowercase hex strings, `K0` first, with the supplied key at `count-1`. This is what the client uses to
*display and distribute* keys after upload.

---

## 6. Decoder

Source: `decoder_bindings.cc`.

```cpp
DecodeResult decodeRaw(uintptr_t ptr, size_t size,
                       val key, val iv,
                       int accessLevel,   // -1 = detect the supplied key's level
                       int reduction);    // DWT halvings; 0 = full resolution
```

Returns `{ width, height, numComponents, reduction, numResolutions, keyLevel, rgbaPixels }`.
`keyLevel` is authenticated for encrypted streams and `-1` for plaintext.
`identifyKeyLevel(ptr, size, key)` needs only the main header and the complete
coarsest zone; it performs no image decode. `keyLookupTag(key, iv)` is exported
by both WASM modules and returns `SHA3-256(IV || key)` as lowercase hex.

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

Before decryption, `detectKeyLevel()` hashes the supplied key toward K0
and verifies MAC[0] on a scratch copy of the coarsest zone. A match identifies
the supplied key as Ka. Wrong keys, damaged coarsest data, and old-format
ciphertext are rejected. The complete requested MAC chain is still verified;
finer corruption never triggers a fallback to a lower grant.

1. Use the detected level a, capped by an explicit `accessLevel` if supplied.
   `all` / `-1` means use a automatically.
2. Derive the effective grant key and all coarser keys backwards from Ka.
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

### 6.8 MAC verification

`verifyAccessibleMacs()` recomputes the chain from §4.1 over the decrypted
plaintext of levels `0..accessLevel` and compares it against the tags stored in
the marker. It runs **before** truncation, so it checks exactly the bytes the
caller is about to decode. Failure raises with the first failing level named:

> `MAC verification failed at resolution level 3: the codestream has been modified`

`describeSecurityZone()` also reports the chain and the IV without
decrypting, so a UI can show what a grant verifies without decoding.

### 6.9 `describeSecurityZone()`

Reports `{ hasSec, zoneCount, starts, sizes, macs, iv }` **without
decrypting** — lets the
UI show which levels are already readable and which are still ciphertext.

`macs` is a flat `zoneCount * 32` array of bytes and `iv` is the 16-byte
counter block. The native side leaves all of these as `null` whenever the
codestream has no
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
| `meta` | JSON `{ layers, width, height, bytes, metadata }`; metadata comes from COM |
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

The same endpoints store and slice plaintext and encrypted codestreams. The
server never requires keys or an encryption flag, and never decides whether an
image is encrypted. `J2kCodestreamParser` handles SEC like any other marker;
packet bytes after SOD remain opaque. `/image-info` reports structural facts
that hold equally for plaintext and ciphertext.

`J2kMetadata.Read()` recognizes the generic binary COM envelope (§3.5) and
returns a cloned JSON object, or null when absent or malformed. It does not
interpret the object's fields. `IndexedImage` caches that metadata together with
the image bytes and marker parse. Upload invalidates this cache, so re-uploading
cannot leave a stale lookup map. There are no sidecar files.

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
const emage = await Emage.init({ serverBaseUrl: 'http://localhost:3233' });
emage.setServer({ baseUrl: 'http://localhost:3233', imagePath: 'example.j2k' });
emage.setCrypto({ key: grantedKey }); // automatic resolution; IV comes from SEC
const image = await emage.playAll();
```

`init()` resolves modules from an explicit factory, a module global, or an
injected script. `wasmBase` defaults to `/wasm/` on `serverBaseUrl` (or the page origin).

`accessLevel` accepts a non-negative integer ceiling or `all` / `-1` for
automatic detection. The legacy `levels` alias maps to that same ceiling.
Keys are 32 bytes. IVs are 16 bytes when supplied; readers do not need one.
Encoding uses the finest/master key, while decoding accepts any granted key.

### 8.2 API surface

| Method | Purpose |
|---|---|
| `encodePixelData(px, w, h, opts)` | Infer gray/RGB/RGBA, encode, return codestream |
| `encodeCanvas(canvas, opts)` | Encode from a canvas |
| `decode(stream, opts)` | Decrypt + decode → `{width,height,rgbaPixels,…}` |
| `decodeToCanvas` / `paintTo` | Decode and paint, optionally scaled into `dims` |
| `describeSecurityZone(stream)` | `{hasSec,zoneCount,starts,sizes,macs,iv}`, no decryption |
| `granularKeys(count?)` | Coarse-first hex chain, supplied key at count−1 |
| `keyLookupTag(key, iv)` | SHA3-256(IV || key), locally computed |
| `Emage.readMetadata(stream)` | Generic JSON from the binary COM envelope |
| `Emage.withMetadata(stream, object)` | Insert/replace the generic COM envelope |
| `meta()` | `GET` with `X-Emage-Layers: meta` |
| `list()` | `GET /images` |
| `upload(j2k, opts)` | `POST`, enriched client-side with `granularKeys` |
| `remove(opts)` | `DELETE` |
| `preview(opts)` | Single thumbnail-sized decode |
| `playAll(opts)` | Every resolution, coarsest first |
| `display(target, opts)` | Levels needed for a display size |

`resolveTarget()` accepts `200`, `'100px'`, `'10vw'`, `'30vh'`, `'50%'`,
`'all'`, `'100%'`.

`meta()`, `preview()`, `playAll()` and `display()` accept an `imagePath`
option that overrides `server.imagePath` for that call. Concurrent readers (for
example the uploader's thumbnail grid, which renders every row at once) must use
it rather than mutating the shared `server.imagePath`, which would otherwise
race and make several rows resolve to the same last-set path.

These four reading methods also accept an optional `signal: AbortSignal`.
It is forwarded to metadata and packet-window fetches, including body reads.
Progressive loops check it between frames, and paint yields can be aborted even
when animation frames are paused. Abort rejects with the signal's reason; it
does not return a completed image. A running synchronous WASM decode finishes
before control can return to the event loop.

### 8.3 Metadata lookup and bounded downloads

For a new encrypted image, `display()`, `preview()` and `playAll()`:

1. Fetch `X-Emage-Layers: meta` once. No image packets are included.
2. Compute `SHA3-256(IV || supplied key)` locally and find its level a in
   `metadata.keyMap.levels`. An unmatched key stops here.
3. Compute the needed level b from the requested reduction r: `E−1−r`,
   clamped to 0, the key's level a, and any explicit `accessLevel` ceiling.
4. A one-shot request fetches exactly `X-Emage-Layers: 0:b`, including headers
   and EOC. A progressive request fetches `0:b0` framed, then `b_{i-1}+1:b_i`
   per later frame, appending as it goes (§8.4).
5. Authenticate the key level and requested MAC chain, then decode.

Full loading therefore means the finest resolution the key unlocks, rather
than downloading the full image regardless of its grant. A master-key thumbnail
still fetches only the thumbnail's packet window. Plaintext uses the same
resolution-window protocol; no secret key is needed.

For an older reversed-chain file that lacks COM lookup metadata, the client
fetches `0:0`, identifies the key with MAC[0] without decoding an image, and
requests only `1:b` if more packets are needed. For Emage's single-tile streams,
it reuses the coarsest bytes, patches Psot, and appends EOC. Other framing can
use a correctly framed `0:b` prefix instead. The legacy **forward-chain** files
from before the chain-direction fix must be re-encoded.

`encodePixelData()` embeds the complete map in the returned image immediately.
The uploader shows every intermediate key immediately after encoding. Upload
preserves the map; when importing a native encode without a map, the client can
add one if it holds the master. Only public tags and the IV are stored in COM;
raw keys stay local. The client enriches upload results with `granularKeys`,
`macs`, and `iv` for encrypted streams. Plaintext reports these as null.

Image transfers are counted separately from metadata. `transferredBytes` counts
image response-body bytes, while `httpRequests` includes metadata and packet
requests. A one-shot load uses two requests (metadata plus one window). A
progressive load uses one extra packet request per frame, but the summed body
bytes never exceed the one-shot prefix it would have needed. Legacy discovery
can add a probe request, but never downloads finer packets to identify a key.

### 8.3.1 Client-side key ring and image coverage map (uploader)

The uploader no longer assumes one master key answers for the whole server.
It keeps a **key ring** (saved AES-256 keys, `localStorage: emage.keyring.v1`)
and an **image index** (`localStorage: emage.images.v1`) mapping each server
image to the public lookup header it carries.

- Image identity is a local SHA3-256 hash of the path (`p` + `SHA3-256(path)` hex,
  with a `~n` suffix on collision); a ring key is identified by the key hex itself.
  The server is never told these ids.
- The image index stores `{path, bytes, iv, levels}` per image — the same public
  `keyMap` that `Emage.readMetadata()` exposes, never raw keys.
- A **coverage scan** runs after `list()`: for every entry whose `bytes` changed
  (or that is new), the client fetches that image's `X-Emage-Layers: meta`
  header, at most 4 in flight, and records its `keyMap`. Unchanged entries reuse
  the cache, so a rescan only touches new or modified images.
- Coverage is then a pure local join: key `K` unlocks image `I` iff
  `SHA3-256(IV_I || K)` is a key of `I.levels`. No image packets are downloaded
  to decide this — only one meta request per changed image.
- Uploads seed the index directly from the just-encoded stream
  (`Emage.readMetadata(j2k).keyMap`), so a freshly uploaded image is classified
  without a round trip. Deletes prune the entry.

The UI mirrors this: the sidebar key-ring card lists each key's label, its
AES-256 abbreviated to first 8 bytes … last 8 bytes (full key on hover), its
unlock count and the paths it opens; each file row carries badges (`plain` = no lookup
header, `locked` = no ring key fits, otherwise one badge per matching key).
Clicking a badge activates that key. Thumbnails choose the first ring key that
unlocks the image in view, falling back to the key in the AES field, so images
under different keys preview correctly side by side.

### 8.4 Progressive resolution loading

`_loadResolutions()` streams the resolution layers one window at a time. The
first request carries the main headers and the coarsest level only (`0:0`,
`headers+packets`); every later frame fetches exactly the next level's packets
(`b:b`, raw `packets`), which the client appends by patching `Psot` and
restoring EOC (§8.2). Starting at level 0 means no request ever carries a
cumulative prefix of levels the viewer has not been shown; a codestream prefix
is inherently cumulative, so batching the first few levels would download
coarse data that is decoded once and then overwritten. No byte is downloaded
twice, so a full progressive load transfers exactly the same total as a single
`0:b` prefix, at the cost of one HTTP request per level. Each window is decoded
and painted (with a paint yield) before the next is requested, so the viewer
sees every level as it arrives instead of waiting for the last fetch. A one-shot
request keeps the single `0:b` fetch. Smaller display targets reduce both transferred
bytes and decoding work. A and B in `compare.html` use the same bounded target
window; the full-resolution baseline C uses a larger window when the key
permits it.

A progressive pass shows coarser frames before the final image and adds CPU work
relative to one-shot decoding. For a halving pyramid, the pixel counts form
`1 + 1/4 + 1/16 + …` relative to the final frame, approaching 4/3; this is an
estimate of sample work rather than a guarantee about total runtime.

Every progressive pass starts at the coarsest level and climbs to the target, so
a reduced target walks through the intervening levels just like a full load
rather than jumping to the first level the target needs. On the streaming path
that climb is one window per level; the single-fetch fallback (a keyed image
with no lookup map, or an older server with no resolution count) decodes the
same level sequence from the one prefix it already holds. The endpoint is capped
by both the available packet window and the authenticated key level;
inaccessible levels produce neither extra decodes nor duplicate frames. One-shot
loading performs one decode. `decodes` counts real decoder invocations, including
a discovery decode when an older server supplies no resolution count; on the
progressive path that probe is the coarsest frame and is reused rather than
repeated.

`_minResolutionForSize()` rounds up to a reduction whose raster fits the target.
`_yieldForPaint()` uses two animation frames so progressive frames are actually
painted rather than coalesced into the final one.

When a `canvas` is supplied, every progressive frame paints into a fixed target
size (`displayDims`): the requested display dimensions for a size target, or the
full raster for `'all'`. A coarser frame is therefore upscaled to the same area
and simply looks blurry, rather than the canvas growing from a thumbnail to the
full image as levels arrive. The final level matches `displayDims` exactly and so
paints without any resample; `displaySize` reports the fixed size.

For a size target, `displayDims` is the larger of the requested dimension and the
raster the decoder's clamp will actually produce. A target finer than the
coarsest level therefore resolves to the clamped level's native size rather than
shrinking it to the unreachable target, and a stream with a single resolution
(no reduction possible) is painted at native size. Only a genuine reduction is
upscaled, so `displayDims` never scales a decoded frame down.

---

## 9. Demo pages

Three standalone HTML pages, no build, sharing `emage.js`.

The only external code is `vendor/noble-sha3.js` — the MIT-licensed
`@noble/hashes` `sha3_256` (vendored verbatim, bundled by esm.sh). The uploader
uses it for local identity hashes (§8.3.1); everything crypto on the wire still
goes through the WASM modules. This was adopted after discovering `SubtleCrypto`
`SHA3-256` is unsupported in Firefox.

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
checkbox selects encrypted vs plaintext encoding and greys out the key input
when cleared. `layerInput` (resolution count; blank by default, meaning the
maximum the image allows, and clamped to the per-image range). Source and destination
canvases with a stage label. A **Random key** button fills the AES field with 32
random bytes. Server images are browsed as a virtual filesystem (folder
navigation, per-file thumbnails, refresh/open/delete), with **Upload current
J2K** alongside so upload and delete both act on the browsed listing. A **key
ring & image coverage** card (see §8.3.1) lists saved keys
with the images each one unlocks and per-file key badges. A sticky **derived-keys table** on the right (`keysPanel`/`keysBody`/
`copyKeysBtn`) listing one row per level — key, level index, the resolution it
resolves to, and the key material — with rows inside the current access grant
highlighted. All intermediate keys appear immediately after encoding, before
upload, and remain visible outside the highlighted grant. Integrity is not a column: MACs are verified on every decode and
are not something the user acts on.

### `downloader.html` — progressive viewer
Server URL/path and a granted key. No IV or key level needs to be entered.
Breadcrumb file browser.
Fetch meta; load full; load for a display size (`10vw` etc.). Canvas with stage
label showing each progressive level. Neither the IV nor the MACs are surfaced:
both are internal to the format and the decoder handles them. Every load reports
the decoded dimensions and protection in the status line — plaintext, or the
zone count and authenticated grant.

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
-sEXPORTED_RUNTIME_METHODS=HEAPU8,stackSave,stackRestore,getExceptionMessage,decrementExceptionRefcount
-sDISABLE_EXCEPTION_CATCHING=0  -O3
```

`-sDISABLE_EXCEPTION_CATCHING=0` is deliberate: C++ exceptions surface as
catchable JS errors instead of aborting the module, which keeps the page alive
when a decode rejects a partial window. The JS wrapper restores the WASM
stack and releases caught C++ exceptions so repeated invalid keys cannot
exhaust the stack.

A `POST_BUILD` step copies each `.js`/`.wasm` pair into
the server project’s `Emage/wwwroot/wasm/` directory, where the server publishes the assets.

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
| `test_progressive.mjs` | EmageClient | Live level selection, ordering, decode counting, incremental requests |
| `test_granular_keys.mjs` | EmageClient | Public API: chain, clamping, window, keys |
| `test_mac.js` | EmageWasm | Marker fields, MAC tampering, zone resizing |
| `test_mac_server.mjs` | EmageClient | MAC survives a live-server window |
| `test_random_iv.mjs` | EmageClient | Per-file IV, and no-IV decode |
| `test_chain.mjs` | EmageClient | Live-server roundtrip and reduced-window bandwidth |
| `test_key_metadata.mjs` | EmageClient | In-header lookup vectors, exact requests, wrong-key rejection |
| `test_preview.mjs` | EmageClient | Live automatic grants, progressive frames, exact packet requests |
| `test_cache_stale.mjs` | EmageClient | Re-upload refreshes bytes and header metadata together |
| `MetadataTests.cs` | Emage server | Generic COM metadata, both stream types, window preservation |

Fixtures: `encrypted.j2k`, `sample.lrcp.j2k`, `sample.rlcp.j2k`,
`sample.sop.j2k`, `sample.nopl.j2k`, `src.ppm`.

`test_granular.js` is the load-bearing one: it asserts a **pixel-exact**
matrix. For a 512×512/6-level image with granular keys, grants 0..5 must
reconstruct 16/32/64/128/256/512 px at reductions 5..0, and each grant's
windowed decode must be **byte-identical to the corresponding full-stream
decode**. That is what proves the SEC offsets, truncation, `Psot` patch and
reduction clamp all agree.

### 11.1 The server byte-arithmetic property

The serving layer drops `TLM`/`PLM`/`PPM` and `PLT`/`PPT` and rebuilds `SOT`
and `Psot` on every window, which shifts every absolute offset in the file.
`test_mac_server.mjs` proves the cumulative chain still verifies through all
six served windows of a 256×256/6-level image (554 B → 123812 B), because `Z`
and `T` are payload-relative and the whole SEC segment is copied verbatim. It
also uploads a **plaintext** control through the same path: the server reports
the same layer count, serves no SEC marker, and the image decodes — one
identical code path for both, with no encryption-awareness anywhere.

`test_mac.js` covers the negative cases: a flipped byte in any zone, a flipped
byte in the MAC table, and an altered zone `T` are each rejected, while
corruption above a coarser grant is correctly *not* detected.

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
- Cumulative SHA3-256 MAC per level, covering the level's bytes *and* its
  position, verified on every decode with a constant-time compare
- Counter block carried in the marker, drawn fresh per file, so a served window
  needs no out-of-band IV and two files never share a keystream
- Public API to list the derived keys as hex (`macs` and `iv` also come back from
  `upload()` for callers that want them; the UI shows neither)

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
- In-image COM key lookup maps with SHA3-256(IV || key) tags
- Automatic resolution detection before packet downloads
- Bounded packet windows for thumbnails and restricted keys
- Hex/byte coercion, validation, and typed error classes

**Demo UI**
- Encrypt-and-upload page with gallery management and key display
- Progressive viewer with breadcrumb browser and staged rendering
- Side-by-side transfer-strategy comparison with timing tables
- Encrypted/plaintext toggle on the uploader; per-load protection reporting on
  the downloader and comparison pages
- Derived-key table with the granted rows highlighted
