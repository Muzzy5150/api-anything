/**
 * The client side of the shared registry against a stand-in for the service on localhost: what
 * shareOps uploads and when, publish, reports, the heal-back, background verification and the
 * bundled upgrade. No request leaves this machine: each op's site answers through an injected fetch.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DAILY_JOBS, verifyCandidates } from "../src/background.js";
import { call } from "../src/execute.js";
import { ensureKey, saveSettings, signedHeaders } from "../src/identity.js";
import { settle } from "../src/report.js";
import { mergeCapture, saveSession } from "../src/session.js";
import { shareOps } from "../src/share.js";
import { parseSite, type Site } from "../src/spec.js";
import { loadSite, saveSite } from "../src/store.js";
import { type FakeRegistry, hashOf, served, startRegistry } from "./fixture/registry.js";

let fake: FakeRegistry;
let onUpload: FakeRegistry["onUpload"];
before(async () => {
  fake = await startRegistry();
  onUpload = fake.onUpload;
  process.env.API_ANYTHING_REGISTRY = fake.url;
});
after(() => fake.close());
beforeEach(() => {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-share-"));
  fake.onUpload = onUpload;
  fake.sites.clear();
  fake.raw.clear();
  fake.jobs = [];
  fake.received.length = 0;
  fake.down = false;
  fake.hang = false;
});

const shareOn = (share = true) => saveSettings({ share, askedAt: "2026-10-25T00:00:00.000Z" });

const site = (op: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Site =>
  parseSite({
    name: "demo",
    baseUrl: "https://www.example.com",
    operations: [
      {
        name: "search",
        request: { method: "GET", url: "https://www.example.com/api/search?q=kittens", headers: {} },
        slots: [{ param: "q", at: ["query:q"] }],
        params: [{ name: "q", example: "puppies" }],
        trigger: { url: "https://www.example.com/search?q={q}" },
        match: { host: "www.example.com", path: "/api/search" },
        response: { extract: "hits" },
        readOnly: true,
        ...op,
      },
    ],
    ...over,
  });

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const uploads = () => fake.received.filter((r) => r.path === "/v1/versions");
const reportRequests = () => fake.received.filter((r) => r.path === "/v1/reports");

/* ------------------------------------------------------------ shareOps */

test("shareOps: a public read goes automatically, signed, and the local op records its version", async () => {
  shareOn();
  saveSite(site());
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.deepEqual(out, { site: "demo", op: "search", shared: true, hash: out!.hash, status: "candidate" });
  const [u] = fake.uploads();
  assert.equal(out!.hash, hashOf("demo", u!.operation), "the hash is the service's, over the op as sent");
  assert.deepEqual(u!.evidence, {
    clientVersion: u!.evidence.clientVersion,
    learnedLoggedIn: false,
    cleanReplay: "ok",
  });
  assert.match(u!.evidence.clientVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(
    { name: u!.site.name, domain: u!.site.domain, baseUrl: u!.site.baseUrl },
    { name: "demo", domain: "example.com", baseUrl: "https://www.example.com" },
  );
  assert.equal(u!.operation.params[0]!.example, "puppies");
  assert.equal(u!.operation.response.shape, undefined);
  assert.deepEqual(loadSite("demo")!.site.operations[0]!.version, { hash: out!.hash, status: "candidate" });
  assert.equal(uploads()[0]!.verified, true, "signed, and the signature verifies");
});

test("shareOps: a read whose clean replay met a bot wall is public too, and goes automatically", async () => {
  shareOn();
  saveSite(site());
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "blocked" } });
  assert.equal(out!.shared, true, JSON.stringify(out));
  assert.equal(fake.uploads()[0]!.evidence.cleanReplay, "blocked");
});

test("shareOps: a public read's check args do not hold back its automatic share; they stay listed", async () => {
  shareOn();
  saveSite(site({ checks: [{ args: { q: "kittens" }, expect: "result" }] }));
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(out!.shared, true, JSON.stringify(out));
  assert.match(out!.personal!.join("\n"), /checks\[0\] sends q=kittens/);
});

test("shareOps: anything that is not a public read waits for the user's yes", async () => {
  shareOn();
  const cases: [string, Site, Record<string, unknown>][] = [
    ["no clean replay", site(), { cleanReplay: "skipped" }],
    ["the clean replay failed", site(), { cleanReplay: "failed" }],
    ["learned signed in", site({ learnedLoggedIn: true }), { cleanReplay: "ok" }],
    ["signed in, by the evidence", site(), { cleanReplay: "ok", learnedLoggedIn: true }],
    [
      "a write",
      site({
        readOnly: false,
        request: { method: "POST", url: "https://www.example.com/api/save", headers: {}, body: '{"q":"x"}' },
        slots: [{ param: "q", at: ["body", "json:/q"] }],
        match: { host: "www.example.com", path: "/api/save" },
      }),
      { cleanReplay: "ok" },
    ],
    [
      "a host off its site",
      site({
        request: { method: "GET", url: "https://search.other-example.net/q?q=kittens", headers: {} },
        match: { host: "search.other-example.net", path: "/q" },
      }),
      { cleanReplay: "ok" },
    ],
    ["a public name", site({ public: ["x-api-key"] }), { cleanReplay: "ok" }],
  ];
  for (const [what, s, evidence] of cases) {
    saveSite(s);
    const [out] = await shareOps("demo", ["search"], { evidence });
    assert.equal(out!.shared, false, what);
    assert.equal(out!.needsConsent, true, what);
    assert.match(out!.reason ?? "", /only with the user's yes/, what);
  }
  assert.equal(uploads().length, 0, "nothing was sent");

  // with the user's yes, each goes up, and the registry decides it is reviewed
  saveSite(site({ learnedLoggedIn: true }));
  const [yes] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.deepEqual([yes!.shared, yes!.status], [true, "review"]);
  assert.equal(fake.uploads()[0]!.evidence.learnedLoggedIn, true);
});

test("shareOps with sharing off sends nothing on its own; consent still sends", async () => {
  saveSite(site());
  const [off] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.deepEqual(off, { site: "demo", op: "search", shared: false, reason: off!.reason });
  assert.match(off!.reason!, /sharing is off/);
  shareOn(false);
  assert.equal((await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } }))[0]!.shared, false);
  assert.equal(uploads().length, 0);
  const [yes] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.equal(yes!.shared, true);
  assert.deepEqual(await shareOps("demo", [], { evidence: {}, consent: true }), [], "no names is no ops");
  assert.equal(uploads().length, 1);
});

test("shareOps refuses an op holding a live value, consent or not, and shows what may be the user's own", async () => {
  shareOn();
  const token = "Zx9Qw8vLm7Kj6HgF5dS4aP3oI2uY1tRe";
  saveSite(
    site({
      request: { method: "GET", url: "https://www.example.com/api/search?q=kittens", headers: { "x-api-key": token } },
      public: ["x-api-key"],
    }),
  );
  mergeCapture("demo", [], { from: "https://www.example.com/api", values: { "search/x-api-key": token } });
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.equal(out!.shared, false);
  assert.match(out!.reason!, /^refused: .*holds the live session value search\/x-api-key/);
  assert.equal(uploads().length, 0);

  // what may be the user's own: a public read holding it waits for a yes, and a consented one shows it
  saveSession("demo", { cookies: [], values: {} });
  saveSite(site({ description: "my searches, ask me@mail.example.com" }));
  const [held] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.deepEqual([held!.shared, held!.needsConsent], [false, true]);
  assert.match(held!.personal!.join("\n"), /holds an email address \(me@mail\.example\.com\)/);
  const [yes] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.equal(yes!.shared, true);
  assert.match(yes!.personal!.join("\n"), /me@mail\.example\.com/);
});

test("shareOps passes on what the registry refused, and a registry that cannot be reached", async () => {
  shareOn();
  saveSite(site());
  fake.onUpload = () => ({
    status: 409,
    body: { error: "the name demo is bound to another domain", reasons: ["demo is example.org"] },
  });
  const [refused] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(refused!.shared, false);
  assert.match(refused!.reason!, /answered 409: the name demo is bound to another domain; demo is example\.org/);
  fake.down = true;
  assert.match((await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } }))[0]!.reason!, /answered 503/);
  assert.equal(loadSite("demo")!.site.operations[0]!.version, undefined);
  const [none] = await shareOps("demo", ["nosuch"], { evidence: {} });
  assert.match(none!.reason!, /no operation "nosuch" on demo/);
});

test("signed headers carry this install's key and verify with WebCrypto; a changed body does not", async () => {
  const body = JSON.stringify({ reports: [] });
  const h = signedHeaders("POST", "/v1/reports", body);
  assert.equal(h["x-aa-key"], ensureKey().publicKey);
  const send = (text: string) =>
    fetch(`${fake.url}/v1/reports`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: text,
    });
  await send(body);
  await send(JSON.stringify({ reports: [{ hash: "x", outcome: "ok" }] }));
  assert.deepEqual(
    reportRequests().map((r) => r.verified),
    [true, false],
  );
  // a signed GET signs its query, and the empty body
  shareOn();
  await verifyCandidates();
  const jobs = fake.received.find((r) => r.path.startsWith("/v1/verify-jobs"))!;
  assert.equal(jobs.path, `/v1/verify-jobs?limit=${DAILY_JOBS}`);
  assert.equal(jobs.verified, true);
});

/* ------------------------------------------------------------ publish */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function cli(...args: string[]): Promise<{ code: number; out: Record<string, unknown> & { [k: string]: never } }> {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args],
      { cwd: ROOT, env: { ...process.env } },
      (err, stdout) => resolve({ code: err ? Number(err.code ?? 1) : 0, out: JSON.parse(stdout) }),
    ),
  );
}

test("publish previews each upload, what may be yours and the warnings, and --yes sends them with consent", async () => {
  saveSite(
    site(
      {},
      {
        operations: [
          site().operations[0]!,
          { ...site({ name: "mine", learnedLoggedIn: true, description: "ask me@mail.example.com" }).operations[0]! },
        ],
      },
    ),
  );
  const preview = await cli("publish", "demo");
  assert.equal(preview.code, 0, JSON.stringify(preview.out));
  const ups = preview.out.uploads as unknown as { operation: { name: string }; evidence: { cleanReplay: string } }[];
  assert.deepEqual(
    ups.map((u) => u.operation.name),
    ["search", "mine"],
  );
  assert.match((preview.out.personal as unknown as string[]).join("\n"), /me@mail\.example\.com/);
  assert.match((preview.out.warnings as unknown as string[]).join("\n"), /learned while signed in/);
  assert.match(String(preview.out.next), /explicit OK: api-anything publish demo --yes/);
  assert.equal(uploads().length, 0, "a preview sends nothing");

  const one = await cli("publish", "demo", "mine", "--yes");
  assert.equal(one.code, 0, JSON.stringify(one.out));
  const shared = one.out.shared as unknown as { op: string; shared: boolean; status: string }[];
  assert.deepEqual(
    shared.map((s) => [s.op, s.shared, s.status]),
    [["mine", true, "review"]],
  );
  assert.equal(uploads().length, 1);
  assert.equal(uploads()[0]!.verified, true);
  assert.equal(loadSite("demo")!.site.operations.find((o) => o.name === "mine")!.version?.status, "review");

  const unknown = await cli("publish", "demo", "nosuch");
  assert.equal(unknown.code, 1);
  assert.match(String(unknown.out.error), /no operation "nosuch" on demo/);
});

/* ------------------------------------------------------------ reports */

test("a call of a registry version is reported after it returns, with its outcome, tier and time", async () => {
  shareOn();
  saveSite(site({ version: { hash: "a".repeat(64), status: "live" } }));
  const answers: Response[] = [
    json({ hits: [{ t: 1 }] }),
    new Response("slow down", { status: 429 }),
    new Response("boom", { status: 500 }),
  ];
  for (const r of answers) {
    const res = await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl: async () => r });
    assert.ok(res.class, JSON.stringify(res));
  }
  // an unknown arg is the caller's mistake: reported as input
  await call("demo", "search", { nope: "x" }, { maxTier: 1, minIntervalMs: 0 });
  assert.equal(reportRequests().length, 0, "the calls did not wait for a report");
  await settle(5000);
  const sent = fake.reports();
  assert.deepEqual(
    sent.map((r) => [r.hash, r.outcome, r.tier]),
    [
      ["a".repeat(64), "ok", 1],
      ["a".repeat(64), "rate", 1],
      ["a".repeat(64), "fail", 1],
      ["a".repeat(64), "input", undefined],
    ],
  );
  assert.ok(sent.every((r) => typeof r.ms === "number"));
  assert.equal(reportRequests().length, 1, "one batch");
  assert.ok(reportRequests().every((r) => r.verified));
});

test("reports are never sent with sharing off, and never hold a call or the exit up", async () => {
  saveSite(site({ version: { hash: "b".repeat(64), status: "live" } }));
  const fetchImpl = async () => json({ hits: [{ t: 1 }] });
  await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  await settle(2000);
  shareOn(false);
  await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  await settle(2000);
  assert.equal(reportRequests().length, 0, "sharing off: nothing sent");

  shareOn();
  fake.hang = true;
  const r = await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(r.ok, true);
  const t0 = Date.now();
  await settle(300);
  assert.ok(Date.now() - t0 < 1500, "a registry that does not answer is given up on");
  fake.hang = false;
  fake.down = true;
  const down = await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(down.ok, true, "a registry that is down changes nothing about the call");
  await settle(2000);
});

/* ------------------------------------------------------------ heal back */

const QID = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H";
const NEW = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3S";

test("a call that heals a registry version reports it failed, and shares the healed op back with its parent", async () => {
  shareOn();
  const parent = "c".repeat(64);
  saveSite(
    site({
      request: { method: "GET", url: `https://www.example.com/api/${QID}/search?q=kittens`, headers: {} },
      volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "Search" }],
      trigger: { url: "https://www.example.com/s/{q}" },
      match: { host: "www.example.com", path: "/api/*/search" },
      version: { hash: parent, status: "live" },
    }),
  );
  const cookies: (string | null)[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://www.example.com/s/"))
      return new Response('<script src="/app.js"></script>', { headers: { "content-type": "text/html" } });
    if (url === "https://www.example.com/app.js") return new Response(`r=[{id:"${NEW}",name:"Search"}]`);
    if (url.includes(`/api/${NEW}/search`)) {
      cookies.push(new Headers(init?.headers).get("cookie"));
      return json({ hits: [{ q: new URL(url).searchParams.get("q") }] });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  saveSession("demo", {
    cookies: [
      {
        name: "sid",
        value: "s3cr3t-session",
        domain: "www.example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    values: {},
  });
  const r = await call("demo", "search", { q: "bob" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(r.healed, true, JSON.stringify(r));
  await settle(5000);
  assert.deepEqual(
    fake.reports().map((x) => [x.hash, x.outcome]),
    [[parent, "fail"]],
    "the version as it was drifted",
  );
  const [u] = fake.uploads();
  assert.equal(u?.parent, parent);
  assert.equal(u?.evidence.healedFrom, parent);
  assert.equal(u?.evidence.cleanReplay, "ok");
  assert.match(u!.operation.request.url, new RegExp(`/api/${NEW}/search`));
  assert.equal(cookies.at(-1), null, "the clean replay sent no cookie");
  const op = loadSite("demo")!.site.operations[0]!;
  assert.deepEqual(op.version, { hash: hashOf("demo", u!.operation), status: "candidate" });
});

test("a heal of a version that is not public is not shared back, and the healed op is no longer that version", async () => {
  shareOn();
  saveSite(
    site({
      request: { method: "GET", url: `https://www.example.com/api/${QID}/search?q=kittens`, headers: {} },
      volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "Search" }],
      trigger: { url: "https://www.example.com/s/{q}" },
      match: { host: "www.example.com", path: "/api/*/search" },
      learnedLoggedIn: true,
      version: { hash: "d".repeat(64), status: "review" },
    }),
  );
  saveSession("demo", {
    cookies: [
      {
        name: "sid",
        value: "s3cr3t-session",
        domain: "www.example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    values: {},
    source: "window",
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://www.example.com/s/"))
      return new Response(`<script>r={id:"${NEW}",name:"Search"}</script>`, {
        headers: { "content-type": "text/html" },
      });
    if (url.includes(`/api/${NEW}/search`)) return json({ hits: [{ q: 1 }] });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const r = await call("demo", "search", { q: "bob" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(r.healed, true, JSON.stringify(r));
  await settle(5000);
  assert.equal(fake.uploads().length, 0);
  assert.equal(loadSite("demo")!.site.operations[0]!.version, undefined);
});

/* ------------------------------------------------- background verification */

test("background verification calls each candidate with no cookies over plain HTTP, reports it, and stops at 20 a day", async () => {
  const cand = site();
  fake.sites.set("demo", served(cand, undefined, "candidate"));
  const hash = hashOf("demo", cand.operations[0]!);
  fake.jobs = Array.from({ length: 25 }, (_, i) => ({ hash, site: "demo", op: "search", args: { q: `q${i}` } }));
  // the user's own session for that site is never sent
  saveSession("demo", {
    cookies: [
      {
        name: "sid",
        value: "s3cr3t-session",
        domain: "www.example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    values: { "search/authorization": "Bearer s3cr3t-value" },
  });
  const sent: { url: string; cookie: string | null; auth: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    sent.push({ url: String(input), cookie: h.get("cookie"), auth: h.get("authorization") });
    return json({ hits: [{ t: 1 }] });
  }) as typeof fetch;

  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0 }), 0, "sharing off: none");
  assert.equal(fake.received.length, 0);

  shareOn();
  const now = new Date("2026-10-25T12:00:00Z");
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now }), DAILY_JOBS);
  assert.equal(sent.length, DAILY_JOBS);
  assert.ok(
    sent.every((s) => s.cookie === null && s.auth === null),
    "no cookie, no session value",
  );
  assert.equal(sent[0]!.url, "https://www.example.com/api/search?q=q0");
  assert.equal(loadSite("demo"), undefined, "the candidate was not installed");
  const reports = fake.reports();
  assert.equal(reports.length, DAILY_JOBS);
  assert.deepEqual(reports[0], { hash, outcome: "ok", tier: 1, ms: reports[0]!.ms });
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now }), 0, "today's are spent");
  assert.equal(
    await verifyCandidates({ fetchImpl, minIntervalMs: 0, now: new Date("2026-10-26T12:00:00Z") }),
    DAILY_JOBS,
    "a new day",
  );

  // a job whose candidate the registry does not serve, or one off the shared rules, is skipped
  fake.jobs = [{ hash: "e".repeat(64), site: "demo", op: "search", args: { q: "x" } }];
  fake.sites.set(
    "bad",
    served(site({ request: { method: "GET", url: "http://www.example.com/api?q=x", headers: {} } }, { name: "bad" })),
  );
  fake.jobs.push({ hash: fake.sites.get("bad")!.operations[0]!.hash, site: "bad", op: "search", args: { q: "x" } });
  sent.length = 0;
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now: new Date("2026-10-27T12:00:00Z") }), 0);
  assert.equal(sent.length, 0);
});

test("background verification stops when the client goes away", async () => {
  shareOn();
  const cand = site();
  fake.sites.set("demo", served(cand, undefined, "candidate"));
  const hash = hashOf("demo", cand.operations[0]!);
  fake.jobs = Array.from({ length: 5 }, (_, i) => ({ hash, site: "demo", op: "search", args: { q: `q${i}` } }));
  const stop = new AbortController();
  let calls = 0;
  const fetchImpl = (async () => {
    if (++calls === 2) stop.abort();
    return json({ hits: [{ t: 1 }] });
  }) as typeof fetch;
  await verifyCandidates({ fetchImpl, minIntervalMs: 0, signal: stop.signal });
  assert.ok(calls <= 2, `ran ${calls} jobs after the stop`);
});

/* ------------------------------------------------------- bundled upgrade */

test("a bundled site called with sharing on is upgraded once to the registry's copy, without the agent mark", async () => {
  const bundled = loadSite("hacker-news")!;
  assert.equal(bundled.source, "bundled");
  fake.sites.set("hacker-news", served(bundled.site, readFileSync(join(ROOT, "sites", "hacker-news.md"), "utf8")));
  const opts = { maxTier: 1 as const, minIntervalMs: 0, fetchImpl: async () => new Response("down", { status: 500 }) };

  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  assert.equal(loadSite("hacker-news")!.source, "bundled", "sharing off: no upgrade");
  assert.equal(fake.received.length, 0);

  shareOn();
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  const now = loadSite("hacker-news")!;
  assert.equal(now.source, "registry");
  assert.equal(now.site.shared?.by, undefined, "the package already trusted it");
  const version = now.site.operations.find((o) => o.name === "frontPage")!.version!;
  assert.equal(version.status, "live");

  // later calls carry the version and report
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  assert.deepEqual(
    fake.reports().map((r) => [r.hash, r.outcome]),
    [[version.hash, "fail"]],
  );
  assert.equal(fake.received.filter((r) => r.path === "/v1/sites/hacker-news").length, 1, "once");
});

test("a bundled site the registry does not have is asked about once, not on every call", async () => {
  shareOn();
  const opts = { maxTier: 1 as const, minIntervalMs: 0, fetchImpl: async () => new Response("down", { status: 500 }) };
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  assert.equal(fake.received.filter((r) => r.path === "/v1/sites/hacker-news").length, 1);
  assert.equal(loadSite("hacker-news")!.source, "bundled");
});
