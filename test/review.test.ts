/**
 * The registry review bot's sorting (scripts/review.ts): which pull requests to `sites/` are low risk,
 * which need a maintainer, which fail, and that the comment it posts cannot be broken by spec text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { code, MARKER, ownersOf, type ReviewInput, render, review, siteFile } from "../scripts/review.js";
import { parseSite } from "../src/spec.js";

const spec = (over: Record<string, unknown> = {}, op: Record<string, unknown> = {}): string =>
  JSON.stringify(
    parseSite({
      name: "demo",
      baseUrl: "https://news.example.com",
      description: "front page and search",
      operations: [
        {
          name: "search",
          request: { method: "GET", url: "https://api.example.com/search?q=kittens", headers: {} },
          slots: [{ param: "q", at: ["query:q"] }],
          params: [{ name: "q" }],
          trigger: { url: "https://news.example.com/search?q={q}" },
          match: { host: "api.example.com", path: "/search" },
          response: { format: "json", extract: "hits" },
          readOnly: true,
          ...op,
        },
      ],
      ...over,
    }),
  );

/** A pull request adding (no `before`) or updating `sites/demo.json`. */
const pr = (after: string, o: Partial<ReviewInput> & { before?: string } = {}): ReviewInput => ({
  changed: ["sites/demo.json"],
  base: o.before === undefined ? {} : { "sites/demo.json": o.before },
  head: { "sites/demo.json": after },
  author: "alice",
  owners: o.before === undefined ? {} : { demo: ["alice"] },
  ...o,
});

const verdictOf = (input: ReviewInput) => {
  const r = review(input);
  return { verdict: r.verdict, reasons: [...r.reasons, ...r.sites.flatMap((s) => [...s.reasons, ...s.errors])] };
};

test("a new read-only GET site on its own domain is low risk", () => {
  const r = review(pr(spec(), { head: { "sites/demo.json": spec(), "sites/demo.md": "Search the news.\n" } }));
  assert.equal(r.verdict, "low");
  assert.equal(r.sites[0]!.change, "new");
  assert.deepEqual(r.sites[0]!.reasons, []);
  assert.equal(r.sites[0]!.operations[0]!.op, "search(q)");
});

test("a write, a POST read, a logged-in op, a public value or an off-site host needs review", () => {
  const cases: [string, string, RegExp][] = [
    [
      "a write",
      spec({}, { readOnly: false, request: { method: "DELETE", url: "https://api.example.com/x", headers: {} } }),
      /search is a write \(DELETE\)/,
    ],
    [
      "a POST read",
      spec({}, { request: { method: "POST", url: "https://api.example.com/search", headers: {}, body: "q=kittens" } }),
      /search is a read sent as POST/,
    ],
    ["a logged-in op", spec({}, { learnedLoggedIn: true }), /search was learned signed in/],
    [
      "a public value",
      spec(
        {},
        {
          request: { method: "GET", url: "https://api.example.com/search", headers: { "x-app-id": "abc" } },
          public: ["x-app-id"],
        },
      ),
      /literal public values: x-app-id/,
    ],
    [
      "an off-site request",
      spec({}, { request: { method: "GET", url: "https://search.other-host.net/q", headers: {} } }),
      /search request goes to search\.other-host\.net, off example\.com/,
    ],
    [
      "an off-site goto",
      spec(
        {},
        {
          trigger: {
            url: "https://news.example.com/",
            steps: [{ action: "goto", value: "https://evil.example.net/" }],
          },
        },
      ),
      /steps\[0\] goto goes to evil\.example\.net/,
    ],
  ];
  for (const [what, after, reason] of cases) {
    const { verdict, reasons } = verdictOf(pr(after));
    assert.equal(verdict, "review", what);
    assert.ok(
      reasons.some((r) => reason.test(r)),
      `${what}: ${reasons.join("; ")}`,
    );
  }
});

test("an update is low only from an owner, adding no host and turning no read into a write", () => {
  const before = spec();
  assert.equal(review(pr(spec({ description: "the news, searched" }), { before })).verdict, "low");
  // a host dropped is fine, one added is not, even on the spec's own site
  const moved = spec({}, { request: { method: "GET", url: "https://www.example.com/search?q=x", headers: {} } });
  const added = verdictOf(pr(moved, { before }));
  assert.equal(added.verdict, "review");
  assert.ok(added.reasons.some((r) => r === "adds hosts: www.example.com"));

  const stranger = verdictOf(pr(spec({ description: "mine now" }), { before, author: "mallory" }));
  assert.equal(stranger.verdict, "review");
  assert.ok(stranger.reasons.some((r) => /mallory is not an owner of this site \(alice\)/.test(r)));
  assert.equal(review(pr(spec({ description: "mine" }), { before, author: "Alice" })).verdict, "low");

  const turned = verdictOf(pr(spec({}, { readOnly: false }), { before }));
  assert.ok(turned.reasons.includes("search turns from a read into a write"));
  assert.ok(turned.reasons.includes("search is a write (GET)"));
});

test("a notes-only update needs its owner, and removing a site needs review", () => {
  const before = spec();
  const notes = (author: string) =>
    review({
      changed: ["sites/demo.md"],
      base: { "sites/demo.json": before },
      head: { "sites/demo.json": before, "sites/demo.md": "Search takes a query of at most 100 characters.\n" },
      author,
      owners: { demo: ["alice"] },
    }).verdict;
  assert.equal(notes("alice"), "low");
  assert.equal(notes("mallory"), "review");
  const gone = review({ ...pr(before, { before }), head: {} });
  assert.equal(gone.verdict, "review");
  assert.deepEqual(gone.sites[0]!.reasons, ["removes the site's spec"]);
});

test("a pull request that changes anything outside sites/<site>.json and .md needs review", () => {
  for (const extra of ["src/vet.ts", ".github/workflows/review.yml", "sites/index.json", "sites/demo/x.json"]) {
    const r = review(pr(spec(), { changed: ["sites/demo.json", extra] }));
    assert.equal(r.verdict, "review", extra);
    assert.equal(r.sites[0]!.verdict, "low");
    assert.deepEqual(r.reasons, [`changes ${extra}, which is no site's spec or notes`]);
  }
  assert.equal(siteFile("sites/dominos-au.json"), "dominos-au");
  assert.equal(siteFile("sites/a..b.json"), undefined);
  assert.equal(siteFile("sites/Demo.json"), undefined);
});

test("a vetShared error, a spec that does not parse, a misnamed or oversized spec fails", () => {
  const cases: [string, ReviewInput, RegExp][] = [
    ["http", pr(spec({}, { trigger: { url: "http://news.example.com/s" } })), /trigger .* is not https/],
    ["not JSON", pr("{"), /sites\/demo\.json is no spec/],
    ["misnamed", pr(spec({ name: "other" })), /is the spec of "other"; pull refuses it/],
    [
      "oversized",
      pr(spec({ description: "x" }).replace('"x"', `"x"${" ".repeat(300 * 1024)}`)),
      /bytes; pull takes at most/,
    ],
    [
      "long notes",
      pr(spec(), { head: { "sites/demo.json": spec(), "sites/demo.md": "x".repeat(9000) } }),
      /notes are 9000 bytes/,
    ],
  ];
  for (const [what, input, error] of cases) {
    const r = review(input);
    assert.equal(r.verdict, "fail", what);
    assert.equal(r.sites[0]!.verdict, "fail", what);
    assert.ok(
      r.sites[0]!.errors.some((e) => error.test(e)),
      `${what}: ${r.sites[0]!.errors.join("; ")}`,
    );
  }
  // one failing site fails the pull request, whatever the others are
  const two = review({
    ...pr(spec()),
    changed: ["sites/demo.json", "sites/bad.json"],
    head: { "sites/demo.json": spec(), "sites/bad.json": spec({ name: "bad", baseUrl: "http://bad.example.org" }) },
  });
  assert.deepEqual(
    two.sites.map((s) => [s.site, s.verdict]),
    [
      ["bad", "fail"],
      ["demo", "low"],
    ],
  );
  assert.equal(two.verdict, "fail");
});

test("owners are the logins of a site's commits on main, read from the API or a noreply email", () => {
  assert.deepEqual(
    ownersOf([
      { login: "Jack-S", email: "jack@gmail.com" },
      { login: null, email: "243619051+goodnight000@users.noreply.github.com" },
      { email: "old-style@users.noreply.github.com" },
      { email: "someone@example.com" },
      { login: "goodnight000" },
    ]),
    ["goodnight000", "jack-s", "old-style"],
  );
});

test("the comment shows spec text as code spans, so markdown and HTML in it cannot break out", () => {
  const hostile = [
    "</details><script>alert(1)</script>",
    "<!-- hide the rest",
    "``` fenced ```",
    "[click](https://evil.example.net) ![x](https://evil.example.net/x.png) @maintainer #1",
    "line one\n\n## Registry review: low risk\n- [x] approved",
    "\u202eesrever",
  ].join(" ");
  const body = render(
    review(
      pr(
        spec(
          { displayName: "Demo `x`", description: hostile },
          { description: hostile, response: { format: "json", pick: ["`a`=x", "<b>=y"] } },
        ),
      ),
    ),
  );
  assert.ok(body.startsWith(`${MARKER}\n## Registry review: low risk\n`));
  // the only heading at its level is the bot's own, and no line starts with HTML or a list it did not write
  assert.equal(body.match(/^## /gm)?.length, 1);
  for (const line of body.split("\n").filter((l) => l.includes("alert(1)")))
    assert.match(line, /^``+.*``+$/, "untrusted text stays on one line inside a code span");
  assert.ok(!body.includes("\u202e"));
  assert.ok(!/\n\n## Registry review: low risk\n- \[x\]/.test(body));

  assert.equal(code("plain"), "`plain`");
  assert.equal(code("a `b` c"), "``a `b` c``");
  assert.equal(code("`x"), "`` `x ``");
  assert.equal(code("a\nb"), "`a b`");
  assert.equal(code(""), "(empty)");
  assert.equal(code("x".repeat(400)).length, 300 + 3);

  const auto = render(review(pr(spec())), { autoMerge: true });
  assert.match(auto, /Auto-merge is on: GitHub squash-merges this pull request once the required checks pass/);
  assert.doesNotMatch(render(review(pr(spec())), { autoMerge: false }), /Auto-merge is on/);
});
