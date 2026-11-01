# Handoff — Emage, 2026-10-07

Context was condensed because this debugging session ran long and generated its
own problems. Read this first; everything needed to resume is here.

## What Emage is

Three repos, all pushed and in sync with origin/main:

| Repo | Local path | Remote |
|---|---|---|
| EmageWasm | `~/CLionProjects/EmageWasm` | `AutoVizz/Emage-Wasm` |
| EmageClient | `~/CLionProjects/EmageClient` | `AutoVizz/Emage-Client` |
| Emage (server) | `~/RiderProjects/Emage` | `AutoVizz/Emage-Server` |

The system stores JPEG 2000 codestreams as per-resolution-level encrypted zones.
One key per DWT level (`K0` = master, `K(i+1) = SHA3-256(K(i))`), cumulative
SHA3-256 MAC per level, IV random per file, all in the SEC marker. The server is
key-blind. See `DESIGN.md` in EmageClient — it is current and accurate.

## What is DONE and pushed

- `DESIGN.md` covering the whole stack.
- SEC marker reworked to the normative JPSEC tool block: `FF 65 | Lsec(16) |
  Zsec(16) | Psec(16, FPSEC|1) | ID(32)=0x80000002 | LZOI(16)=0 | LPID(16) | PID`
  where `PID = E(2) | IV(16) | zones(10E) | MACs(32E)`. Verified with the user
  against ISO/IEC 15444-8. User-defined tool range, `FPSEC=1`.
- Cumulative MAC chain `MAC[r] = SHA3-256(MAC[r-1] || K_r || r || Z_r || T_r ||
  plaintext[r])`, computed pre-encryption, verified on decode before truncation.
- IV random per encode via `crypto.getRandomValues`, carried in the marker;
  decoder treats the marker's IV as authoritative. Cross-file keystream reuse
  closed (was a real two-time-pad).
- `describeSecurityZone` returns `{hasSec, zoneCount, starts, sizes, macs, iv}`.
- `upload()` returns `granularKeys`, `macs`, `iv`, all gated on `hasSec`.
- Plaintext support: `enableSec` in `emage.js` and all three pages.
- Server bug fixed: `J2kImageLibrary.Invalidate()` on upload, so re-uploading to
  the same path no longer serves stale bytes (`fa582f0`, server tests 14/14).
- Both old-format files (`encrypted.j2k`, `slug.j2k`) deleted from the server
  store at the user's request.
- `setCrypto` now accepts `iv: null` / `key: null` as "unset" (was throwing).
- Decoder zone-range clamping (the OOB heap-write bug) fixed and tested.
- Nine suites all pass: `test_node.js`, `test_resolution.js`, `test_granular.js`,
  `test_mac.js` (EmageWasm); `test_granular_keys.mjs`, `test_progressive.mjs`,
  `test_random_iv.mjs`, `test_preview.mjs`, `test_mac_server.mjs`, `test_chain.mjs`
  (EmageClient).

## The ONE open bug

**In the user's browser only**, `Emage.init()` fails on the decoder with a C++
exception:

```
probe J2KEncoder : OK, exports = 6
probe J2KDecoder : FAILED typeof = object | raw = {"excPtr":24132}
```

Deterministic (same `excPtr` both times). Encoder instantiates fine. In a
headless Firefox (fresh profile, no extensions) everything works: INIT OK,
ENCODED, DECODED. So the decoder module is fine; the user's browser is the
variable, and the wallet extension (`window.ethereum` present in their console)
is the leading suspect. `Module` is NOT predefined on the page, WASM is
available, all four bundles fetch 200 with correct MIME, fetch is native.

## What to do next

1. Have the user hard-reload `http://localhost:8080/uploader.html` and paste the
   `[emage]` lines. The instrumentation now captures `printErr`/`onAbort` for
   the decoder, so the abort reason should be printed as:
   `[emage] probe J2KDecoder printErr: <the actual reason>`
2. That text is the root cause. Act on it.
3. **Remove all the temporary instrumentation** from `uploader.html` before
   calling this done (see below).

## Uncommitted working state — READ THIS BEFORE EDITING

- `emage.js` (+10/-3): the `setCrypto` null-iv fix. **Keep.** It is correct,
  tested, and was the probable original cause of the encode button never
  enabling. Commit it.
- `uploader.html` (+112/-2): **almost entirely temporary diagnostics** added to
  debug the above. `diag()` console logging, WASM availability probe, `Module`
  probe, HEAD probes, and the per-module probe that captures `printErr`. The
  `globalThis.Module` ReferenceError crash was just fixed. Do NOT commit this
  as-is; strip the instrumentation once the bug is known. The only intended
  permanent change in this file from this session is the earlier random-IV /
  hidden-IV work, already committed.

## How to run things

- Servers: API on `:3233` (Docker `emage-emage-1`, freshly rebuilt), client on
  `:8080` (`python3 -m http.server`, pid 14929, still running).
- WASM tests: `cd ~/CLionProjects/EmageWasm && node test_node.js` etc.
- Client tests: `cd ~/CLionProjects/EmageClient && EMAGE_PASSWORD="$(grep
  '^EMAGE_UPLOAD_PASSWORD=' ~/RiderProjects/Emage/.env | cut -d= -f2-)" node
  test_chain.mjs` (and the other .mjs files).
- Rebuild WASM: `source ~/emsdk/emsdk_env.sh && cmake --build
  ~/CLionProjects/EmageWasm/cmake-build-wasm -j4`. Needs the Emscripten
  toolchain; POST_BUILD copies bundles into `~/CLionProjects/EmageClient/wasm/`.
- Server tests: `cd ~/RiderProjects/Emage && DOTNET_ROOT=$HOME/.dotnet
  ~/.dotnet/dotnet test Emage.slnx -c Release`.
- Upload password is `EMAGE_UPLOAD_PASSWORD` in `~/RiderProjects/Emage/.env`.
  It is NOT bash-sourceable (parens in value); extract with grep + cut.

## Honest notes for the next instance

- Do not eval the Emscripten glue outside a script tag. It defines
  `globalThis.J2KEncoder` and makes `Emage.init()` reuse that instance, which
  produces exactly the confusing `CppException` we chased for hours.
- Do not read `.name`/`.message`/`.stack` off the rejection: Emscripten throws
  bare values, so those print `undefined`. Dump the raw value.
- A wallet extension in the console is just noise; it is not proof of the bug.
- The server listing returning 200 does not mean the gallery thumbnails render:
  stale files were the old SEC format and decoded as noise. They are deleted now.
