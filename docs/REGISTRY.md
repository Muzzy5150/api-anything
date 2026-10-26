# The shared registry — design

Agents share one catalog of website operations, and the same agents fill it, verify it and repair
it as a side effect of using it. The registry is a small service (`registry/`, a Cloudflare Worker
with D1) that stores operations and counts reports. Every expensive step — learning, verifying,
repairing — runs on users' machines, which already have the browser, the sessions and home
connections that sites do not block. The wire contract is `src/registry-api.ts`.

## The rule

Nobody does anything only to share or verify. Uploading, verifying and repairing happen as part of
using the tool; a person is asked only to share an operation that needed a login or that writes.

## Setup

`npx api-anything setup` finds the user's agents (Claude Code, Codex, Cursor, Claude Desktop),
connects the MCP server to each (and the skill where the agent takes skills), checks for a Chromium
browser (needed only to learn sites), makes the install's key (`identity.ts`: an Ed25519 pair in
`~/.api-anything/key.json`, 0600) and asks one question:

> Help build the shared catalog? Your agent will share operations it learns from public pages (never
> your cookies or logins), report under this install's anonymous key whether calls work, and test a few
> new operations a day from your network. Site searches go to the catalog either way.

The answer is `settings.json` `share: true|false` (default yes). No account. What it does not change:
`find_sites` sends its words, domain or URL to `GET /v1/search` whether sharing is on or off (the
local specs are searched too, and answer alone when the registry cannot be reached), and so does a
call of a site this machine lacks, which fetches it. The registry sees the request's IP address, as any
web server does, and does not store it.

## Using an operation that exists

1. The agent calls MCP `find_sites` (words, a domain or a URL). The registry's `GET /v1/search`
   answers with each match's operations, their params and status, so the agent can call one next.
2. `call_operation` on a site that is not installed fetches it (`GET /v1/sites/:name`) first. Of a
   site fetched this way only the reads run until a human runs `api-anything pull` (the `by: "agent"`
   mark, as before). The call runs on the user's machine: plain HTTP first, the browser if it must.
3. After the call, a report (`POST /v1/reports`): version hash, outcome, tier, ms. No args, no data.
   Reports are batched, sent in the background, and dropped when the registry cannot be reached. Each
   is signed by the install's key and stored with it and the time it arrived: the key is anonymous, but
   it ties together every report and upload this install makes.

## Learning an operation that does not exist

1. `find_sites` finds nothing, or the site lacks the op. Its `nextCall` is `learn_site`.
2. `learn_site {page URL template, args, args2, args3, intent}` (MCP; CLI `learn`) runs the page with the
   user's own args, picks the request and the fields from the outline (the agent can override), runs
   it again with a second example, and returns the data of the user's own request with the op saved.
3. The client proves it before sharing (`learnsite.ts`):
   - the two-run diff and run 2's data (add's existing rules);
   - a holdout call, with args used as neither example, answers with data;
   - a clean replay: the op called with no cookies and no session values. Ok means it is public; so does
     a bot wall answering (Anubis, Cloudflare): the data is public behind it, and each caller's browser
     tier passes it.
   Before the holdout call sends anything, `learn_site` refuses a request that is no read: a method other
   than GET or HEAD unless it is a GraphQL query sent as POST, a GraphQL mutation, or a param that is the
   whole body or the document. Over MCP the trigger must be an https page on a public host.
4. `shareOps` uploads it (`POST /v1/versions`, signed). A public read goes automatically when
   `share` is on. A login op or a write is uploaded only with the user's yes (CLI prompt, or MCP
   elicitation where the client supports it); the prompt lists what in the upload may be the user's own
   (an email, an id, a literal typed into the page). The published examples are the agent's chosen second
   example and holdout, never the user's own request. An automatic upload carries no checks but
   learn_site's holdout and none of the user's own `<site>.md` notes: a check recorded with
   `api-anything check`, or notes the user wrote, go only with their yes (`publish --yes`). A pulled
   site's notes came from the registry and go back with its heal.
5. A new site's name must start with the first label of its registrable domain (`crates`, `crates-io`
   or `crates.io` for crates.io; `lobsters` for lobste.rs). `learn_site`'s default name does (the host,
   else the registrable domain), and a given `site` that does not is refused before anything runs.

## Verification by the crowd

A new version is a **candidate**. It is served to others while no live version of that op exists,
marked as such. It becomes **live** once installs other than its uploader report it ok:

| rule | value (env var on the worker) |
|---|---|
| distinct installs reporting ok, uploader excluded | `PROMOTE_KEYS` = 2 |
| of which distinct networks (ASN, else /24, stored hashed) | `PROMOTE_NETWORKS` = 2 |
| a heal of a live version (`evidence.healedFrom`) | `PROMOTE_HEAL_KEYS` = 1 |
| `wrong` reports | each outweighs two oks |

Background verification makes the long tail move: an MCP server idle for a minute asks
`GET /v1/verify-jobs` for candidates it has not reported and calls each with its published examples,
plain HTTP only, no cookies, at most 20 a day, and reports the outcome. The calls go from the user's
machine and IP address to the candidates' sites, which are whatever the uploaders named: only https to
a host under a public suffix that resolves to no private, loopback, link-local, CGNAT or unique-local
address, every redirect hop included. A candidate that needs the browser (`minTier` above 1) is
skipped, since plain HTTP would fail it whether it works or not.

Only public reads are promoted by reports. A version that needed a login, writes, sends to a host off
its site, or lists `public` names is `review`: served to its uploader only, until a maintainer sets its
status (`POST /v1/admin/versions/:hash`).

## Maintenance by the crowd

- Every call is a health check. A live version is **degraded** when, among the last 10 reports from
  distinct installs, more than half are `fail` or `wrong` and at least 3 installs failed. Then the
  next best version is served. `auth`, `rate`, `blocked` and `input` say nothing about the op.
- The client already heals an op that drifted. A healed public op uploads automatically as a new
  version with `parent` and `evidence.healedFrom`; one confirmation promotes it. The registry counts it
  as a heal only after the uploader reported `fail` on the parent, so the client sends that report
  before the upload.
- Identical repairs from many installs hash the same: each upload of an existing version counts as
  its uploader's confirmation.
- Versions of one op are grouped by its site and op name; each version also stores its match (method,
  host, path, GraphQL operationName). The match alone would merge distinct ops that share an endpoint
  (goodreads `getBook` and `getWorkId` both match `/book/show/*`). The best is served: live over
  candidate over degraded, then by success rate, then by confirmations.
- A daily job archives a candidate or degraded version with no ok report in 30 days, and any version
  older than a live version of the same op, which replaced it. A live version never times out: it
  leaves live only by degrading.

## Trust

- A site's name is bound to its domain by its first upload; another domain under that name is refused.
- The server runs `vetShared` and the export secret scan on every upload, and refuses a spec over 256 KB.
- A version's hosts off its site, a login or a write make it `review`, never promoted by reports.
- Keys are cheap, so a key counts once per version, promotion needs distinct networks, and uploads and
  reports are rate-limited per key and per IP.
- A signed request signs its method, the path it requests with its query (`url.pathname + url.search`),
  the time and the body's hash (`signingText`).
- A maintainer can block a version or a site.

## What the registry stores

D1 tables: `sites` (name, domain, display fields, notes, first uploader), `versions` (hash, site,
op name, match signature, operation JSON, parent, status, uploader, evidence, timestamps), `reports`
(hash, key, network hash, outcome, tier, at), `keys` (public key, first seen, counts). No args, no
response data, no IP addresses.
