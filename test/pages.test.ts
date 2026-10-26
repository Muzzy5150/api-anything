/**
 * The registry's Pages site: the daily health check (against the localhost fixture), and the pages built from
 * specs someone else wrote, which must stay inert whatever those specs say.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkHealth, type HealthFile } from "../scripts/health.js";
import { buildPages, contributors } from "../scripts/pages.js";
import { markdown } from "../scripts/pages-html.js";
import { type Fixture, startFixture } from "./fixture/server.js";

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(() => fx.close());

const read = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  readOnly: true,
  trigger: { url: `${fx.url}/spa/{name}` },
  match: { method: "GET", path: "/api/spa/user" },
  request: { method: "GET", url: `${fx.url}/api/spa/user?name=alice`, headers: {} },
  slots: [{ param: "name", at: ["query:name"] }],
  params: [{ name: "name", example: "alice" }],
  ...over,
});

test("health calls each logged-out read with its examples, skips the rest, and carries lastOk forward", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-health-sites-"));
  writeFileSync(
    join(dir, "fx.json"),
    JSON.stringify({
      name: "fx",
      baseUrl: fx.url,
      operations: [
        read("getUser"),
        read("gone", {
          match: { method: "GET", path: "/api/gone" },
          request: { method: "GET", url: `${fx.url}/api/gone?name=alice`, headers: {} },
        }),
        read("mine", { learnedLoggedIn: true }),
        read("noExample", { params: [{ name: "name" }] }),
        read("follow", {
          readOnly: false,
          match: { method: "POST", path: "/api/follow" },
          request: { method: "POST", url: `${fx.url}/api/follow?name=alice`, headers: {} },
        }),
      ],
    }),
  );
  const homeBefore = process.env.API_ANYTHING_HOME;
  const previous: HealthFile = {
    generated: "2026-10-01T00:00:00.000Z",
    sites: {
      fx: {
        gone: {
          ok: true,
          class: "ok",
          tier: 1,
          ms: 5,
          checkedAt: "2026-10-01T00:00:00.000Z",
          lastOk: "2026-10-01T00:00:00.000Z",
        },
      },
    },
  };
  const at = new Date("2026-10-25T06:00:00.000Z");
  const hits = fx.calls.length;
  const h = await checkHealth(dir, previous, { callOptions: { maxTier: 1, minIntervalMs: 0 }, now: () => at });

  assert.equal(process.env.API_ANYTHING_HOME, homeBefore, "the fresh home is the check's alone");
  assert.equal(h.generated, at.toISOString());
  assert.deepEqual(
    Object.keys(h.sites.fx!),
    ["getUser", "gone"],
    "a write, a logged-in op and one with no example are not run",
  );
  const sent = fx.calls.slice(hits).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(
    [...new Set(sent)],
    ["GET /api/spa/user?name=alice", "GET /api/gone?name=alice"],
    "the examples, and nothing for the skipped ops",
  );
  assert.equal(sent.filter((s) => s.includes("/api/spa/user")).length, 1);
  const { getUser, gone } = h.sites.fx!;
  assert.deepEqual(getUser, {
    ok: true,
    class: "ok",
    tier: 1,
    ms: getUser!.ms,
    checkedAt: at.toISOString(),
    lastOk: at.toISOString(),
  });
  assert.equal(gone!.ok, false);
  assert.equal(gone!.lastOk, "2026-10-01T00:00:00.000Z", "the last success is carried from the previous file");
  assert.ok(gone!.reason && gone!.reason.length <= 200, String(gone!.reason));
});

/* ------------------------------------------------------------------ pages */

const HOSTILE = "</script><script>alert(1)</script>";

function hostileSites(): string {
  const dir = mkdtempSync(join(tmpdir(), "aa-pages-sites-"));
  writeFileSync(
    join(dir, "evil.json"),
    JSON.stringify({
      name: "evil",
      displayName: HOSTILE,
      description: '<img src=x onerror=alert(1)> "quoted"',
      baseUrl: "https://www.evil.example.com",
      operations: [
        {
          name: "search",
          description: `"><svg onload=alert(1)>`,
          readOnly: true,
          trigger: { url: "https://www.evil.example.com/search?q={q}" },
          match: { host: "api.evil.example.com", path: "/search" },
          request: { method: "GET", url: "https://api.evil.example.com/search?q=dune", headers: {} },
          slots: [{ param: "q", at: ["query:q"] }],
          params: [{ name: "q", example: "it's </script>" }],
        },
        {
          name: "inbox",
          readOnly: true,
          learnedLoggedIn: true,
          trigger: { url: "https://www.evil.example.com/inbox" },
          match: { host: "api.evil.example.com", path: "/inbox" },
          request: { method: "GET", url: "https://api.evil.example.com/inbox", headers: {} },
          slots: [],
          params: [],
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "evil.md"),
    "No account is needed. <script>alert(2)</script>\n\n- `q` is [a link](javascript:alert(3)) or [docs](https://evil.example.com/docs)\n\n## Maintainer notes\n\nPRIVATE maintainer text\n",
  );
  return dir;
}

test("pages escape every spec string, keep spec text out of scripts, and show health per op", () => {
  const out = mkdtempSync(join(tmpdir(), "aa-pages-"));
  const health: HealthFile = {
    generated: "2026-10-25T06:00:00.000Z",
    sites: {
      evil: {
        search: {
          ok: false,
          class: "drift",
          tier: 1,
          ms: 9,
          checkedAt: "2026-10-25T06:00:00.000Z",
          lastOk: "2026-10-20T06:00:00.000Z",
          reason: "x",
        },
      },
    },
  };
  buildPages(hostileSites(), out, { generated: health.generated, health });

  const page = readFileSync(join(out, "sites", "evil", "index.html"), "utf8");
  const home = readFileSync(join(out, "index.html"), "utf8");
  for (const html of [page, home]) {
    assert.equal(html.match(/<script/g)?.length, 1, "the page's own script, and no other");
    assert.ok(!/<img|<svg|<i>|href="javascript/.test(html), "no markup from the spec survives");
    const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
    assert.ok(!script.includes("alert"), "no spec text inside the script");
  }
  assert.match(
    page,
    /<title>&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; API \(unofficial\), via API Anything<\/title>/,
  );
  assert.match(page, /<meta name="description" content="Unofficial &lt;\/script&gt;/);
  assert.match(page, /<link rel="canonical" href="https:\/\/goodnight000\.github\.io\/api-anything\/sites\/evil\/">/);
  assert.match(page, /<code>search\(q\)<\/code>/);
  assert.match(
    page,
    /Failed<\/span> <small><time datetime="2026-10-25T06:00:00.000Z">Oct 25, 2026<\/time>; last worked <time/,
  );
  assert.match(page, /title="needs an account, which the check does not have">Not checked/);
  assert.match(
    page,
    /api-anything call evil search &#39;q=it&#39;\\&#39;&#39;s &lt;\/script&gt;&#39;/,
    "the example, shell-quoted",
  );
  assert.match(page, /<a href="https:\/\/evil\.example\.com\/docs" rel="nofollow ugc">docs<\/a>/);
  assert.match(
    page,
    /<code>q<\/code> is \[a link\]\(javascript:alert\(3\)\) or <a/,
    "a link that is not https stays text",
  );
  assert.ok(!page.includes("PRIVATE maintainer text"), "maintainer notes stay off the page");
  assert.match(page, /href="https:\/\/github\.com\/goodnight000\/api-anything\/blob\/main\/sites\/evil\.json"/);
  assert.ok(!page.includes("Contributors:"), "no history, no contributors line");
  assert.match(home, /<span class="h bad">0 of 1 working<\/span>/);
  assert.match(home, /href="sites\/evil\/"/);

  const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
  assert.deepEqual(index.sites[0].operations[0].health, {
    ok: false,
    checkedAt: "2026-10-25T06:00:00.000Z",
    lastOk: "2026-10-20T06:00:00.000Z",
  });
  assert.equal(index.sites[0].operations[1].health, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "health.json"), "utf8")), health, "served for the next run");
  assert.match(
    readFileSync(join(out, "sitemap.xml"), "utf8"),
    /<loc>https:\/\/goodnight000\.github\.io\/api-anything\/sites\/evil\/<\/loc>/,
  );
  assert.ok(existsSync(join(out, ".nojekyll")));
});

test("notes markdown: paragraphs, lists with continuation lines, code, and nothing else as markup", () => {
  assert.equal(
    markdown(
      "Intro **bold** `<b>`.\n\n- one\n  continued\n- two [x](http://insecure.example)\n\n## Caveats\n<i>raw</i>",
    ),
    [
      "<p>Intro <strong>bold</strong> <code>&lt;b&gt;</code>.</p>",
      "<ul><li>one continued</li><li>two [x](http://insecure.example)</li></ul>",
      "<h4>Caveats</h4>",
      "<p>&lt;i&gt;raw&lt;/i&gt;</p>",
    ].join("\n"),
  );
});

test("contributors come from the spec's git history, first author first, each once", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-pages-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  for (const [who, text] of [
    ["Ada", "1"],
    ["Bo & Co", "2"],
    ["Ada", "3"],
  ] as const) {
    writeFileSync(join(dir, "s.json"), text);
    git("add", "s.json");
    git("-c", `user.name=${who}`, "-c", "user.email=x@example.com", "commit", "-q", "--no-gpg-sign", "-m", text);
  }
  assert.deepEqual(contributors(dir, "s"), ["Ada", "Bo & Co"]);
  assert.deepEqual(contributors(mkdtempSync(join(tmpdir(), "aa-nogit-")), "s"), [], "no repository, no names");
});

test("every bundled spec gets a page", () => {
  const out = mkdtempSync(join(tmpdir(), "aa-pages-bundled-"));
  const dir = fileURLToPath(new URL("../sites/", import.meta.url));
  buildPages(dir, out);
  const goodreads = readFileSync(join(out, "sites", "goodreads", "index.html"), "utf8");
  assert.match(goodreads, /<title>Goodreads API \(unofficial\), via API Anything<\/title>/);
  assert.match(goodreads, /api-anything pull goodreads\napi-anything call goodreads searchBooks q=hyperion/);
  const linkedin = readFileSync(join(out, "sites", "linkedin", "index.html"), "utf8");
  assert.match(linkedin, /api-anything login linkedin/, "a site that needs an account says to log in first");
});
