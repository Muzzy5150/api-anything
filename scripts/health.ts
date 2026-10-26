/**
 * Calls every shared op that can run without an account, with its own example args, and records whether
 * it worked: the health that site pages, the index and `search` show. CI runs it daily from GitHub's
 * runners. `npm run health -- <out.json> [previous.json]`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeBrowser } from "../src/browser.js";
import { type CallOptions, call, exampleArgs, type Tier } from "../src/execute.js";
import { parseSite } from "../src/spec.js";

export interface OpCheck {
  ok: boolean;
  class: string;
  tier?: Tier;
  ms: number;
  checkedAt: string;
  /** the last check that worked, this one or an earlier one */
  lastOk?: string;
  reason?: string;
}
export interface HealthFile {
  generated: string;
  sites: Record<string, Record<string, OpCheck>>;
}

const REASON_CAP = 200;

/**
 * Checks the specs in `sitesDir`, one call at a time, in a fresh home: no session, no cookie, no heal
 * history, as a first-time user would run them. `previous` carries each op's `lastOk` forward.
 */
export async function checkHealth(
  sitesDir: string,
  previous?: HealthFile,
  o: { callOptions?: CallOptions; now?: () => Date } = {},
): Promise<HealthFile> {
  const now = o.now ?? (() => new Date());
  const homeBefore = process.env.API_ANYTHING_HOME;
  const home = mkdtempSync(join(tmpdir(), "aa-health-"));
  process.env.API_ANYTHING_HOME = home;
  const sites: HealthFile["sites"] = {};
  try {
    mkdirSync(join(home, "sites"));
    for (const f of readdirSync(sitesDir)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const name = f.slice(0, -5);
      // a copy in the fresh home's own specs is what call() resolves first, whatever sitesDir is
      copyFileSync(join(sitesDir, f), join(home, "sites", f));
      const site = parseSite(JSON.parse(readFileSync(join(sitesDir, f), "utf8")));
      for (const op of site.operations) {
        const args = exampleArgs(op);
        if (!op.readOnly || op.learnedLoggedIn || !args) continue;
        const checkedAt = now().toISOString();
        const r = await call(name, op.name, args, o.callOptions);
        const lastOk = r.ok ? checkedAt : previous?.sites[name]?.[op.name]?.lastOk;
        sites[name] ??= {};
        sites[name][op.name] = {
          ok: r.ok,
          class: r.class,
          ...(r.tier ? { tier: r.tier } : {}),
          ms: r.ms,
          checkedAt,
          ...(lastOk ? { lastOk } : {}),
          ...(r.ok || !r.reason ? {} : { reason: r.reason.slice(0, REASON_CAP) }),
        };
      }
    }
  } finally {
    await closeBrowser();
    if (homeBefore === undefined) delete process.env.API_ANYTHING_HOME;
    else process.env.API_ANYTHING_HOME = homeBefore;
    rmSync(home, { recursive: true, force: true });
  }
  return { generated: now().toISOString(), sites };
}

/** A health file, or undefined when there is none yet (the first run has nothing deployed to carry over). */
export function readHealth(path: string | undefined): HealthFile | undefined {
  if (!path || !existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  return text.trim() ? (JSON.parse(text) as HealthFile) : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out, prev] = process.argv.slice(2);
  if (!out) throw new Error("usage: npm run health -- <out.json> [previous.json]");
  const health = await checkHealth(fileURLToPath(new URL("../sites", import.meta.url)), readHealth(prev));
  writeFileSync(out, `${JSON.stringify(health, null, 2)}\n`);
  const checks = Object.values(health.sites).flatMap((ops) => Object.values(ops));
  process.stdout.write(`${checks.filter((c) => c.ok).length} of ${checks.length} checked ops worked\n`);
}
