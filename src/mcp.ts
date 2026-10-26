/**
 * stdio MCP server with five fixed meta-tools, so the tool list costs the same at 2 sites or 200.
 * Writes are hidden from list_operations and refused by call_operation unless started with allowWrites.
 * It cannot learn operations (that is the CLI's capture/add), but it finds and pulls reviewed shared
 * specs, whose writes it never offers: page content may be steering the agent. For the same reason its
 * login cannot import cookies a human did not already choose to import.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser, login } from "./browser.js";
import { call, type NextCall } from "./execute.js";
import { returnedFields } from "./extract.js";
import { profileDir } from "./heal.js";
import { browserSource, cookieNames, importSession, loggedIn, resolveLoginTarget } from "./login.js";
import { type Found, type IndexCache, type Pulled, pull, search } from "./registry.js";
import { loadSession, saveSession, sessionFile, withLock } from "./session.js";
import { listSites, loadSite, siteNotes } from "./store.js";
import { SHARED_NOTE } from "./vet.js";

export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * A `next` hint in MCP terms: the CLI's `ops`, `sites` and `login` are tools here; commands only the
 * CLI has (heal, add, capture) the agent runs in its own shell, or hands to the user when it has none.
 */
export function mcpNext(next: string): string {
  const out = next
    .replace(/rerun with --allow-writes \(MCP: [^)]*\)/, "ask the user to restart this MCP server with --allow-writes")
    .replace(/api-anything ops ([\w.-]+)/g, 'list_operations {"site":"$1"}')
    .replace(/api-anything sites/g, "list_sites")
    .replace(/api-anything search ([\w.-]+)/g, 'find_sites {"query":"$1"}')
    .replace(/api-anything pull ([\w.-]+)/g, 'list_operations {"site":"$1"} (it pulls a shared site)')
    .replace(
      /(?:ask the user to run:? )?api-anything login ([\w.-]+)/g,
      'the login tool {"site":"$1"} (mode "window" when the user must sign in or clear a challenge by hand)',
    )
    .replace(/api-anything add creates one/, "a new site is added with the CLI");
  return /\bapi-anything (heal|add|capture|verify|export)\b/.test(out)
    ? `${out} (api-anything is a CLI: run it in your shell, as npx -y github:goodnight000/api-anything when the command is not installed; with no shell, ask the user)`
    : out;
}

const CHECKED_NOTE =
  "[worked/failed <date>] is a daily check that calls each read needing no account with its examples, from GitHub's servers; one that failed there may still work from the user's machine";

/** An op as find_sites lists it: its signature, and what the registry's last check of it found. */
function withHealth(o: Found["operations"][number]): string {
  const h = o.health;
  if (!h) return o.op;
  const day = (iso: string) => iso.slice(0, 10);
  if (h.ok) return `${o.op} [worked ${day(h.checkedAt)}]`;
  return `${o.op} [failed ${day(h.checkedAt)}${h.lastOk ? `, last worked ${day(h.lastOk)}` : ""}]`;
}

/**
 * A result's `nextCall` in MCP terms: the tool that takes the step and its arguments, when one of
 * this server's tools does (`retry` is call_operation with the same args). The rest are the CLI's or
 * the user's, and `next` says how.
 */
export function mcpNextCall(nc: NextCall): NextCall & { tool?: string; args?: Record<string, unknown> } {
  const { site, op } = nc;
  switch (nc.action) {
    case "login":
      return { ...nc, tool: "login", args: { site, ...(nc.mode ? { mode: nc.mode } : {}) } };
    case "fix_args":
      return { ...nc, tool: "list_operations", args: { site } };
    case "list_sites":
      return { ...nc, tool: "list_sites", args: {} };
    case "retry":
      return { ...nc, tool: "call_operation", args: { site, op } };
    default:
      return nc;
  }
}

/**
 * A list of records repeats every key in every item, which an agent pays for in tokens. Over MCP
 * such a list is sent once-per-key as `{columns, rows}`; a missing field is null. A table that
 * would grow the JSON is kept as records, as is anything else, including a list with one item.
 */
export function asTable(data: unknown): unknown {
  const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  if (!Array.isArray(data) || data.length < 2 || !data.every(isRecord)) return data;
  const keys = new Set<string>();
  let fields = 0;
  for (const record of data) {
    const names = Object.keys(record);
    fields += names.length;
    for (const name of names) keys.add(name);
  }
  const sourceSize = JSON.stringify(data).length;
  // Missing fields alone can exceed the capped answer; do not allocate that dense matrix.
  if ((data.length * keys.size - fields) * 4 > sourceSize) return data;
  const columns = [...keys];
  const table = { columns, rows: data.map((x) => columns.map((c) => (Object.hasOwn(x, c) ? x[c] : null))) };
  return JSON.stringify(table).length < sourceSize ? table : data;
}

/** A result's `share` over MCP, which cannot publish: publishing is the user's, in their terminal. */
export const mcpShare = (command: string) =>
  `this call repaired a site someone shared, and the registry's copy is still broken for everyone else: ask the user whether to send the fix back, and if they want to, to run in a terminal: ${command} (it previews exactly what becomes public and sends nothing)`;

/**
 * A site an agent pulled over MCP: its writes stay hidden whatever the server allows (see registry.ts pull).
 * A site that does not load counts as one; call() then says why it does not, in its own fields.
 */
const agentPulled = (site: string) => {
  try {
    return loadSite(site)?.site.shared?.by === "agent";
  } catch {
    return true;
  }
};
const isWrite = (site: string, op: string) => {
  try {
    return !!loadSite(site)?.site.operations.some((o) => o.name === op && !o.readOnly);
  } catch {
    return false;
  }
};

const reply = (v: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v) }],
  isError,
});

/** Every failure comes back as {error, next} JSON, like call_operation's, never as a bare exception text. */
const guarded =
  <A>(fn: (a: A) => Promise<ReturnType<typeof reply>>) =>
  async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!;
      return reply(
        {
          ok: false,
          error: msg,
          next: /invalid site name|no site/.test(msg)
            ? "list_sites"
            : "fix or delete the file named in error, then retry once",
        },
        true,
      );
    }
  };

export function createServer({ allowWrites = false }: { allowWrites?: boolean } = {}): McpServer {
  const indexCache: IndexCache = {};
  // without naming the sites up front, an agent asked "what does Goodreads rate X?" reaches for web search
  const server = new McpServer(
    { name: "api-anything", version: VERSION },
    {
      instructions:
        `Calls these websites' own data requests directly, usually over plain HTTP: ${listSites().join(", ")}. ` +
        "When the user wants data from one of them, prefer list_operations then call_operation over web search or a browser. " +
        "For any other website, find_sites first: someone may have shared it, and list_operations then fetches it.",
    },
  );

  server.registerTool(
    "list_sites",
    {
      description: "List the websites api-anything can call, with how many operations each has.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      reply(
        listSites().map((name) => {
          try {
            const s = loadSite(name)!.site;
            const writes = allowWrites && !agentPulled(name);
            const ops = s.operations.filter((o) => writes || o.readOnly).length;
            return { name, ...(s.description ? { description: s.description } : {}), operations: ops };
          } catch (e) {
            return { name, error: (e as Error).message };
          }
        }),
      ),
  );

  server.registerTool(
    "find_sites",
    {
      description:
        'Find websites someone already turned into operations: the shared registry and this machine\'s sites, best match first. query is words (what you need: "book ratings", "flight prices"), a domain or a URL. A match with installed false is fetched by list_operations on first use.',
      inputSchema: { query: z.string().describe("words, a domain or a URL") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ query }: { query: string }) => {
      const r = await search(query, { cache: indexCache });
      const top = r.matches[0];
      return reply({
        matches: r.matches.map((m) => ({
          ...m,
          operations: m.operations.filter((o) => !o.write).map(withHealth),
        })),
        ...(r.registryError ? { registryError: r.registryError } : {}),
        ...(r.matches.some((m) => m.operations.some((o) => o.health)) ? { checked: CHECKED_NOTE } : {}),
        // bundled and pulled specs are someone else's too, installed or not
        ...(r.matches.length ? { shared: SHARED_NOTE } : {}),
        next: top
          ? `list_operations {"site":"${top.site}"}`
          : "nobody shared one yet: a new site is learned with the CLI (api-anything capture, then add), in your shell or by the user",
      });
    }),
  );

  server.registerTool(
    "list_operations",
    {
      description:
        "List a site's operations with their params and the keys a result item can carry (returns; one the site leaves out is absent), and the site's notes (caveats, arg formats). Call this before call_operation. A shared site from find_sites that is not installed is pulled from the registry first (reads only).",
      inputSchema: { site: z.string().describe("site name from list_sites or find_sites") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ site }: { site: string }) => {
      let pulled: Pulled | undefined;
      if (!loadSite(site)) {
        try {
          pulled = await pull(site, { by: "agent" });
        } catch (e) {
          const missing = /^no shared spec/.test((e as Error).message);
          return reply(
            {
              error: missing ? `no site "${site}", here or in the registry` : (e as Error).message,
              next: missing
                ? `find_sites {"query":"${site}"} with words or the site's domain; if nothing matches, a new site is learned with the CLI (api-anything capture, then add)`
                : "do not try to get around this; tell the user the shared spec could not be used",
            },
            true,
          );
        }
      }
      const r = loadSite(site)!;
      const writes = allowWrites && !agentPulled(r.site.name);
      const notes = siteNotes(r.site.name);
      return reply({
        site,
        ...(pulled
          ? { pulled: { from: pulled.from, warnings: pulled.warnings.filter((w) => !/a write \(/.test(w)) } }
          : {}),
        operations: r.site.operations
          .filter((o) => writes || o.readOnly)
          .map((o) => ({
            name: o.name,
            ...(o.description ? { description: o.description } : {}),
            ...(o.readOnly ? {} : { write: true }),
            ...(returnedFields(o.response) ? { returns: returnedFields(o.response) } : {}),
            params: o.params.map((p) => ({
              name: p.name,
              type: p.type,
              required: p.required,
              ...(p.description ? { description: p.description } : {}),
              ...(p.example !== undefined ? { example: p.example } : {}),
              ...(p.hint ? { hint: p.hint } : {}),
              ...(p.pattern ? { pattern: p.pattern } : {}),
              ...(p.enum ? { enum: p.enum } : {}),
              ...(p.min !== undefined ? { min: p.min } : {}),
              ...(p.max !== undefined ? { max: p.max } : {}),
            })),
          })),
        ...(r.site.shared ? { shared: SHARED_NOTE } : {}),
        ...(notes ? { notes } : {}),
      });
    }),
  );

  server.registerTool(
    "call_operation",
    {
      description:
        "Call a site operation. Returns {ok, class, data, tier, healed?, share?, ms, reason?, next?, nextCall?, retry?, retryAfterMs?, write?}; a list of two or more records comes back as data {columns, rows} when that shortens the JSON (one row per item, null for a missing field); otherwise it stays a list. `reason` also explains a slow success. On failure follow `next` (nextCall is the same step as data, with the tool to use) at most once, then stop and report. `retry` says whether to send the same call again: safe, after_wait (retryAfterMs), after_fix (once the step is done) or no. `share` means this call repaired a site someone shared: offer the user, in one line, to send the fix back as it says." +
        (allowWrites
          ? " Write operations change the user's account: only call them when the user asked for that exact action. A write's `write` says what it did: not_sent, not_applied, accepted or may_have_applied; never send one again that is accepted or may_have_applied without checking the site. The same write within 10 minutes is refused (class duplicate) unless again is true."
          : " Writes are disabled on this server."),
      inputSchema: {
        site: z.string(),
        op: z.string().describe("operation name from list_operations"),
        args: z.record(z.string(), z.unknown()).optional().describe("param name -> value"),
        ...(allowWrites
          ? {
              again: z
                .boolean()
                .optional()
                .describe(
                  "send a write that was refused as a duplicate; only when the user checked the site and wants it sent again",
                ),
              idempotencyKey: z
                .string()
                .optional()
                .describe("a key of your choosing for this write: a repeat with it returns the first call's record"),
            }
          : {}),
      },
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites, openWorldHint: true },
    },
    guarded(
      async ({
        site,
        op,
        args,
        again,
        idempotencyKey,
      }: {
        site: string;
        op: string;
        args?: Record<string, unknown>;
        again?: boolean;
        idempotencyKey?: string;
      }) => {
        // an agent-pulled site is read-only here, whatever the server allows
        const writes = allowWrites && !agentPulled(site);
        if (allowWrites && !writes && isWrite(site, op))
          return reply(
            {
              ok: false,
              class: "input",
              write: "not_sent",
              retry: "after_fix",
              reason: `${op} is a write of a site this server pulled for an agent, and those run only once a human pulls the site`,
              next: `ask the user to look at the site's operations and, if they trust them, run in a terminal: api-anything pull ${site.toLowerCase()}`,
            },
            true,
          );
        const r = await call(site, op, args ?? {}, { allowWrites: writes, again, idempotencyKey });
        return reply(
          {
            ...r,
            ...(r.data !== undefined ? { data: asTable(r.data) } : {}),
            ...(r.next ? { next: mcpNext(r.next) } : {}),
            ...(r.nextCall ? { nextCall: mcpNextCall(r.nextCall) } : {}),
            ...(r.share ? { share: mcpShare(r.share) } : {}),
          },
          !r.ok,
        );
      },
    ),
  );

  server.registerTool(
    "login",
    {
      description:
        "Sign in to a site so its operations work; use after a call returns class 'auth'. mode 'import' (default) refreshes the session from the browser profile the user already chose with `api-anything login` (no password); 'window' opens a visible browser for the user to sign in and clear 2FA/captcha by hand: tell the user to close that window when they are signed in, because the call only returns once it is closed.",
      inputSchema: {
        site: z.string().optional().describe("site name from list_sites"),
        url: z.string().optional().describe("a full URL, if the site is not yet known (window mode only)"),
        mode: z.enum(["import", "window"]).optional(),
      },
      annotations: { openWorldHint: true },
    },
    guarded(async ({ site, url, mode }: { site?: string; url?: string; mode?: "import" | "window" }) => {
      const target = site ?? url;
      if (!target) return reply({ error: "give a site or a url" }, true);
      let t: ReturnType<typeof resolveLoginTarget>;
      try {
        t = resolveLoginTarget(target);
      } catch (e) {
        return reply({ error: (e as Error).message, next: "list_sites" }, true);
      }
      if (mode === "window") {
        // a human signs in by hand: they see which site and which account
        const cookies = await login({ url: t.url, profileDir: profileDir(), waitForEnter: false });
        withLock(sessionFile(t.site), () => saveSession(t.site, { ...loadSession(t.site), cookies, source: "window" }));
        return reply({
          ok: true,
          site: t.site,
          source: "window",
          cookies: cookieNames(cookies),
          loggedIn: loggedIn(cookies, t.loginCookies),
        });
      }
      // An agent may be acting on injected page text: it may only refresh a known site's session from
      // the profile a human already picked, never pull another domain's or another account's cookies.
      const source = loadSite(t.site) ? browserSource(t.site) : undefined;
      if (!source) {
        return reply(
          {
            ok: false,
            site: t.site,
            error: "MCP can only refresh a session the user imported with the CLI",
            next: `ask the user to run in a terminal: api-anything login ${t.site} (or use mode "window")`,
          },
          true,
        );
      }
      let imported: Awaited<ReturnType<typeof importSession>>;
      try {
        imported = await importSession(t.site, t.url, { loginCookies: t.loginCookies, profile: source });
      } catch (e) {
        return reply(
          {
            ok: false,
            site: t.site,
            error: (e as Error).message,
            next: `ask the user to run: api-anything login ${t.site}`,
          },
          true,
        );
      }
      if (!imported)
        return reply(
          {
            ok: false,
            site: t.site,
            error: `no signed-in session in ${source}`,
            next: `ask the user to run: api-anything login ${t.site}`,
          },
          true,
        );
      return reply({
        ok: true,
        site: t.site,
        source: imported.source,
        profile: `${imported.browser}/${imported.profile}`,
        ...(imported.name ? { profileName: imported.name } : {}),
        cookies: cookieNames(imported.cookies),
        loggedIn: loggedIn(imported.cookies, t.loginCookies),
      });
    }),
  );
  return server;
}

export async function serveStdio(opts: { allowWrites?: boolean } = {}): Promise<void> {
  await createServer(opts).connect(new StdioServerTransport());
  // An open Chrome keeps the process alive after the client goes away.
  process.stdin.once("end", () => void closeBrowser().finally(() => process.exit(0)));
}
