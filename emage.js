// One protected zone per DWT resolution level in the SEC marker, so the
// resolution pyramid is bounded by the size of that zone table.
const MAX_RESOLUTIONS = 64;
const METADATA_PREFIX = 'EMAGE-META\0';

function mainHeaderSegments(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0x4f) throw new EmageError('Missing SOC');
    const segments = [];
    for (let offset = 2; offset + 3 < bytes.length;) {
        if (bytes[offset] !== 0xff) throw new EmageError('Invalid main-header marker');
        if (bytes[offset + 1] === 0x90) return { segments, tile: offset };
        const length = bytes[offset + 2] << 8 | bytes[offset + 3];
        if (length < 2 || offset + length + 2 > bytes.length) throw new EmageError('Invalid main-header length');
        segments.push({ offset, length: length + 2, code: bytes[offset + 1] });
        offset += length + 2;
    }
    throw new EmageError('Missing SOT');
}

function isMetadataSegment(bytes, segment) {
    const start = segment.offset;
    if (segment.code !== 0x64 || segment.length < 6 + METADATA_PREFIX.length ||
        bytes[start + 4] !== 0 || bytes[start + 5] !== 0) return false;
    return [...METADATA_PREFIX].every((char, i) => bytes[start + 6 + i] === char.charCodeAt(0));
}

export class EmageError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'EmageError';
    }
}

export class EmageServerError extends EmageError {
    constructor(message, options) {
        super(message, options);
        this.name = 'EmageServerError';
    }
}

function hexToBytes(hex) {
    const t = String(hex).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (t.length % 2 !== 0) {
        throw new EmageError('hex string must have an even number of digits');
    }
    const bytes = new Uint8Array(t.length / 2);
    for (let i = 0; i < bytes.length; ++i) {
        bytes[i] = parseInt(t.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; ++i) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

function rgbaToRgb(rgba) {
    const rgb = new Uint8Array((rgba.length / 4) * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i];
        rgb[j + 1] = rgba[i + 1];
        rgb[j + 2] = rgba[i + 2];
    }
    return rgb;
}

function rgbaToGray(rgba) {
    const gray = new Uint8Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
        gray[j] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
    }
    return gray;
}

function parseJson(resp) {
    return resp.text().then((text) => {
        try { return JSON.parse(text); } catch (_) { return { raw: text }; }
    });
}

function injectScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new EmageError('Failed to load script: ' + src));
        document.head.appendChild(s);
    });
}

function defaultWasmBase() {
    try {
        return new URL('cmake-build-wasm/', import.meta.url).href;
    } catch (_) {
        return '/cmake-build-wasm/';
    }
}

async function instantiateWasm(name, file, { factory, url, wasmBase }) {
    let f = factory;
    if (f == null && typeof globalThis !== 'undefined') f = globalThis[name];
    if (f == null && typeof document !== 'undefined' && (url || wasmBase)) {
        const src = url || wasmBase + file;
        await injectScript(src);
        f = globalThis[name];
    }
    if (f == null) {
        throw new EmageError(
            `Cannot locate ${name}. Pass a factory/module to Emage.init(), define globalThis.${name}, or provide url/wasmBase.`);
    }
    if (typeof f !== 'function') return f;
    return await f(wasmBase ? { locateFile: (p) => wasmBase + p } : {});
}

// Normalize a display-size target to either "all" (fetch every layer) or a
// concrete pixel dimension. Targets may be raw numbers (interpreted as px),
// strings with px/vw/vh/% units, or the keywords "all"/"100%".
function resolveTarget(target) {
    if (target == null || target === '' || target === 'all' || target === '100%') {
        return { type: 'all', value: null };
    }
    const m = String(target).trim().match(/^([\d.]+)\s*(px|vw|vh|%)?$/i);
    if (!m) {
        throw new EmageError(
            `Invalid display target "${target}"; use pixels or units px, vw, vh, % ` +
            `(e.g. 100, '100px', '10vw')`);
    }
    const num = parseFloat(m[1]);
    const unit = (m[2] || 'px').toLowerCase();
    if (unit === 'vw') {
        const w = typeof window !== 'undefined' ? window.innerWidth : 0;
        if (!w) throw new EmageError('Cannot resolve a vw target without a window');
        return { type: 'px', value: w * num / 100 };
    }
    if (unit === 'vh') {
        const h = typeof window !== 'undefined' ? window.innerHeight : 0;
        if (!h) throw new EmageError('Cannot resolve a vh target without a window');
        return { type: 'px', value: h * num / 100 };
    }
    if (unit === '%') return { type: 'pct', value: num / 100 };
    return { type: 'px', value: num };
}

export class Emage {
    // Generic binary COM metadata; independent of SEC/encryption state.
    static readMetadata(bytes) {
        for (const segment of mainHeaderSegments(bytes).segments) {
            if (!isMetadataSegment(bytes, segment)) continue;
            try {
                const start = segment.offset + 6 + METADATA_PREFIX.length;
                const data = JSON.parse(new TextDecoder().decode(bytes.subarray(start, segment.offset + segment.length)));
                if (data && typeof data === 'object' && !Array.isArray(data)) return data;
            } catch (_) { /* unrelated or malformed comments do not supply metadata */ }
        }
        return null;
    }

    static withMetadata(bytes, metadata) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            throw new EmageError('Image metadata must be an object');
        }
        const { segments, tile } = mainHeaderSegments(bytes);
        const payload = new TextEncoder().encode(METADATA_PREFIX + JSON.stringify(metadata));
        if (payload.length + 4 > 65535) throw new EmageError('Image metadata exceeds one COM marker');
        const kept = segments.filter(segment => !isMetadataSegment(bytes, segment));
        const headerSize = 2 + kept.reduce((sum, segment) => sum + segment.length, 0);
        const out = new Uint8Array(headerSize + 6 + payload.length + bytes.length - tile);
        out.set([0xff, 0x4f]);
        let offset = 2;
        for (const segment of kept) {
            out.set(bytes.subarray(segment.offset, segment.offset + segment.length), offset);
            offset += segment.length;
        }
        out.set([0xff, 0x64, (payload.length + 4) >> 8, (payload.length + 4) & 255, 0, 0], offset);
        out.set(payload, offset + 6);
        out.set(bytes.subarray(tile), offset + 6 + payload.length);
        return out;
    }
    constructor(options = {}) {
        this.encoder = null;
        this.decoder = null;
        this.server = { baseUrl: '', imagePath: '', password: '' };
        // accessLevel is the highest DWT resolution level the caller may read,
        // counted coarse-first (0 = the 1-pixel approximation). The granular key
        // chain K0..K_accessLevel is derived backwards from K_accessLevel, so a smaller
        // number means a coarser, cheaper image.
        this.crypto = { key: null, iv: null, accessLevel: null };
        this.j2k = null;
        this.progress = null;
    }

    static async init(options = {}) {
        const wasmBase = options.wasmBase != null ? options.wasmBase : defaultWasmBase();
        const encoder = await instantiateWasm('J2KEncoder', 'EmageWasmEncoder.js', {
            factory: options.encoder,
            url: options.encoderUrl,
            wasmBase,
        });
        const decoder = await instantiateWasm('J2KDecoder', 'EmageWasmDecoder.js', {
            factory: options.decoder,
            url: options.decoderUrl,
            wasmBase,
        });
        const emage = new Emage(options);
        emage.encoder = encoder;
        emage.decoder = decoder;
        return emage;
    }

    static hexToBytes(hex) { return hexToBytes(hex); }
    static bytesToHex(bytes) { return bytesToHex(bytes); }

    static messageOf(err) {
        if (typeof err === 'string') return err;
        if (err && typeof err.message === 'string' && err.message !== '[object Object]') return err.message;
        if (err && typeof err.cause === 'string') return err.cause;
        try { return JSON.stringify(err); } catch (_) { return String(err); }
    }

    static readBytes(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = () => reject(new EmageError('Failed to read file: ' + file.name));
            reader.readAsArrayBuffer(file);
        });
    }

    // Layer count is caller policy: the library only validates that an explicit
    // numLayers is a positive integer. omitting it leaves the native encoder's
    // own default (2) in effect — the library never picks a number.
    _layerCount(v) {
        if (v == null || v === '') return undefined;
        const n = typeof v === 'number' ? v : parseInt(String(v), 10);
        if (!Number.isFinite(n) || n < 1) {
            throw new EmageError('numLayers must be a positive integer');
        }
        return Math.floor(n);
    }

    setServer(config = {}) {
        if (config.baseUrl !== undefined) this.server.baseUrl = String(config.baseUrl).trim();
        if (config.imagePath !== undefined) this.server.imagePath = String(config.imagePath).trim();
        if (config.password !== undefined) this.server.password = String(config.password).trim();
        return this;
    }

    // Configure encryption.
    //
    //   key         32-byte AES-256 key (hex string, array, or Uint8Array).
    //               Encoding uses the finest/master key. Decoding authenticates
    //               the supplied key's level automatically using the MACs.
    //   iv          16-byte counter block
    //   accessLevel highest DWT resolution level this caller may read, counted
    //               coarse-first: 0 is the 1-pixel approximation, and the finest
    //               level is `numResolutions - 1`. Use 'all' or -1 to decode
    //               through the automatically detected key level. Defaults to -1.
    //
    // K(E-1) is the master key and K(m-1) = SHA3-256(Km). A recipient
    // holding Ka derives K(a-1)..K0 and reconstructs level a, without any
    // finer keys. The chain is derived locally and never sent to the server.
// null means "unset" for key and iv, mirroring how the encoder treats a null
// iv as the unencrypted path. Coercing null through _toBytes would throw, which
// turned a missing optional value into a hard failure for the caller.
setCrypto(config = {}) {
    if (config.key !== undefined) {
        this.crypto.key = config.key === null ? null : this._toBytes(config.key, 'key');
    }
    if (config.iv !== undefined) {
        this.crypto.iv = config.iv === null ? null : this._toBytes(config.iv, 'iv');
    }
        // `levels` was the old cascade-round count and is no longer meaningful:
        // every level is now its own protected zone under its own derived key.
        const level = config.accessLevel ?? config.levels;
        if (level !== undefined && level !== null) {
            this.crypto.accessLevel = this._accessLevel(level);
        }
        return this;
    }

    // Accept a resolution level index, or the string "all" for every level.
    _accessLevel(value) {
        if (value === 'all' || value === -1) return -1;
        if (!Number.isInteger(value) || value < 0) {
            throw new EmageError('accessLevel must be a non-negative integer, "all", or -1');
        }
        return value;
    }

    resetProgressive() {
        this.progress = null;
        return this;
    }

    _toBytes(value, name) {
        if (value instanceof Uint8Array) return value;
        if (Array.isArray(value) || ArrayBuffer.isView(value)) return new Uint8Array(value);
        if (typeof value === 'string') return hexToBytes(value);
        throw new EmageError(`${name} must be a hex string, array, or Uint8Array`);
    }

    // AES-256 key: 32 bytes, whatever access level is configured.
    _bytesKey(value, name) {
        if (value == null || value.length === 0) {
            throw new EmageError(`${name} is required (AES-256: exactly 32 bytes)`);
        }
        const bytes = this._toBytes(value, name);
        if (bytes.length !== 32) {
            throw new EmageError(`${name} must be exactly 32 bytes (got ${bytes.length})`);
        }
        return bytes;
    }

    _bytesIv(value, name) {
        if (value == null || value.length === 0) {
            throw new EmageError(`${name} is required (AES-256: exactly 16 bytes)`);
        }
        const bytes = this._toBytes(value, name);
        if (bytes.length !== 16) {
            throw new EmageError(`${name} must be exactly 16 bytes (got ${bytes.length})`);
        }
        return bytes;
    }

    // Number of readable resolution levels implied by an access level, or null
    // when the caller asked for every level.
    _levels(value) {
        if (Number.isInteger(value) && value >= 0) return value;
        return null;
    }

    // The granular key chain as lowercase hex strings, K0 first.
    // The configured key is the highest key in the requested chain:
    // result[count - 1] = key; result[i - 1] = SHA3-256(result[i]).
    //
    // `count` defaults to the number of levels the current access level grants
    // (accessLevel + 1). It has no default for accessLevel 'all' / -1: the number
    // of levels in the file is not known until the server reports it, so pass one
    // explicitly — `upload()` does this with the `layers` value from its result.
    // To list every file key, configure the master and pass the file's full
    // level count. Increasing count with a restricted key cannot recover any
    // finer file keys. The result is not transmitted anywhere.
    granularKeys(count) {
        if (!this.encoder) throw new EmageError('Encoder module not initialized');
        const key = this._bytesKey(this.crypto.key, 'key');
        if (count == null) {
            const grant = this.crypto.accessLevel;
            if (grant == null || grant < 0) {
                throw new EmageError(
                    'granularKeys needs a level count: with accessLevel "all" the file\'s resolution ' +
                    'count is not known here (pass one, e.g. the `layers` value from an upload result)');
            }
            count = grant + 1;
        }
        const n = this._levels(count);
        if (n == null || n < 1) throw new EmageError('granularKeys needs a level count');
        return this.encoder.deriveGranularKeys(key, Math.min(n, 64));
    }

    _message(err) {
        for (const mod of [this.encoder, this.decoder]) {
            if (!mod || typeof mod.getExceptionMessage !== 'function') continue;
            try {
                const m = mod.getExceptionMessage(err);
                const s = typeof m === 'string' ? m : m && m.length ? (m[1] || m[0]) : null;
                if (s) return s;
            } catch (_) { /* ignore */ }
        }
        return Emage.messageOf(err);
    }

    _imageUrl() {
        const base = String(this.server.baseUrl || '').replace(/\/+$/, '');
        return base + '/image/' + this.server.imagePath;
    }

    keyLookupTag(key, iv) {
        const mod = this.encoder || this.decoder;
        if (!mod || typeof mod.keyLookupTag !== 'function') {
            throw new EmageError('Reload the page to load the key lookup helper');
        }
        return mod.keyLookupTag(this._bytesKey(key, 'key'), this._bytesIv(iv, 'iv'));
    }

    _withKeyMap(stream, key, iv, count) {
        const keys = this.encoder.deriveGranularKeys(this._bytesKey(key, 'key'), count);
        const levels = Object.fromEntries(keys.map((k, level) => [this.keyLookupTag(k, iv), level]));
        return Emage.withMetadata(stream, {
            ...(Emage.readMetadata(stream) || {}),
            keyMap: { iv: bytesToHex(this._bytesIv(iv, 'iv')), levels },
        });
    }

    _decoderFailure(err, stack) {
        const dec = this.decoder;
        if (stack != null) dec.stackRestore(stack);
        let message = Emage.messageOf(err);
        if (err && err.excPtr && typeof dec.getExceptionMessage === 'function') {
            try {
                const detail = dec.getExceptionMessage(err);
                message = typeof detail === 'string' ? detail : detail[1] || detail[0];
            } finally {
                dec.decrementExceptionRefcount(err);
            }
        }
        return new EmageError(message);
    }

    _identifyKeyLevel(stream, rawKey) {
        const dec = this.decoder;
        if (!dec || typeof dec.identifyKeyLevel !== 'function') {
            throw new EmageError('Reload the page to load the decoder with automatic key detection');
        }
        const key = rawKey != null && rawKey.length ? this._bytesKey(rawKey, 'key') : null;
        const ptr = dec._malloc(stream.length);
        const stack = typeof dec.stackSave === 'function' ? dec.stackSave() : null;
        try {
            dec.HEAPU8.set(stream, ptr);
            return dec.identifyKeyLevel(ptr, stream.length, key);
        } catch (err) {
            throw this._decoderFailure(err, stack);
        } finally {
            dec._free(ptr);
        }
    }

    decode(stream, opts = {}) {
        if (!this.decoder) throw new EmageError('Decoder module not initialized');
        if (!stream || !stream.length) throw new EmageError('Cannot decode an empty codestream');
        // Polymorphic crypto: an unset or empty key/IV selects the unencrypted
        // flow and is passed as null — the native decoder only requires a key
        // and IV for codestreams that actually carry a SEC marker.
        const rawKey = opts.key ?? this.crypto.key;
        const rawIv = opts.iv ?? this.crypto.iv;
        const key = (rawKey != null && rawKey.length) ? this._bytesKey(rawKey, 'key') : null;
        const iv = (rawIv != null && rawIv.length) ? this._bytesIv(rawIv, 'iv') : null;
        // Optional resolution ceiling, coarse-first. -1 automatically uses the
        // supplied key's authenticated level. The native side clamps reduction to what
        // this grant can actually reconstruct, so a finer ask is never honoured
        // with a fabricated image.
        const accessLevel = this._accessLevel(
            opts.accessLevel ?? opts.levels ?? this.crypto.accessLevel ?? -1);
        // Number of DWT halvings the decoder should apply. 0 is the full
        // resolution; n decodes only the n-th coarsest resolution level, so the
        // decoder never materializes the finer subbands. The native side clamps
        // this to the codestream's decomposition count and reports both the
        // clamped value and the count back, so an out-of-range value is not an
        // error and callers never have to guess the decomposition depth.
        const reduction = Math.max(0, Math.trunc(opts.reduction) || 0);
        const dec = this.decoder;
        const ptr = dec._malloc(stream.length);
        try {
            dec.HEAPU8.set(stream, ptr);
            const stack = typeof dec.stackSave === 'function' ? dec.stackSave() : null;
            try {
                const out = dec.decodeRaw(ptr, stream.length, key, iv, accessLevel, reduction);
                if (stream.expectedKeyLevel != null && out.keyLevel !== stream.expectedKeyLevel) {
                    throw new EmageError('Image lookup metadata disagrees with the authenticated key level');
                }
                return {
                    width: out.width,
                    height: out.height,
                    numComponents: out.numComponents,
                    rgbaPixels: out.rgbaPixels,
                    reduction: out.reduction != null ? out.reduction : reduction,
                    numResolutions: out.numResolutions || 0,
                    keyLevel: out.keyLevel ?? -1,
                };
            } catch (err) {
                // A C++ exception crossing into JS leaves the WASM stack to
                // the caller. Restore it so rejected grants cannot exhaust it.
                throw this._decoderFailure(err, stack);
            }
        } finally {
            dec._free(ptr);
        }
    }

    decodeToCanvas(canvas, stream, opts = {}) {
        const result = this.decode(stream, opts);
        this.paintTo(canvas, result);
        return result;
    }

    // Paint a decoded frame. When dims is given the frame is scaled into those
    // canvas dimensions with high-quality smoothing instead of being painted at
    // the decoded resolution; passing no dims paints at native size.
    paintTo(canvas, result, dims) {
        if (!dims) {
            canvas.width = result.width;
            canvas.height = result.height;
            canvas.getContext('2d').putImageData(
                new ImageData(result.rgbaPixels, result.width, result.height), 0, 0);
            return;
        }
        canvas.width = dims.width;
        canvas.height = dims.height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (result.width === dims.width && result.height === dims.height) {
            ctx.putImageData(
                new ImageData(result.rgbaPixels, result.width, result.height), 0, 0);
            return;
        }
        const tmp = document.createElement('canvas');
        tmp.width = result.width;
        tmp.height = result.height;
        tmp.getContext('2d').putImageData(
            new ImageData(result.rgbaPixels, result.width, result.height), 0, 0);
        ctx.drawImage(tmp, 0, 0, dims.width, dims.height);
    }

    // Report the per-resolution protection a codestream declares, without
    // decrypting it: `zoneCount` zones (one per DWT resolution level, coarse
    // first), each `starts[i]` bytes into the packet payload and `sizes[i]`
    // bytes long. `hasSec` is 0 for an unencrypted stream.
    //
    // Also returns the counter block carried in the marker (`iv`, 16 bytes) and
    // the cumulative per-level MACs (`macs`, a flat zoneCount*32 array). A
    // reader holding K0..Ka can recompute the chain up to level a and compare it
    // against macs[a], which transitively authenticates every coarser level. The
    // decoder does that automatically; these are for display and for a caller
    // that wants to verify before decoding.
    describeSecurityZone(stream) {
        if (!this.decoder) throw new EmageError('Decoder module not initialized');
        if (!stream || !stream.length) {
            return { hasSec: 0, zoneCount: 0, starts: [], sizes: [], macs: [], iv: null };
        }
        const dec = this.decoder;
        const ptr = dec._malloc(stream.length);
        try {
            dec.HEAPU8.set(stream, ptr);
            const z = dec.describeSecurityZone(ptr, stream.length);
            return {
                hasSec: z.hasSec,
                zoneCount: z.zoneCount,
                // The native side leaves starts/sizes null whenever there is no
                // SEC marker -- which is every plaintext codestream, not just an
                // empty buffer -- so normalise here instead of trusting the
                // arrays. Array.from(null) throws.
                starts: z.starts ? Array.from(z.starts) : [],
                sizes: z.sizes ? Array.from(z.sizes) : [],
                macs: z.macs ? Array.from(z.macs) : [],
                iv: z.iv ? Array.from(z.iv) : null,
            };
        } finally {
            dec._free(ptr);
        }
    }

    encodePixelData(pixels, width, height, opts = {}) {
        if (!this.encoder) throw new EmageError('Encoder module not initialized');
        if (!pixels || !pixels.length) throw new EmageError('No pixel data to encode');
        if (width <= 0 || height <= 0) throw new EmageError('width and height must be positive');

        const expected1 = width * height;
        const expected3 = width * height * 3;
        const expected4 = width * height * 4;

        let numComponents = opts.numComponents;
        let data = pixels;
        if (numComponents == null) {
            if (pixels.length === expected4) { numComponents = 3; data = rgbaToRgb(pixels); }
            else if (pixels.length === expected3) numComponents = 3;
            else if (pixels.length === expected1) numComponents = 1;
            else {
                throw new EmageError(
                    `Pixel buffer size ${pixels.length} does not match width*height*1/3/4 ` +
                    `(${expected1}/${expected3}/${expected4})`);
            }
        } else if (numComponents === 1) {
            if (pixels.length === expected4) data = rgbaToGray(pixels);
            else if (pixels.length !== expected1) {
                throw new EmageError('Grayscale buffer must be width*height bytes');
            }
        } else if (numComponents === 3) {
            if (pixels.length === expected4) data = rgbaToRgb(pixels);
            else if (pixels.length !== expected3) {
                throw new EmageError('RGB buffer must be width*height*3 bytes');
            }
        } else {
            throw new EmageError('numComponents must be 1 or 3');
        }

        const encOpts = {
            width,
            height,
            numComponents,
            precision: opts.precision ?? 8,
            lossless: opts.lossless ?? true,
            numResolutions: opts.numResolutions ?? 6,
            enablePterm: opts.enablePterm ?? false,
            enableSegsym: opts.enableSegsym ?? false,
            enableSop: opts.enableSop ?? false,
            enableEph: opts.enableEph ?? false,
            enableTlm: opts.enableTlm ?? true,
            enableSec: opts.enableSec ?? true,
        };
        // Same required-field rule as key/iv below: the binding declares
        // numLayers as required, so it must always be present. The encoder only
        // ever writes one lossless quality layer, so 1 is the honest value.
        const numLayers = this._layerCount(opts.numLayers);
        encOpts.numLayers = numLayers != null ? numLayers : 1;
        // One protected zone per resolution level, so the SEC marker's zone table
        // caps the pyramid at 64 levels. Checked here to fail with a useful message
        // instead of the binding's generic range error.
        if (!Number.isInteger(encOpts.numResolutions) ||
            encOpts.numResolutions < 1 || encOpts.numResolutions > MAX_RESOLUTIONS) {
            throw new EmageError(
                `numResolutions must be between 1 and ${MAX_RESOLUTIONS} ` +
                `(got ${encOpts.numResolutions})`);
        }
        // key/iv are always present in the options object. The binding declares
        // them as required fields, so omitting them entirely throws "Missing
        // field" rather than meaning "unencrypted"; null is what selects the
        // unencrypted path.
        encOpts.key = encOpts.enableSec ? this._bytesKey(opts.key ?? this.crypto.key, 'key') : null;
        encOpts.iv = encOpts.enableSec ? this._bytesIv(opts.iv ?? this.crypto.iv, 'iv') : null;

        const enc = this.encoder;
        const ptr = enc._malloc(data.length);
        try {
            enc.HEAPU8.set(data, ptr);
            try {
                let j2k = enc.encodeRaw(ptr, data.length, encOpts);
                if (encOpts.enableSec) {
                    j2k = this._withKeyMap(j2k, encOpts.key, encOpts.iv, encOpts.numResolutions);
                }
                this.j2k = j2k;
                return j2k;
            } catch (err) {
                throw new EmageError('Encoding error: ' + this._message(err), { cause: err });
            }
        } finally {
            enc._free(ptr);
        }
    }

    encodeCanvas(canvas, opts = {}) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return this.encodePixelData(imageData.data, canvas.width, canvas.height, opts);
    }

    async _fetchWindow(spec) {
        const resp = await fetch(this._imageUrl(), { headers: { 'X-Emage-Layers': spec } });
        const body = await resp.arrayBuffer();
        if (!resp.ok) {
            let text = '';
            try { text = new TextDecoder().decode(body); } catch (_) { /* ignore */ }
            throw new EmageServerError('HTTP ' + resp.status + ' ' + text.trim());
        }
        const offsets = resp.headers?.get('X-Emage-TilePsotOffsets');
        const bytes = new Uint8Array(body);
        bytes.packetRequests = 1;
        bytes.transferredBytes = bytes.length;
        return {
            bytes,
            psotOffsets: offsets ? offsets.split(',').map(Number) : [],
            total: Number(resp.headers?.get('X-Emage-TotalLayers')) || 0,
        };
    }

    // Fetch level 0 to identify the key, then only the additional packets
    // needed for the requested size. The coarsest packets are reused.
    async _stream(opts = {}) {
        const ceiling = this._accessLevel(opts.accessLevel ?? opts.levels ?? this.crypto.accessLevel ?? -1);
        const reduction = Math.max(0, Math.trunc(opts.reduction) || 0);
        const meta = opts.meta || await this.meta();
        let total = meta.layers || meta.numResolutions || 0;
        const rawKey = opts.key ?? this.crypto.key;
        const map = meta.metadata?.keyMap;
        if (map) {
            if (!total || !map.levels || typeof map.levels !== 'object' || Array.isArray(map.levels)) {
                throw new EmageError('Invalid key lookup metadata');
            }
            const tag = this.keyLookupTag(rawKey, map.iv);
            const keyLevel = Object.hasOwn(map.levels, tag) ? map.levels[tag] : null;
            if (!Number.isInteger(keyLevel) || keyLevel < 0 || keyLevel >= total) {
                throw new EmageError('Key does not match the image lookup metadata');
            }
            let last = Math.min(keyLevel, Math.max(0, total - 1 - reduction));
            if (ceiling >= 0) last = Math.min(last, ceiling);
            const result = await this._fetchWindow('0:' + last);
            result.bytes.availableLevel = last;
            result.bytes.expectedKeyLevel = keyLevel;
            return result.bytes;
        }
        if (!rawKey || !rawKey.length) {
            const last = total ? Math.max(0, total - 1 - reduction) : -1;
            const limit = ceiling < 0 ? last : last < 0 ? ceiling : Math.min(ceiling, last);
            const result = await this._fetchWindow(limit < 0 || limit === total - 1 ? 'all' : '0:' + limit);
            result.bytes.availableLevel = limit;
            return result.bytes;
        }
        const coarse = await this._fetchWindow('0:0');
        const keyLevel = this._identifyKeyLevel(coarse.bytes, rawKey);
        const zones = this.describeSecurityZone(coarse.bytes);
        total = zones.hasSec ? zones.zoneCount : total || coarse.total;
        if (!total) total = (await this.meta()).layers;
        if (!total) throw new EmageError('Cannot determine the resolution count for a partial download');
        let last = Math.max(0, total - 1 - reduction);
        if (keyLevel >= 0) last = Math.min(last, keyLevel);
        if (ceiling >= 0) last = Math.min(last, ceiling);
        if (last === 0) {
            coarse.bytes.availableLevel = 0;
            return coarse.bytes;
        }
        // Emage's encrypted streams use one tile. For other codestreams,
        // request the needed prefix with its own framing instead of guessing.
        if (coarse.psotOffsets.length !== 1) {
            const result = await this._fetchWindow('0:' + last);
            result.bytes.availableLevel = last;
            result.bytes.packetRequests = 2;
            result.bytes.transferredBytes += coarse.bytes.length;
            return result.bytes;
        }
        const rest = await this._fetchWindow('1:' + last);
        const prefix = coarse.bytes;
        if (prefix.length < 2 || prefix[prefix.length - 2] !== 0xff || prefix[prefix.length - 1] !== 0xd9) {
            throw new EmageError('Coarsest window is missing EOC');
        }
        const combined = new Uint8Array(prefix.length + rest.bytes.length);
        combined.set(prefix.subarray(0, prefix.length - 2));
        combined.set(rest.bytes, prefix.length - 2);
        combined.set([0xff, 0xd9], combined.length - 2);
        const offset = coarse.psotOffsets[0];
        if (!Number.isInteger(offset) || offset < 6 || offset + 4 > prefix.length - 2) {
            throw new EmageError('Invalid tile framing offset');
        }
        const view = new DataView(combined.buffer);
        view.setUint32(offset, view.getUint32(offset) + rest.bytes.length);
        combined.availableLevel = last;
        combined.packetRequests = 2;
        combined.transferredBytes = prefix.length + rest.bytes.length;
        return combined;
    }

    async meta() {
        const resp = await fetch(this._imageUrl(), { headers: { 'X-Emage-Layers': 'meta' } });
        const data = await parseJson(resp);
        if (!resp.ok) {
            throw new EmageServerError('HTTP ' + resp.status + ' ' + JSON.stringify(data));
        }
        return data;
    }

    async list() {
        const base = String(this.server.baseUrl || '').replace(/\/+$/, '');
        const resp = await fetch(base + '/images');
        const data = await parseJson(resp);
        if (!resp.ok) {
            throw new EmageServerError('HTTP ' + resp.status + ' ' + JSON.stringify(data));
        }
        return data;
    }

    // Upload a codestream and return the server's response, enriched with the
    // granular keys.
    //
    // `granularKeys` on the returned object is an array of hex strings, one per
    // DWT resolution level (coarse-first), derived in this browser from the
    // master key. It is attached client-side after the round trip — the server
    // never receives or returns key material, since the bytes were encrypted
    // before upload. It is null when no master key is configured or the stream
    // carries no SEC marker.
    async upload(j2k, opts = {}) {
        let data = j2k || this.j2k;
        if (!data) throw new EmageError('Nothing to upload — encode an image first.');
        if (!data.length || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
            throw new EmageError('Refusing to upload: buffer does not end with EOC (not a full codestream).');
        }
        // Files encoded through this client already have the lookup header.
        // Add it to imported native encodes only when the master is available.
        const security = this.describeSecurityZone(data);
        if (security.hasSec && this.crypto.key && !Emage.readMetadata(data)?.keyMap &&
            this._identifyKeyLevel(data, this.crypto.key) === security.zoneCount - 1) {
            const original = data;
            data = this._withKeyMap(data, this.crypto.key, security.iv, security.zoneCount);
            if (original === this.j2k) this.j2k = data;
        }
        const resp = await fetch(this._imageUrl(), {
            method: 'POST',
            headers: {
                'X-Emage-Password': opts.password ?? this.server.password,
                // Declared per the OpenAPI upload contract. The server ignores the
                // value, but sending a body without a Content-Type makes the browser
                // default it to text/plain, which is a lie about the bytes on the wire.
                'Content-Type': 'image/jp2',
            },
            body: data,
        });
        const out = await parseJson(resp);
        if (!resp.ok) {
            throw new EmageServerError('HTTP ' + resp.status + ' ' + JSON.stringify(out));
        }
        this.progress = null;
        // The per-resolution keys are derived here, client-side, and attached to
        // the response so a caller can save or distribute them. They are never
        // sent to the server: the codestream was encrypted before upload and the
        // server only ever saw ciphertext.
        // The per-resolution keys describe an encrypted codestream, so only
        // report them when this one actually carries a SEC marker. A plaintext
        // stream has no zones to list, even when a master key is configured for
        // the rest of the session.
        out.granularKeys = null;
        out.macs = null;
        out.iv = null;
        if (this.crypto.key && this.crypto.key.length) {
            let zones = null;
            try {
                zones = this.describeSecurityZone(data);
            } catch (_) {
                zones = null;
            }
            if (zones && zones.hasSec) {
                out.iv = zones.iv ? bytesToHex(zones.iv) : null;
                // One cumulative tag per level, as hex, aligned with the keys:
                // macs[i] is what a holder of K0..Ki can verify.
                out.macs = zones.macs.length === zones.zoneCount * 32
                    ? Array.from({ length: zones.zoneCount }, (_, i) =>
                        bytesToHex(zones.macs.slice(i * 32, i * 32 + 32)))
                    : null;
                try {
                    out.granularKeys = this.granularKeys(zones.zoneCount);
                } catch (_) {
                    // A non-granular or unreadable stream simply reports no keys.
                    out.granularKeys = null;
                }
            }
        }
        return out;
    }

    async remove(opts = {}) {
        const resp = await fetch(this._imageUrl(), {
            method: 'DELETE',
            headers: { 'X-Emage-Password': opts.password ?? this.server.password },
        });
        if (resp.status === 401) {
            throw new EmageServerError('unauthorized (HTTP 401): check the password / server config');
        }
        const out = await parseJson(resp);
        if (!resp.ok) {
            throw new EmageServerError('HTTP ' + resp.status + ' ' + JSON.stringify(out));
        }
        this.progress = null;
        return out;
    }

    // Decode the codestream at a descending series of DWT resolution levels.
    //
    // Fetch only the needed prefix of resolution packets, then reuse it for
    // each progressive decode. A reduced target saves bandwidth and decoding
    // work. Progressive frames add work relative to one-shot decoding, while
    // giving the viewer a coarse image before the final frame.
    async _loadResolutions(reduction, opts = {}, meta) {
        if (!meta) meta = await this.meta();
        const stream = await this._stream({ ...opts, reduction, meta });
        if (stream.availableLevel >= 0) opts = { ...opts, accessLevel: stream.availableLevel };
        const progressive = opts.progressive !== false;

        // The codestream's decomposition count caps the useful range, and only
        // the decoder knows it. Prefer the server's declaration, but do not
        // require it. A progressive pass has to know the bound before it can
        // choose where to start, so when the server is silent it probes: a
        // reduction far past any real codestream is clamped to the coarsest
        // level, which makes the probe the cheapest possible decode and hands
        // back the count. Without the bound the loop would instead overshoot
        // and re-decode a level the native side clamps away. A one-shot decode
        // never needs the bound, so it never probes -- it just lets the native
        // side clamp and takes the value the decoder reports back.
        const requested = Math.max(0, Math.trunc(reduction) || 0);
        // 'layers' is the server's count of DWT resolution levels (see openapi.yaml
        // MetaResponse). This project does not use JPEG 2000 quality layers, so that
        // is the only progression bound the server reports. numResolutions is kept as
        // an alias so a caller that already carries the count from elsewhere does not
        // trigger a probe.
        let numResolutions = meta.layers || meta.numResolutions || 0;
        let probe = null;
        if (!numResolutions && progressive) {
            probe = this.decode(stream, { ...opts, reduction: 31 });
            numResolutions = probe.numResolutions || 0;
        }
        // Unknown (0) means no bound; a declared count of 1 means a flat
        // codestream whose only valid reduction is 0.
        const maxReduction = numResolutions > 0 ? numResolutions - 1 : Infinity;
        let end = Math.min(requested, maxReduction);
        const early = Math.max(0, Math.trunc(opts.previewSteps ?? 2));
        let start = end;
        if (progressive) {
            start = !Number.isFinite(maxReduction) ? end + early
                // Climbing to full resolution is the classic progressive
                // experience, so start at the coarsest level. For a reduced
                // target, start a few levels early instead, skipping the ones
                // the target does not need.
                : end === 0 ? maxReduction
                : Math.min(end + early, maxReduction);
        }

        const steps = [];
        // Count real decoder invocations, not frames. A discovery decode is
        // counted whether or not its level is reused, so the figure stays honest.
        // Reuse only happens when the probe's level is the one the loop starts
        // at; widening the sequence to include it just to save the decode would
        // paint a frame smaller than previewSteps asked for, so the probe can
        // legitimately go unused.
        let decodes = probe ? 1 : 0;
        let probeUsed = false;
        for (let r = start; r >= end; --r) {
            // The probe already decoded the coarsest level; reuse it rather
            // than paying for the identical decode twice.
            let decoded;
            if (!probeUsed && probe && probe.reduction === r) {
                decoded = probe;
                probeUsed = true;
            } else {
                decoded = this.decode(stream, { ...opts, reduction: r });
                ++decodes;
            }
            if (decoded.keyLevel >= 0) {
                const ceiling = opts.accessLevel ?? opts.levels ?? this.crypto.accessLevel ?? -1;
                const granted = ceiling === 'all' || ceiling < 0
                    ? decoded.keyLevel : Math.min(ceiling, decoded.keyLevel);
                end = Math.max(end, decoded.numResolutions - 1 - granted);
                start = Math.max(start, end);
                // A one-shot request finer than its key was already clamped.
                if (r < end) r = end;
            }
            if (opts.canvas) this.paintTo(opts.canvas, decoded, opts.displayDims);
            const isLast = r === end;
            const st = {
                layer: steps.length + 1,
                // Kept for onLayer compatibility; the count is the number of
                // steps actually performed, which is only final once the last
                // step has run.
                totalLayers: progressive ? start - end + 1 : 1,
                reduction: decoded.reduction != null ? decoded.reduction : r,
                complete: isLast,
                assembledBytes: stream.length,
                appendedBytes: 0,
                pixels: decoded.width * decoded.height,
                width: decoded.width,
                height: decoded.height,
                decoded,
            };
            steps.push(st);
            if (typeof opts.onLayer === 'function') {
                opts.onLayer({
                    layer: st.layer,
                    totalLayers: st.totalLayers,
                    complete: st.complete,
                    assembledBytes: stream.length,
                    reduction: st.reduction,
                    width: decoded.width,
                    height: decoded.height,
                });
            }
            // Yield to the browser's renderer after each paint so every frame is
            // actually shown, not coalesced away into the final one.
            if (opts.canvas && !isLast) await this._yieldForPaint();
        }
        const last = steps[steps.length - 1];
        return {
            meta,
            steps,
            decoded: last.decoded,
            stream,
            reduction: last.reduction,
            numResolutions: numResolutions || last.decoded.numResolutions || 0,
            transferredBytes: stream.transferredBytes ?? stream.length,
            httpRequests: 1 + (stream.packetRequests ?? 1), // metadata + packet requests
            decodes,
            complete: true,
        };
    }

    // Fetch the codestream and decode the coarsest resolution level that still
    // carries a usable thumbnail.
    async preview(opts = {}) {
        const meta = await this.meta();
        const reduction = this._minResolutionForSize(opts.thumbSize ?? 160, meta);
        const out = await this._loadResolutions(reduction, { ...opts, progressive: false }, meta);
        return { ...out, kind: 'preview' };
    }

    // Fetch the codestream and decode every resolution level, coarsest first.
    async playAll(opts = {}) {
        return this.display('all', opts);
    }

    // Fetch the codestream and decode only the resolution levels needed to
    // render at the requested display size, painting (and optionally yielding
    // after) each one when opts.canvas is given.
    // target: px number, '100px', '10vw', '30vh', '50%', or 'all'/'100%'.
    async display(target, opts = {}) {
        const spec = resolveTarget(target);
        const meta = await this.meta();
        let targetDim = null;
        let reduction = 0;
        let displayDims = null;
        if (spec.type !== 'all') {
            targetDim = spec.type === 'pct'
                ? Math.max(meta.width, meta.height) * spec.value
                : spec.value;
            reduction = this._minResolutionForSize(targetDim, meta);
            const fullW = meta.width || 0;
            const fullH = meta.height || 0;
            const fullDim = Math.max(fullW, fullH);
            if (fullW && fullH && fullDim > targetDim) {
                const scale = targetDim / fullDim;
                displayDims = {
                    width: Math.max(1, Math.round(fullW * scale)),
                    height: Math.max(1, Math.round(fullH * scale)),
                };
            }
        }
        // Resolution selection limits the pixels we decode; paint into the
        // requested display dimensions so arbitrary sizes (for example 200px)
        // do not leave the canvas at the nearest power-of-two DWT size.
        if (displayDims) opts = { ...opts, displayDims };
        const out = await this._loadResolutions(reduction, opts, meta);
        const decoded = out.decoded;
        return {
            ...out,
            target,
            // Based on what the decoder actually applied, not what was asked
            // for: a codestream with fewer levels than requested clamps to
            // full resolution and should not claim otherwise.
            loadMode: out.reduction > 0 ? 'size' : 'full',
            targetDimension: targetDim != null ? Math.round(targetDim) : null,
            displaySize: decoded ? {
                width: displayDims?.width ?? decoded.width,
                height: displayDims?.height ?? decoded.height,
            } : null,
            decodedSize: decoded ? { width: decoded.width, height: decoded.height } : null,
            fullDimension: Math.max(meta.width, meta.height),
            loadedLayers: out.steps.length,
            totalLayers: out.steps.length,
        };
    }

    // How many DWT halvings bring the image down to a display size. Rounding up
    // lands on the coarsest level that is still at or below the target, so the
    // decoded raster is never more than 2x the target's area. Rounding down
    // instead would guarantee an upscale, or cost 4x the samples decoding a level
    // twice as large and letting the browser throw three quarters of it away.
    _minResolutionForSize(targetDim, meta) {
        if (!targetDim || !(targetDim > 0)) return 0;
        const fullW = meta.width || 0;
        const fullH = meta.height || 0;
        if (!fullW || !fullH) return 0;
        return Math.max(0, Math.ceil(Math.log2(Math.max(fullW, fullH) / targetDim)));
    }

    // Hand control back to the browser long enough for the current canvas
    // frame to be composited and presented to the user. Double requestAnimation
    // Frame guarantees the paint has been flushed before the next layer is
    // fetched, so progressive frames are actually visible one by one.
    _yieldForPaint() {
        return new Promise((resolve) => {
            if (typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            } else if (typeof setImmediate === 'function') {
                setImmediate(resolve);
            } else {
                setTimeout(resolve, 0);
            }
        });
    }
}
