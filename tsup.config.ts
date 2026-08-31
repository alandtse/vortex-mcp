import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["cjs"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Vortex loads extensions as CommonJS and provides its own copies of
  // heavy runtime deps (electron, react, etc.) — only bundle what's ours.
  // `@nexusmods/vortex-api` is intercepted by Vortex's own require() patch
  // (extensionRequire.ts) at runtime and must never be bundled — the npm
  // package is types-only here, there is no real module to inline.
  noExternal: ["@modelcontextprotocol/server", "@modelcontextprotocol/node", "zod"],
  external: ["electron", "@nexusmods/vortex-api"],
  minify: false,
});
