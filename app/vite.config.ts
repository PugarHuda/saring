import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shim = (f: string) => fileURLToPath(new URL(`./src/shims/${f}`, import.meta.url));

// @arcium-hq/client imports node's `crypto` and `fs`; the browser only needs
// randomBytes + sha256/sha3, so those are shimmed. It also default-imports
// anchor, whose browser build has no default export. See src/shims/.
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { global: "globalThis" },
  resolve: {
    alias: [
      { find: /^crypto$/, replacement: shim("crypto.ts") },
      { find: /^fs$/, replacement: shim("fs.ts") },
      { find: /^@anchor-lang\/core$/, replacement: shim("anchor.js") },
    ],
  },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
