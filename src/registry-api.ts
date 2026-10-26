/**
 * The wire contract between the client and the registry service (registry/): what each endpoint takes
 * and answers. docs/REGISTRY.md says why. Both sides import these types; neither adds a field the other
 * does not read without making it optional.
 */
import type { Operation } from "./spec.js";

/** Production registry; API_ANYTHING_REGISTRY overrides it (https, or http to this machine for tests). */
export const REGISTRY_API = "https://api-anything-registry.forth-site.workers.dev";

/**
 * - candidate: uploaded, served to others (marked) while no live version of the op exists
 * - live: confirmed by other installs; the default answer
 * - degraded: failing across installs; served only when nothing better exists
 * - review: outside the automatic rules (a login, a write, another site's host); served only to its uploader
 * - archived: a candidate or degraded version with no ok report in 30 days, or a degraded one a newer live version replaced; never served (a live version is never archived)
 * - blocked: a maintainer's kill switch; never served
 */
export type Status = "candidate" | "live" | "degraded" | "review" | "archived" | "blocked";

/** A call's outcome as a report: the class of `CallResult`, with `wrong` for data an agent saw contradict the page. */
export type Outcome = "ok" | "fail" | "wrong" | "auth" | "blocked" | "rate" | "input" | "error";

/** What a site is, shared by all its operations. A site's name is bound to its domain by the first upload. */
export interface SiteContext {
  /** the site's short name, as `safeName` allows: goodreads, google-flights */
  name: string;
  /** the registrable domain of baseUrl (`siteOf`); the server computes it and refuses a mismatch */
  domain: string;
  baseUrl: string;
  displayName?: string;
  description?: string;
  loginCookies?: string[];
  /** caller notes (the `<site>.md` text before `## Maintainer notes`), at most 8 KB */
  notes?: string;
}

/** What the uploader's client proved before uploading (see learnsite.ts and share.ts). */
export interface Evidence {
  clientVersion: string;
  learnedLoggedIn: boolean;
  /**
   * the op replayed with no cookies and no session values at all. ok: it is public. blocked: a bot wall
   * answered (an Anubis or Cloudflare page): public data behind a wall, which each caller's browser tier
   * passes on its own, so it counts as public too.
   */
  cleanReplay: "ok" | "blocked" | "failed" | "skipped";
  /** a call with args used as neither example */
  holdout?: { args: Record<string, unknown>; ok: boolean; tier?: 1 | 2 | 3 };
  /** the tier the uploader's own successful calls answered at */
  tier?: 1 | 2 | 3;
  /** a heal: the version this one repairs */
  healedFrom?: string;
}

/** POST /v1/versions (signed). The operation is stored as sent, keyed by its hash. */
export interface VersionUpload {
  site: SiteContext;
  operation: Operation;
  /** the version this one replaces (a heal, or a re-learn of the same op) */
  parent?: string;
  evidence: Evidence;
}

export interface UploadResult {
  /** sha256 hex of the canonical operation (see `versionHash`) */
  hash: string;
  status: Status;
  /** the same version was already there: this upload counted as a confirmation */
  duplicate: boolean;
  /** why it is `review`, or why it was refused (then the HTTP status is 4xx) */
  reasons?: string[];
}

/** One op as the registry serves it: the best version of it. */
export interface ServedOp {
  hash: string;
  status: Status;
  /** distinct installs (not the uploader) that reported ok on this version */
  confirmations: number;
  /** ok / (ok + fail + wrong) over the recent window, distinct installs; absent with no reports */
  successRate?: number;
  lastOkAt?: string;
  operation: Operation;
}

/** GET /v1/sites/:name */
export interface ServedSite extends SiteContext {
  operations: ServedOp[];
}

/** One op in a search answer: enough to call it without another round trip. */
export interface FoundOp {
  name: string;
  /** `name(params) -> fields`, as `summarize` in registry.ts writes it */
  signature: string;
  description?: string;
  status: Status;
  confirmations: number;
  successRate?: number;
  login?: true;
  params: { name: string; type: string; required: boolean; description?: string; hint?: string; example?: unknown }[];
}

/** GET /v1/search?q=&limit= */
export interface SearchMatch {
  name: string;
  domain: string;
  displayName?: string;
  description?: string;
  operations: FoundOp[];
}

/** POST /v1/reports (signed), at most 50 per request */
export interface Report {
  hash: string;
  outcome: Outcome;
  tier?: 1 | 2 | 3;
  ms?: number;
}

/** GET /v1/verify-jobs?limit= (signed): candidates this install has not reported, with the args to call them with */
export interface VerifyJob {
  hash: string;
  site: string;
  op: string;
  args: Record<string, unknown>;
}

/**
 * Request signing. An install's key is an Ed25519 key pair made at setup (identity.ts). A signed request
 * carries three headers:
 * - x-aa-key: the raw 32-byte public key, base64url
 * - x-aa-ts: milliseconds since the epoch; the server refuses one more than 5 minutes off
 * - x-aa-sig: base64url Ed25519 signature of `signingText`
 */
export const signingText = (method: string, path: string, ts: string, bodySha256Hex: string) =>
  `${method.toUpperCase()}\n${path}\n${ts}\n${bodySha256Hex}`;

/** The canonical form a version's hash is taken over: keys sorted at every level, no `learnedAt`. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .filter((k) => k !== "learnedAt")
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

/** The text a version's hash (sha256 hex) is taken over: its site's name, then the canonical operation. */
export const versionHashText = (site: string, operation: Operation) => `${site}\n${canonical(operation)}`;
