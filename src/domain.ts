/** Hosts to sites, with no file or network access, so the registry service shares it. */
import { getDomain } from "tldts";

/**
 * A host's site: its registrable domain by the Public Suffix List, private section included
 * (github.io, run.app, amazonaws.com hosts), so a cookie ref, a Set-Cookie Domain or a browser
 * import never reaches another site. An IP, localhost or a bare suffix is its own site.
 */
export const siteOf = (host: string): string => {
  const h = host.toLowerCase();
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
};
