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
    constructor(options = {}) {
        this.encoder = null;
        this.decoder = null;
        this.server = { baseUrl: '', imagePath: '', password: '' };
        this.crypto = { key: null, iv: null, levels: null };
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

    setCrypto(config = {}) {
        if (config.key !== undefined) this.crypto.key = this._toBytes(config.key, 'key');
        if (config.iv !== undefined) this.crypto.iv = this._toBytes(config.iv, 'iv');
        if (config.levels !== undefined) this.crypto.levels = config.levels;
        return this;
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

    // AES-256 cascade: the key is 32 bytes, the IV 16 bytes, for every level.
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

    _levels(value) {
        if (Number.isInteger(value) && value >= 1) return value;
        return null;
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
        // 0 = "read the cascade count from the SEC marker"; an explicit value
        // is only needed for header-less layer windows (no marker present).
        const levels = this._levels(opts.levels ?? this.crypto.levels) ?? 0;
        const dec = this.decoder;
        const ptr = dec._malloc(stream.length);
        try {
            dec.HEAPU8.set(stream, ptr);
            try {
                const out = dec.decodeRaw(ptr, stream.length, key, iv, levels);
                return {
                    width: out.width,
                    height: out.height,
                    numComponents: out.numComponents,
                    rgbaPixels: out.rgbaPixels,
                };
            } catch (err) {
                throw new EmageError(this._message(err), { cause: err });
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

    paintTo(canvas, result) {
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext('2d').putImageData(
            new ImageData(result.rgbaPixels, result.width, result.height), 0, 0);
    }

    // Paint a decoded frame scaled into a fixed-size canvas. If no target
    // dimensions are given, falls back to painting at the decoded resolution.
    _paintScaled(canvas, result, dims) {
        if (!dims) return this.paintTo(canvas, result);
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

    describeSecurityZone(stream) {
        if (!this.decoder) throw new EmageError('Decoder module not initialized');
        if (!stream || !stream.length) return { hasSec: 0, zoneStart: 0, zoneSize: 0, levels: 0 };
        const dec = this.decoder;
        const ptr = dec._malloc(stream.length);
        try {
            dec.HEAPU8.set(stream, ptr);
            const z = dec.describeSecurityZone(ptr, stream.length);
            return { hasSec: z.hasSec, zoneStart: z.zoneStart, zoneSize: z.zoneSize, levels: z.levels };
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
            enablePlt: opts.enablePlt ?? true,
            enableSec: opts.enableSec ?? true,
            levels: this._levels(opts.levels ?? this.crypto.levels) ?? 1,
        };
        const numLayers = this._layerCount(opts.numLayers);
        if (numLayers != null) encOpts.numLayers = numLayers;
        if (encOpts.enableSec) {
            encOpts.key = this._bytesKey(opts.key ?? this.crypto.key, 'key');
            encOpts.iv = this._bytesIv(opts.iv ?? this.crypto.iv, 'iv');
        }

        const enc = this.encoder;
        const ptr = enc._malloc(data.length);
        try {
            enc.HEAPU8.set(data, ptr);
            try {
                const j2k = enc.encodeRaw(ptr, data.length, encOpts);
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

    // Lowest-level server primitive: fetch a layer window. Kept private so
    // callers interact with the abstracted meta()/preview()/display() API.
    async _window(layers) {
        const resp = await fetch(this._imageUrl(), { headers: { 'X-Emage-Layers': String(layers) } });
        const body = await resp.arrayBuffer();
        if (!resp.ok) {
            let text = '';
            try { text = new TextDecoder().decode(body); } catch (_) { /* ignore */ }
            throw new EmageServerError('HTTP ' + resp.status + ' ' + text.trim());
        }
        return { bytes: new Uint8Array(body), headers: resp.headers };
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

    async upload(j2k, opts = {}) {
        const data = j2k || this.j2k;
        if (!data) throw new EmageError('Nothing to upload — encode an image first.');
        if (!data.length || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
            throw new EmageError('Refusing to upload: buffer does not end with EOC (not a full codestream).');
        }
        const resp = await fetch(this._imageUrl(), {
            method: 'POST',
            headers: { 'X-Emage-Password': opts.password ?? this.server.password },
            body: data,
        });
        const out = await parseJson(resp);
        if (!resp.ok) {
            throw new EmageServerError('HTTP ' + resp.status + ' ' + JSON.stringify(out));
        }
        this.progress = null;
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

    static finalizeStream(data, numLayers, layerCountOffset, tilePsotOffsets) {
        const out = new Uint8Array(data.length + 2);
        out.set(data, 0);
        out[data.length] = 0xff;
        out[data.length + 1] = 0xd9;
        if (layerCountOffset >= 0) {
            out[layerCountOffset] = (numLayers >> 8) & 0xff;
            out[layerCountOffset + 1] = numLayers & 0xff;
        }
        for (const po of tilePsotOffsets) {
            const sotStart = po - 6;
            const psot = data.length - sotStart;
            out[po] = (psot >>> 24) & 0xff;
            out[po + 1] = (psot >> 16) & 0xff;
            out[po + 2] = (psot >> 8) & 0xff;
            out[po + 3] = psot & 0xff;
        }
        return out;
    }

    // Fetch the first quality layer and decode a low-quality preview.
    async preview(opts = {}) {
        const out = await this._loadLayers(1, opts);
        return { ...out, kind: 'preview' };
    }

    // Progressively load every quality layer from coarsest to finest.
    async playAll(opts = {}) {
        return this.display('all', opts);
    }

    // Progressively load only the quality layers needed to render the image at
    // the requested display size, decoding (and optionally painting each frame
    // when opts.canvas is given) layer by layer until that size is reached.
    // target: px number, '100px', '10vw', '30vh', '50%', or 'all'/'100%'.
    async display(target, opts = {}) {
        const spec = resolveTarget(target);
        const meta = await this.meta();
        let targetDim = null;
        let count;
        if (spec.type === 'all') {
            count = meta.layers;
        } else {
            targetDim = spec.type === 'pct'
                ? Math.max(meta.width, meta.height) * spec.value
                : spec.value;
            count = this._minLayersForSize(targetDim, meta);
        }
        // Resolve the requested size to concrete canvas pixels: at every
        // progressive stage the image is rendered at exactly this size, never
        // the full source resolution.
        const dims = this._displayDims(meta, targetDim);
        if (dims && opts.canvas) {
            opts.canvas.width = dims.width;
            opts.canvas.height = dims.height;
        }
        const out = await this._loadLayers(count, { ...opts, displayDims: targetDim != null ? dims : null }, meta);
        return {
            ...out,
            target,
            loadMode: count >= meta.layers ? 'full' : 'size',
            targetDimension: targetDim != null ? Math.round(targetDim) : null,
            displaySize: dims,
            fullDimension: Math.max(meta.width, meta.height),
            loadedLayers: count,
            totalLayers: meta.layers,
        };
    }

    // Compute canvas pixel dimensions for a display target while preserving the
    // source aspect ratio. targetDim is the long-edge pixel dimension.
    _displayDims(meta, targetDim) {
        const fullW = meta.width || 0;
        const fullH = meta.height || 0;
        if (!fullW || !fullH || !(targetDim > 0)) return null;
        const scale = targetDim / Math.max(fullW, fullH);
        return {
            width: Math.max(1, Math.round(fullW * scale)),
            height: Math.max(1, Math.round(fullH * scale)),
        };
    }

    // Estimate how many quality layers are required to display the image at a
    // given pixel dimension. Each additional layer roughly doubles the usable
    // resolution (LRCP + rate allocation), so the needed layer count scales
    // logarithmically with the full/display dimension ratio.
    _minLayersForSize(targetDim, meta) {
        if (!targetDim || !(targetDim > 0)) return meta.layers;
        if (!meta.width || !meta.height) return meta.layers;
        const fullDim = Math.max(meta.width, meta.height);
        if (targetDim >= fullDim) return meta.layers;
        const log2r = Math.log2(fullDim / targetDim);
        return Math.max(1, Math.min(meta.layers, Math.ceil(meta.layers - log2r)));
    }

    async _loadLayers(count, opts = {}, meta) {
        if (!meta) meta = await this.meta();
        if (!meta.layers || meta.layers < 1) throw new EmageError('No layers to play');
        count = Math.max(1, Math.min(count, meta.layers));
        const first = await this._window('0');
        const layerCountOffset = parseInt(first.headers.get('x-emage-layercountoffset') || '-1', 10);
        const tilePsotOffsets = (first.headers.get('x-emage-tilepsotoffsets') || '')
            .split(',').filter(Boolean).map(Number);
        const st = {
            image: this.server.imagePath,
            layers: meta.layers,
            data: first.bytes,
            k: 1,
            layerCountOffset,
            tilePsotOffsets,
        };
        this.progress = st;
        const steps = [];
        let window = null;
        for (let k = 1; k <= count; ++k) {
            if (k > 1) {
                window = await this._window(String(k - 1));
                const next = new Uint8Array(st.data.length + window.bytes.length);
                next.set(st.data, 0);
                next.set(window.bytes, st.data.length);
                st.data = next;
                st.k = k;
            }
            const stream = Emage.finalizeStream(st.data, k, layerCountOffset, tilePsotOffsets);
            const decoded = this._maybeDecode(stream, opts);
            steps.push({
                layer: k,
                totalLayers: meta.layers,
                complete: k >= meta.layers,
                assembledBytes: st.data.length,
                appendedBytes: k === 1 ? first.bytes.length : window.bytes.length,
                stream,
                decoded,
            });
            if (typeof opts.onLayer === 'function') {
                opts.onLayer({
                    layer: k,
                    totalLayers: meta.layers,
                    complete: k >= meta.layers,
                    assembledBytes: st.data.length,
                });
            }
            // Yield to the browser's renderer after each paint so every layer
            // is actually shown, not coalesced away into the final frame.
            if (opts.canvas && opts.decode !== false && k < count) await this._yieldForPaint();
        }
        const complete = count >= meta.layers;
        this.progress = complete ? null : st;
        return {
            meta,
            count,
            steps,
            complete,
            decoded: steps[steps.length - 1].decoded,
            stream: steps[steps.length - 1].stream,
            patches: { layerCountOffset, tilePsotOffsets },
        };
    }

    _maybeDecode(stream, opts) {
        if (opts.decode === false) return null;
        const decoded = this.decode(stream, opts);
        if (opts.canvas) this._paintScaled(opts.canvas, decoded, opts.displayDims);
        return decoded;
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