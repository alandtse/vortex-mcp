#!/usr/bin/env node
// Copies the built extension (dist/index.js + info.json) into Vortex's local
// plugins folder for manual testing. Run `pnpm run build` first.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
if (!existsSync(dist)) {
  console.error("dist/ not found — run `pnpm run build` first.");
  process.exit(1);
}

const info = JSON.parse(readFileSync(path.join(root, "info.json"), "utf8"));
// Matches installExtension.ts's own precedence (extensionInfo?.id ?? archive basename) —
// info.json's `id` is what decides the stable plugins/ folder name across real installs,
// so this has to agree with it rather than always deriving from `name`.
const pluginId = info.id ?? info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const target = path.join(process.env.APPDATA, "vortex", "plugins", pluginId);

mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
cpSync(path.join(root, "info.json"), path.join(target, "info.json"));

console.log(`Installed to ${target}`);
console.log("Restart Vortex (or reload extensions) to pick it up.");
