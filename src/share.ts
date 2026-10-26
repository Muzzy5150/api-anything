/**
 * Sharing what this install learned or healed with the registry (docs/REGISTRY.md): publish.ts builds
 * and checks each upload, this sends the ones the rules allow, signed, and records the version.
 */
import { cleanCall } from "./clean.js";
import { loadSettings } from "./identity.js";
import { plan } from "./publish.js";
import { registryRequest } from "./registry.js";
import type { Evidence, Status, UploadResult } from "./registry-api.js";
import { flushReports } from "./report.js";
import type { Operation } from "./spec.js";
import { loadSite, updateSite } from "./store.js";

/** The purpose of the check learn_site records from its holdout call: the one kind an automatic share may carry. */
export const HOLDOUT_PURPOSE = "learn_site holdout";

export interface ShareOutcome {
  site: string;
  op: string;
  /** uploaded (or already there, counted as a confirmation) */
  shared: boolean;
  status?: Status;
  hash?: string;
  /** why it was not shared: sharing off in settings, a login or write op without consent, refused */
  reason?: string;
  /** a login or write op: shared only with the user's explicit yes (`consent: true`) */
  needsConsent?: boolean;
  /** what in the upload may be the user's own (an email, an account id), for the caller to show them */
  personal?: string[];
}

/**
 * Uploads each named op of a local site. A public read (learned logged out, clean replay ok, its hosts
 * on its own site) goes automatically when settings allow sharing; anything else only with `consent`.
 * One that holds what may be the user's own waits for their yes too. `parent`: the version it replaces.
 */
export async function shareOps(
  site: string,
  ops: string[],
  o: { evidence: Partial<Evidence>; consent?: boolean; parent?: string; signal?: AbortSignal } = { evidence: {} },
): Promise<ShareOutcome[]> {
  // plan reads no names as all of them
  if (!ops.length) return [];
  let p: ReturnType<typeof plan>;
  try {
    p = plan(site, { ops, evidence: o.evidence, parent: o.parent, consent: o.consent });
  } catch (e) {
    return ops.map((op) => ({ site, op, shared: false, reason: (e as Error).message.split("\n")[0] }));
  }
  const share = loadSettings().share;
  const out: ShareOutcome[] = [];
  for (const op of p.ops) {
    const base = { site: p.site, op: op.op, ...(op.personal.length ? { personal: op.personal } : {}) };
    if (op.errors.length) {
      out.push({ ...base, shared: false, reason: `refused: ${op.errors.join("; ")}` });
      continue;
    }
    // The holdout check learn_site records has args its agent chose as neither of the user's examples (the
    // user's own refuse the share there): it holds back only what needs consent anyway. A check the user
    // recorded (api-anything check), an email, an id, an IP or a literal typed into the page holds an
    // automatic share back.
    const checks = op.upload.operation.checks ?? [];
    const holding = op.personal.filter((x) => {
      const j = /\.checks\[(\d+)\] sends /.exec(x)?.[1];
      return j === undefined || checks[Number(j)]?.purpose !== HOLDOUT_PURPOSE;
    });
    if (!o.consent && !(op.public && share && !holding.length)) {
      out.push({
        ...base,
        shared: false,
        ...(op.public && !holding.length
          ? { reason: "sharing is off in settings (api-anything setup asks)" }
          : {
              needsConsent: true,
              reason: op.public
                ? "it may hold something of the user's own (personal): shared only with their yes"
                : "it needed a login, writes, sends off its site or uses a public credential: shared only with the user's yes",
            }),
      });
      continue;
    }
    try {
      const r = await registryRequest<UploadResult>("/v1/versions", {
        method: "POST",
        body: op.upload,
        signed: true,
        cap: 64 * 1024,
        signal: o.signal,
      });
      record(p.site, op.op, { hash: r.hash, status: r.status });
      out.push({
        ...base,
        shared: true,
        hash: r.hash,
        status: r.status,
        ...(r.reasons?.length ? { reason: r.reasons.join("; ") } : {}),
      });
    } catch (e) {
      out.push({ ...base, shared: false, reason: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/** The local op now is that registry version: its calls report on it. */
function record(site: string, op: string, version: { hash: string; status: string }): void {
  updateSite(site, (s) => ({
    ...s!,
    operations: s!.operations.map((x) => (x.name === op ? { ...x, version } : x)),
  }));
}

/** The op's stored example args, with defaults; undefined when a required param has none. */
function examplesOf(op: Operation): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of op.params) {
    const v = p.example ?? p.default;
    if (v !== undefined) out[p.name] = v;
    else if (p.required) return undefined;
  }
  return out;
}

/**
 * A call healed an op that was the registry version `parent`. When sharing is on and the healed op is
 * public, as a clean replay of its examples shows, it goes up as the version that repairs `parent`.
 */
export async function healBack(
  site: string,
  opName: string,
  parent: string,
  o: { fetchImpl?: typeof fetch; minIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<ShareOutcome | undefined> {
  if (!loadSettings().share) return undefined;
  const op = loadSite(site)?.site.operations.find((x) => x.name === opName);
  // nothing that could be public: no replay is spent on it
  if (!op || op.version || !op.readOnly || op.learnedLoggedIn || op.public?.length) return undefined;
  const args = examplesOf(op);
  if (!args) return undefined;
  const clean = await cleanCall(op, args, { site, fetchImpl: o.fetchImpl, minIntervalMs: o.minIntervalMs });
  if (clean.class !== "ok" && clean.class !== "blocked") return undefined;
  // the registry counts it as a heal only after this install's `fail` report on `parent`: send that first
  await flushReports(o.signal);
  const [shared] = await shareOps(site, [opName], {
    evidence: { cleanReplay: clean.class, healedFrom: parent },
    parent,
    signal: o.signal,
  });
  return shared;
}
