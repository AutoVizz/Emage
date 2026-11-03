import { fileURLToPath } from 'node:url';

export const wasmDir = process.env.EMAGE_WASM_DIR || fileURLToPath(
    new URL('wasm/', import.meta.url));
