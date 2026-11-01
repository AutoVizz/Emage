// Tests use the same files served by the server; override for other checkouts.
import { fileURLToPath } from 'node:url';

export const wasmDir = process.env.EMAGE_WASM_DIR || fileURLToPath(
    new URL('../../RiderProjects/Emage/Emage/wwwroot/wasm/', import.meta.url));
