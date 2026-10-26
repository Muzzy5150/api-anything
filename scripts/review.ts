/**
 * Sorts a pull request to the registry by risk, for the review workflow: the sites it adds, changes or
 * removes, what `vetShared` says of each, and whether every change is low-risk enough to merge without a
 * maintainer reading it. It reads the files as data and never runs a spec.
 *
 * `npm run review -- fetch <dir>` (GH_TOKEN, GH_REPO, PR, HEAD_SHA, AUTHOR, BASE_REF) writes the pull
 * request's files and the sites' owners to `<dir>/input.json`, reading main's files from this checkout;
 * `npm run review -- report <dir>` (AUTO_MERGE) reads it and writes `comment.md`, `report.json` and
 * `verdict` there, with no token in reach.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../src/registry.js";
import { siteOf } from "../src/session.js";
import { parseSite, type Site } from "../src/spec.js";
import { addresses, LIMITS, vetShared } from "../src/vet.js";

export type Verdict = "low" | "review" | "fail";
/** path (`sites/<name>.json`) -> content; a path that is missing is no file there */
export type Files = Record<string, string>;

export interface ReviewInput {
  /** every path the pull request changes, and a rename's old path */
  changed: string[];
  /** the touched sites' files on main, and as they would be after the merge */
  base: Files;
  head: Files;
  /** the pull request's author, a GitHub login */
  author: string;
  /** site -> the logins that authored commits touching its spec on main */
  owners: Record<string, string[]>;
}

export interface SiteReport {
  site: string;
  change: "new" | "updated" | "removed";
  verdict: Verdict;
  description?: string;
  /** why it is not low risk */
  reasons: string[];
  errors: string[];
  warnings: string[];
  operations: ReturnType<typeof summarize>[];
}

export interface Report {
  verdict: Verdict;
  /** why the pull request as a whole is not low risk, whatever its sites are */
  reasons: string[];
  sites: SiteReport[];
}

const SITE_FILE = /^sites\/([a-z0-9][a-z0-9._-]*)\.(json|md)$/;

/** The site a path is the spec or notes of, or undefined for any other path. */
export function siteFile(path: string): string | undefined {
  const name = SITE_FILE.exec(path)?.[1];
  // index.json is the name the registry's built index takes on Pages
  return name && !name.includes("..") && name !== "index" ? name : undefined;
}

const NOREPLY = /^(?:\d+\+)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)@users\.noreply\.github\.com$/i;

/** The owners of a site, from the commits touching its spec on main: each one's GitHub login, or the login of its noreply author email. */
export function ownersOf(commits: { login?: string | null; email?: string | null }[]): string[] {
  const logins = commits.flatMap((c) => [c.login, NOREPLY.exec(c.email ?? "")?.[1]]);
  return [...new Set(logins.filter((l): l is string => !!l).map((l) => l.toLowerCase()))].sort();
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const hostsOf = (site: Site) =>
  new Set(
    [site.baseUrl, ...site.operations.flatMap((op) => addresses(op).map(([, url]) => url))]
      .map(hostOf)
      .filter((h): h is string => !!h),
  );

const message = (e: unknown) => (e as Error).message;

function reviewSite(name: string, input: ReviewInput): SiteReport {
  const json = `sites/${name}.json`;
  const before = input.base[json];
  const after = input.head[json];
  const change = before === undefined ? "new" : after === undefined ? "removed" : "updated";
  const r: SiteReport = { site: name, change, verdict: "low", reasons: [], errors: [], warnings: [], operations: [] };
  const done = () => {
    r.verdict = r.errors.length ? "fail" : r.reasons.length ? "review" : "low";
    return r;
  };
  if (after === undefined) {
    r.reasons.push(before === undefined ? `adds notes to ${json}, which does not exist` : "removes the site's spec");
    return done();
  }

  let site: Site;
  try {
    site = parseSite(JSON.parse(after));
  } catch (e) {
    r.errors.push(`${json} is no spec: ${message(e)}`);
    return done();
  }
  r.description = site.displayName
    ? `${site.displayName}${site.description ? `: ${site.description}` : ""}`
    : site.description;
  if (site.name.toLowerCase() !== name) r.errors.push(`${json} is the spec of "${site.name}"; pull refuses it`);
  if (Buffer.byteLength(after) > LIMITS.file)
    r.errors.push(`${json} is ${Buffer.byteLength(after)} bytes; pull takes at most ${LIMITS.file}`);
  const vetted = vetShared(site, input.head[`sites/${name}.md`]);
  r.errors.push(...vetted.errors);
  r.warnings.push(...vetted.warnings);
  try {
    r.operations = site.operations.map(summarize);
  } catch {
    // summarize parses every URL; one that does not parse is a vetShared error already
  }

  const baseHost = hostOf(site.baseUrl);
  const own = baseHost && siteOf(baseHost);
  for (const op of site.operations) {
    const method = op.request.method.toUpperCase();
    if (!op.readOnly) r.reasons.push(`${op.name} is a write (${method})`);
    else if (method !== "GET" && method !== "HEAD") r.reasons.push(`${op.name} is a read sent as ${method}`);
    if (op.learnedLoggedIn) r.reasons.push(`${op.name} was learned signed in`);
    if (op.public?.length) r.reasons.push(`${op.name} sends literal public values: ${op.public.join(", ")}`);
    for (const [where, url] of addresses(op)) {
      const host = hostOf(url);
      if (own && host && siteOf(host) !== own) r.reasons.push(`${op.name} ${where} goes to ${host}, off ${own}`);
    }
  }

  if (before !== undefined) {
    let old: Site | undefined;
    try {
      old = parseSite(JSON.parse(before));
    } catch {
      r.reasons.push(`the spec on main does not parse, so this update cannot be compared with it`);
    }
    if (old) {
      const known = hostsOf(old);
      const added = [...hostsOf(site)].filter((h) => !known.has(h));
      if (added.length) r.reasons.push(`adds hosts: ${added.join(", ")}`);
      const reads = new Set(old.operations.filter((op) => op.readOnly).map((op) => op.name));
      for (const op of site.operations)
        if (!op.readOnly && reads.has(op.name)) r.reasons.push(`${op.name} turns from a read into a write`);
    }
    const owners = input.owners[name] ?? [];
    if (!owners.includes(input.author.toLowerCase()))
      r.reasons.push(
        owners.length
          ? `${input.author} is not an owner of this site (${owners.join(", ")})`
          : `${input.author} is not an owner of this site, which has none on record`,
      );
  }
  return done();
}

export function review(input: ReviewInput): Report {
  const names = new Set<string>();
  const outside: string[] = [];
  for (const path of input.changed) {
    const name = siteFile(path);
    if (name) names.add(name);
    else outside.push(path);
  }
  const reasons = outside.slice(0, 10).map((p) => `changes ${p}, which is no site's spec or notes`);
  if (outside.length > 10) reasons.push(`changes ${outside.length - 10} more paths outside sites/<site>.json and .md`);
  if (!names.size) reasons.push("changes no site");
  const sites = [...names].sort().map((name) => reviewSite(name, input));
  const verdict: Verdict = sites.some((s) => s.verdict === "fail")
    ? "fail"
    : !reasons.length && sites.every((s) => s.verdict === "low")
      ? "low"
      : "review";
  return { verdict, reasons, sites };
}

/* ------------------------------------------------------------------ the comment */

/** Finds the bot's own comment, to update it rather than add another. */
export const MARKER = "<!-- api-anything registry review -->";
/** GitHub refuses a comment over 65536 characters. */
const MAX_COMMENT = 60_000;

const TITLE: Record<Verdict, string> = {
  low: "low risk",
  review: "needs a maintainer's review",
  fail: "fails the shared rules",
};

/**
 * Untrusted text as an inline code span, which renders no markdown or HTML and pings no one: one line,
 * fenced by more backticks than any run inside it.
 */
export function code(text: string, max = 300): string {
  // line breaks would end the span, and bidi controls can make the text read as something else
  let t = text.replace(/[\u0000-\u001f\u007f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
  if (t.length > max) t = `${t.slice(0, max)}…`;
  if (!t.trim()) return "(empty)";
  const fence = "`".repeat(Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = /^[` ]|[` ]$/.test(t) ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

function summary(verdict: Verdict, autoMerge: boolean): string {
  if (verdict === "fail")
    return "It fails the shared rules that `pull` and CI apply. Fix the errors below and push; this comment updates.";
  if (verdict === "review")
    return "A maintainer reviews it like code before it merges, for the reasons below. That is no judgement of the spec: low risk covers only a narrow kind of change.";
  return `Every change is a GET or HEAD read on the spec's own site that passes the shared rules, in a new site or its owner's update. ${
    autoMerge
      ? "Auto-merge is on: GitHub squash-merges this pull request once the required checks pass."
      : "A maintainer still merges it; it should be a short look."
  }`;
}

export function render(report: Report, o: { autoMerge?: boolean } = {}): string {
  const lines = [
    MARKER,
    `## Registry review: ${TITLE[report.verdict]}`,
    "",
    summary(report.verdict, !!o.autoMerge),
    "",
  ];
  const list = (heading: string, items: string[]) => {
    if (items.length) lines.push(`${heading}:`, "", ...items.map((i) => `- ${code(i)}`), "");
  };
  list("The pull request", report.reasons);
  for (const s of report.sites) {
    lines.push(`### ${code(s.site)} (${s.change}): ${TITLE[s.verdict]}`, "");
    if (s.description) lines.push(code(s.description), "");
    list("Errors", s.errors);
    list("Needs review because", s.reasons);
    list("Warnings", s.warnings);
    if (s.operations.length)
      lines.push(
        "Operations:",
        "",
        ...s.operations.map(
          (op) =>
            `- ${code(`${op.method} ${op.op}`)} on ${op.hosts.map((h) => code(h)).join(", ")}${op.write ? ", **write**" : ""}${op.login ? ", learned signed in" : ""}`,
        ),
        "",
      );
  }
  lines.push(
    "<sub>This bot reads the changed files as data and never runs a spec, so it says nothing of whether the ops work. It runs again on every push.</sub>",
  );
  let body = lines.join("\n");
  if (body.length > MAX_COMMENT)
    body = `${body.slice(0, body.lastIndexOf("\n", MAX_COMMENT))}\n\n(cut here: the review is longer than a comment can be)`;
  return `${body}\n`;
}

/* ------------------------------------------------------------------ the workflow's two steps */

function env(name: string, shape: RegExp): string {
  const v = process.env[name] ?? "";
  if (!shape.test(v)) throw new Error(`${name} is not set to what the workflow passes`);
  return v;
}

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const ghPages = <T>(path: string): T[] => (JSON.parse(gh(["api", "--paginate", "--slurp", path])) as T[][]).flat();

/** Reads the pull request's files at its head commit through the API: no checkout, nothing of it run. */
function fetchInput(): ReviewInput {
  const repo = env("GH_REPO", /^[\w.-]+\/[\w.-]+$/);
  const pr = env("PR", /^\d+$/);
  const sha = env("HEAD_SHA", /^[0-9a-f]{40}$/);
  const author = env("AUTHOR", /^[A-Za-z0-9-]+(\[bot\])?$/);
  const baseRef = env("BASE_REF", /^[\w.-]+$/);
  const root = fileURLToPath(new URL("..", import.meta.url));

  const files = ghPages<{ filename: string; status: string; previous_filename?: string }>(
    `repos/${repo}/pulls/${pr}/files?per_page=100`,
  );
  const status = new Map<string, string>();
  for (const f of files) if (f.previous_filename) status.set(f.previous_filename, "removed");
  for (const f of files) status.set(f.filename, f.status);
  const changed = [...status.keys()];

  const base: Files = {};
  const head: Files = {};
  const owners: Record<string, string[]> = {};
  for (const name of new Set(changed.map(siteFile).filter((n): n is string => !!n))) {
    for (const path of [`sites/${name}.json`, `sites/${name}.md`]) {
      if (existsSync(join(root, path))) base[path] = readFileSync(join(root, path), "utf8");
      const s = status.get(path);
      // a file the pull request leaves alone is main's after the merge
      if (s === undefined) {
        if (base[path] !== undefined) head[path] = base[path];
      } else if (s !== "removed")
        head[path] = gh([
          "api",
          "-H",
          "Accept: application/vnd.github.raw+json",
          `repos/${repo}/contents/${path}?ref=${sha}`,
        ]);
    }
    if (base[`sites/${name}.json`] !== undefined) {
      const commits = ghPages<{ author?: { login?: string } | null; commit?: { author?: { email?: string } } }>(
        `repos/${repo}/commits?sha=${baseRef}&path=sites/${name}.json&per_page=100`,
      );
      owners[name] = ownersOf(commits.map((c) => ({ login: c.author?.login, email: c.commit?.author?.email })));
    }
  }
  // the file list is the pull request's now; the contents are its head commit's
  const now = gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"]).trim();
  if (now !== sha) throw new Error(`the pull request moved on from ${sha} to ${now}; the run for ${now} reviews it`);
  return { changed, base, head, author, owners };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [step, dir] = process.argv.slice(2);
  if (!dir || (step !== "fetch" && step !== "report")) throw new Error("usage: npm run review -- fetch|report <dir>");
  if (step === "fetch") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "input.json"), JSON.stringify(fetchInput()));
  } else {
    const report = review(JSON.parse(readFileSync(join(dir, "input.json"), "utf8")) as ReviewInput);
    writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(dir, "comment.md"), render(report, { autoMerge: process.env.AUTO_MERGE === "true" }));
    writeFileSync(join(dir, "verdict"), report.verdict);
  }
}
