/** The registry's SQL over D1. Only the D1 surface below is used, so a test can stand in for it (test/d1.ts). */
import type { Evidence, Outcome, SiteContext, Status } from "../../src/registry-api.js";
import type { Operation } from "../../src/spec.js";
import { ABOUT_OP, type Archivable, type Facts, SERVED } from "./rules.js";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export interface SiteRow {
  name: string;
  domain: string;
  base_url: string;
  display_name: string | null;
  description: string | null;
  login_cookies: string | null;
  notes: string | null;
  first_uploader: string;
}

export interface VersionRow {
  hash: string;
  site: string;
  op_name: string;
  sig: string;
  operation: string;
  status: Status;
  reasons: string | null;
  uploader: string;
  heal: number;
  created_at: string;
  last_ok_at: string | null;
  /** when it first became live: the incumbent of an op is the live version with the earliest */
  live_since: string | null;
  /** the uploader's network hash, as reports store it */
  uploader_network: string | null;
}

/** A version with what its recent reports say. */
export interface StatRow extends VersionRow {
  confirmations: number;
  oks: number;
  bad: number;
}

export const context = (r: SiteRow): SiteContext => ({
  name: r.name,
  domain: r.domain,
  baseUrl: r.base_url,
  ...(r.display_name ? { displayName: r.display_name } : {}),
  ...(r.description ? { description: r.description } : {}),
  ...(r.login_cookies ? { loginCookies: JSON.parse(r.login_cookies) as string[] } : {}),
  ...(r.notes ? { notes: r.notes } : {}),
});

export const getSite = (db: D1Database, name: string) =>
  db.prepare("SELECT * FROM sites WHERE name = ?").bind(name).first<SiteRow>();

export const allSites = async (db: D1Database) =>
  (await db.prepare("SELECT * FROM sites ORDER BY name").all<SiteRow>()).results;

const siteValues = (s: SiteContext, uploader: string, now: string) => [
  s.name,
  s.domain,
  s.baseUrl,
  s.displayName ?? null,
  s.description ?? null,
  s.loginCookies ? JSON.stringify(s.loginCookies) : null,
  s.notes ?? null,
  uploader,
  now,
  now,
];
const SITE_COLUMNS =
  "(name, domain, base_url, display_name, description, login_cookies, notes, first_uploader, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** The first upload binds the name to its domain and sets the site's context; later ones leave it. */
export const addSite = (db: D1Database, s: SiteContext, uploader: string, now: string) =>
  db
    .prepare(`INSERT INTO sites ${SITE_COLUMNS} ON CONFLICT (name) DO NOTHING`)
    .bind(...siteValues(s, uploader, now))
    .run();

/** A maintainer's seed replaces the context, the domain included. */
export const seedSite = (db: D1Database, s: SiteContext, now: string) =>
  db
    .prepare(
      `INSERT INTO sites ${SITE_COLUMNS} ON CONFLICT (name) DO UPDATE SET domain = excluded.domain, base_url = excluded.base_url, display_name = excluded.display_name, description = excluded.description, login_cookies = excluded.login_cookies, notes = excluded.notes, updated_at = excluded.updated_at`,
    )
    .bind(...siteValues(s, "seed", now))
    .run();

export const getVersion = (db: D1Database, hash: string) =>
  db.prepare("SELECT * FROM versions WHERE hash = ?").bind(hash).first<VersionRow>();

export const versionsIn = async (db: D1Database, hashes: string[]) =>
  hashes.length
    ? (
        await db
          .prepare(`SELECT * FROM versions WHERE hash IN (${hashes.map(() => "?").join(", ")})`)
          .bind(...hashes)
          .all<VersionRow>()
      ).results
    : [];

export interface NewVersion {
  hash: string;
  site: string;
  operation: Operation;
  sig: string;
  parent?: string;
  heal: boolean;
  status: Status;
  reasons: string[];
  uploader: string;
  /** the uploader's network hash; a seed has none */
  uploaderNetwork?: string;
  evidence: Evidence;
}

export const addVersion = (db: D1Database, v: NewVersion, now: string) =>
  db
    .prepare(
      "INSERT INTO versions (hash, site, op_name, sig, operation, parent, heal, status, reasons, uploader, evidence, created_at, updated_at, last_ok_at, live_since, uploader_network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      v.hash,
      v.site,
      v.operation.name,
      v.sig,
      JSON.stringify(v.operation),
      v.parent ?? null,
      v.heal ? 1 : 0,
      v.status,
      v.reasons.length ? JSON.stringify(v.reasons) : null,
      v.uploader,
      JSON.stringify(v.evidence),
      now,
      now,
      null,
      v.status === "live" ? now : null,
      v.uploaderNetwork ?? null,
    )
    .run();

/** Sets a status; the first time a version goes live is kept, so an incumbent stays one through a dip. */
export const setStatus = (db: D1Database, hash: string, status: Status, now: string) =>
  db
    .prepare(
      "UPDATE versions SET status = ?, updated_at = ?, live_since = CASE WHEN ? = 'live' THEN COALESCE(live_since, ?) ELSE live_since END WHERE hash = ?",
    )
    .bind(status, now, status, now, hash)
    .run();

/** A seed's version is live from now; a blocked one stays blocked. */
export const reseed = (db: D1Database, hash: string, now: string) =>
  db
    .prepare(
      "UPDATE versions SET status = CASE WHEN status = 'blocked' THEN status ELSE 'live' END, live_since = CASE WHEN status = 'blocked' THEN live_since ELSE COALESCE(live_since, ?) END, updated_at = ? WHERE hash = ?",
    )
    .bind(now, now, hash)
    .run();

/** The seed's earlier versions of a site that this seed no longer has: replaced. */
export async function archiveOldSeeds(db: D1Database, site: string, keep: string[], now: string) {
  const rows = (
    await db
      .prepare(
        "SELECT hash FROM versions WHERE site = ? AND uploader = 'seed' AND status IN ('live', 'candidate', 'degraded')",
      )
      .bind(site)
      .all<{ hash: string }>()
  ).results;
  const old = rows.filter((r) => !keep.includes(r.hash));
  if (old.length)
    await db.batch(
      old.map((r) =>
        db.prepare("UPDATE versions SET status = 'archived', updated_at = ? WHERE hash = ?").bind(now, r.hash),
      ),
    );
}

export interface ReportRow {
  hash: string;
  key: string;
  network: string;
  outcome: Outcome;
  tier?: number;
  ms?: number;
  at: string;
}

/** An install counts once per version: its latest report replaces the one before. */
export const putReport = (db: D1Database, r: ReportRow) =>
  db
    .prepare(
      "INSERT INTO reports (hash, key, network, outcome, tier, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hash, key) DO UPDATE SET network = excluded.network, outcome = excluded.outcome, tier = excluded.tier, ms = excluded.ms, at = excluded.at",
    )
    .bind(r.hash, r.key, r.network, r.outcome, r.tier ?? null, r.ms ?? null, r.at);

/** An ok from someone other than the uploader keeps a version from the archive. */
export const touchOk = (db: D1Database, hash: string, key: string, at: string) =>
  db.prepare("UPDATE versions SET last_ok_at = ? WHERE hash = ? AND uploader <> ?").bind(at, hash, key);

export async function facts(db: D1Database, v: VersionRow, since: string, window: number): Promise<Facts> {
  const counts = await db
    .prepare(
      `SELECT COALESCE(SUM(outcome = 'ok' AND key <> ?), 0) AS okKeys,
        COUNT(DISTINCT CASE WHEN outcome = 'ok' AND key <> ? THEN network END) AS okNetworks,
        COALESCE(SUM(outcome = 'wrong'), 0) AS wrongKeys
      FROM reports WHERE hash = ? AND at >= ?`,
    )
    .bind(v.uploader, v.uploader, v.hash, since)
    .first<{ okKeys: number; okNetworks: number; wrongKeys: number }>();
  const latest = await db
    .prepare(
      `SELECT outcome, network FROM reports WHERE hash = ? AND at >= ? AND outcome IN (${ABOUT_OP.map(() => "?").join(", ")}) ORDER BY at DESC LIMIT ?`,
    )
    .bind(v.hash, since, ...ABOUT_OP, window)
    .all<{ outcome: Outcome; network: string }>();
  const failed = latest.results.filter((r) => r.outcome === "fail" || r.outcome === "wrong");
  return {
    okKeys: counts?.okKeys ?? 0,
    okNetworks: counts?.okNetworks ?? 0,
    wrongKeys: counts?.wrongKeys ?? 0,
    heal: v.heal === 1,
    latest: latest.results.map((r) => r.outcome),
    failedNetworks: new Set(failed.map((r) => r.network)).size,
  };
}

/**
 * The versions a viewer may be served, with their recent report counts: everything served, and the
 * viewer's own `review` versions. `site` narrows to one site.
 */
export async function servable(db: D1Database, since: string, viewer?: string, site?: string): Promise<StatRow[]> {
  const statuses = SERVED.map(() => "?").join(", ");
  return (
    await db
      .prepare(
        `SELECT v.*,
          COALESCE(SUM(r.outcome = 'ok' AND r.key <> v.uploader), 0) AS confirmations,
          COALESCE(SUM(r.outcome = 'ok'), 0) AS oks,
          COALESCE(SUM(r.outcome IN ('fail', 'wrong')), 0) AS bad
        FROM versions v LEFT JOIN reports r ON r.hash = v.hash AND r.at >= ?
        WHERE (v.status IN (${statuses}) OR (v.status = 'review' AND v.uploader = ?))${site ? " AND v.site = ?" : ""}
        GROUP BY v.hash`,
      )
      .bind(since, ...SERVED, viewer ?? "", ...(site ? [site] : []))
      .all<StatRow>()
  ).results;
}

/**
 * Candidates this key neither uploaded nor reported, oldest first: only those served (no live version of
 * the op shadows them), that plain HTTP can call (minTier 1). On a site with no live op, only one some
 * install on another network than the uploader's already reported ok (it found the site by itself), so a
 * stranger's fresh site cannot point every verifying install at a host it watches.
 */
export async function unverified(db: D1Database, key: string, limit: number) {
  return (
    await db
      .prepare(
        `SELECT v.hash, v.site, v.op_name, v.operation FROM versions v
        WHERE v.status = 'candidate' AND v.uploader <> ?
          AND COALESCE(json_extract(v.operation, '$.minTier'), 1) = 1
          AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.hash = v.hash AND r.key = ?)
          AND NOT EXISTS (SELECT 1 FROM versions l WHERE l.site = v.site AND l.op_name = v.op_name AND l.status = 'live')
          AND (EXISTS (SELECT 1 FROM versions l WHERE l.site = v.site AND l.status = 'live')
            OR EXISTS (SELECT 1 FROM reports r WHERE r.hash = v.hash AND r.outcome = 'ok' AND r.key <> v.uploader
              AND r.network <> COALESCE(v.uploader_network, '')))
        ORDER BY v.created_at LIMIT ?`,
      )
      .bind(key, key, limit)
      .all<Pick<VersionRow, "hash" | "site" | "op_name" | "operation">>()
  ).results;
}

/**
 * The op names a site's versions have; whether any was learned signed in; and whether its domain is
 * established: some site on it has a live or seeded op. By domain, so a second name for x.com is no way
 * around the review of new ops on x.
 */
export async function siteOps(
  db: D1Database,
  site: string,
  domain: string,
): Promise<{ opNames: string[]; loginOp: boolean; established: boolean }> {
  const rows = (
    await db
      .prepare(
        "SELECT op_name, MAX(COALESCE(json_extract(operation, '$.learnedLoggedIn'), 0)) AS login FROM versions WHERE site = ? GROUP BY op_name",
      )
      .bind(site)
      .all<{ op_name: string; login: number }>()
  ).results;
  const established = await db
    .prepare(
      "SELECT 1 AS x FROM versions v JOIN sites s ON s.name = v.site WHERE s.domain = ? AND (v.status = 'live' OR v.uploader = 'seed') LIMIT 1",
    )
    .bind(domain)
    .first();
  return { opNames: rows.map((r) => r.op_name), loginOp: rows.some((r) => r.login === 1), established: !!established };
}

/** Whether `key`'s latest report on `hash` is a fail made since `since`. */
export const failedOn = async (db: D1Database, hash: string, key: string, since: string) =>
  !!(await db
    .prepare("SELECT 1 AS x FROM reports WHERE hash = ? AND key = ? AND outcome = 'fail' AND at >= ?")
    .bind(hash, key, since)
    .first());

export const getKey = (db: D1Database, key: string) =>
  db
    .prepare("SELECT first_seen, uploads FROM keys WHERE key = ?")
    .bind(key)
    .first<{ first_seen: string; uploads: number }>();

/** Adds `n` to a subject's count for this hour and answers the new count. */
export async function count(db: D1Database, subject: string, kind: string, hour: number, n: number): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO rates (subject, kind, hour, n) VALUES (?, ?, ?, ?) ON CONFLICT (subject, kind, hour) DO UPDATE SET n = n + excluded.n RETURNING n",
    )
    .bind(subject, kind, hour, n)
    .first<{ n: number }>();
  return row?.n ?? n;
}

export const touchKey = (db: D1Database, key: string, now: string, uploads: number, reports: number) =>
  db
    .prepare(
      "INSERT INTO keys (key, first_seen, uploads, reports) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET uploads = uploads + excluded.uploads, reports = reports + excluded.reports",
    )
    .bind(key, now, uploads, reports)
    .run();

/** Every version that could still be served, with what the archive decision reads. */
export async function archiveCandidates(db: D1Database): Promise<(Archivable & { hash: string })[]> {
  const rows = (
    await db
      .prepare(
        `SELECT hash, site, op_name, status, created_at, last_ok_at FROM versions WHERE status IN (${SERVED.map(() => "?").join(", ")})`,
      )
      .bind(...SERVED)
      .all<Pick<VersionRow, "hash" | "site" | "op_name" | "status" | "created_at" | "last_ok_at">>()
  ).results;
  return rows.map((r) => ({
    hash: r.hash,
    site: r.site,
    op: r.op_name,
    status: r.status,
    createdAt: r.created_at,
    ...(r.last_ok_at ? { lastOkAt: r.last_ok_at } : {}),
  }));
}

/**
 * Archives the given versions, deletes versions archived before `purgeBefore` with their reports, and drops
 * spent rate counters.
 */
export const archive = (db: D1Database, hashes: string[], now: string, hour: number, purgeBefore: string) =>
  db.batch([
    ...hashes.map((h) =>
      db.prepare("UPDATE versions SET status = 'archived', updated_at = ? WHERE hash = ?").bind(now, h),
    ),
    db
      .prepare(
        "DELETE FROM reports WHERE hash IN (SELECT hash FROM versions WHERE status = 'archived' AND updated_at < ?)",
      )
      .bind(purgeBefore),
    db.prepare("DELETE FROM versions WHERE status = 'archived' AND updated_at < ?").bind(purgeBefore),
    db.prepare("DELETE FROM rates WHERE hour < ?").bind(hour - 24),
  ]);
