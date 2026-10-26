import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { versionHashText } from "../../src/registry-api.js";
import { IndexSchema } from "../../src/search.js";
import { OperationSchema } from "../../src/spec.js";
import worker from "../src/worker.js";
import { ADMIN, evidence, install, op, registry, report, seed, send, signed, site, upload } from "./helpers.js";

const NET1 = "198.51.100.7";
const NET2 = "192.0.2.44";

describe("signatures", () => {
  test("a valid signature uploads; the hash is sha256 of versionHashText", async () => {
    const { env } = registry();
    const r = await send(env, "POST", "/v1/versions", { as: install(), body: upload() });
    assert.equal(r.status, 201, r.text);
    const expected = createHash("sha256")
      .update(versionHashText("books", OperationSchema.parse(op())))
      .digest("hex");
    assert.deepEqual(r.body, { hash: expected, status: "candidate", duplicate: false });
  });

  test("an unsigned upload, a wrong key, a stale timestamp and a tampered body are refused", async () => {
    const { env } = registry();
    const a = install();
    const b = install();
    const body = JSON.stringify(upload());
    const unsigned = await send(env, "POST", "/v1/versions", { body });
    assert.equal(unsigned.status, 401);

    const wrongKey = await send(env, "POST", "/v1/versions", {
      body,
      headers: { ...signed(a, "POST", "/v1/versions", body), "x-aa-key": b.key },
    });
    assert.equal(wrongKey.status, 401);
    assert.match(wrongKey.body.error, /does not match/);

    const stale = await send(env, "POST", "/v1/versions", { as: a, body, ts: Date.now() - 6 * 60_000 });
    assert.equal(stale.status, 401);
    assert.match(stale.body.error, /5 minutes/);

    const tampered = await send(env, "POST", "/v1/versions", {
      body: body.replace("dune", "dunf"),
      headers: signed(a, "POST", "/v1/versions", body),
    });
    assert.equal(tampered.status, 401);

    const partial = await send(env, "POST", "/v1/versions", { body, headers: { "x-aa-key": a.key } });
    assert.equal(partial.status, 401);
  });

  test("a GET signs its path with the query", async () => {
    const { env } = registry();
    const r = await send(env, "GET", "/v1/verify-jobs?limit=3", { as: install() });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { jobs: [] });
  });
});

describe("uploads", () => {
  test("refuses a spec that fails the schema, the domain check, the shared rules or the credential check", async () => {
    const { env } = registry();
    const as = install();
    const post = (body: unknown) => send(env, "POST", "/v1/versions", { as, body });

    const schema = await post(upload({ operation: { ...op(), readOnly: undefined } }));
    assert.equal(schema.status, 422);
    assert.ok(
      schema.body.reasons.some((r: string) => r.startsWith("operation.readOnly")),
      schema.text,
    );

    const domain = await post(upload({ site: { ...site, domain: "example.org" } }));
    assert.equal(domain.status, 422);
    assert.match(domain.body.reasons[0], /not baseUrl's site example.com/);

    const http = await post(upload({ site: { ...site, baseUrl: "http://www.example.com" }, operation: op() }));
    assert.equal(http.status, 422);
    assert.ok(
      http.body.reasons.some((r: string) => /not https/.test(r)),
      http.text,
    );

    const credential = await post(
      upload({
        operation: op({
          request: {
            method: "GET",
            url: "https://www.example.com/api/search?q=dune",
            headers: { authorization: "Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0" },
          },
        }),
      }),
    );
    assert.equal(credential.status, 422);
    assert.ok(
      credential.body.reasons.some((r: string) => /literal credential/.test(r)),
      credential.text,
    );

    const badName = await post(upload({ site: { ...site, name: "Books!" } }));
    assert.equal(badName.status, 422);

    const big = await post({ ...upload(), padding: "x".repeat(257 * 1024) });
    assert.equal(big.status, 413);

    const notJson = await send(env, "POST", "/v1/versions", { as, body: "{nope" });
    assert.equal(notJson.status, 400);
  });

  test("the first upload binds a site name to its domain", async () => {
    const { env } = registry();
    const as = install();
    assert.equal((await send(env, "POST", "/v1/versions", { as, body: upload() })).status, 201);
    const other = { ...site, domain: "example.org", baseUrl: "https://www.example.org" };
    const r = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({
        site: other,
        operation: op({
          request: { method: "GET", url: "https://www.example.org/api/search?q=dune", headers: {} },
          trigger: { url: "https://www.example.org/search?q={q}" },
          match: { host: "www.example.org", path: "/api/search" },
        }),
      }),
    });
    assert.equal(r.status, 409);
    assert.match(r.body.reasons[0], /bound to example.com/);
    // the same domain under that name is welcome, with a new op
    const same = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ operation: op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } }) }),
    });
    assert.equal(same.status, 201);
  });

  test("each reason makes a version review", async () => {
    const cases: [string, ReturnType<typeof upload>, RegExp][] = [
      [
        "off-site host",
        upload({
          operation: op({
            trigger: { url: "https://www.example.com/search?q={q}", softFrom: "https://cdn.example.net/" },
          }),
        }),
        /cdn\.example\.net, off its site/,
      ],
      ["login (op)", upload({ operation: op({ learnedLoggedIn: true }) }), /signed in/],
      ["login (evidence)", upload({ evidence: { ...evidence, learnedLoggedIn: true } }), /signed in/],
      [
        "write",
        upload({
          operation: op({
            readOnly: false,
            request: { method: "DELETE", url: "https://www.example.com/api/shelf/1", headers: {} },
          }),
        }),
        /a write/,
      ],
      [
        "public names",
        upload({
          operation: op({
            public: ["x-api-key"],
            request: {
              method: "GET",
              url: "https://www.example.com/api/search?q=dune",
              headers: { "x-api-key": "Zx81Kq0pLm2Nb7Vc" },
            },
          }),
        }),
        /public values: x-api-key/,
      ],
      ["clean replay", upload({ evidence: { ...evidence, cleanReplay: "failed" } }), /clean replay was failed/],
    ];
    for (const [why, body, reason] of cases) {
      const { env } = registry();
      const r = await send(env, "POST", "/v1/versions", { as: install(), body });
      assert.equal(r.status, 201, `${why}: ${r.text}`);
      assert.equal(r.body.status, "review", why);
      assert.ok(
        r.body.reasons.some((x: string) => reason.test(x)),
        `${why}: ${r.text}`,
      );
    }
  });

  test("a client's own `version` record does not change the hash", async () => {
    const { env } = registry();
    const a = await send(env, "POST", "/v1/versions", { as: install(), body: upload() });
    const b = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({
        operation: { ...op(), version: { hash: "0".repeat(64), status: "live" }, learnedAt: "2026-01-01" },
      }),
    });
    assert.equal(b.body.hash, a.body.hash);
    assert.equal(b.body.duplicate, true);
  });
});

describe("verification by the crowd", () => {
  test("a re-upload counts as its uploader's confirmation", async () => {
    const { env } = registry();
    const first = await send(env, "POST", "/v1/versions", { as: install(), body: upload() });
    const again = await send(env, "POST", "/v1/versions", { as: install(), ip: NET1, body: upload() });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { hash: first.body.hash, status: "candidate", duplicate: true });
    const third = await send(env, "POST", "/v1/versions", { as: install(), ip: NET2, body: upload() });
    assert.equal(third.body.status, "live");
  });

  test("promotion takes 2 installs on 2 networks, not counting the uploader", async () => {
    const { env } = registry();
    const uploader = install();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: uploader, body: upload() })).body;
    const status = async () => (await send(env, "GET", "/v1/sites/books")).body.operations[0];

    await report(env, uploader, hash, "ok", NET2);
    await report(env, install(), hash, "ok", NET1);
    assert.equal((await status()).status, "candidate");
    await report(env, install(), hash, "ok", NET1);
    assert.equal((await status()).status, "candidate", "two installs on one network");
    const r = await report(env, install(), hash, "ok", NET2);
    assert.deepEqual(r.body, { accepted: 1, ignored: 0 });
    const served = await status();
    assert.equal(served.status, "live");
    assert.equal(served.confirmations, 3);
    assert.equal(served.successRate, 1);
    assert.ok(served.lastOkAt);
  });

  test("the ASN, when Cloudflare gives one, is the network", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    await send(env, "POST", "/v1/reports", {
      as: install(),
      ip: NET1,
      asn: 7922,
      body: { reports: [{ hash, outcome: "ok" }] },
    });
    await send(env, "POST", "/v1/reports", { as: install(), ip: NET2, asn: 7922, body: [{ hash, outcome: "ok" }] });
    assert.equal((await send(env, "GET", "/v1/sites/books")).body.operations[0].status, "candidate");
  });

  test("an install counts once, by its latest outcome", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    const k = install();
    for (let i = 0; i < 3; i++) await report(env, k, hash, "ok", NET1);
    await report(env, k, hash, "fail", NET1);
    const served = (await send(env, "GET", "/v1/sites/books")).body.operations[0];
    assert.equal(served.confirmations, 0);
    assert.equal(served.successRate, 0);
  });

  test("a heal of a live version is promoted by one confirmation", async () => {
    const { env } = registry();
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const heal = op({ request: { method: "GET", url: "https://www.example.com/api/search?q=dune&v=2", headers: {} } });
    const up = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ operation: heal, parent: live.hash, evidence: { ...evidence, healedFrom: live.hash } }),
    });
    assert.equal(up.body.status, "candidate");
    await report(env, install(), up.body.hash, "ok", NET1);
    const versions = await send(env, "GET", "/v1/sites/books");
    assert.equal(versions.body.operations.length, 1, "one op, two versions");
    assert.equal(versions.body.operations[0].status, "live");
  });

  test("a wrong report outweighs two oks", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    await report(env, install(), hash, "wrong", NET1);
    await report(env, install(), hash, "ok", NET1);
    await report(env, install(), hash, "ok", NET2);
    const status = async () => (await send(env, "GET", "/v1/sites/books")).body.operations[0];
    assert.equal((await status()).status, "candidate");
    await report(env, install(), hash, "ok", "203.0.113.200");
    assert.equal((await status()).status, "candidate");
    await report(env, install(), hash, "ok", "100.64.1.1");
    assert.equal((await status()).status, "live");
    assert.equal((await status()).successRate, 0.8);
  });

  test("auth, rate, blocked and input reports say nothing about the op", async () => {
    const { env } = registry();
    const { hash } = (await seed(env, { site, operations: [op()] })).body.operations[0];
    for (const outcome of ["auth", "rate", "blocked", "input", "input"]) await report(env, install(), hash, outcome);
    const served = (await send(env, "GET", "/v1/sites/books")).body.operations[0];
    assert.equal(served.status, "live");
    assert.equal(served.successRate, undefined);
  });
});

describe("maintenance by the crowd", () => {
  test("a failing live version is degraded and the next best is served", async () => {
    const { env } = registry();
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const next = op({ request: { method: "GET", url: "https://www.example.com/api/search?q=dune&v=2", headers: {} } });
    const cand = (await send(env, "POST", "/v1/versions", { as: install(), body: upload({ operation: next }) })).body;
    const served = async () => (await send(env, "GET", "/v1/sites/books")).body.operations[0];
    assert.equal((await served()).hash, live.hash);

    await report(env, install(), live.hash, "ok");
    await report(env, install(), live.hash, "fail");
    await report(env, install(), live.hash, "fail");
    assert.equal((await served()).hash, live.hash, "two failures are not enough");
    await report(env, install(), live.hash, "wrong");
    const now = await served();
    assert.equal(now.hash, cand.hash);
    assert.equal(now.status, "candidate");

    // more installs that work again bring it back
    for (let i = 0; i < 4; i++) await report(env, install(), live.hash, "ok");
    assert.equal((await served()).hash, live.hash);
  });

  test("a review version is served only to its uploader", async () => {
    const { env } = registry();
    const uploader = install();
    const r = await send(env, "POST", "/v1/versions", {
      as: uploader,
      body: upload({ operation: op({ learnedLoggedIn: true }) }),
    });
    assert.equal(r.body.status, "review");
    assert.equal((await send(env, "GET", "/v1/sites/books")).status, 404);
    assert.equal((await send(env, "GET", "/v1/sites/books", { as: install() })).status, 404);
    const own = await send(env, "GET", "/v1/sites/books", { as: uploader });
    assert.equal(own.status, 200);
    assert.equal(own.body.operations[0].status, "review");
    const found = await send(env, "GET", "/v1/search?q=books");
    assert.deepEqual(found.body.matches, []);
    assert.doesNotMatch((await send(env, "GET", "/")).text, /href="\/sites\/books"/);
  });

  test("verify-jobs: candidates this key neither uploaded nor reported, with example args", async () => {
    const { env } = registry();
    const me = install();
    const other = install();
    const mk = (name: string, over: Record<string, unknown> = {}) =>
      op({ name, match: { host: "www.example.com", path: `/api/${name}` }, ...over });
    const post = async (as: typeof me, operation: unknown, ev: Record<string, unknown> = evidence) =>
      (await send(env, "POST", "/v1/versions", { as, body: upload({ operation, evidence: ev }) })).body.hash;
    const wanted = await post(
      other,
      mk("wanted", {
        params: [
          { name: "q", required: true, example: "dune" },
          { name: "page", type: "number", required: false, default: 1 },
        ],
      }),
    );
    await post(me, mk("mine"));
    const reported = await post(other, mk("reported"));
    await report(env, me, reported, "fail");
    await post(other, mk("review"), { ...evidence, cleanReplay: "skipped" });
    await post(other, mk("noExample", { params: [{ name: "q", required: true }] }));
    await seed(env, { site, operations: [mk("seeded")] });

    const r = await send(env, "GET", "/v1/verify-jobs?limit=20", { as: me });
    assert.deepEqual(r.body.jobs, [{ hash: wanted, site: "books", op: "wanted", args: { q: "dune", page: 1 } }]);
    assert.equal((await send(env, "GET", "/v1/verify-jobs")).status, 401);
  });

  test("the daily job archives versions with no ok in 30 days", async () => {
    const { env, raw } = registry();
    const old = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body.hash;
    const fresh = (
      await send(env, "POST", "/v1/versions", {
        as: install(),
        body: upload({ operation: op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } }) }),
      })
    ).body.hash;
    raw
      .prepare("UPDATE versions SET created_at = ?, updated_at = ? WHERE hash = ?")
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", old);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    const served = (await send(env, "GET", "/v1/sites/books")).body.operations.map((o: { hash: string }) => o.hash);
    assert.deepEqual(served, [fresh]);
    await worker.scheduled({ scheduledTime: Date.now() + 31 * 86_400_000 }, env);
    assert.equal((await send(env, "GET", "/v1/sites/books")).status, 404);
  });
});

describe("rate limits", () => {
  test("uploads per key and per network an hour, with Retry-After", async () => {
    const { env } = registry({ UPLOADS_PER_HOUR: "2" });
    const k = install();
    const mk = (i: number) =>
      upload({ operation: op({ name: `op${i}`, match: { host: "www.example.com", path: `/api/${i}` } }) });
    assert.equal((await send(env, "POST", "/v1/versions", { as: k, ip: NET1, body: mk(1) })).status, 201);
    assert.equal((await send(env, "POST", "/v1/versions", { as: k, ip: NET2, body: mk(2) })).status, 201);
    const over = await send(env, "POST", "/v1/versions", { as: k, ip: "100.64.0.1", body: mk(3) });
    assert.equal(over.status, 429);
    const wait = Number(over.headers.get("retry-after"));
    assert.ok(wait > 0 && wait <= 3600, String(wait));
    // other keys on one network
    assert.equal(
      (await send(env, "POST", "/v1/versions", { as: install(), ip: "100.64.0.2", body: mk(4) })).status,
      201,
    );
    assert.equal(
      (await send(env, "POST", "/v1/versions", { as: install(), ip: "100.64.0.3", body: mk(5) })).status,
      429,
    );
  });

  test("reports count one by one", async () => {
    const { env } = registry({ REPORTS_PER_HOUR: "3" });
    const { hash } = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const k = install();
    const four = Array(4).fill({ hash, outcome: "ok" });
    assert.equal((await send(env, "POST", "/v1/reports", { as: k, body: { reports: four } })).status, 429);
    const many = Array(51).fill({ hash, outcome: "ok" });
    assert.equal((await send(env, "POST", "/v1/reports", { as: install(), body: { reports: many } })).status, 400);
    const unknown = await send(env, "POST", "/v1/reports", {
      as: install(),
      ip: NET2,
      body: { reports: [{ hash: "a".repeat(64), outcome: "ok" }] },
    });
    assert.deepEqual(unknown.body, { accepted: 0, ignored: 1 });
  });
});

describe("admin", () => {
  test("a maintainer blocks a version; nobody else can", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    const path = `/v1/admin/versions/${hash}`;
    assert.equal((await send(env, "POST", path, { body: { status: "blocked" } })).status, 403);
    assert.equal(
      (await send(env, "POST", path, { body: { status: "blocked" }, headers: { authorization: "Bearer nope" } }))
        .status,
      403,
    );
    const ok = await send(env, "POST", path, {
      body: { status: "blocked" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.deepEqual(ok.body, { hash, status: "blocked" });
    assert.equal((await send(env, "GET", "/v1/sites/books")).status, 404);
    const unknown = await send(env, "POST", `/v1/admin/versions/${"b".repeat(64)}`, {
      body: { status: "live" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(unknown.status, 404);
  });

  test("a maintainer can promote a review version", async () => {
    const { env } = registry();
    const r = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ operation: op({ learnedLoggedIn: true }) }),
    });
    await send(env, "POST", `/v1/admin/versions/${r.body.hash}`, {
      body: { status: "live" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal((await send(env, "GET", "/v1/sites/books")).body.operations[0].status, "live");
  });

  test("seed inserts the site context and its ops live, and a re-seed replaces what changed", async () => {
    const { env } = registry();
    const notes = "Search by title words.";
    const first = await seed(env, {
      site: { ...site, notes },
      operations: [op(), op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } })],
    });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(
      first.body.operations.map((o: { status: string }) => o.status),
      ["live", "live"],
    );
    const served = (await send(env, "GET", "/v1/sites/books")).body;
    assert.equal(served.notes, notes);
    assert.equal(served.operations[0].lastOkAt, undefined, "a seed is no ok report");
    assert.equal(served.domain, "example.com");
    assert.deepEqual(
      served.operations.map((o: { status: string; operation: { name: string } }) => [o.operation.name, o.status]),
      [
        ["bookPage", "live"],
        ["searchBooks", "live"],
      ],
    );
    const changed = op({ description: "Find books, better" });
    const again = await seed(env, { site, operations: [changed] });
    const after = (await send(env, "GET", "/v1/sites/books")).body.operations;
    assert.deepEqual(
      after.map((o: { hash: string }) => o.hash),
      [again.body.operations[0].hash],
    );
    assert.equal((await send(env, "POST", "/v1/admin/seed", { body: { site, operations: [op()] } })).status, 403);
    const bad = await seed(env, { site: { ...site, domain: "example.org" }, operations: [op()] });
    assert.equal(bad.status, 422);
  });
});

describe("serving", () => {
  test("search answers SearchMatch with FoundOp params", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    await seed(env, {
      site: { name: "weather", domain: "example.net", baseUrl: "https://www.example.net", description: "Forecasts" },
      operations: [
        op({
          name: "forecast",
          description: "The forecast for a city",
          request: { method: "GET", url: "https://www.example.net/api/forecast?city=paris", headers: {} },
          slots: [{ param: "city", at: ["query:city"] }],
          trigger: { url: "https://www.example.net/?city={city}" },
          match: { host: "www.example.net", path: "/api/forecast" },
          params: [{ name: "city", required: true, example: "paris" }],
        }),
      ],
    });
    const r = await send(env, "GET", "/v1/search?q=book%20ratings");
    assert.equal(r.status, 200);
    assert.equal(r.body.matches.length, 1);
    const [m] = r.body.matches;
    assert.equal(m.name, "books");
    assert.equal(m.domain, "example.com");
    assert.equal(m.displayName, "Books");
    assert.deepEqual(m.operations, [
      {
        name: "searchBooks",
        signature: "searchBooks(q) -> title, avgRating",
        description: "Find books by title words, with their ratings",
        status: "live",
        confirmations: 0,
        params: [{ name: "q", type: "string", required: true, description: "title words", example: "dune" }],
      },
    ]);
    assert.equal((await send(env, "GET", "/v1/search?q=example.net")).body.matches[0].name, "weather");
    assert.equal((await send(env, "GET", "/v1/search")).status, 400);
  });

  test("the index is a RegistryIndex of the best ops", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const r = await send(env, "GET", "/v1/index");
    const index = IndexSchema.parse(r.body);
    assert.equal(index.sites[0]!.site, "books");
    assert.deepEqual(index.sites[0]!.domains, ["example.com"]);
  });

  test("distinct ops on one endpoint are both served; versions of one op name are one", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op(), op({ name: "searchAuthors" })] });
    const names = (await send(env, "GET", "/v1/sites/books")).body.operations.map(
      (o: { operation: { name: string } }) => o.operation.name,
    );
    assert.deepEqual(names, ["searchAuthors", "searchBooks"]);
  });

  test("unknown routes and methods", async () => {
    const { env } = registry();
    assert.equal((await send(env, "GET", "/v1/nothing")).status, 404);
    assert.equal((await send(env, "GET", "/v1/versions")).status, 405);
    assert.equal((await send(env, "GET", "/v1/sites/nobody")).status, 404);
  });
});

describe("pages", () => {
  const hostile = '<script>alert("x")</script>';
  const evil = {
    ...site,
    displayName: `Books ${hostile}`,
    description: `Ratings <img src=x onerror=alert(1)> "quoted"`,
    notes: `- a note with ${hostile} and [a link](javascript:alert(1))\n\n**bold** \`<b>code</b>\``,
  };

  test("a landing page escapes every spec string and runs only its own script", async () => {
    const { env } = registry();
    await seed(env, { site: evil, operations: [op({ description: `Find </td>${hostile}` })] });
    const r = await send(env, "GET", "/sites/books");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    assert.match(r.headers.get("content-security-policy")!, /script-src 'sha256-/);
    assert.doesNotMatch(r.text, /<script>alert|<img src=x|href="javascript:/);
    assert.match(r.text, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.equal(r.text.match(/<script>/g)?.length, 1);
    assert.match(r.text, /npx -y api-anything setup/);
    assert.match(r.text, /api-anything call books searchBooks q=dune/);
    assert.match(r.text, /searchBooks\(q\) -&gt; title, avgRating/);
    assert.match(r.text, /Live/);
    assert.match(r.text, /<strong>bold<\/strong>/);
  });

  test("the home page lists and searches the sites, escaped", async () => {
    const { env } = registry();
    await seed(env, { site: evil, operations: [op()] });
    const home = await send(env, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.text, /href="\/sites\/books"/);
    assert.doesNotMatch(home.text, /<script>alert|<img src=x/);
    const q = await send(env, "GET", `/?q=${encodeURIComponent(`ratings ${hostile}`)}`);
    assert.doesNotMatch(q.text, /<script>alert/);
    assert.match(q.text, /href="\/sites\/books"/);
    const none = await send(env, "GET", "/?q=zzzzzz");
    assert.match(none.text, /No shared site matches/);
    assert.equal((await send(env, "GET", "/sites/nobody")).status, 404);
  });

  test("the sitemap lists every served site", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const r = await send(env, "GET", "/sitemap.xml");
    assert.match(r.headers.get("content-type")!, /xml/);
    assert.match(r.text, /<loc>https:\/\/registry\.test\/sites\/books<\/loc>/);
  });
});
