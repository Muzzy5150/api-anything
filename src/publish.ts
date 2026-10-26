/**
 * Publishing a spec: a preview of exactly what becomes public, then, on the human's OK, a pull
 * request to the registry through the GitHub CLI. api-anything never holds a GitHub token, clones
 * nothing and runs no shell: every GitHub call is `gh api` with its body as JSON on stdin.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { checksTable, type Gate, gate } from "./checks.js";
import { fetchCapped, REPO, registryBase, summarize } from "./registry.js";
import { besideOrigins, credentialsOf, ipIn, opUrls, scanSecrets } from "./secrets.js";
import { home, loadSession, safeName, writePrivate } from "./session.js";
import { type Operation, parseSite, type Site } from "./spec.js";
import { exportSite, loadSite } from "./store.js";
import { LIMITS, vetShared } from "./vet.js";

export const outboxDir = () => join(home(), "outbox");

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * What in the outgoing text may be the publisher's own, for them to look at: no scan tells an account
 * id from a constant. Every string and key of the spec is read, and the notes.
 */
function personal(spec: Site, notes: string | undefined): string[] {
  const found: string[] = [];
  const check = (text: string, where: string) => {
    if (EMAIL.test(text)) found.push(`${where} holds an email address (${EMAIL.exec(text)![0]})`);
    if (UUID.test(text)) found.push(`${where} holds an id (${UUID.exec(text)![0]}): is it your account's?`);
    const ip = ipIn(text);
    if (ip) found.push(`${where} holds the IP address ${ip}`);
  };
  const visit = (v: unknown, path: string) => {
    if (typeof v === "string") check(v, path);
    else if (Array.isArray(v)) for (const [i, x] of v.entries()) visit(x, `${path}[${i}]`);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        check(k, `a key in ${path}`);
        visit(x, `${path}.${k}`);
      }
  };
  visit(spec, "$");
  for (const [i, op] of spec.operations.entries()) {
    const at = `$.operations[${i}]`;
    for (const seg of new URL(op.request.url).pathname.split("/"))
      if (/^\d{5,}$/.test(seg))
        found.push(`${at}.request.url has ${seg} in its path, which no param fills: is it your account's?`);
    for (const [j, s] of (op.trigger.steps ?? []).entries())
      if (s.action === "fill" && s.value && !s.value.includes("{"))
        found.push(`${at}.trigger.steps[${j}] types the literal "${s.value}" into the page`);
    for (const p of op.params) {
      if (p.default !== undefined) found.push(`${at} param ${p.name} defaults to ${JSON.stringify(p.default)}`);
      for (const v of p.enum ?? [])
        if (/\d{5,}/.test(v))
          found.push(`${at} param ${p.name} allows "${v}": is it your account's, or one of the site's own options?`);
      if (p.example !== undefined)
        found.push(`${at} param ${p.name} keeps its example ${JSON.stringify(p.example)}: public?`);
    }
    // a check's args are typed by the publisher, as a fill step's value is
    for (const [j, c] of (op.checks ?? []).entries())
      found.push(
        `${at}.checks[${j}] sends ${Object.entries(c.args)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}: is every value public, none of them yours?`,
      );
  }
  if (notes) check(notes, "the notes");
  return found;
}

export interface Plan {
  site: string;
  /** the files that will be sent, byte for byte */
  files: { path: string; text: string }[];
  /** of the files: what `--yes` must find unchanged */
  sha256: string;
  operations: ReturnType<typeof summarize>[];
  stripped: string[];
  errors: string[];
  warnings: string[];
  /** to the publisher only: may be their own, never put in the pull request */
  personal: string[];
  /** each op's last verify on its current version: put in the pull request */
  checks: Gate["rows"];
  /** the hash of the registry copy this spec was pulled as, when it was pulled */
  pulled?: string;
}

/**
 * Which param examples go out: by default those of ops learned signed out, each listed in `personal`
 * for the human to check (verify, and anything testing the shared spec, needs them); `all` keeps those
 * of ops learned signed in too, `none` strips every one.
 */
export type Examples = "loggedOut" | "all" | "none";

/** The preview: the export, the shared rules, a live-secret scan no `public` name waives, and the privacy checks. */
export function plan(name: string, o: { examples?: Examples } = {}): Plan {
  name = safeName(name);
  const r = loadSite(name);
  if (!r) throw new Error(`no site "${name}"`);
  const examples = o.examples ?? "loggedOut";
  const ex = exportSite(name, { keepExamples: examples === "loggedOut" ? "loggedOut" : examples === "all" });
  const notesPath = join(dirname(r.path), `${name}.md`);
  const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : undefined;
  const live = credentialsOf(
    besideOrigins(loadSession(name), [ex.spec.baseUrl, ...ex.spec.operations.flatMap(opUrls)]),
  );
  const vet = vetShared(ex.spec, notes);
  // the user's own copy, examples and all: what verify ran
  const checked = gate(r.site);
  const json = `${JSON.stringify(ex.spec, null, 2)}\n`;
  const files = [
    { path: `sites/${name}.json`, text: json },
    ...(notes !== undefined ? [{ path: `sites/${name}.md`, text: notes }] : []),
  ];
  // The exact bytes that would be public, keys and all. `public` keeps a shared bearer out of the shape
  // heuristics, never out of this: a value this machine holds is refused wherever it sits.
  const strict = scanSecrets(
    files.map((f) => f.text),
    live,
  ).secrets.map((m) => m.replace(/^\$\[(\d+)\]/, (_, i) => files[Number(i)]!.path));
  const big =
    Buffer.byteLength(json) > LIMITS.file
      ? [`${files[0]!.path} is ${Buffer.byteLength(json)} bytes; at most ${LIMITS.file}`]
      : [];
  return {
    site: name,
    files,
    sha256: createHash("sha256")
      .update(files.map((f) => `${f.path}\0${f.text}`).join("\0"))
      .digest("hex"),
    operations: ex.spec.operations.map(summarize),
    stripped: [
      ...(examples === "none"
        ? ["param examples"]
        : examples === "loggedOut" &&
            r.site.operations.some((op) => op.learnedLoggedIn && op.params.some((p) => p.example !== undefined))
          ? ["param examples of ops learned signed in"]
          : []),
      "response shapes",
      "when each op was learned",
      ...(r.site.shared ? ["where it was pulled from"] : []),
    ],
    errors: [...new Set([...ex.secrets, ...strict])].concat(vet.errors, big, checked.errors),
    warnings: [...new Set([...ex.warnings, ...vet.warnings])],
    personal: personal(ex.spec, notes),
    checks: checked.rows,
    ...(r.site.shared ? { pulled: r.site.shared.sha256 } : {}),
  };
}

/* ------------------------------------------------------------ against the registry */

export interface Changes {
  /** the registry's copy is the one this spec was pulled as (`current`: this is a heal of it), or an older one */
  base?: "current" | "older";
  added: string[];
  removed: string[];
  changed: { op: string; parts: string[] }[];
  /** the spec's own fields other than its ops */
  site: string[];
}

/** The parts of an op a reviewer of a change looks at, each compared on its own. */
const PARTS: [string, (op: Operation) => unknown][] = [
  ["request host", (op) => new URL(op.request.url).host],
  ["request URL", (op) => `${op.request.method} ${op.request.url.replace(/^[^/]*\/\/[^/]*/, "")}`],
  ["request headers or body", (op) => [op.request.headers, op.request.body]],
  ["slots", (op) => op.slots],
  ["volatile tokens", (op) => op.volatile],
  ["response recipe", (op) => op.response],
  ["trigger", (op) => op.trigger],
  ["match", (op) => op.match],
  ["params", (op) => op.params.map(({ example: _, ...p }) => p)],
  ["param examples", (op) => op.params.map((p) => p.example)],
  ["checks", (op) => op.checks],
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// what export strips is no change: the registry's copy went through export too
const comparable = (op: Operation): Operation => ({
  ...op,
  learnedAt: undefined,
  response: { ...op.response, shape: undefined },
});

/**
 * The registry's current copy of the plan's site against what the plan sends, fetched the way pull
 * fetches it; undefined when the registry has none.
 */
export async function againstRegistry(p: Plan, fetchImpl: typeof fetch = fetch): Promise<Changes | undefined> {
  const from = `${registryBase()}/sites/${p.site}.json`;
  const text = await fetchCapped(from, LIMITS.file, fetchImpl);
  if (text === undefined) return undefined;
  let theirs: Site;
  try {
    theirs = parseSite(JSON.parse(text));
  } catch (e) {
    throw new Error(`${from}: ${(e as Error).message.split("\n")[0]}`);
  }
  const ours = parseSite(JSON.parse(p.files[0]!.text));
  const old = new Map(theirs.operations.map((op) => [op.name, comparable(op)]));
  const now = new Map(ours.operations.map((op) => [op.name, comparable(op)]));
  const changed = [...now].flatMap(([name, op]) => {
    const before = old.get(name);
    if (!before || same(before, op)) return [];
    const parts = PARTS.filter(([, of]) => !same(of(before), of(op))).map(([part]) => part);
    return [{ op: name, parts: parts.length ? parts : ["other fields"] }];
  });
  const fields = new Set([...Object.keys(theirs), ...Object.keys(ours)] as (keyof Site)[]);
  const sha256 = createHash("sha256").update(text).digest("hex");
  return {
    ...(p.pulled ? { base: p.pulled === sha256 ? ("current" as const) : ("older" as const) } : {}),
    added: [...now.keys()].filter((n) => !old.has(n)),
    removed: [...old.keys()].filter((n) => !now.has(n)),
    changed,
    site: [...fields].filter((k) => k !== "operations" && k !== "name" && !same(theirs[k], ours[k])),
  };
}

/** The changes as lines, for the preview and the pull request. */
export function describeChanges(c: Changes): string[] {
  const code = (names: string[]) => names.map((n) => `\`${n}\``).join(", ");
  const none = !c.added.length && !c.removed.length && !c.changed.length && !c.site.length;
  return [
    ...(c.base === "current"
      ? ["A heal of the registry's current copy: this spec was pulled as that version and repaired when it drifted."]
      : c.base === "older"
        ? ["This spec was pulled as an older version of the registry's copy: a change below may undo one made since."]
        : []),
    ...(c.added.length ? [`Added: ${code(c.added)}`] : []),
    ...(c.removed.length ? [`Removed: ${code(c.removed)}`] : []),
    ...c.changed.map((x) => `Changed: \`${x.op}\` (${x.parts.join(", ")})`),
    ...(c.site.length ? [`Site fields changed: ${c.site.join(", ")}`] : []),
    ...(none ? ["Nothing changed."] : []),
  ];
}

/** Write the preview's files to the outbox, where the human reads them and `--yes` checks them. */
export function writeOutbox(p: Plan): string[] {
  const written = [`${p.site}.json`, `${p.site}.md`].map((f) => join(outboxDir(), f));
  for (const file of written) rmSync(file, { force: true });
  for (const f of p.files) writePrivate(join(outboxDir(), f.path.slice("sites/".length)), f.text);
  writePrivate(join(outboxDir(), `${p.site}.sha256`), `${p.sha256}\n`);
  return p.files.map((f) => join(outboxDir(), f.path.slice("sites/".length)));
}

/** The hash of the last preview, or undefined when there was none. */
export function previewed(name: string): string | undefined {
  const file = join(outboxDir(), `${safeName(name)}.sha256`);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/* ------------------------------------------------------------------ gh */

const ghBin = () => process.env.API_ANYTHING_GH || "gh";

class GhError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** One `gh api` call: fixed argument positions, the body as JSON on stdin, the answer parsed. */
function api(method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ["api", "--method", method, path, ...(body !== undefined ? ["--input", "-"] : [])];
    const child = execFile(ghBin(), args, { maxBuffer: 16 << 20, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim() ? JSON.parse(stdout) : undefined);
      const status = Number(/HTTP (\d{3})/.exec(`${stderr}${stdout}`)?.[1]) || undefined;
      const why =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "the GitHub CLI (gh) is not installed"
          : stderr.trim() || err.message;
      reject(new GhError(`gh api ${method} ${path}: ${why}`, status));
    });
    child.stdin?.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}

const optional = <T>(p: Promise<T>) =>
  p.catch((e) => {
    if (e instanceof GhError && e.status === 404) return undefined;
    throw e;
  });

async function retry<T>(f: () => Promise<T>, tries: number, ms: number): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

const field = (v: unknown, key: string, re: RegExp): string => {
  const x = (v as Record<string, unknown> | undefined)?.[key];
  if (typeof x !== "string" && typeof x !== "number") throw new Error(`gh answered no ${key}`);
  if (!re.test(String(x))) throw new Error(`gh answered an unexpected ${key}: ${String(x).slice(0, 80)}`);
  return String(x);
};

function prBody(p: Plan, update: boolean, changes: Changes | undefined): string {
  const ops = p.operations.map(
    (o) =>
      `| \`${o.op.replace(/\|/g, "\\|")}\` | ${o.method} | ${o.hosts.join(", ")} | ${o.write ? "write" : "read"}${o.login ? ", needs login" : ""} |`,
  );
  return [
    `${update ? "Updates" : "Adds"} the spec of \`${p.site}\`, sent with \`api-anything publish\`.`,
    "",
    "| operation | method | hosts | kind |",
    "|---|---|---|---|",
    ...ops,
    ...(changes ? ["", "Against the registry's current copy:", ...describeChanges(changes).map((l) => `- ${l}`)] : []),
    "",
    `Stripped before sending: ${p.stripped.join(", ")}. The shared rules passed, and no live cookie or session value of the publisher's was found in it.`,
    "",
    "What `api-anything verify` answered on the publisher's machine (every counted case passed; an inconclusive one, a challenge, sign-in page, rate limit or server failure, counts neither way):",
    "",
    ...checksTable(p.checks),
    ...(p.warnings.length ? ["", "For the reviewer:", ...p.warnings.map((w) => `- ${w}`)] : []),
  ].join("\n");
}

export interface Published {
  pr: string;
  branch: string;
  fork: string;
  update: boolean;
}

/**
 * Send what the preview showed. The plan is made again and must hash to the preview's, so what the
 * human approved is what is sent. Commits go to a branch of the user's fork named after the content
 * (a second run with the same content opens nothing new), authored and committed under the account's
 * noreply address, not the user's git email.
 */
export async function submit(
  name: string,
  o: { examples?: Examples; retryMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Published> {
  name = safeName(name);
  const p = plan(name, o);
  if (p.errors.length) throw new Error(`refusing to publish: ${p.errors.join("; ")}`);
  const seen = previewed(name);
  if (!seen) throw new Error(`no preview of ${name} yet`);
  if (seen !== p.sha256) throw new Error(`${name} changed since its preview`);
  const changes = await againstRegistry(p, o.fetchImpl);

  const user = await api("GET", "user");
  const login = field(user, "login", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
  const id = field(user, "id", /^\d+$/);
  const who = { name: login, email: `${id}+${login}@users.noreply.github.com` };
  const fork = field(await api("POST", `repos/${REPO}/forks`), "full_name", /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
  const owner = fork.split("/")[0]!;
  const ms = o.retryMs ?? 3000;
  // A new fork takes a few seconds to answer; an old one may be behind. Neither is fatal here.
  await retry(() => api("POST", `repos/${fork}/merge-upstream`, { branch: "main" }), 4, ms).catch(() => undefined);
  const main = (await api("GET", `repos/${REPO}/git/ref/heads/main`)) as { object?: unknown } | undefined;
  const base = field(main?.object, "sha", /^[0-9a-f]{40}$/);
  const branch = `share/${name}-${p.sha256.slice(0, 10)}`;
  await retry(
    () =>
      api("POST", `repos/${fork}/git/refs`, { ref: `refs/heads/${branch}`, sha: base }).catch((e) => {
        if (e instanceof GhError && e.status === 422) return undefined; // the branch exists: this content was sent before
        throw e;
      }),
    4,
    ms,
  );
  const update = (await optional(api("GET", `repos/${REPO}/contents/sites/${name}.json?ref=main`))) !== undefined;
  // From the first upload on, the spec may be public in the fork (a lost answer is no proof the
  // upload failed): a failure after one must say so.
  const sent: string[] = [];
  try {
    for (const f of p.files) {
      const there = await optional(api("GET", `repos/${fork}/contents/${f.path}?ref=${encodeURIComponent(branch)}`));
      const sha = there && field(there, "sha", /^[0-9a-f]{40}$/);
      sent.push(f.path);
      // replacing a file takes its blob sha: the branch starts at the registry's main, so a file there is here
      await api("PUT", `repos/${fork}/contents/${f.path}`, {
        message: `${sha ? "Update" : "Add"} ${f.path}`,
        content: Buffer.from(f.text).toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
        author: who,
        committer: who,
      });
    }
    const title = `${update ? "Update" : "Add"} sites/${name}.json`;
    let pr: string;
    try {
      pr = field(
        await api("POST", `repos/${REPO}/pulls`, {
          title,
          head: `${owner}:${branch}`,
          base: "main",
          body: prBody(p, update, changes),
        }),
        "html_url",
        /^https:\/\/github\.com\//,
      );
    } catch (e) {
      if (!(e instanceof GhError && e.status === 422)) throw e;
      // already open for this branch
      const open = await api("GET", `repos/${REPO}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`);
      pr = field((open as unknown[])[0], "html_url", /^https:\/\/github\.com\//);
    }
    return { pr, branch, fork, update };
  } catch (e) {
    if (!sent.length) throw e;
    throw new Error(
      `${(e as Error).message}; ${sent.join(" and ")} may already be public in your fork ${fork}, branch ${branch}: run this again to open the pull request, or delete that branch to take them back`,
    );
  }
}
