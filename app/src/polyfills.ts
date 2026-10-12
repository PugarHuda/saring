// Must be the first import in main.tsx: web3.js / anchor expect Buffer and process globals.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string> } };
g.Buffer ??= Buffer;
g.process ??= { env: {} };
