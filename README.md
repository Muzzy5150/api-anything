# API Anything

[![CI](https://github.com/goodnight000/api-anything/actions/workflows/ci.yml/badge.svg)](https://github.com/goodnight000/api-anything/actions/workflows/ci.yml)

**Your agent uses websites through their own data requests, over plain HTTP, instead of driving a browser.**

```sh
npx -y api-anything setup
```

Then ask your agent for something on any website. If someone already turned that site into
operations, the agent finds them in the shared catalog and calls one. If nobody has, the agent
learns the operation in one tool call, gives you the answer, and shares the operation so the next
person's agent doesn't have to learn it. Every call reports whether the operation still works, so
the agents that use an operation also check it, and an operation that breaks is repaired by the
next agent that meets the failure.

[![Two agents race on the same Google Flights task: one drives Chrome, one calls API Anything](docs/media/agent-race.gif)](docs/media/agent-race.mp4)

<sub>Same agent (Claude Opus 5.5), same prompt, started together. Left: it drives headless Chrome
through Playwright MCP. Right: it calls API Anything's Google Flights operation. Shown at 3× speed with no cuts;
the timers show real elapsed time. Recorded 2026-09-28. [MP4](docs/media/agent-race.mp4) · [how it was recorded](bench/README.md#the-recorded-race)</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/agent-benchmark-dark.svg">
  <img alt="Median time and cost per task. 1 date: browser 12.9 s and $0.166, API Anything 8.4 s and $0.074. 5 dates: browser 41.6 s and $0.154, API Anything 21.1 s and $0.152." src="docs/media/agent-benchmark-light.svg">
</picture>

Across 5 runs of each task, the agent using API Anything answered 1.5 to 2× sooner, read about
half as many tokens, and cost the same or less. All 20 answers were correct.
[Method, raw numbers and limits](bench/README.md).

## Setup

`npx -y api-anything setup` needs Node 22.13 or newer. It:

- finds the agents on your machine (Claude Code, Codex, Cursor, Claude Desktop) and connects the MCP
  server to each, with the agent's own `mcp add` command where it has one. It adds the skill to the
  agents that take skills. Other entries in their configs are left alone, and each file is backed
  up to `<file>.bak-api-anything` before its first edit;
- checks for a Chromium browser (Chrome, Brave, Edge, Chromium, Vivaldi, Arc). One is needed only to
  learn sites; calling shared operations works without it;
- makes this install's key (`~/.api-anything/key.json`). There is no account;
- asks one question: help build the shared catalog? The default is yes. See [Sharing](#sharing).

Run it again at any time: it changes only what is missing. `--dry-run` prints what it would change,
`--yes` or `--no-share` answer the question without asking, and `--agents claude-code,codex` limits
it to those agents. Restart the agent afterwards, then ask it something like "What does Goodreads
rate Piranesi?" [Setup details](docs/QUICKSTART.md) · [for an agent installing it](INSTALL.md)

## How your agent uses it

The MCP server gives the agent six tools:

1. `find_sites` searches the shared catalog and this machine's sites by what the agent needs ("book
   ratings"), a domain or a URL, and answers with each match's operations and their params.
2. `call_operation` calls one. The call runs on your machine: plain HTTP first, the browser only if
   the site needs it. A site from the catalog is fetched on first use, with its reads only.
3. When nothing matches, `learn_site` learns the operation. The agent gives the page URL with a
   placeholder (`https://site.com/search?q={q}`), your value, and two other values of the same kind.
   API Anything loads the page with your value and the second one, picks the data request and the
   fields, calls the new operation with the third value, and replays it once with no cookies. You
   get the answer in the same call. A public read is then shared.
4. `list_sites`, `list_operations` and `login` cover the rest: what is installed, an operation's
   params, and refreshing a session for a site that needs your account.

Learning happens in a headless browser on your machine. The agent picks the values; API Anything
builds the request template without an LLM.

## Sharing

With sharing on, this is what leaves your machine:

- **Operations learned from public pages.** An operation is shared automatically only when it is a
  read, it was learned signed out, and the replay with no cookies worked. Its stored example is the
  agent's second value and its check is the third, never what you asked. Cookies and tokens are
  references in an operation (`cookie:name`), never their values, and a spec holding a live
  credential is refused before it is saved.
- **An operation that needed your login** is shared only after you say yes. The agent asks you
  (through the MCP client's prompt where it supports one), and the command it runs is
  `api-anything publish <site> <op> --yes`.
- **Reports.** After a call: which version of the operation ran, the outcome, the transport tier
  and the time. No arguments and no data.
- **Background checks.** An idle MCP server calls a few new operations a day (at most 20) with their
  published examples, over plain HTTP with no cookies, and reports the outcome.
- **Repairs.** When a call heals a public operation that drifted, the repaired version is shared.

A new operation is a candidate until installs other than its uploader report it working from
different networks; then it is served as live. Operations that write, that needed a login, or that
send to another site's host are never promoted by reports. With sharing off
(`api-anything setup --no-share`), nothing is shared or reported, and the catalog still works for
reads. [How the catalog works](docs/REGISTRY.md)

## Teach it a site from the CLI

`learn` is `learn_site` on the command line:

```sh
api-anything learn 'https://lobste.rs/domains/{domain}' \
  --args domain=github.com --args2 domain=arxiv.org --args3 domain=youtube.com
```

For control over every step (UI steps, a pinned request, a write), `add` takes the trigger, two
examples and the recipe:

```sh
api-anything add hn-demo links \
  --trigger 'https://news.ycombinator.com/from?site={domain}' \
  --example domain=github.com --example2 domain=github.io --match path=/from \
  --html '{"items":"tr.athing","fields":{"title":".titleline > a","url":".titleline > a@href"}}'

api-anything call hn-demo links domain=arxiv.org      # 30 arxiv.org stories, tier 1
```

The headless browser loads the page once for each example. The part of the request that changed with
the input becomes a parameter, and the rest is stored as a template. Writes are learned only with
`add --write`, which aborts the request in the browser, so learning never performs the action.
[Recorded demos](docs/demos/README.md).

## Map a site from an intent

Tell an agent what you need from a site. The [skill](skills/api-anything/SKILL.md) makes it do
this, in order:

1. Ask about whatever the request leaves unclear.
2. Propose operations and wait for your approval.
3. Scout each page with `capture --outline`. This is a summary of what each request returns, so
   the agent doesn't have to read full responses.
4. Build each operation and check it with an input that wasn't an example.

Goodreads has had no public API since 2020. One run took 6.3 minutes and $1.19. It produced
search, book details, an author's books and reviews:

```sh
api-anything call goodreads searchBooks q=piranesi
api-anything call goodreads getBook bookId=50202953
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/goodreads-benchmark-dark.svg">
  <img alt="Goodreads, median of 5 runs. 1 book: browser agent 16.8 s and $0.156, API Anything 14.4 s and $0.048. 5 books: browser 182.5 s and $0.122, API Anything 30.5 s and $0.107." src="docs/media/goodreads-benchmark-light.svg">
</picture>

- **Tested on unseen books.** The test used 30 books that nobody used while building the
  operations. For the 29 books the search found, every checked field matched the page Chrome
  rendered: title, rating, ratings count and pages. All 146 calls went over plain HTTP.
- **Agent comparison.** An agent using the operations answered 5 books in 30.5 s; the browser
  agent took 182.5 s. For one book, it cost a third as much.
- **No agent needed.** A plain script ([`examples/reading-list.mjs`](examples/reading-list.mjs))
  builds the same five-book table in 16 s with no model.

[How it was explored, tested and compared](bench/explore/README.md).

## What's included

22 read operations across 9 sites ship with the package:

- `google-flights`: search, top flights, price calendar
- `hacker-news`
- `x` and `instagram` profiles
- search on `youtube`, `airbnb` and `amazon`
- `linkedin`: profiles, companies and search, with your own login
- `goodreads`: search, books, author lists and reviews, built by the explorer above

They cover selected features, not whole sites. `api-anything ops <site>` lists parameters and
caveats. Everything else comes from the shared catalog or is learned when first needed.

## How it works

- **Learn.** The headless browser records the page's requests for two example inputs. The request that
  followed the inputs becomes a template with slots, and cookies and tokens become references to
  a local store.
- **Call.** Fill the slots and send the request with Node's `fetch`. If the site blocks that,
  fetch from inside a browser page. As a last resort for reads, run the page itself and read its
  own response.
- **Repair.** If the request stops working (a rotated id, a moved field), re-learn it and save
  the new version only after a replay succeeds. Otherwise the call returns an error, not
  someone else's data.
- **Share.** Learned and repaired public reads go to the catalog with what the client proved about
  them; calls report outcomes, and the catalog serves the version that works for the most installs.

[Details](docs/REFERENCE.md#replay-fallback-and-repair) · [design](docs/DESIGN.md) · [catalog](docs/REGISTRY.md)

## Sessions and logins

For a site that needs an account, `api-anything login <site>` first tries to import that
site's cookies from a browser profile you are already signed in to, so there is usually no
password to type. If several profiles are signed in it asks which one, and if none can be
imported it opens a browser window to sign in by hand. A saved operation holds references to
cookies and tokens, never their values, so a refreshed session works without re-learning anything.

A session is kept current where that is possible. Cookies a site sets on a plain-HTTP response,
or while API Anything runs the site's page in the browser, are saved. When a plain-HTTP call comes back
unauthorized, API Anything tries these in order, each at most once, retrying the call after each
one that changes something:

1. re-import from the browser profile you chose at login;
2. take the cookies from its own browser profile, if they differ from the saved ones;
3. for an operation that uses session tokens (a bearer, a CSRF token the page issues), reload
   the page so the site issues fresh ones. For a write, the page's own request is stopped, so it
   is sent only by the retry.

A read whose only credential is a key the site gives every visitor (X's web-app bearer) is
re-learned from the page when the site rotates it. If the call is still unauthorized, it returns `class: "auth"` with the `login` command to run.

Import reads Chrome, Arc, Brave, Edge, Chromium and Firefox profiles on macOS and Linux (on
Linux, not cookies encrypted with the desktop keyring). On Windows, `login` opens the browser
window. [Details](docs/REFERENCE.md#logging-in)

## Limits

- It is a local tool, not a hosted API. Calls use your machine, your network and your sessions.
- `learn_site` learns from one page load per value, from a URL template. A site whose data appears
  only after clicks or typing, or only on in-app navigation, needs the CLI's `capture` and `add`
  with `--steps` or `--soft-from`. It learns reads only.
- A shared operation is someone else's work. Candidates are served marked as such until other
  installs confirm them, and an operation that worked for others can still fail for you (a
  different region, a block on your network).
- Repair can fail. There is no CAPTCHA solving, and if a site challenges real Chrome, you have
  to clear the challenge by hand.
- An operation is proven only as far as its examples and checks go: a holdout value and the
  reports of the installs that called it, not a test suite.
- No write operations are bundled, and writes are never shared automatically. Writes are tested
  only against a local fixture, and they need `--allow-writes`. An HTTP 2xx doesn't prove a
  message was delivered.
- Credentials stay in `~/.api-anything`, and specs hold references, never values. Read each
  site's terms: you are responsible for how you use it.

[All limits](docs/REFERENCE.md#status-and-known-limits)

## Docs

[Setup](docs/QUICKSTART.md) · [For agents installing it](INSTALL.md) · [Catalog design](docs/REGISTRY.md) ·
[Benchmark](bench/README.md) · [Demos](docs/demos/README.md) · [Reference](docs/REFERENCE.md) ·
[Design](docs/DESIGN.md) · [Release checks](docs/RELEASE-READINESS.md) · [Contributing](CONTRIBUTING.md)

MIT licensed.
