import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "vite";

const shim = (f: string) => fileURLToPath(new URL(`./src/shims/${f}`, import.meta.url));

// The hosted deployment may not have /api/chains yet, so dev runs it locally (same handler as Vercel).
const localChains: Plugin = {
  name: "local-api-chains",
  configureServer(server) {
    server.middlewares.use("/api/chains", async (req, res) => {
      const url = pathToFileURL(fileURLToPath(new URL("./api/chains.js", import.meta.url))).href;
      const { default: handler } = await import(/* @vite-ignore */ url);
      const r = {
        status: (c: number) => ((res.statusCode = c), r),
        setHeader: (k: string, v: string) => (res.setHeader(k, v), r),
        json: (o: unknown) => (res.setHeader("Content-Type", "application/json"), res.end(JSON.stringify(o))),
      };
      await handler(req, r);
    });
  },
};

// @arcium-hq/client imports node's `crypto` and `fs`; the browser only needs
// randomBytes + sha256/sha3, so those are shimmed. It also default-imports
// anchor, whose browser build has no default export. See src/shims/.
export default defineConfig({
  plugins: [react(), localChains],
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
