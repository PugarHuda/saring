// Anchor's browser build has no default export, but @arcium-hq/client does
// `import anchor from "@anchor-lang/core"` (for BN). Re-export with a default.
import * as anchor from "@anchor-lang/core/dist/browser/index.js";
export * from "@anchor-lang/core/dist/browser/index.js";
export default anchor;
