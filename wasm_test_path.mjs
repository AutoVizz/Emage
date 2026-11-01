// Tests use the same codec files served by the static client.
import { fileURLToPath } from 'node:url';

export const wasmDir = process.env.EMAGE_WASM_DIR || fileURLToPath(
    new URL('wasm/', import.meta.url));
