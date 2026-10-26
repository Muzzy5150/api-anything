/**
 * Builds what GitHub Pages serves for the registry, from `sites/` on main: `index.json`, which `search`
 * and MCP `find_sites` read, the last `health.json`, a home page, one page per site and a sitemap.
 * `npm run pages -- <outDir> [health.json]`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../src/registry.js";
import { safeName } from "../src/session.js";
import { parseSite } from "../src/spec.js";
import { forCallers } from "../src/store.js";
import { type HealthFile, readHealth } from "./health.js";
import { homePage, sitemap, sitePage } from "./pages-html.js";

/** Who committed a spec, first contributor first; none when git or the history is not there (a shallow clone has one commit). */
export function contributors(sitesDir: string, name: string): string[] {
  try {
    const log = execFileSync("git", ["log", "--format=%an", "--", `${name}.json`], {
      cwd: sitesDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(log.split("\n").filter(Boolean).reverse())];
  } catch {
    return [];
  }
}

export function buildPages(
  sitesDir: string,
  outDir: string,
  o: { generated?: string; health?: HealthFile } = {},
): void {
  const index = buildIndex(sitesDir, o.generated, o.health?.sites);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index)}\n`);
  // the next health run reads this one back, to carry each op's last success forward
  if (o.health) writeFileSync(join(outDir, "health.json"), `${JSON.stringify(o.health)}\n`);
  // Pages would otherwise run Jekyll over the files
  writeFileSync(join(outDir, ".nojekyll"), "");
  writeFileSync(join(outDir, "index.html"), homePage(index.sites));
  for (const entry of index.sites) {
    const name = safeName(entry.site);
    const site = parseSite(JSON.parse(readFileSync(join(sitesDir, `${name}.json`), "utf8")));
    const notesPath = join(sitesDir, `${name}.md`);
    const notes = existsSync(notesPath) ? forCallers(readFileSync(notesPath, "utf8")) : undefined;
    const dir = join(outDir, "sites", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.html"),
      sitePage({ site, entry, notes: notes || undefined, contributors: contributors(sitesDir, name) }),
    );
  }
  writeFileSync(join(outDir, "sitemap.xml"), sitemap(index.sites.map((e) => e.site)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out, health] = process.argv.slice(2);
  if (!out) throw new Error("usage: npm run pages -- <outDir> [health.json]");
  buildPages(fileURLToPath(new URL("../sites", import.meta.url)), out, { health: readHealth(health) });
}
