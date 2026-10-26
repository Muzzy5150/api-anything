import assert from "node:assert/strict";
import { test } from "node:test";
import { prefixOf } from "../src/auth.js";
import { byRank, degraded, type Facts, nextStatus, promoted, thresholds, toArchive } from "../src/rules.js";

const t = thresholds({});
const facts = (f: Partial<Facts> = {}): Facts => ({
  okKeys: 0,
  okNetworks: 0,
  wrongKeys: 0,
  heal: false,
  latest: [],
  ...f,
});

test("thresholds default to docs/REGISTRY.md and read env vars", () => {
  assert.equal(t.promoteKeys, 2);
  assert.equal(t.promoteNetworks, 2);
  assert.equal(t.promoteHealKeys, 1);
  assert.equal(t.recentDays, 30);
  assert.equal(thresholds({ PROMOTE_KEYS: "5", PROMOTE_NETWORKS: "x" }).promoteKeys, 5);
  assert.equal(thresholds({ PROMOTE_NETWORKS: "x" }).promoteNetworks, 2);
});

test("promotion, a heal, and wrong outweighing oks", () => {
  assert.equal(promoted(facts({ okKeys: 2, okNetworks: 1 }), t), false);
  assert.equal(promoted(facts({ okKeys: 2, okNetworks: 2 }), t), true);
  // a heal needs fewer installs, never fewer networks
  assert.equal(promoted(facts({ okKeys: 1, okNetworks: 1, heal: true }), t), false);
  assert.equal(promoted(facts({ okKeys: 2, okNetworks: 2, heal: true }), t), true);
  const strict = thresholds({ PROMOTE_KEYS: "3" });
  assert.equal(promoted(facts({ okKeys: 2, okNetworks: 2, heal: true }), strict), true);
  assert.equal(promoted(facts({ okKeys: 2, okNetworks: 2 }), strict), false);
  assert.equal(promoted(facts({ okKeys: 5, okNetworks: 1, heal: true }), strict), false);
  assert.equal(promoted(facts({ okKeys: 3, okNetworks: 3, wrongKeys: 1 }), t), false);
  assert.equal(promoted(facts({ okKeys: 4, okNetworks: 2, wrongKeys: 1 }), t), true);
});

test("degradation needs more than half failing and at least 3 installs", () => {
  assert.equal(degraded(facts({ latest: ["fail", "fail"] }), t), false);
  assert.equal(degraded(facts({ latest: ["fail", "wrong", "fail", "ok", "ok", "ok"] }), t), false);
  assert.equal(degraded(facts({ latest: ["fail", "wrong", "fail", "ok", "ok"] }), t), true);
  assert.equal(nextStatus("live", facts({ latest: ["fail", "fail", "fail"] }), t), "degraded");
  assert.equal(nextStatus("degraded", facts({ latest: ["ok"] }), t), "live");
  for (const s of ["review", "blocked", "archived"] as const)
    assert.equal(nextStatus(s, facts({ okKeys: 9, okNetworks: 9 }), t), s);
});

test("rank: live, candidate, degraded; then success rate; then confirmations", () => {
  const v = (status: "live" | "candidate" | "degraded", successRate?: number, confirmations = 0) => ({
    status,
    successRate,
    confirmations,
    createdAt: "2026-01-01",
  });
  const sorted = [v("degraded", 1), v("candidate"), v("candidate", 0.5), v("live", 0.2), v("candidate", 0.5, 3)].sort(
    byRank,
  );
  assert.deepEqual(
    sorted.map((x) => [x.status, x.successRate, x.confirmations]),
    [
      ["live", 0.2, 0],
      ["candidate", 0.5, 3],
      ["candidate", 0.5, 0],
      ["candidate", undefined, 0],
      ["degraded", 1, 0],
    ],
  );
});

test("an IP's network is its /24 or /32", () => {
  assert.equal(prefixOf("203.0.113.9"), "203.0.113");
  assert.equal(prefixOf("::ffff:203.0.113.9"), "203.0.113");
  // one subscriber holds a /48 or more: rotating through it is one network
  assert.equal(prefixOf("2001:db8:abcd:12::1"), "2001:db8");
  assert.equal(prefixOf("2001:db8:1::1"), "2001:db8");
  assert.equal(prefixOf("2001:db9::1"), "2001:db9");
  assert.equal(prefixOf(""), "unknown");
});

test("archive: stale candidates and degraded versions, and a degraded one a newer live version replaced; never a live one", () => {
  const v = (
    op: string,
    status: "live" | "candidate" | "degraded" | "review",
    createdAt: string,
    lastOkAt?: string,
  ) => ({
    site: "s",
    op,
    status,
    createdAt,
    ...(lastOkAt ? { lastOkAt } : {}),
  });
  const versions = [
    v("a", "live", "2026-01-01"),
    v("b", "live", "2026-01-01"),
    v("b", "live", "2026-03-01"),
    v("b", "candidate", "2026-04-01"),
    v("c", "candidate", "2026-01-01", "2026-05-01"),
    v("c", "degraded", "2026-01-01"),
    v("d", "review", "2026-01-01"),
    v("e", "degraded", "2026-05-01"),
    v("e", "live", "2026-05-02"),
    v("f", "degraded", "2026-05-01"),
  ];
  assert.deepEqual(
    toArchive(versions, "2026-04-15").map((x) => [x.op, x.status, x.createdAt]),
    [
      ["b", "candidate", "2026-04-01"],
      ["c", "degraded", "2026-01-01"],
      ["e", "degraded", "2026-05-01"],
    ],
  );
});
