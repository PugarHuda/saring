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
  // ../panta/panta.ts lives outside the app root; one web3.js copy for both.
  // /api (RPC proxy, faucet) is served by Vercel; in dev, forward it to the hosted deployment.
  server: { fs: { allow: [".."] }, proxy: { "/api": { target: "https://saring-silk.vercel.app", changeOrigin: true, configure: (p) => p.on("proxyReq", (r) => r.removeHeader("origin")) } } },
  resolve: {
    dedupe: ["@solana/web3.js"],
    alias: [
      { find: /^crypto$/, replacement: shim("crypto.ts") },
      { find: /^fs$/, replacement: shim("fs.ts") },
      { find: /^@anchor-lang\/core$/, replacement: shim("anchor.js") },
    ],
  },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
