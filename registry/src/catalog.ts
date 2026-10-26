/** What the registry serves: each site with the best version of each of its ops, and search over them. */
import type { FoundOp, SearchMatch, ServedOp, ServedSite } from "../../src/registry-api.js";
import { type IndexEntry, indexEntry, score, summarize } from "../../src/search.js";
import type { Operation, Site } from "../../src/spec.js";
import { byRank, successRate } from "./rules.js";
import { allSites, context, type D1Database, getSite, type StatRow, servable } from "./store.js";

const servedOp = (r: StatRow): ServedOp => {
  const rate = successRate(r.oks, r.bad);
  return {
    hash: r.hash,
    status: r.status,
    confirmations: r.confirmations,
    ...(rate !== undefined ? { successRate: rate } : {}),
    ...(r.last_ok_at ? { lastOkAt: r.last_ok_at } : {}),
    operation: JSON.parse(r.operation) as Operation,
  };
};

/**
 * One version per op: the best of those with its name. Not by match signature alone, as docs/REGISTRY.md
 * has it: real specs hold distinct ops on one endpoint (goodreads getBook and getWorkId, google-flights
 * search and top), and a site must never serve two ops of one name.
 */
export function bestPerOp(rows: StatRow[]): ServedOp[] {
  const groups = new Map<string, ServedOp & { createdAt: string }>();
  for (const r of rows) {
    const op = { ...servedOp(r), createdAt: r.created_at };
    const held = groups.get(r.op_name);
    if (!held || byRank(op, held) < 0) groups.set(r.op_name, op);
  }
  return [...groups.values()]
    .map(({ createdAt: _, ...op }) => op)
    .sort((a, b) => a.operation.name.localeCompare(b.operation.name));
}

/** The sites with something to serve this viewer, by name; `name` narrows to one. */
export async function catalog(db: D1Database, since: string, viewer?: string, name?: string): Promise<ServedSite[]> {
  const rows = await servable(db, since, viewer, name);
  const bySite = new Map<string, StatRow[]>();
  for (const r of rows) bySite.set(r.site, [...(bySite.get(r.site) ?? []), r]);
  const sites = name ? [await getSite(db, name)].flatMap((s) => (s ? [s] : [])) : await allSites(db);
  return sites.flatMap((s) => {
    const versions = bySite.get(s.name);
    return versions ? [{ ...context(s), operations: bestPerOp(versions) }] : [];
  });
}

const asSite = (s: ServedSite): Site => ({
  name: s.name,
  baseUrl: s.baseUrl,
  ...(s.displayName ? { displayName: s.displayName } : {}),
  ...(s.description ? { description: s.description } : {}),
  operations: s.operations.map((o) => o.operation),
});

/** The site as an index entry; its sha256 is over its served versions, so it changes when one does. */
export const entryOf = (s: ServedSite): IndexEntry => indexEntry(asSite(s), s.operations.map((o) => o.hash).join("\n"));

const foundOp = (o: ServedOp): FoundOp => ({
  name: o.operation.name,
  signature: summarize(o.operation).op,
  ...(o.operation.description ? { description: o.operation.description } : {}),
  status: o.status,
  confirmations: o.confirmations,
  ...(o.successRate !== undefined ? { successRate: o.successRate } : {}),
  ...(o.operation.learnedLoggedIn ? { login: true as const } : {}),
  params: o.operation.params.map((p) => ({
    name: p.name,
    type: p.type,
    required: p.required,
    ...(p.description ? { description: p.description } : {}),
    ...(p.hint ? { hint: p.hint } : {}),
    ...(p.example !== undefined ? { example: p.example } : {}),
  })),
});

/** The sites that answer a query, best first, cut as the client's search cuts (src/registry.ts `search`). */
export function search(sites: ServedSite[], query: string, limit: number): SearchMatch[] {
  const scored = sites
    .map((s) => ({ s, score: score(entryOf(s), query) }))
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  // a site far behind the best answer matched a stray word
  const best = scored[0]?.score ?? 0;
  return scored
    .filter(({ score }) => score > 0 && score * 3 >= best)
    .slice(0, limit)
    .map(({ s }) => ({
      name: s.name,
      domain: s.domain,
      ...(s.displayName ? { displayName: s.displayName } : {}),
      ...(s.description ? { description: s.description } : {}),
      operations: s.operations.map(foundOp),
    }));
}
