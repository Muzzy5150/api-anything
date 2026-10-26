/** What an uploaded or seeded version must pass, and what makes one `review`. docs/REGISTRY.md "Trust". */
import { z } from "zod";
import { siteOf } from "../../src/domain.js";
import { type Evidence, type SiteContext, versionHashText } from "../../src/registry-api.js";
import { type Operation, OperationSchema, SiteSchema } from "../../src/spec.js";
import { vetShared } from "../../src/vet.js";
import { sha256Hex } from "./auth.js";

export const HASH = z.string().regex(/^[0-9a-f]{64}$/);
// as the index's site names (src/search.ts IndexEntrySchema)
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SiteContextSchema = z.object({
  name: z.string().regex(NAME, "site name must be lower-case letters, digits, . _ -, at most 64"),
  domain: z.string(),
  baseUrl: z.string(),
  displayName: z.string().max(100).optional(),
  description: z.string().optional(),
  loginCookies: z.array(z.string().max(200)).max(50).optional(),
  notes: z.string().optional(),
});

const Tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const UploadSchema = z.object({
  site: SiteContextSchema,
  operation: z.unknown(),
  parent: HASH.optional(),
  evidence: z.object({
    clientVersion: z.string().max(100),
    learnedLoggedIn: z.boolean(),
    cleanReplay: z.enum(["ok", "failed", "skipped"]),
    holdout: z.object({ args: z.record(z.string(), z.unknown()), ok: z.boolean(), tier: Tier.optional() }).optional(),
    tier: Tier.optional(),
    healedFrom: HASH.optional(),
  }),
});

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);

/** The operation as the registry keys it: parsed, and without the client's own record of where it came from. */
export function parseOperation(input: unknown): { op: Operation } | { errors: string[] } {
  const r = OperationSchema.safeParse(input);
  if (!r.success) return { errors: issues(r.error).map((m) => `operation.${m}`) };
  const { version: _, ...op } = r.data as Operation & { version?: unknown };
  return { op };
}

export const versionHash = (site: string, op: Operation) => sha256Hex(versionHashText(site, op));

/** The request an op matches: method, host, path, GraphQL operationName; stored with each version for maintainers. */
export const matchSig = (op: Operation) =>
  JSON.stringify([
    op.request.method.toUpperCase(),
    op.match.host ?? "",
    op.match.path ?? "",
    op.match.operationName ?? "",
  ]);

/** Why a site context and its ops cannot be shared at all: the domain, the shared rules, the credential checks. */
export function refusals(site: SiteContext, ops: Operation[]): string[] {
  let host: string;
  try {
    host = new URL(site.baseUrl).hostname;
  } catch {
    return [`baseUrl ${site.baseUrl} is not an absolute URL`];
  }
  if (site.domain !== siteOf(host)) return [`domain ${site.domain} is not baseUrl's site ${siteOf(host)}`];
  const spec = SiteSchema.safeParse({
    name: site.name,
    baseUrl: site.baseUrl,
    displayName: site.displayName,
    description: site.description,
    loginCookies: site.loginCookies,
    operations: ops,
  });
  if (!spec.success) return issues(spec.error);
  return vetShared(spec.data, site.notes).errors;
}

/** Hosts an op sends to or opens off its site. */
function offSite(op: Operation, domain: string): string[] {
  const urls = [
    op.request.url,
    op.trigger.url,
    op.trigger.softFrom,
    ...(op.trigger.steps ?? []).map((s) => (s.action === "goto" ? (s.value ?? s.selector) : undefined)),
  ];
  const hosts = urls.flatMap((u) => {
    try {
      return u ? [new URL(u).hostname.toLowerCase()] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(hosts.filter((h) => siteOf(h) !== domain))];
}

/** Why a version is outside the automatic rules: served to its uploader only until a maintainer decides. */
export function reviewReasons(site: SiteContext, op: Operation, evidence: Evidence): string[] {
  const reasons: string[] = [];
  const off = offSite(op, site.domain);
  if (off.length) reasons.push(`sends to or opens ${off.join(", ")}, off its site ${site.domain}`);
  if (op.learnedLoggedIn || evidence.learnedLoggedIn) reasons.push("learned while signed in");
  if (!op.readOnly) reasons.push("a write");
  if (op.public?.length) reasons.push(`lists public values: ${op.public.join(", ")}`);
  if (evidence.cleanReplay !== "ok") reasons.push(`its clean replay was ${evidence.cleanReplay}, not ok`);
  // the export scan's heuristics: a JWT, a bearer, a long blob; they misfire, so a maintainer looks
  const spec = SiteSchema.parse({ name: site.name, baseUrl: site.baseUrl, operations: [op] });
  for (const w of vetShared(spec).warnings) if (w.startsWith("$")) reasons.push(w);
  return reasons;
}

export interface Upload {
  site: SiteContext;
  operation: Operation;
  parent?: string;
  evidence: Evidence;
  hash: string;
}

/** An upload's body, parsed and held to the shared rules, or why it is refused. */
export async function readUpload(body: unknown): Promise<Upload | { errors: string[] }> {
  const r = UploadSchema.safeParse(body);
  if (!r.success) return { errors: issues(r.error) };
  const parsed = parseOperation(r.data.operation);
  if ("errors" in parsed) return parsed;
  const site = r.data.site as SiteContext;
  const errors = refusals(site, [parsed.op]);
  if (errors.length) return { errors };
  // the holdout's args are examples, but the registry keeps no args at all
  const { holdout, ...rest } = r.data.evidence;
  const evidence: Evidence = {
    ...rest,
    ...(holdout ? { holdout: { args: {}, ok: holdout.ok, tier: holdout.tier } } : {}),
  };
  return {
    site,
    operation: parsed.op,
    ...(r.data.parent ? { parent: r.data.parent } : {}),
    evidence,
    hash: await versionHash(site.name, parsed.op),
  };
}
