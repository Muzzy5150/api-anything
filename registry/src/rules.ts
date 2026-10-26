/**
 * How reports move a version between statuses, and which version of an op is served. Pure: the store
 * gathers the facts, these decide. docs/REGISTRY.md "Verification by the crowd" and "Maintenance by the crowd".
 */
import type { Outcome, Status } from "../../src/registry-api.js";

export interface Thresholds {
  /** distinct installs reporting ok, the uploader excluded */
  promoteKeys: number;
  /** of which distinct networks */
  promoteNetworks: number;
  /** for a heal of a live version */
  promoteHealKeys: number;
  /** the latest reports from distinct installs that degradation looks at */
  degradeWindow: number;
  /** installs among those that must have failed */
  degradeMinFailed: number;
  /** reports older than this count for nothing; a version with no ok in it is archived */
  recentDays: number;
  uploadsPerHour: number;
  reportsPerHour: number;
}

/** Each threshold from the env var of its name (a Worker var is a string), else its default. */
export function thresholds(env: object): Thresholds {
  const n = (name: string, fallback: number) => {
    const raw = (env as Record<string, unknown>)[name];
    const v = Number(raw);
    return typeof raw === "string" && raw.trim() !== "" && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    promoteKeys: n("PROMOTE_KEYS", 2),
    promoteNetworks: n("PROMOTE_NETWORKS", 2),
    promoteHealKeys: n("PROMOTE_HEAL_KEYS", 1),
    degradeWindow: n("DEGRADE_WINDOW", 10),
    degradeMinFailed: n("DEGRADE_MIN_FAILED", 3),
    recentDays: n("RECENT_DAYS", 30),
    uploadsPerHour: n("UPLOADS_PER_HOUR", 30),
    reportsPerHour: n("REPORTS_PER_HOUR", 2000),
  };
}

/** What the recent reports on one version say; each install counts once, by its latest outcome. */
export interface Facts {
  /** installs other than the uploader whose latest outcome is ok */
  okKeys: number;
  /** distinct networks among those */
  okNetworks: number;
  /** installs whose latest outcome is wrong */
  wrongKeys: number;
  /** a heal of a version that was live */
  heal: boolean;
  /** the latest ok/fail/wrong outcomes of distinct installs, newest first, at most `degradeWindow` */
  latest: Outcome[];
}

/** Outcomes that say something about the op; auth, rate, blocked, input and error say nothing. */
export const ABOUT_OP: readonly Outcome[] = ["ok", "fail", "wrong"];

export function promoted(f: Facts, t: Thresholds): boolean {
  const keys = f.heal ? t.promoteHealKeys : t.promoteKeys;
  const networks = Math.min(t.promoteNetworks, keys);
  // each `wrong` outweighs two oks
  return f.okKeys - 2 * f.wrongKeys >= keys && f.okNetworks >= networks;
}

export function degraded(f: Facts, t: Thresholds): boolean {
  const failed = f.latest.filter((o) => o === "fail" || o === "wrong").length;
  return failed * 2 > f.latest.length && failed >= t.degradeMinFailed;
}

/** The status reports give a version. review, archived and blocked are left to a maintainer and the archive job. */
export function nextStatus(current: Status, f: Facts, t: Thresholds): Status {
  if (current === "candidate") return promoted(f, t) ? "live" : "candidate";
  if (current === "live") return degraded(f, t) ? "degraded" : "live";
  if (current === "degraded") return degraded(f, t) ? "degraded" : "live";
  return current;
}

/** ok / (ok + fail + wrong), or undefined with none of those. */
export function successRate(ok: number, bad: number): number | undefined {
  return ok + bad ? Math.round((ok / (ok + bad)) * 1000) / 1000 : undefined;
}

export interface Rankable {
  status: Status;
  successRate?: number;
  confirmations: number;
  createdAt: string;
}

// review is served only to its uploader, who ranks it as a candidate
const ORDER: Partial<Record<Status, number>> = { live: 0, candidate: 1, review: 1, degraded: 2 };

/** Best first: live, candidate, degraded; then success rate (none ranks below any); then confirmations; then newest. */
export function byRank(a: Rankable, b: Rankable): number {
  return (
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
    (b.successRate ?? -1) - (a.successRate ?? -1) ||
    b.confirmations - a.confirmations ||
    b.createdAt.localeCompare(a.createdAt)
  );
}

export interface Archivable {
  site: string;
  op: string;
  status: Status;
  createdAt: string;
  /** the last ok from an install other than the uploader */
  lastOkAt?: string;
}

/**
 * The versions the daily job archives: a candidate or a degraded version with no ok since `cutoff`, and any
 * version older than a live version of the same op, which replaced it. A live version never times out: it
 * leaves live only by degrading.
 */
export function toArchive<V extends Archivable>(versions: V[], cutoff: string): V[] {
  const newestLive = new Map<string, string>();
  for (const v of versions) {
    const op = `${v.site}\n${v.op}`;
    if (v.status === "live" && v.createdAt > (newestLive.get(op) ?? "")) newestLive.set(op, v.createdAt);
  }
  return versions.filter((v) => {
    const replaced = v.createdAt < (newestLive.get(`${v.site}\n${v.op}`) ?? "");
    const stale = (v.status === "candidate" || v.status === "degraded") && (v.lastOkAt ?? v.createdAt) < cutoff;
    return SERVED.includes(v.status) && (replaced || stale);
  });
}

/** The statuses ever served to someone other than the uploader. */
export const SERVED: readonly Status[] = ["live", "candidate", "degraded"];
