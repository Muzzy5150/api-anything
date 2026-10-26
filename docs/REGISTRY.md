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
   answers with each match's operations, their params and status, so the agent can call one next. Every
   match, local or the registry's, shows its `domain`, and the tool's description, its `next` and the
   skill tell the agent to check that domain is the site the user means: a site's name and description
   are the uploader's words, and can imitate another site.
   Anyone can upload a site that calls itself Amazon, so search trusts only what other installs
   confirmed:
   - a site with a live op always ranks above a site with only candidates, whatever the score;
   - words never find a site with no live op. A domain or URL query finds it when it names the site's
     own domain;
   - `GET /v1/index`, the home page list and the sitemap leave such a site out. Its page
     (`/sites/:name`) still renders, marked `noindex`.
2. `call_operation` on a site that is not installed fetches it (`GET /v1/sites/:name`) first. Of a
   site fetched this way only the reads run until a human runs `api-anything pull` (the `by: "agent"`
   mark, as before). An op of a fetched or pulled site that is still a `candidate` is called with none of
   the user's cookies or session values, at plain HTTP and in the browser's page fetch: by the review
   rules a candidate is a public read and needs none, and a GET with the user's cookies can still act on
   their account. The call runs on the user's machine: plain HTTP first, the browser if it must.
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
   than GET or HEAD unless it is a GraphQL query sent as POST, a GraphQL mutation, a GraphQL POST that
   carries no query document (a persisted query, named by a hash or an id), or a param that is the whole
   body or the document. Over MCP the trigger must be an https page on a public host.
4. `shareOps` uploads it (`POST /v1/versions`, signed). A public read goes automatically when
   `share` is on. A login op or a write is uploaded only with the user's yes (CLI prompt, or MCP
   elicitation where the client supports it); the prompt lists what in the upload may be the user's own
   (an email, an id, a literal typed into the page). The published examples are the agent's chosen second
   example and holdout, never the user's own request. An automatic upload carries no checks but
   learn_site's holdout and none of the user's own `<site>.md` notes: a check recorded with
   `api-anything check`, or notes the user wrote, go only with their yes (`publish --yes`). A pulled
   site's notes came from the registry and go back with its heal.
5. A new site's name is its registrable domain with dots as dashes (`crates-io` for crates.io,
   `lobste-rs` for lobste.rs); a site the registry already holds keeps its name (a seed's: goodreads.com
   is `goodreads`), and a new op uploaded under another name on that domain goes to review. So
   `learn_site` names a new site after a site this machine has on that host, else the name the registry
   serves the domain under (`sharedName`: `GET /v1/search?q=<domain>`, a match whose `domain` is it;
   not asked for a trigger on this machine or the network), else the slug. `shareOps` uploads a site
   under its own name when it is pulled or bundled or the registry serves its domain under that name,
   and otherwise under the slug, which the outcome's `as` names (`publish.ts` `registryName`,
   `uploadName`).

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

Promotion does not decide what is served. Of the live versions of an op, the **incumbent** (the one live
the longest) is served while it is not degraded, whatever the success rates and confirmations. A newer
live version, a heal included, is served only once the incumbent degrades. A few keys on two networks
can promote a version, but they cannot replace one callers already rely on.

Background verification makes the long tail move: an MCP server idle for a minute asks
`GET /v1/verify-jobs` for candidates and calls each with its published examples, plain HTTP only, no
cookies, at most 20 a day, and reports the outcome. The calls go from the user's machine and IP address,
only over https to a host under a public suffix that resolves to no private, loopback, link-local, CGNAT
or unique-local address, every redirect hop included. A job is a candidate that:

- this key neither uploaded nor reported;
- is served: no live version of its op name shadows it;
- runs at `minTier` 1, over plain HTTP;
- has published examples for every required param;
- belongs to a site that already has a live op, or has ok reports from installs on 2 distinct networks
  other than the uploader's. Those installs found it by themselves, through a domain search or a
  re-learn with the same hash. A stranger's fresh site never sends every verifying install to a host it
  watches, which would harvest their IP addresses. With the default thresholds such a candidate is
  usually promoted by those same reports, so in practice a new site's ops are checked by the installs
  that find it, not by background jobs.

Only public reads are promoted by reports. A version is `review`, served to its uploader only until a
maintainer sets its status (`POST /v1/admin/versions/:hash`), when it:

- was learned while signed in, or its clean replay was neither ok nor a bot wall;
- writes, or is a read sent with a method other than GET or HEAD. The one exception is a POST that
  carries only GraphQL query documents. A persisted query names no document and could be a mutation;
- has a slot with a `cookie:` or `session:` ref: every caller's client would send its own credentials;
- is a new op name on a site that lists `loginCookies` or has an op learned while signed in;
- is a new op name on an established site: some site on its domain has a live or seeded op. Callers
  trust an established site, so a maintainer approves what it newly does (an x.com `follow`). The check
  is by domain, so a second name for the same domain gets around nothing. A new version of an op the
  site already has is no new op;
- on such a site, has a match (method, host, path, GraphQL operationName) other than the op's
  incumbent's: of its live and degraded versions, the one live the longest. A real heal keeps its match,
  since the match is built only from the request's stable identity. A version that turns linkedin
  `search` into a GET of `/psettings/close-account` is never served without a maintainer. Degrading
  the incumbent first changes nothing, since a degraded version still counts;
- sends to or opens a host off its site, or lists `public` names;
- holds something the export secret scan flags.

## Maintenance by the crowd

- Every call is a health check. A live version is **degraded** when, among the last 10 reports from
  distinct installs (`DEGRADE_WINDOW`), more than half are `fail` or `wrong`, at least 3 installs
  failed (`DEGRADE_MIN_FAILED`), those failures come from at least 3 distinct networks
  (`DEGRADE_MIN_NETWORKS`), and the failing networks outnumber the networks whose latest report on it in
  the last 7 days is ok. Fresh keys on one network are cheap, and a handful of VPSes cannot degrade an op
  with real traffic. Then the next best version is served. `auth`, `rate`, `blocked` and `input` say
  nothing about the op.
- The client already heals an op that drifted. A healed public op uploads automatically as a new
  version with `parent` and `evidence.healedFrom`. Its own failed call of the old version makes it a
  heal (above), so the client sends that `fail` report before the upload.
- Identical repairs from many installs hash the same: each upload of an existing version counts as
  its uploader's confirmation.
- Versions of one op are grouped by its site and op name; each version also stores its match (method,
  host, path, GraphQL operationName). The match alone would merge distinct ops that share an endpoint
  (goodreads `getBook` and `getWorkId` both match `/book/show/*`). The best is served: live over
  candidate over degraded; of two live versions the incumbent; otherwise by success rate, then by
  confirmations.
- A daily job archives a candidate or degraded version with no ok report in 30 days, and a degraded
  version older than a live version of the same op, which replaced it. It never archives a live
  version: a newer live one may be a takeover. A live version leaves live only by degrading. The job
  deletes versions archived over 30 days ago, with their reports.

## Trust

- A site's name is bound to its domain by its first upload; another domain under that name is refused.
- A new site's name must be exactly its registrable domain (`siteOf`) with dots turned into dashes:
  `crates-io` for crates.io, `lobste-rs` for lobste.rs, `git-xyz` for git.xyz. Otherwise the upload is
  refused with 422 and the reason. A name is unique by construction and cannot take another site's
  brand. A maintainer's seed is exempt (`goodreads`, `dominos-au`).
- An uploaded `displayName` is ignored: a site nobody seeded is titled by its domain.
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

What these rules leave open:

- A lookalike domain is its own site. Whoever registers github-xyz.com can share `github-xyz-com`, and
  ok reports from installs on 2 networks promote it. Its title is only its domain, but its description
  is the uploader's own. Once it is live, that description ranks for words like any other site's
  ("amazon prices" finds amazon-deals.net next to amazon). No registry rule tells a lookalike from a
  real site. The defence is the agent's: every match carries `domain`, and the agent checks it against
  the site the user meant before calling.
- An op with no ok report from any network in the last 7 days (a seed nobody calls) can be degraded by
  failures from 3 networks. A version with the same match, promoted by 2 networks, is then served. A
  version with a different match still goes to review.
- The edge cache holds a public read for up to 60 s, so a maintainer's block takes up to a minute to
  disappear from search, site and index answers.
- An uploaded site `description` and op descriptions are the uploader's words, shown on its page and
  read by agents as data, never as instructions.

## What the registry stores

D1 tables: `sites` (name, domain, display fields, notes, first uploader), `versions` (hash, site,
op name, match signature, operation JSON, parent, status, uploader and its network hash, evidence,
timestamps including when it first went live), `reports`
(hash, key, network hash, outcome, tier, at), `keys` (public key, first seen, counts), `rates` (hourly
counters, kept for a day). No args, no response data, no IP addresses.

About the caller, the registry keeps its reports, keyed by install key and time, and nothing else:
no account, no IP address (a network is a salted hash, used to count distinct networks and for rate
limits), no search queries. Workers observability logs are off (`registry/wrangler.jsonc`), so request
URLs, and the queries in them, are not stored.
