/** The registry's defences against a hostile uploader: each test reproduces one way in that used to work. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OperationSchema } from "../../src/spec.js";
import { search } from "../src/catalog.js";
import type { Env } from "../src/worker.js";
import { ADMIN, evidence, install, op, registry, report, seed, send, site, upload } from "./helpers.js";

/** A site on example.net, its op on www.example.net. */
const net = (name: string, over: Record<string, unknown> = {}) => ({
  site: { name, domain: "example.net", baseUrl: "https://www.example.net", ...over },
  operation: op({
    request: { method: "GET", url: "https://www.example.net/api/search?q=dune", headers: {} },
    trigger: { url: "https://www.example.net/search?q={q}" },
    match: { host: "www.example.net", path: "/api/search" },
  }),
});

async function uploaded(env: Env, body: unknown): Promise<{ status: string; reasons?: string[] }> {
  const r = await send(env, "POST", "/v1/versions", { as: install(), body });
  assert.equal(r.status, 201, r.text);
  return r.body;
}

describe("reads that write, sent to review", () => {
  const post = (url: string, body: string, over: Record<string, unknown> = {}) =>
    op({
      request: { method: "POST", url, headers: { "content-type": "application/json" }, body },
      match: { host: "www.example.com", path: new URL(url).pathname },
      ...over,
    });

  test("a read sent as POST is review, unless it carries only GraphQL query documents", async () => {
    const { env } = registry();
    const settings = await uploaded(
      env,
      upload({ operation: post("https://www.example.com/account/settings", '{"email":"a@b.example","q":"dune"}') }),
    );
    assert.equal(settings.status, "review");
    assert.ok(
      settings.reasons?.some((x) => /a read sent as POST, not a GraphQL query/.test(x)),
      JSON.stringify(settings),
    );

    const query = await uploaded(
      env,
      upload({
        operation: post(
          "https://www.example.com/graphql",
          '{"query":"query Search($q: String) { search(q: $q) { title } }","variables":{"q":"dune"}}',
          { name: "gqlSearch", slots: [{ param: "q", at: ["json:/variables/q"] }] },
        ),
      }),
    );
    assert.equal(query.status, "candidate", JSON.stringify(query));

    // a persisted query names no document: it could be a mutation
    const persisted = await uploaded(
      env,
      upload({
        operation: post(
          "https://www.example.com/graphql",
          '{"operationName":"Search","variables":{"q":"dune"},"extensions":{"persistedQuery":{"version":1}}}',
          { name: "gqlPersisted", slots: [{ param: "q", at: ["json:/variables/q"] }] },
        ),
      }),
    );
    assert.equal(persisted.status, "review");
  });

  test("a slot that sends the caller's cookie or session value is review", async () => {
    const { env } = registry();
    const r = await uploaded(
      env,
      upload({
        operation: op({
          request: { method: "GET", url: "https://www.example.com/api/search?q=dune", headers: { "x-csrf": "x" } },
          slots: [
            { param: "q", at: ["query:q"] },
            { ref: "cookie:csrftoken", at: ["header:x-csrf"] },
          ],
        }),
      }),
    );
    assert.equal(r.status, "review");
    assert.ok(
      r.reasons?.some((x) => /caller's own cookie:csrftoken/.test(x)),
      JSON.stringify(r),
    );
  });

  test("a new op name on a site with a login is review; a new version of an op it has is not", async () => {
    const bookPage = op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } });
    const variant = op({ description: "Find books by title words, again" });

    const cookies = registry();
    await seed(cookies.env, { site: { ...site, loginCookies: ["sessionid"] }, operations: [op()] });
    const added = await uploaded(cookies.env, upload({ operation: bookPage }));
    assert.equal(added.status, "review");
    assert.ok(
      added.reasons?.some((x) => /new op on a site with a login: bookPage/.test(x)),
      JSON.stringify(added),
    );
    assert.equal((await uploaded(cookies.env, upload({ operation: variant }))).status, "candidate");

    const loginOp = registry();
    const shelf = op({ name: "shelf", learnedLoggedIn: true, match: { host: "www.example.com", path: "/api/shelf" } });
    await seed(loginOp.env, { site, operations: [op(), shelf] });
    assert.equal((await uploaded(loginOp.env, upload({ operation: bookPage }))).status, "review");

    // a first upload that lists login cookies itself
    const fresh = registry();
    const first = await uploaded(fresh.env, upload({ site: { ...site, loginCookies: ["sessionid"] } }));
    assert.equal(first.status, "review");
  });
});

describe("site names", () => {
  test("a new site's name is its domain with dots as dashes; a seed is exempt", async () => {
    const { env } = registry();
    for (const name of ["github", "example", "examplenet", "example.net"]) {
      const r = await send(env, "POST", "/v1/versions", { as: install(), body: upload(net(name)) });
      assert.equal(r.status, 422, name);
      assert.match(r.body.reasons[0], new RegExp(`domain example\\.net with dots as dashes: example-net, not ${name}`));
    }
    assert.equal(
      (await send(env, "POST", "/v1/versions", { as: install(), body: upload(net("example-net")) })).status,
      201,
    );
    const weather = net("weather");
    assert.equal((await seed(env, { site: weather.site, operations: [weather.operation] })).status, 200);
    // a name already bound to its domain stays welcome
    const again = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ site: weather.site, operation: weather.operation }),
    });
    assert.equal(again.status, 200, again.text);
  });

  test("an uploaded title is ignored: a site nobody seeded is titled by its domain", async () => {
    const { env } = registry();
    await uploaded(env, upload(net("example-net", { displayName: "GitHub", description: "Repositories" })));
    const served = (await send(env, "GET", "/v1/sites/example-net")).body;
    assert.equal(served.displayName, "example.net");
    assert.equal((await seed(env, { site, operations: [op()] })).status, 200);
    assert.equal((await send(env, "GET", "/v1/sites/example-com")).body.displayName, "Books", "a seed keeps its own");
  });
});

describe("drive-by ops on established sites", () => {
  const follow = op({
    name: "follow",
    description: "List follows",
    request: { method: "GET", url: "https://www.example.com/api/friendships/create?screen_name=x", headers: {} },
    slots: [{ param: "q", at: ["query:screen_name"] }],
    trigger: { url: "https://www.example.com/{q}" },
    match: { host: "www.example.com", path: "/api/friendships/create" },
  });

  test("a new op name on a seeded or live site is review; a new version of an op it has is not", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const added = await uploaded(env, upload({ operation: follow }));
    assert.equal(added.status, "review");
    assert.ok(
      added.reasons?.some((x) => /new op on an established site: follow/.test(x)),
      JSON.stringify(added),
    );
    const variant = op({ description: "Find books by title words, again" });
    assert.equal((await uploaded(env, upload({ operation: variant }))).status, "candidate");

    // live by the crowd, not seeded, counts too
    const crowd = registry();
    const first = await uploaded(crowd.env, upload(net("example-net")));
    await send(crowd.env, "POST", `/v1/admin/versions/${(first as { hash?: string }).hash}`, {
      body: { status: "live" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const extra = { ...net("example-net").operation, name: "extra", match: { host: "www.example.net", path: "/x" } };
    assert.equal(
      (await uploaded(crowd.env, upload({ site: net("example-net").site, operation: extra }))).status,
      "review",
    );
  });

  test("a second name for an established domain is no way around it", async () => {
    const { env } = registry();
    // the seed named it books; the upload rule names it example-com
    await seed(env, { site: { ...site, name: "books" }, operations: [op()] });
    const r = await uploaded(env, upload({ operation: follow }));
    assert.equal(r.status, "review");
    assert.equal((await uploaded(env, upload())).status, "review", "every op of a parallel site is new to it");
  });
});

describe("takeover of a live op", () => {
  test("the incumbent is served ahead of any newer live version until it degrades", async () => {
    const { env } = registry();
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const served = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    const ok = (hash: string, asn: number, ip: string) =>
      send(env, "POST", "/v1/reports", { as: install(), ip, asn, body: { reports: [{ hash, outcome: "ok" }] } });

    // three keys on two ASNs: a heal claim with its own failure, then two oks
    const evil = install();
    await send(env, "POST", "/v1/reports", {
      as: evil,
      ip: "203.0.113.1",
      body: { reports: [{ hash: live.hash, outcome: "fail" }] },
    });
    const attack = op({ description: "ATTACKER", response: { format: "json", pick: ["title"] } });
    const up = await send(env, "POST", "/v1/versions", {
      as: evil,
      ip: "203.0.113.1",
      body: upload({ operation: attack, parent: live.hash, evidence: { ...evidence, healedFrom: live.hash } }),
    });
    await ok(up.body.hash, 64500, "198.51.100.1");
    await ok(up.body.hash, 64501, "192.0.2.1");
    const now = await served();
    assert.equal(now.hash, live.hash, "the incumbent, though the newcomer has the better rate");
    assert.equal(now.operation.description, op().description);

    // a plain upload promoted the same way changes nothing either
    const plain = await send(env, "POST", "/v1/versions", {
      as: install(),
      ip: "203.0.113.2",
      body: upload({ operation: op({ description: "ATTACKER 2" }) }),
    });
    await ok(plain.body.hash, 64502, "198.51.100.2");
    await ok(plain.body.hash, 64503, "192.0.2.2");
    assert.equal((await served()).hash, live.hash);

    // failures from three networks degrade the incumbent: then the oldest newer live version is served
    for (const ip of ["100.64.1.1", "100.64.2.1", "100.64.3.1"]) await report(env, install(), live.hash, "fail", ip);
    assert.equal((await served()).hash, up.body.hash);
  });

  test("a version of an established op with another match is review, even once the incumbent degrades", async () => {
    const { env, raw } = registry();
    const li = { name: "linkedin", domain: "example.com", baseUrl: "https://www.example.com" };
    const at = (path: string, description = "Search people") =>
      op({
        name: "search",
        description,
        request: { method: "GET", url: `https://www.example.com${path}?q=dune`, headers: {} },
        match: { host: "www.example.com", path },
      });
    const live = (await seed(env, { site: li, operations: [at("/api/search")] })).body.operations[0];
    const close = await uploaded(env, upload({ site: li, operation: at("/psettings/close-account", "ATTACKER") }));
    assert.equal(close.status, "review");
    assert.ok(
      close.reasons?.some((x) => /match .*close-account.* differs from the live version's .*\/api\/search/.test(x)),
      JSON.stringify(close),
    );
    // a heal keeps its match: a candidate as before
    const heal = at("/api/search", "Search people, repaired");
    assert.equal((await uploaded(env, upload({ site: li, operation: heal }))).status, "candidate");
    // degrading the incumbent first moves nothing
    raw.prepare("UPDATE versions SET status = 'degraded' WHERE hash = ?").run(live.hash);
    const again = await uploaded(env, upload({ site: li, operation: at("/psettings/close-account", "ATTACKER 2") }));
    assert.equal(again.status, "review");
  });
});

describe("degrading a busy op", () => {
  test("failing networks must outnumber the networks it worked on this week", async () => {
    const { env } = registry();
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const status = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0].status;
    for (let i = 1; i <= 3; i++) await report(env, install(), live.hash, "ok", `198.18.${i}.1`);
    // five failing installs of eight, on three networks: every other rule holds, but no more networks failed than worked
    for (const n of [1, 1, 2, 2, 3]) await report(env, install(), live.hash, "fail", `100.64.${n}.1`);
    assert.equal(await status(), "live", "3 failing networks against 3 that worked");
    await report(env, install(), live.hash, "fail", "100.64.4.1");
    assert.equal(await status(), "degraded", "4 against 3");
  });
});

describe("search poisoning", () => {
  test("a site with no live op is found only by its domain", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    // anyone can upload a site that says it is the books site
    const poison = await uploaded(env, upload(net("example-net", { description: "Book ratings, the real ones" })));
    assert.equal(poison.status, "candidate");
    const matches = async (q: string) => (await send(env, "GET", `/v1/search?q=${encodeURIComponent(q)}`)).body.matches;
    const names = async (q: string) => (await matches(q)).map((m: { name: string }) => m.name);
    assert.deepEqual(await names("book ratings"), ["example-com"]);
    assert.deepEqual(await names("example net"), ["example-com"]);
    assert.deepEqual(await names("example.net"), ["example-net"]);
    assert.deepEqual(await names("https://www.example.net/search?q=x"), ["example-net"]);
    // every match says which domain it calls
    assert.equal((await matches("example.net"))[0].domain, "example.net");
    assert.equal((await matches("book ratings"))[0].domain, "example.com");

    const index = (await send(env, "GET", "/v1/index")).body.sites.map((s: { site: string }) => s.site);
    assert.deepEqual(index, ["example-com"]);
    const home = (await send(env, "GET", "/")).text;
    assert.match(home, /href="\/sites\/example-com"/);
    assert.doesNotMatch(home, /href="\/sites\/example-net"/);
    assert.doesNotMatch((await send(env, "GET", "/?q=book%20ratings")).text, /href="\/sites\/example-net"/);
    assert.doesNotMatch((await send(env, "GET", "/sitemap.xml")).text, /sites\/example-net</);
    // its own page renders, kept out of search engines
    const page = await send(env, "GET", "/sites/example-net");
    assert.equal(page.status, 200);
    assert.match(page.text, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch((await send(env, "GET", "/sites/example-com")).text, /noindex/);
  });

  test("a site with a live op ranks above one with only candidates, whatever the score", () => {
    const served = (name: string, status: "live" | "candidate") => ({
      name,
      domain: "example.net",
      baseUrl: "https://www.example.net",
      operations: [
        {
          hash: "a".repeat(64),
          status,
          confirmations: 0,
          operation: OperationSchema.parse(net(name).operation),
        },
      ],
    });
    const found = search([served("example-net", "candidate"), served("weather", "live")], "example.net", 5);
    assert.deepEqual(
      found.map((m) => m.name),
      ["weather", "example-net"],
    );
  });
});

describe("abuse limits", () => {
  const mk = (i: number) =>
    upload({ operation: op({ name: `op${i}`, match: { host: "www.example.com", path: `/api/${i}` } }) });
  const post = (env: Env, as: ReturnType<typeof install>, ip: string, i: number) =>
    send(env, "POST", "/v1/versions", { as, ip, body: mk(i) });

  test("a key new this hour uploads at most 5 versions", async () => {
    const { env, raw } = registry();
    const k = install();
    for (let i = 0; i < 5; i++) assert.equal((await post(env, k, `100.64.${i}.1`, i)).status, 201);
    const over = await post(env, k, "100.64.9.1", 9);
    assert.equal(over.status, 429);
    assert.match(over.body.error, /new this hour/);
    const wait = Number(over.headers.get("retry-after"));
    assert.ok(wait > 3500 && wait <= 3600, String(wait));
    const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
    raw.prepare("UPDATE keys SET first_seen = ? WHERE key = ?").run(earlier, k.key);
    assert.equal((await post(env, k, "100.64.9.1", 10)).status, 201);
  });

  test("a circuit breaker caps uploads across all keys, with Retry-After", async () => {
    const { env } = registry({ UPLOADS_PER_HOUR_ALL: "3" });
    for (let i = 0; i < 3; i++) assert.equal((await post(env, install(), `100.64.${i}.1`, i)).status, 201);
    const over = await post(env, install(), "100.64.9.1", 9);
    assert.equal(over.status, 429);
    assert.match(over.body.error, /at most 3 uploads an hour/);
    assert.ok(Number(over.headers.get("retry-after")) > 0);
  });

  test("rate limits count an IPv6 /32 as one network", async () => {
    const { env } = registry({ UPLOADS_PER_HOUR: "2" });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await post(env, install(), `2001:db8:${i + 1}::1`, i)).status);
    assert.deepEqual(codes, [201, 201, 429]);
  });
});

describe("edge cache", () => {
  test("public reads are cached 60 s by URL; signed ones and errors never", async () => {
    const store = new Map<string, Response>();
    const g = globalThis as { caches?: unknown };
    const before = g.caches;
    g.caches = {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => {
          store.set(r.url, res);
        },
      },
    };
    try {
      const { env } = registry();
      const { hash } = (await seed(env, { site, operations: [op()] })).body.operations[0];
      const first = await send(env, "GET", "/v1/search?q=book%20ratings");
      assert.equal(first.body.matches.length, 1);
      assert.equal(first.headers.get("cache-control"), "public, max-age=60");
      for (const path of ["/v1/sites/example-com", "/v1/index", "/", "/sitemap.xml"])
        assert.equal((await send(env, "GET", path)).status, 200);
      assert.deepEqual([...store.keys()].map((u) => new URL(u).pathname).sort(), [
        "/",
        "/sitemap.xml",
        "/v1/index",
        "/v1/search",
        "/v1/sites/example-com",
      ]);

      await send(env, "POST", `/v1/admin/versions/${hash}`, {
        body: { status: "blocked" },
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      const again = await send(env, "GET", "/v1/search?q=book%20ratings");
      assert.equal(again.body.matches.length, 1, "from the cache");
      const other = await send(env, "GET", "/v1/search?q=book%20ratings&limit=3");
      assert.equal(other.body.matches.length, 0, "another URL");
      const signedRead = await send(env, "GET", "/v1/search?q=book%20ratings", { as: install() });
      assert.equal(signedRead.body.matches.length, 0, "a signed read skips the cache");
      assert.equal((await send(env, "GET", "/v1/search")).status, 400);
      assert.equal(store.has("https://registry.test/v1/search"), false, "an error is not cached");
    } finally {
      g.caches = before;
    }
  });
});
