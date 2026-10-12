// Browser stand-in for the parts of node:crypto that @arcium-hq/client touches.
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { sha3_256 } from "@noble/hashes/sha3";

export function randomBytes(n: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

const algos = { sha256, "sha3-256": sha3_256 } as const;

export function createHash(alg: string) {
  const fn = algos[alg as keyof typeof algos];
  if (!fn) throw new Error(`createHash(${alg}) not available in browser`);
  const h = fn.create();
  const api = {
    update(data: Uint8Array | string) {
      h.update(typeof data === "string" ? Buffer.from(data) : data);
      return api;
    },
    digest: () => Buffer.from(h.digest()),
  };
  return api;
}

// ponytail: AES ciphers aren't used by Blindcourt (it uses RescueCipher).
export function createCipheriv(): never {
  throw new Error("AES cipher not available in browser build");
}
export const createDecipheriv = createCipheriv;

export default { randomBytes, createHash, createCipheriv, createDecipheriv };
