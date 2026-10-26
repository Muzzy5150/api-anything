/**
 * Sharing what this install learned or healed with the registry, and reporting how calls went.
 * CONTRACT STUB: the registry-client work implements these; learnsite.ts and setup.ts call them.
 */
import type { Evidence, Status } from "./registry-api.js";

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
}

/**
 * Uploads each named op of a local site. A public read (learned logged out, clean replay ok, its hosts
 * on its own site) goes automatically when settings allow sharing; anything else only with `consent`.
 */
export async function shareOps(
  site: string,
  ops: string[],
  o: { evidence: Partial<Evidence>; consent?: boolean } = { evidence: {} },
): Promise<ShareOutcome[]> {
  void o;
  return ops.map((op) => ({ site, op, shared: false, reason: "sharing is not implemented yet" }));
}
