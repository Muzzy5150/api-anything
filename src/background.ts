/**
 * Background verification (docs/REGISTRY.md "Verification by the crowd"): an idle MCP server asks the
 * registry for candidates this install has not reported, calls each with its published args over plain
 * HTTP with no cookies and no session values (clean.ts), only to public addresses, and reports the
 * outcome. At most 20 a day. A candidate that needs the browser (minTier above 1) is skipped: plain HTTP
 * would fail it whether it works or not.
 */
import { join } from "node:path";
import { cleanCall } from "./clean.js";
import { loadSettings } from "./identity.js";
import { registryRequest } from "./registry.js";
import type { ServedSite, VerifyJob } from "./registry-api.js";
import { flushReports, outcomeOf, queueReport, withSignal } from "./report.js";
import { home, readJson, safeName, withLock, writePrivate } from "./session.js";
import { type Operation, parseSite } from "./spec.js";
import { vetShared } from "./vet.js";

export const DAILY_JOBS = 20;
const capFile = () => join(home(), "verify-jobs.json");

/** Count one job against today's cap; false when today's are spent. */
function spend(now: Date): boolean {
  const day = now.toISOString().slice(0, 10);
  return withLock(capFile(), () => {
    let c: { day?: string; count?: number };
    try {
      c = readJson<{ day?: string; count?: number }>(capFile(), {});
    } catch {
      c = {};
    }
    const count = c.day === day ? (c.count ?? 0) : 0;
    if (count >= DAILY_JOBS) return false;
    writePrivate(capFile(), JSON.stringify({ day, count: count + 1 }));
    return true;
  });
}

/** The candidate a job names, as the registry serves its site; not installed, and held to the shared rules. */
async function candidate(
  job: VerifyJob,
  sites: Map<string, Promise<ServedSite>>,
  signal?: AbortSignal,
): Promise<{ site: string; op: Operation } | undefined> {
  const name = safeName(job.site);
  if (!sites.has(name)) sites.set(name, registryRequest<ServedSite>(`/v1/sites/${name}`, { signal }));
  const served = await sites.get(name)!;
  const found = served.operations?.find((o) => o.hash === job.hash && o.operation?.name === job.op);
  if (!found) return undefined;
  const site = parseSite({ name, baseUrl: served.baseUrl, operations: [found.operation] });
  if (vetShared(site).errors.length) return undefined;
  return { site: name, op: site.operations[0]! };
}

/** One round: the jobs the registry has for this install, today's cap allowing. Never throws. */
export async function verifyCandidates(
  o: { fetchImpl?: typeof fetch; signal?: AbortSignal; now?: Date; minIntervalMs?: number } = {},
): Promise<number> {
  if (!loadSettings().share) return 0;
  let ran = 0;
  try {
    const { jobs } = await registryRequest<{ jobs?: VerifyJob[] }>(`/v1/verify-jobs?limit=${DAILY_JOBS}`, {
      signed: true,
      signal: o.signal,
    });
    // one fetch of a site per round, however many of its candidates there are
    const sites = new Map<string, Promise<ServedSite>>();
    for (const job of jobs ?? []) {
      if (o.signal?.aborted) break;
      const c = await candidate(job, sites, o.signal).catch(() => undefined);
      if (!c?.op.readOnly || c.op.minTier > 1) continue;
      if (!spend(o.now ?? new Date())) break;
      const fetchImpl = o.fetchImpl ?? fetch;
      const r = await cleanCall(c.op, job.args ?? {}, {
        site: c.site,
        fetchImpl: o.signal ? withSignal(fetchImpl, o.signal) : fetchImpl,
        minIntervalMs: o.minIntervalMs,
        publicOnly: true,
      });
      ran++;
      const outcome = outcomeOf(r.class);
      if (outcome) queueReport({ hash: job.hash, outcome, tier: 1, ms: r.ms });
    }
  } catch {
    // the registry could not be reached: the next idle minute asks again
  }
  await flushReports(o.signal).catch(() => undefined);
  return ran;
}

/**
 * Runs `verifyCandidates` once the server has been idle for `idleMs`, and flushes reports every
 * `everyMs`. `touch` marks activity; `stop` ends it and the round in flight.
 */
export function idleWork(o: { idleMs?: number; everyMs?: number } = {}): { touch: () => void; stop: () => void } {
  const idleMs = o.idleMs ?? 60_000;
  const stopper = new AbortController();
  let last = Date.now();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    if (Date.now() - last < idleMs) return void flushReports(stopper.signal).catch(() => undefined);
    busy = true;
    void verifyCandidates({ signal: stopper.signal }).finally(() => {
      busy = false;
      last = Date.now();
    });
  }, o.everyMs ?? 5_000);
  timer.unref();
  return {
    touch: () => {
      last = Date.now();
    },
    stop: () => {
      clearInterval(timer);
      stopper.abort();
    },
  };
}
