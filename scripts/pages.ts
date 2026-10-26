/**
 * Builds what GitHub Pages serves for the registry, from `sites/` on main: `index.json`, which `search`
 * and MCP `find_sites` read. `npm run pages -- <outDir>`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../src/registry.js";

export function buildPages(sitesDir: string, outDir: string, generated?: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(buildIndex(sitesDir, generated))}\n`);
  // Pages would otherwise run Jekyll over the files
  writeFileSync(join(outDir, ".nojekyll"), "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: npm run pages -- <outDir>");
  buildPages(fileURLToPath(new URL("../sites", import.meta.url)), out);
}
