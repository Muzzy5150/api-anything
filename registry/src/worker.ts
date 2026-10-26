/** The registry Worker: the HTTP surface of src/registry-api.ts, the pages, and the daily archive. */
import { z } from "zod";
import type { Report, Status, UploadResult, VerifyJob } from "../../src/registry-api.js";
import type { Operation } from "../../src/spec.js";
import { networksOf, sha256Hex, signer } from "./auth.js";
import { catalog, entryOf, search } from "./catalog.js";
import { CSP, homePage, sitemap, sitePage } from "./pages.js";
import { nextStatus, type Thresholds, thresholds } from "./rules.js";
import {
  addSite,
  addVersion,
  archive,
  archiveOldSeeds,
  count,
  type D1Database,
  facts,
  getSite,
  getVersion,
  putReport,
  reseed,
  seedSite,
  setStatus,
  touchKey,
  touchOk,
  unverified,
  type VersionRow,
  versionsIn,
} from "./store.js";
import {
  HASH,
  matchSig,
  parseOperation,
  readUpload,
  refusals,
  reviewReasons,
  SiteContextSchema,
  versionHash,
} from "./upload.js";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  SALT?: string;
  /** thresholds (rules.ts), e.g. PROMOTE_KEYS */
  [threshold: string]: unknown;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_BODY = 256 * 1024;
const MAX_SEED = 1024 * 1024;
const MAX_REPORTS = 50;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reasons?: string[],
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "public, max-age=60",
    },
  });

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  now: number;
  t: Thresholds;
  /** the start of the recent window, ISO */
  since: string;
  body: Uint8Array<ArrayBuffer>;
}

async function readBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (request.method === "GET" || request.method === "HEAD") return new Uint8Array();
  if (Number(request.headers.get("content-length") ?? 0) > max)
    throw new HttpError(413, `the body is over ${max / 1024} KB`);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > max) throw new HttpError(413, `the body is over ${max / 1024} KB`);
  return body;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);

/** The key that signed the request; `required` refuses an unsigned one. A bad signature is always refused. */
async function keyOf(c: Ctx, required: true): Promise<string>;
async function keyOf(c: Ctx, required: false): Promise<string | undefined>;
async function keyOf(c: Ctx, required: boolean): Promise<string | undefined> {
  const s = await signer(c.request, c.body, c.now);
  if (s && "error" in s) throw new HttpError(401, s.error);
  if (!s && required) throw new HttpError(401, "this endpoint takes a signed request (x-aa-key, x-aa-ts, x-aa-sig)");
  return s?.key;
}

function salt(c: Ctx): string {
  if (!c.env.SALT) throw new HttpError(500, "the registry has no SALT set");
  return c.env.SALT;
}

/** Counts `n` against the key's and the network's hourly budget for `kind`; past either, a 429. */
async function spend(c: Ctx, kind: "upload" | "report", key: string, prefix: string, n: number) {
  const max = kind === "upload" ? c.t.uploadsPerHour : c.t.reportsPerHour;
  const hour = Math.floor(c.now / HOUR);
  const byKey = await count(c.env.DB, `key:${key}`, kind, hour, n);
  const byNet = await count(c.env.DB, `net:${prefix}`, kind, hour, n);
  if (byKey > max || byNet > max)
    throw new HttpError(429, `over ${max} ${kind}s an hour`, undefined, {
      "retry-after": String(Math.ceil(((hour + 1) * HOUR - c.now) / 1000)),
    });
}

/** Applies what the version's reports now say to its status. */
async function recompute(c: Ctx, v: VersionRow): Promise<Status> {
  const status = nextStatus(v.status, await facts(c.env.DB, v, c.since, c.t.degradeWindow), c.t);
  if (status !== v.status) await setStatus(c.env.DB, v.hash, status, new Date(c.now).toISOString());
  return status;
}

/* ------------------------------------------------------------------ reads */

function searchApi(c: Ctx) {
  const q = c.url.searchParams.get("q")?.trim();
  if (!q) throw new HttpError(400, "search takes q: words, a domain or a URL");
  const limit = Math.min(Math.max(Number(c.url.searchParams.get("limit")) || 5, 1), 20);
  return keyOf(c, false)
    .then((viewer) => catalog(c.env.DB, c.since, viewer))
    .then((sites) => json({ matches: search(sites, q, limit) }));
}

async function siteApi(c: Ctx, name: string) {
  const [site] = await catalog(c.env.DB, c.since, await keyOf(c, false), name);
  if (!site) throw new HttpError(404, `no shared site ${name}`);
  return json(site);
}

async function indexApi(c: Ctx) {
  const sites = await catalog(c.env.DB, c.since, await keyOf(c, false));
  return json({ generated: new Date(c.now).toISOString(), sites: sites.map(entryOf) });
}

/** The op's published example args, defaults filled; undefined when a required param has neither. */
function exampleArgs(op: Operation): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of op.params) {
    const v = p.example ?? p.default;
    if (v !== undefined) out[p.name] = v;
    else if (p.required) return undefined;
  }
  return out;
}

async function verifyJobs(c: Ctx) {
  const key = await keyOf(c, true);
  const limit = Math.min(Math.max(Number(c.url.searchParams.get("limit")) || 5, 1), 20);
  // a candidate with no examples cannot be checked, so look past it
  const rows = await unverified(c.env.DB, key, limit * 5);
  const jobs: VerifyJob[] = rows
    .flatMap((r) => {
      const args = exampleArgs(JSON.parse(r.operation) as Operation);
      return args ? [{ hash: r.hash, site: r.site, op: r.op_name, args }] : [];
    })
    .slice(0, limit);
  return json({ jobs });
}

/* ------------------------------------------------------------------ writes */

async function upload(c: Ctx) {
  const key = await keyOf(c, true);
  const { network, prefix } = await networksOf(c.request, salt(c));
  await spend(c, "upload", key, prefix, 1);
  const now = new Date(c.now).toISOString();
  await touchKey(c.env.DB, key, now, 1, 0);
  const u = await readUpload(parseJson(c.body));
  if ("errors" in u) throw new HttpError(422, "the version is refused", u.errors);
  const db = c.env.DB;
  const bound = await getSite(db, u.site.name);
  if (bound && bound.domain !== u.site.domain)
    throw new HttpError(409, "the version is refused", [`the name ${u.site.name} is bound to ${bound.domain}`]);

  const held = await getVersion(db, u.hash);
  if (held) {
    // the same version again: its uploader's confirmation
    await db.batch([
      putReport(db, { hash: u.hash, key, network, outcome: "ok", at: now }),
      touchOk(db, u.hash, key, now),
    ]);
    const status = await recompute(c, held);
    const reasons = held.reasons ? (JSON.parse(held.reasons) as string[]) : undefined;
    return json({ hash: u.hash, status, duplicate: true, ...(reasons ? { reasons } : {}) } satisfies UploadResult);
  }

  const reasons = reviewReasons(u.site, u.operation, u.evidence);
  const from = u.evidence.healedFrom ? await getVersion(db, u.evidence.healedFrom) : null;
  const heal = from?.site === u.site.name && (from.status === "live" || from.status === "degraded");
  const status: Status = reasons.length ? "review" : "candidate";
  await addSite(db, u.site, key, now);
  await addVersion(
    db,
    {
      hash: u.hash,
      site: u.site.name,
      operation: u.operation,
      sig: matchSig(u.operation),
      ...(u.parent ? { parent: u.parent } : {}),
      heal,
      status,
      reasons,
      uploader: key,
      evidence: u.evidence,
    },
    now,
  );
  return json(
    { hash: u.hash, status, duplicate: false, ...(reasons.length ? { reasons } : {}) } satisfies UploadResult,
    201,
  );
}

const ReportSchema = z.object({
  hash: HASH,
  outcome: z.enum(["ok", "fail", "wrong", "auth", "blocked", "rate", "input", "error"]),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  ms: z.number().int().min(0).max(3_600_000).optional(),
});

async function reports(c: Ctx) {
  const key = await keyOf(c, true);
  const raw = parseJson(c.body);
  const list = z
    .array(ReportSchema)
    .max(MAX_REPORTS)
    .safeParse(Array.isArray(raw) ? raw : (raw as { reports?: unknown } | null)?.reports);
  if (!list.success)
    throw new HttpError(400, `the body is { reports: Report[] }, at most ${MAX_REPORTS}`, issues(list.error));
  const { network, prefix } = await networksOf(c.request, salt(c));
  await spend(c, "report", key, prefix, list.data.length);
  const db = c.env.DB;
  const now = new Date(c.now).toISOString();
  const versions = new Map((await versionsIn(db, [...new Set(list.data.map((r) => r.hash))])).map((v) => [v.hash, v]));
  const known: Report[] = list.data.filter((r) => versions.has(r.hash));
  if (known.length)
    await db.batch(
      known.flatMap((r) => [
        putReport(db, { ...r, key, network, at: now }),
        ...(r.outcome === "ok" ? [touchOk(db, r.hash, key, now)] : []),
      ]),
    );
  for (const v of versions.values()) await recompute(c, v);
  await touchKey(db, key, now, 0, known.length);
  return json({ accepted: known.length, ignored: list.data.length - known.length });
}

/* ------------------------------------------------------------------ admin */

async function admin(c: Ctx) {
  const token = c.env.ADMIN_TOKEN;
  const given = c.request.headers.get("authorization") ?? "";
  // compared as digests, so the time taken says nothing about the token
  if (!token || (await sha256Hex(given)) !== (await sha256Hex(`Bearer ${token}`)))
    throw new HttpError(403, "this endpoint takes the maintainer's token");
}

const STATUSES = ["candidate", "live", "degraded", "review", "archived", "blocked"] as const;

async function adminVersion(c: Ctx, hash: string) {
  await admin(c);
  const r = z.object({ status: z.enum(STATUSES) }).safeParse(parseJson(c.body));
  if (!r.success) throw new HttpError(400, `the body is { status: ${STATUSES.join(" | ")} }`, issues(r.error));
  if (!(await getVersion(c.env.DB, hash))) throw new HttpError(404, `no version ${hash}`);
  await setStatus(c.env.DB, hash, r.data.status, new Date(c.now).toISOString());
  return json({ hash, status: r.data.status });
}

async function adminSeed(c: Ctx) {
  await admin(c);
  const r = z.object({ site: SiteContextSchema, operations: z.array(z.unknown()).min(1) }).safeParse(parseJson(c.body));
  if (!r.success)
    throw new HttpError(400, "the body is { site: SiteContext, operations: Operation[] }", issues(r.error));
  const site = r.data.site;
  const ops: Operation[] = [];
  for (const raw of r.data.operations) {
    const p = parseOperation(raw);
    if ("errors" in p) throw new HttpError(422, "the seed is refused", p.errors);
    ops.push(p.op);
  }
  const refused = refusals(site, ops);
  if (refused.length) throw new HttpError(422, "the seed is refused", refused);
  const db = c.env.DB;
  const now = new Date(c.now).toISOString();
  await seedSite(db, site, now);
  const out: { name: string; hash: string; status: Status }[] = [];
  for (const op of ops) {
    const hash = await versionHash(site.name, op);
    const held = await getVersion(db, hash);
    if (held) await reseed(db, hash, now);
    else
      await addVersion(
        db,
        {
          hash,
          site: site.name,
          operation: op,
          sig: matchSig(op),
          heal: false,
          status: "live",
          reasons: [],
          uploader: "seed",
          evidence: { clientVersion: "seed", learnedLoggedIn: op.learnedLoggedIn, cleanReplay: "skipped" },
        },
        now,
      );
    out.push({ name: op.name, hash, status: held?.status === "blocked" ? "blocked" : "live" });
  }
  await archiveOldSeeds(
    db,
    site.name,
    out.map((o) => o.hash),
    now,
  );
  return json({ site: site.name, operations: out });
}

/* ------------------------------------------------------------------ pages */

async function home(c: Ctx) {
  const sites = await catalog(c.env.DB, c.since);
  const q = c.url.searchParams.get("q")?.trim();
  if (!q) return html(homePage(sites, c.url.origin));
  const byName = new Map(sites.map((s) => [s.name, s]));
  const found = search(sites, q, 20).map((m) => byName.get(m.name)!);
  return html(homePage(found, c.url.origin, q));
}

async function landing(c: Ctx, name: string) {
  const [site] = await catalog(c.env.DB, c.since, undefined, name);
  if (!site) return html(homePage([], c.url.origin, name), 404);
  return html(sitePage(site, c.url.origin));
}

async function sitemapXml(c: Ctx) {
  const sites = await catalog(c.env.DB, c.since);
  return new Response(
    sitemap(
      sites.map((s) => s.name),
      c.url.origin,
    ),
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
}

/* ------------------------------------------------------------------ routing */

type Handler = (c: Ctx, param: string) => Promise<Response>;
const NAME = "([a-z0-9][a-z0-9._-]{0,63})";
const ROUTES: [method: string, path: RegExp, handler: Handler, maxBody?: number][] = [
  ["GET", /^\/v1\/search$/, searchApi],
  ["GET", new RegExp(`^/v1/sites/${NAME}$`), siteApi],
  ["GET", /^\/v1\/index$/, indexApi],
  ["GET", /^\/v1\/verify-jobs$/, verifyJobs],
  ["POST", /^\/v1\/versions$/, upload],
  ["POST", /^\/v1\/reports$/, reports],
  ["POST", /^\/v1\/admin\/versions\/([0-9a-f]{64})$/, adminVersion],
  ["POST", /^\/v1\/admin\/seed$/, adminSeed, MAX_SEED],
  ["GET", /^\/$/, home],
  ["GET", new RegExp(`^/sites/${NAME}/?$`), landing],
  ["GET", /^\/sitemap\.xml$/, sitemapXml],
];

async function route(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url);
  const matches = ROUTES.flatMap(([method, re, handler, max]) => {
    const m = re.exec(url.pathname);
    return m ? [{ method, handler, max, param: m[1] ?? "" }] : [];
  });
  if (!matches.length) throw new HttpError(404, `no route ${url.pathname}`);
  // a HEAD is answered as its GET; the runtime drops the body
  const hit = matches.find((m) => m.method === (request.method === "HEAD" ? "GET" : request.method));
  if (!hit) throw new HttpError(405, `${url.pathname} takes ${matches.map((m) => m.method).join(", ")}`);
  const t = thresholds(env);
  const body = await readBody(request, hit.max ?? MAX_BODY);
  const since = new Date(now - t.recentDays * DAY).toISOString();
  return hit.handler({ request, env, url, now, t, since, body }, hit.param);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env, Date.now());
    } catch (e) {
      if (e instanceof HttpError)
        return json({ error: e.message, ...(e.reasons ? { reasons: e.reasons } : {}) }, e.status, e.headers);
      console.error(e);
      return json({ error: "the registry failed on this request" }, 500);
    }
  },

  /** The daily job: archive what nobody has called successfully in the recent window. */
  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    const now = controller.scheduledTime;
    const cutoff = new Date(now - thresholds(env).recentDays * DAY).toISOString();
    const n = await archive(env.DB, cutoff, new Date(now).toISOString(), Math.floor(now / HOUR));
    console.log(`archived ${n} versions`);
  },
};
