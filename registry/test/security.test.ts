/** The registry's defences against a hostile uploader: each test reproduces one way in that used to work. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Env } from "../src/worker.js";
import { ADMIN, install, op, registry, seed, send, site, upload } from "./helpers.js";

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
  test("a new site's name starts with its domain's first label; a seed is exempt", async () => {
    const { env } = registry();
    const squat = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload(net("github", { displayName: "GitHub" })),
    });
    assert.equal(squat.status, 422);
    assert.match(squat.body.reasons[0], /first label of its domain example\.net: example.*not github/);
    for (const name of ["example", "example-net", "examplenet"])
      assert.equal((await send(env, "POST", "/v1/versions", { as: install(), body: upload(net(name)) })).status, 201);
    const weather = net("weather");
    assert.equal((await seed(env, { site: weather.site, operations: [weather.operation] })).status, 200);
    // a name already bound to its domain stays welcome
    const again = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ site: weather.site, operation: { ...weather.operation, name: "other" } }),
    });
    assert.equal(again.status, 201, again.text);
  });
});

describe("search poisoning", () => {
  test("a site with no live op is found only by its domain, and a confirmed site ranks above it", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const weather = net("example-weather", { description: "Forecasts" });
    const forecast = { ...weather.operation, name: "forecast", description: "The forecast for a city" };
    await seed(env, { site: weather.site, operations: [forecast] });
    // anyone can upload a site that says it is the books site
    const poison = await uploaded(
      env,
      upload(net("example", { displayName: "Books", description: "Book ratings, the real ones" })),
    );
    assert.equal(poison.status, "candidate");
    const names = async (q: string) =>
      (await send(env, "GET", `/v1/search?q=${encodeURIComponent(q)}`)).body.matches.map(
        (m: { name: string }) => m.name,
      );
    assert.deepEqual(await names("book ratings"), ["example-books"]);
    assert.deepEqual(await names("example"), ["example-books", "example-weather"]);
    // by domain: the live site first, though "example" sorts before it
    assert.deepEqual(await names("example.net"), ["example-weather", "example"]);
    assert.deepEqual(await names("https://www.example.net/search?q=x"), ["example-weather", "example"]);

    const index = (await send(env, "GET", "/v1/index")).body.sites.map((s: { site: string }) => s.site);
    assert.deepEqual(index.sort(), ["example-books", "example-weather"]);
    const home = (await send(env, "GET", "/")).text;
    assert.match(home, /href="\/sites\/example-books"/);
    assert.doesNotMatch(home, /href="\/sites\/example"/);
    assert.doesNotMatch((await send(env, "GET", "/?q=book%20ratings")).text, /href="\/sites\/example"/);
    assert.doesNotMatch((await send(env, "GET", "/sitemap.xml")).text, /sites\/example</);
    // its own page renders, kept out of search engines
    const page = await send(env, "GET", "/sites/example");
    assert.equal(page.status, 200);
    assert.match(page.text, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch((await send(env, "GET", "/sites/example-books")).text, /noindex/);
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
      for (const path of ["/v1/sites/example-books", "/v1/index", "/", "/sitemap.xml"])
        assert.equal((await send(env, "GET", path)).status, 200);
      assert.deepEqual([...store.keys()].map((u) => new URL(u).pathname).sort(), [
        "/",
        "/sitemap.xml",
        "/v1/index",
        "/v1/search",
        "/v1/sites/example-books",
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
