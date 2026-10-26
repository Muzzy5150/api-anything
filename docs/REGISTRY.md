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

> Help build the shared catalog? Your agent will share what it learns from public pages (never logins,
> never your data), report whether calls work, and check a few new operations a day in the background.

The answer is `settings.json` `share: true|false` (default yes). No account.

## Using an operation that exists

1. The agent calls MCP `find_sites` (words, a domain or a URL). The registry's `GET /v1/search`
   answers with each match's operations, their params and status, so the agent can call one next.
   Anyone can upload a site that calls itself Amazon, so search trusts only what other installs
   confirmed:
   - a site with a live op always ranks above a site with only candidates, whatever the score;
   - words never find a site with no live op. A domain or URL query finds it when it names the site's
     own domain;
   - `GET /v1/index`, the home page list and the sitemap leave such a site out. Its page
     (`/sites/:name`) still renders, marked `noindex`.
2. `call_operation` on a site that is not installed fetches it (`GET /v1/sites/:name`) first. Of a
   site fetched this way only the reads run until a human runs `api-anything pull` (the `by: "agent"`
   mark, as before). The call runs on the user's machine: plain HTTP first, the browser if it must.
3. After the call, a report (`POST /v1/reports`): version hash, outcome, tier, ms. No args, no data.
   Reports are batched, sent in the background, and dropped when the registry cannot be reached.

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
4. `shareOps` uploads it (`POST /v1/versions`, signed). A public read goes automatically when
   `share` is on. A login op or a write is uploaded only with the user's yes (CLI prompt, or MCP
   elicitation where the client supports it). The published examples are the agent's chosen second
   example and holdout, never the user's own request.

## Verification by the crowd

A new version is a **candidate**. It is served to others while no live version of that op exists,
marked as such. It becomes **live** once installs other than its uploader report it ok:

| rule | value (env var on the worker) |
|---|---|
| distinct installs reporting ok, uploader excluded | `PROMOTE_KEYS` = 2 |
| of which distinct networks (ASN, else /24 or IPv6 /32, stored hashed) | `PROMOTE_NETWORKS` = 2 |
| a heal (below) | `PROMOTE_HEAL_KEYS` = 1 installs, still `PROMOTE_NETWORKS` networks |
| `wrong` reports | each outweighs two oks |

A version that claims `evidence.healedFrom` is a heal only when the version it names is of the same op
and either `degraded`, or live with a `fail` report from the uploader's own key in the last 7 days.
Otherwise anyone could name a live hash and take its op over with one friend. A heal never needs fewer
networks than a new op, so with the defaults it needs as many installs as one too. It needs fewer only
where `PROMOTE_KEYS` is set above `PROMOTE_NETWORKS`.

Background verification makes the long tail move: an MCP server idle for a minute asks
`GET /v1/verify-jobs` for candidates and calls each with its published examples, plain HTTP only, no
cookies, at most 20 a day, and reports the outcome. A job is a candidate that:

- this key neither uploaded nor reported;
- is served: no live version of its op name shadows it;
- runs at `minTier` 1, over plain HTTP;
- has published examples for every required param;
- belongs to a site that already has a live op. A stranger's fresh site never sends every verifying
  install to a host it watches, which would harvest their IP addresses.

Only public reads are promoted by reports. A version is `review`, served to its uploader only until a
maintainer sets its status (`POST /v1/admin/versions/:hash`), when it:

- was learned while signed in, or its clean replay was neither ok nor a bot wall;
- writes, or is a read sent with a method other than GET or HEAD. The one exception is a POST that
  carries only GraphQL query documents. A persisted query names no document and could be a mutation;
- has a slot with a `cookie:` or `session:` ref: every caller's client would send its own credentials;
- is a new op name on a site that lists `loginCookies` or has an op learned while signed in;
- sends to or opens a host off its site, or lists `public` names;
- holds something the export secret scan flags.

## Maintenance by the crowd

- Every call is a health check. A live version is **degraded** when, among the last 10 reports from
  distinct installs, more than half are `fail` or `wrong` and at least 3 installs failed. Then the
  next best version is served. `auth`, `rate`, `blocked` and `input` say nothing about the op.
- The client already heals an op that drifted. A healed public op uploads automatically as a new
  version with `parent` and `evidence.healedFrom`. Its own failed call of the old version makes it a
  heal (above).
- Identical repairs from many installs hash the same: each upload of an existing version counts as
  its uploader's confirmation.
- Versions of one op are grouped by its site and op name; each version also stores its match (method,
  host, path, GraphQL operationName). The match alone would merge distinct ops that share an endpoint
  (goodreads `getBook` and `getWorkId` both match `/book/show/*`). The best is served: live over
  candidate over degraded, then by success rate, then by confirmations.
- A daily job archives a candidate or degraded version with no ok report in 30 days, and a degraded
  version older than a live version of the same op, which replaced it. It never archives a live
  version: a newer live one may be a takeover. A live version leaves live only by degrading. The job
  deletes versions archived over 30 days ago, with their reports.

## Trust

- A site's name is bound to its domain by its first upload; another domain under that name is refused.
- A new site's name must start with the first label of its registrable domain (`siteOf`): `amazon` for
  amazon.com, `crates` or `crates-io` for crates.io, `lobsters` for lobste.rs, `dominos-au` for
  dominos.com.au. Otherwise the upload is refused with 422 and the reason. A maintainer's seed is exempt.
- The server runs `vetShared` and the export secret scan on every upload, and refuses a spec over 256 KB.
  It checks the declared length first, then reads the body as a stream that stops at the cap. A request
  missing a signature header or with a stale timestamp is refused before any of its body is read.
- A signature covers the method, the path with its query exactly as sent, the timestamp and the body's
  hash. A signature over the bare path does not cover a query.
- The `review` reasons above are never promoted by reports.
- Keys are cheap, so a key counts once per version and promotion needs distinct networks. Uploads and
  reports are rate-limited each hour per key and per network (an IPv4 /24 or an IPv6 /32: one
  subscriber holds a /48 or more). A key first seen less than an hour ago uploads at most 5 versions
  (`NEW_KEY_UPLOADS`). A circuit breaker caps uploads at 300 an hour across all keys
  (`UPLOADS_PER_HOUR_ALL`). Every limit answers 429 with Retry-After.
- Public reads (`/v1/search`, `/v1/sites/:name`, `/v1/index`, `/`, `/sites/:name`, `/sitemap.xml`) are
  cached for 60 s at the edge, keyed by URL. A signed read skips the cache, since it may include the
  signer's own `review` versions.
- A maintainer can block a version or a site.

## What the registry stores

D1 tables: `sites` (name, domain, display fields, notes, first uploader), `versions` (hash, site,
op name, match signature, operation JSON, parent, status, uploader, evidence, timestamps), `reports`
(hash, key, network hash, outcome, tier, at), `keys` (public key, first seen, counts), `rates` (hourly
counters, kept for a day). No args, no response data, no IP addresses.

About the caller, the registry keeps its reports, keyed by install key and time, and nothing else:
no account, no IP address (a network is a salted hash, used to count distinct networks and for rate
limits), no search queries. Workers observability logs are off (`registry/wrangler.jsonc`), so request
URLs, and the queries in them, are not stored.
