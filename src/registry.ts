/**
 * Sharing specs through the registry: this repository's `sites/` on GitHub. `pull` fetches one into
 * `~/.api-anything/registry`, `publish` opens a pull request adding one; the rules both apply are vet.ts's.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "tldts";
import { z } from "zod";
import { returnedFields } from "./extract.js";
import { dropUnbound, loadSession, safeName, siteOf, writePrivate } from "./session.js";
import { type Operation, parseSite, type Site } from "./spec.js";
import { listSites, loadSite, registryDir, updateSite } from "./store.js";
import { LIMITS, vetShared } from "./vet.js";

/** The GitHub repository whose `sites/` is the registry. */
export const REPO = "goodnight000/api-anything";
export const REGISTRY = `https://raw.githubusercontent.com/${REPO}/main`;
/** The registry's index and site pages, which CI builds from main and serves on GitHub Pages. */
export const PAGES = "https://goodnight000.github.io/api-anything";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The registry's base URL: `API_ANYTHING_REGISTRY`, https (or http to this machine, for tests). */
export function registryBase(): string {
  const base = (process.env.API_ANYTHING_REGISTRY || REGISTRY).replace(/\/+$/, "");
  const u = new URL(base);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.has(u.hostname)))
    throw new Error(`API_ANYTHING_REGISTRY must be https: ${base}`);
  return base;
}

/** The body of `url`, or undefined on a 404. Read while streaming, so a huge answer stops at `cap`. */
async function fetchCapped(url: string, cap: number, fetchImpl: typeof fetch): Promise<string | undefined> {
  // a redirect could move the fetch to any origin; the registry's files are served where they are
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > cap) throw new Error(`${url} is over ${cap} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const hostsOf = (op: Operation) => {
  const urls = [op.request.url, op.trigger.url, op.trigger.softFrom];
  return [...new Set(urls.flatMap((u) => (u ? [new URL(u).hostname] : [])))];
};

/** One op as the person deciding whether to run it needs to see it. */
export function summarize(op: Operation) {
  const fields = returnedFields(op.response);
  return {
    op: `${op.name}(${op.params.map((p) => `${p.name}${p.required ? "" : "?"}`).join(", ")})${fields ? ` -> ${fields.join(", ")}` : ""}`,
    method: op.request.method.toUpperCase(),
    hosts: hostsOf(op),
    ...(op.readOnly ? {} : { write: true as const }),
    ...(op.learnedLoggedIn ? { login: true as const } : {}),
  };
}

export interface Pulled {
  site: string;
  from: string;
  sha256: string;
  operations: ReturnType<typeof summarize>[];
  warnings: string[];
  /** on a pull again: ops that are new, changed or gone since the last one */
  changed?: { added: string[]; changed: string[]; removed: string[] };
  /** the user's own copy, which wins over the pulled one */
  shadowedBy?: string;
}

const sitesOfSession = (name: string) => {
  const s = loadSession(name);
  return new Set([
    ...s.cookies.map((c) => siteOf(c.domain.replace(/^\./, ""))),
    ...(s.origins ?? []).map((o) => siteOf(new URL(o).hostname)),
  ]);
};

/**
 * `by: "agent"` marks a pull an agent made over MCP rather than one a human ran: its writes stay hidden
 * there whatever the server allows, since page text may have steered the agent to it.
 */
export async function pull(name: string, o: { fetchImpl?: typeof fetch; by?: "agent" } = {}): Promise<Pulled> {
  name = safeName(name);
  const fetchImpl = o.fetchImpl ?? fetch;
  const from = `${registryBase()}/sites/${name}.json`;
  const text = await fetchCapped(from, LIMITS.file, fetchImpl);
  if (text === undefined) throw new Error(`no shared spec for "${name}" in the registry`);
  let site: Site;
  try {
    site = parseSite(JSON.parse(text));
  } catch (e) {
    throw new Error(`${from}: ${(e as Error).message}`);
  }
  if (site.name.toLowerCase() !== name) throw new Error(`${from} is the spec of "${site.name}", not "${name}"`);
  const sha256 = createHash("sha256").update(text).digest("hex");
  site = { ...site, name, shared: { from, sha256, ...(o.by ? { by: o.by } : {}) } };
  const notes = await fetchCapped(`${registryBase()}/sites/${name}.md`, LIMITS.notes, fetchImpl);
  const { errors, warnings } = vetShared(site, notes);
  if (errors.length) throw new Error(`the shared spec of "${name}" fails the shared rules: ${errors.join("; ")}`);

  // One name is one session: a spec on another site would inherit this one's cookies and values.
  const own = siteOf(new URL(site.baseUrl).hostname);
  let local: ReturnType<typeof loadSite>;
  try {
    local = loadSite(name);
  } catch {
    local = undefined; // an unreadable copy is replaced
  }
  if (local && siteOf(new URL(local.site.baseUrl).hostname) !== own)
    throw new Error(`a local spec "${name}" is for ${local.site.baseUrl}, not ${site.baseUrl}`);
  const held = sitesOfSession(name);
  if (held.size && !held.has(own))
    throw new Error(`the local session "${name}" belongs to ${[...held].join(", ")}, not ${own}`);

  dropUnbound(name);

  const path = join(registryDir(), `${name}.json`);
  const before = local?.site.shared ? local.site : undefined;
  // the notes first: a spec without its new notes beside it would load with the old ones
  const notesPath = join(registryDir(), `${name}.md`);
  if (notes !== undefined) writePrivate(notesPath, notes);
  else rmSync(notesPath, { force: true });
  writePrivate(path, `${JSON.stringify(site, null, 2)}\n`);
  // The user's own copy (a heal's, or one an add extended) wins over the pulled one: a human's pull
  // is the consent that clears the agent's mark there too, or its writes would stay hidden for good.
  if (!o.by && local?.source === "user" && local.site.shared?.by === "agent")
    updateSite(name, (s) => ({ ...s!, shared: { from: s!.shared!.from, sha256: s!.shared!.sha256 } }));

  return {
    site: name,
    from,
    sha256,
    operations: site.operations.map(summarize),
    warnings,
    ...(before ? { changed: changes(before, site) } : {}),
    ...(local?.source === "user" ? { shadowedBy: local.path } : {}),
  };
}

function changes(before: Site, after: Site) {
  const old = new Map(before.operations.map((op) => [op.name, JSON.stringify(op)]));
  const now = new Map(after.operations.map((op) => [op.name, JSON.stringify(op)]));
  return {
    added: [...now.keys()].filter((n) => !old.has(n)),
    changed: [...now].filter(([n, s]) => old.has(n) && old.get(n) !== s).map(([n]) => n),
    removed: [...old.keys()].filter((n) => !now.has(n)),
  };
}

/* ------------------------------------------------------------------ index and search */

// The index reaches the agent as text, so it is held to the limits the shared rules put on a spec.
const text = z.string().max(LIMITS.text);
const HOST = z.string().regex(/^[a-z0-9.-]{1,253}$/);
const IndexOpSchema = z.object({
  // a signature: `name(params) -> fields`, whose name the shared rules restrict
  op: z
    .string()
    .max(2000)
    .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}\(/),
  method: z.string().regex(/^[A-Z]{1,10}$/),
  hosts: z.array(HOST).max(20),
  write: z.literal(true).optional(),
  login: z.literal(true).optional(),
  description: text.optional(),
});
const IndexEntrySchema = z.object({
  site: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  displayName: z.string().max(100).optional(),
  description: text.optional(),
  /** the registrable domains the spec's ops send to or open: what a search by domain or URL matches */
  domains: z.array(HOST).max(50),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  operations: z.array(IndexOpSchema).max(LIMITS.operations),
});
const IndexSchema = z.object({ generated: z.string(), sites: z.array(IndexEntrySchema) });
export type IndexEntry = z.infer<typeof IndexEntrySchema>;
export type RegistryIndex = z.infer<typeof IndexSchema>;

/** The index for 10k sites is a few MB; past this something is wrong. */
const INDEX_CAP = 32 * 1024 * 1024;

/** Where search reads the index: the Pages copy, or `index.json` beside the specs of a registry `API_ANYTHING_REGISTRY` names. */
export const indexUrl = () => `${process.env.API_ANYTHING_REGISTRY ? registryBase() : PAGES}/index.json`;

export function indexEntry(site: Site, text: string): IndexEntry {
  return {
    site: site.name,
    ...(site.displayName ? { displayName: site.displayName } : {}),
    ...(site.description ? { description: site.description } : {}),
    domains: [
      ...new Set([new URL(site.baseUrl).hostname, ...site.operations.flatMap(hostsOf)].map((h) => siteOf(h))),
    ].sort(),
    sha256: createHash("sha256").update(text).digest("hex"),
    operations: site.operations.map((op) => ({
      ...summarize(op),
      ...(op.description ? { description: op.description } : {}),
    })),
  };
}

/** The index of a directory of specs (the registry's `sites/`), as CI builds it on every merge. */
export function buildIndex(dir: string, generated = new Date().toISOString()): RegistryIndex {
  const sites = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      return indexEntry({ ...parseSite(JSON.parse(text)), name: f.slice(0, -5) }, text);
    });
  return { generated, sites };
}

/** A long-lived caller's (an MCP server's) copy of the index: it searches often, and the index changes on a merge. */
export type IndexCache = { url?: string; at?: number; index?: RegistryIndex };
const INDEX_TTL = 10 * 60_000;

/** The index, with each entry that breaks its rules dropped (one bad entry is no reason to lose the rest). */
export async function fetchIndex(o: { fetchImpl?: typeof fetch; cache?: IndexCache } = {}): Promise<RegistryIndex> {
  const from = indexUrl();
  const c = o.cache;
  if (c?.index && c.url === from && Date.now() - c.at! < INDEX_TTL) return c.index;
  const body = await fetchCapped(from, INDEX_CAP, o.fetchImpl ?? fetch);
  if (body === undefined) throw new Error(`the registry has no index at ${from}`);
  let raw: { generated: unknown; sites: unknown[] };
  try {
    raw = z.object({ generated: z.string(), sites: z.array(z.unknown()) }).parse(JSON.parse(body));
  } catch (e) {
    throw new Error(`${from}: ${(e as Error).message.split("\n")[0]}`);
  }
  const sites = raw.sites.flatMap((e) => {
    const r = IndexEntrySchema.safeParse(e);
    return r.success ? [r.data] : [];
  });
  const index = { generated: raw.generated as string, sites };
  if (c) Object.assign(c, { url: from, at: Date.now(), index });
  return index;
}

// Words that say nothing about which site: a query is often a sentence ("the weather in paris").
const STOP = new Set(
  "and are best can cheap find for from get how into list near new now of on one or out per show some than that the their them then this top what when where which who why with you your".split(
    " ",
  ),
);

/** A text's search words: lower-cased, no stopword, none under 3 letters, a plural `s` dropped (not "news"). */
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !/[su]s$/.test(w) ? w.slice(0, -1) : w));

/** An op's signature, its camelCase names split: `searchBooks(q) -> avgRating` reads as search books ... rating. */
const opWords = (text: string) => words(text.replace(/([a-z])([A-Z])/g, "$1 $2"));

/** A query that names a domain or a URL, as its registrable domain. */
function domainOf(query: string): string | undefined {
  const q = query.trim();
  if (!/^\S+\.\S+$/.test(q)) return undefined;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(q) ? q : `https://${q}`).hostname;
    return parse(host, { allowPrivateDomains: true }).domain ? siteOf(host) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How well an entry answers a query: a domain query matches the domains the spec uses; words weigh most in
 * the site's name, then its title and domains, then what its ops say they do and return.
 */
export function score(e: IndexEntry, query: string): number {
  const domain = domainOf(query);
  if (domain) return e.domains.includes(domain) ? 100 : 0;
  const name = words(e.site);
  const title = words(`${e.displayName ?? ""} ${e.domains.join(" ")}`);
  const about = [
    ...words([e.description, ...e.operations.map((o) => o.description)].filter(Boolean).join(" ")),
    ...opWords(e.operations.map((o) => o.op).join(" ")),
  ];
  let total = 0;
  for (const w of new Set(words(query))) {
    // part of a longer word: "book" in "bookshelf"; in the ops' text only from 5 letters, where "time" is in "datetime"
    const hit = (list: string[], whole: number, part: number, min = 3) =>
      list.includes(w) ? whole : w.length >= min && list.some((x) => x.includes(w)) ? part : 0;
    // a word that misses entirely makes the site a worse answer than one that has every word
    const s = Math.max(hit(name, 10, 6), hit(title, 6, 3), hit(about, 2, 1, 5));
    total += s || -1;
  }
  return total;
}

/** This machine's specs as index entries; one that does not load is left out, as `sites` reports it. */
export function localEntries(): IndexEntry[] {
  return listSites().flatMap((name) => {
    try {
      const r = loadSite(name);
      return r ? [indexEntry(r.site, readFileSync(r.path, "utf8"))] : [];
    } catch {
      return [];
    }
  });
}

export interface Found {
  site: string;
  displayName?: string;
  description?: string;
  /** on this machine already: its own spec, a pulled one or a bundled one */
  installed: boolean;
  operations: IndexEntry["operations"];
}

/**
 * The sites that answer a query, best first: the registry's index merged with the specs on this machine (a
 * site learned here and never shared is found too). An index that cannot be fetched leaves the local ones,
 * with the reason in `registryError`.
 */
export async function search(
  query: string,
  o: { fetchImpl?: typeof fetch; cache?: IndexCache; limit?: number; local?: IndexEntry[] } = {},
): Promise<{ matches: Found[]; registryError?: string }> {
  let remote: IndexEntry[] = [];
  let registryError: string | undefined;
  try {
    remote = (await fetchIndex(o)).sites;
  } catch (e) {
    registryError = (e as Error).message;
  }
  const local = o.local ?? localEntries();
  const installed = new Set(local.map((e) => e.site));
  const entries = [...local, ...remote.filter((e) => !installed.has(e.site))];
  const scored = entries
    .map((e) => ({ e, s: score(e, query) }))
    .sort((a, b) => b.s - a.s || a.e.site.localeCompare(b.e.site));
  // a site far behind the best answer matched a stray word
  const best = scored[0]?.s ?? 0;
  const matches = scored
    .filter(({ s }) => s > 0 && s * 3 >= best)
    .slice(0, o.limit ?? 5)
    .map(({ e }) => ({
      site: e.site,
      ...(e.displayName ? { displayName: e.displayName } : {}),
      ...(e.description ? { description: e.description } : {}),
      installed: installed.has(e.site),
      operations: e.operations,
    }));
  return { matches, ...(registryError ? { registryError } : {}) };
}
