/**
 * The registry's HTML: a home page that lists and searches every shared site, and one page per site. Every
 * string from a spec, its notes or git is someone else's text, so all of it goes through `esc`; none of it
 * reaches a script.
 */
import { failing, type IndexEntry, PAGES, REPO, STOP, searchWords } from "../src/registry.js";
import type { Operation, Site } from "../src/spec.js";

export interface SitePage {
  site: Site;
  entry: IndexEntry;
  /** the notes for callers, markdown */
  notes?: string;
  contributors: string[];
}

const INSTALL = `Set up API Anything for me: https://github.com/${REPO}/blob/main/INSTALL.md`;
const TAGLINE = "Teach your agent a website once; after that it calls the site like an API.";

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const titleOf = (e: Pick<IndexEntry, "site" | "displayName">) => e.displayName ?? e.site;

const day = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const text = d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  return `<time datetime="${esc(iso)}">${text}</time>`;
};

/** `code`, **bold** and https links inside one line of escaped text; code spans are left as they are. */
function inline(text: string): string {
  return esc(text)
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      i % 2
        ? `<code>${part.slice(1, -1)}</code>`
        : part
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" rel="nofollow ugc">$1</a>'),
    )
    .join("");
}

/** The markdown site notes use: paragraphs, `-` lists with indented continuation lines, headings. */
export function markdown(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (items.length) out.push(`<ul>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`);
    para = [];
    items = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (item) {
      if (para.length) flush();
      items.push(item[1]!);
    } else if (items.length && /^\s/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else {
      if (items.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/* ------------------------------------------------------------------ health */

type IndexOp = IndexEntry["operations"][number];

function healthCell(op: IndexOp, spec: Operation): string {
  const h = op.health;
  if (!h) {
    const why = !spec.readOnly
      ? "writes are never run by the check"
      : spec.learnedLoggedIn
        ? "needs an account, which the check does not have"
        : "no example args to check it with";
    return `<span class="h none" title="${esc(why)}">Not checked</span>`;
  }
  if (h.ok) return `<span class="h ok">Worked</span> <small>${day(h.checkedAt)}</small>`;
  const last = h.lastOk ? `last worked ${day(h.lastOk)}` : "no passing check yet";
  return `<span class="h bad">Failed</span> <small>${day(h.checkedAt)}; ${last}</small>`;
}

function healthSummary(e: IndexEntry): { label: string; tone: "ok" | "bad" | "mixed" | "none" } {
  const checked = e.operations.filter((o) => o.health);
  const ok = checked.filter((o) => o.health!.ok).length;
  if (!checked.length) return { label: "not checked", tone: "none" };
  const tone = ok === checked.length ? "ok" : ok === 0 ? "bad" : "mixed";
  return { label: `${ok} of ${checked.length} working`, tone };
}

const lastChecked = (e: IndexEntry) =>
  e.operations
    .flatMap((o) => (o.health ? [o.health.checkedAt] : []))
    .sort()
    .at(-1);

/* ------------------------------------------------------------------ sample call */

const shellArg = (s: string) => (/^[\w.,:/@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const argText = (v: unknown) => (typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

/** The op a visitor should try first: a read that runs logged out and has examples, preferring one that worked. */
function sampleOp(site: Site, e: IndexEntry): Operation | undefined {
  // the index lists a site's ops in the spec's order
  const worked = new Set(site.operations.filter((_, i) => e.operations[i]?.health?.ok));
  const reads = site.operations.filter((o) => o.readOnly);
  const runnable = (o: Operation) =>
    o.params.every((p) => !p.required || p.example !== undefined || p.default !== undefined);
  const ranked = [
    reads.filter((o) => runnable(o) && !o.learnedLoggedIn && worked.has(o)),
    reads.filter((o) => runnable(o) && !o.learnedLoggedIn),
    reads.filter(runnable),
    reads,
  ];
  return ranked.find((l) => l.length)?.[0];
}

function sampleCommands(name: string, op: Operation | undefined): string {
  const lines = [`api-anything pull ${name}`];
  if (op?.learnedLoggedIn) lines.push(`api-anything login ${name}    # signs in with your browser's cookies`);
  if (op) {
    const args = op.params.flatMap((p) =>
      p.example !== undefined
        ? [shellArg(`${p.name}=${argText(p.example)}`)]
        : p.required
          ? [`${p.name}=<${p.name}>`]
          : [],
    );
    lines.push(["api-anything call", name, op.name, ...args].join(" "));
  }
  return esc(lines.join("\n"));
}

/* ------------------------------------------------------------------ layout */

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1c1c1e;--muted:#68686f;--line:#e7e4de;--card:#fff;--code:#f2f0eb;--accent:#2952e3;--ok:#18794e;--ok-bg:#e6f4ec;--bad:#c2352e;--bad-bg:#fbeae8;--mixed:#9a6700;--mixed-bg:#fbf1dc;--none-bg:#efede9}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececef;--muted:#9b9ba3;--line:#2a2a2f;--card:#18181b;--code:#1f1f23;--accent:#86a6ff;--ok:#4cc38a;--ok-bg:#132d21;--bad:#ff7a70;--bad-bg:#3a1714;--mixed:#e2b340;--mixed-bg:#33270b;--none-bg:#232327}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
header.top{border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}
.brand{font-weight:650;color:var(--fg);letter-spacing:-.01em}
.top nav a{color:var(--muted);margin-left:18px;font-size:15px}
main{padding:44px 0 64px}
h1{font-size:clamp(30px,5vw,44px);line-height:1.1;letter-spacing:-.025em;margin:0 0 14px}
h2{font-size:22px;letter-spacing:-.015em;margin:48px 0 14px}
h3,h4,h5,h6{font-size:17px;margin:24px 0 8px}
.lede{font-size:clamp(18px,2.4vw,21px);color:var(--muted);margin:0 0 26px;max-width:42em}
.tag{display:inline-block;vertical-align:middle;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin-left:10px;position:relative;top:-4px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
code{background:var(--code);padding:1px 5px;border-radius:5px}
pre code{background:none;padding:0;border-radius:0}
.cmd{position:relative;background:var(--card);border:1px solid var(--line);border-radius:12px;margin:10px 0 22px}
.cmd pre{margin:0;padding:16px 92px 16px 18px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.copy{position:absolute;top:10px;right:10px;font:inherit;font-size:13px;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.copy:hover{color:var(--fg)}
.note{color:var(--muted);font-size:15px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px;padding:0;list-style:none}
.chips li{font-size:14px;background:var(--code);border-radius:999px;padding:2px 12px}
.h{display:inline-block;font-size:12.5px;font-weight:600;border-radius:999px;padding:1px 9px;white-space:nowrap}
.h.ok{color:var(--ok);background:var(--ok-bg)}.h.bad{color:var(--bad);background:var(--bad-bg)}.h.mixed{color:var(--mixed);background:var(--mixed-bg)}.h.none{color:var(--muted);background:var(--none-bg)}
small{color:var(--muted);font-size:13px}
input[type=search]{width:100%;font:inherit;font-size:17px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;outline:none}
input[type=search]:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
.sites{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:12px}
.sites li a{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;color:var(--fg)}
.sites li a:hover{text-decoration:none;border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.sites .row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.sites strong{font-size:17px}
.sites p{margin:4px 0 0;color:var(--muted);font-size:15px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sites .meta{white-space:nowrap;display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted)}
table.ops{width:100%;border-collapse:collapse;font-size:15px}
.ops th{text-align:left;font-size:13px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--line);padding:8px 10px}
.ops td{border-bottom:1px solid var(--line);padding:12px 10px;vertical-align:top}
.ops td.sig code{background:none;padding:0;font-weight:600;word-break:break-word}
.ops td.sig p{margin:4px 0 0;color:var(--muted);font-size:14px}
.ops .yes{font-weight:600}
.ops small{display:block;margin-top:4px;min-width:9em}
.notes{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:4px 22px}
.notes ul{padding-left:20px}.notes li{margin:6px 0}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:14px;padding:24px 0 40px}
footer p{margin:4px 0}
@media (max-width:680px){
  main{padding-top:30px}
  .cmd pre{padding:46px 16px 14px}
  .sites .row{flex-direction:column;gap:4px}
  .ops thead{display:none}
  .ops tr{display:block;border-bottom:1px solid var(--line);padding:10px 0}
  .ops td{display:inline-block;border:0;padding:3px 16px 3px 0}
  .ops td.sig{display:block}
  .ops td[data-label]:not(.sig)::before{content:attr(data-label) ": ";color:var(--muted);font-size:13px}
}
`;

const SCRIPT_COPY = `for(const b of document.querySelectorAll("[data-copy]"))b.addEventListener("click",()=>{navigator.clipboard.writeText(b.previousElementSibling.textContent).then(()=>{b.textContent="Copied";setTimeout(()=>{b.textContent="Copy"},1500)})});`;

// score() and search()'s cut from src/registry.ts, over the words each row carries (searchWords)
const SCRIPT_SEARCH = `(()=>{const q=document.getElementById("q"),list=document.getElementById("site-list"),none=document.getElementById("none"),rows=[...list.children];
const stop=new Set(${JSON.stringify([...STOP])});
const words=t=>t.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2&&!stop.has(w)).map(w=>w.length>4&&w.endsWith("s")&&!/[su]s$/.test(w)?w.slice(0,-1):w);
const of=r=>["name","title","about"].map(k=>r.dataset[k].split(" "));
const score=(r,ws)=>{const[name,title,about]=of(r);let t=0;for(const w of ws){const hit=(l,a,b,m=3)=>l.includes(w)?a:w.length>=m&&l.some(x=>x.includes(w))?b:0;t+=Math.max(hit(name,10,6),hit(title,6,3),hit(about,2,1,5))||-1}return t};
const run=()=>{const ws=[...new Set(words(q.value))];
const scored=rows.map((r,i)=>({r,i,s:ws.length?score(r,ws):1})).sort((a,b)=>b.s-a.s||(a.r.dataset.failing?1:0)-(b.r.dataset.failing?1:0)||a.i-b.i);
const best=scored[0]?.s??0;let shown=0;
for(const{r,s}of scored){r.hidden=!(s>0&&s*3>=best);if(!r.hidden)shown++;list.appendChild(r)}none.hidden=shown>0};
q.addEventListener("input",run);const p=new URLSearchParams(location.search).get("q");if(p){q.value=p;run()}})();`;

const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2952e3"/><path d="M9 22l7-12 7 12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

function layout(o: { title: string; description: string; path: string; root: string; body: string; script?: string }) {
  const url = `${PAGES}/${o.path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(url)}">
<link rel="icon" href="${ICON}">
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${o.root}">API Anything</a><nav><a href="${o.root}#sites">Sites</a><a href="https://github.com/${REPO}">GitHub</a></nav></div></header>
<main><div class="wrap">
${o.body}
</div></main>
<footer><div class="wrap"><p>API Anything is open source (MIT). Shared specs are written by contributors and reviewed before they merge; none is affiliated with or endorsed by the site it calls.</p><p><a href="https://github.com/${REPO}">github.com/${REPO}</a> · <a href="${o.root}index.json">index.json</a></p></div></footer>
<script>${SCRIPT_COPY}${o.script ?? ""}</script>
</body>
</html>
`;
}

const command = (text: string) =>
  `<div class="cmd"><pre><code>${text}</code></pre><button class="copy" type="button" data-copy>Copy</button></div>`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/* ------------------------------------------------------------------ pages */

export function homePage(entries: IndexEntry[]): string {
  const rows = entries.map((e) => {
    const h = healthSummary(e);
    const w = searchWords(e);
    const n = e.operations.length;
    return `<li data-name="${esc(w.name.join(" "))}" data-title="${esc(w.title.join(" "))}" data-about="${esc(w.about.join(" "))}"${failing(e) ? ' data-failing="1"' : ""}><a href="sites/${encodeURIComponent(e.site)}/">
<div class="row"><strong>${esc(titleOf(e))}</strong><span class="meta">${n} operation${n === 1 ? "" : "s"} <span class="h ${h.tone}">${esc(h.label)}</span></span></div>
${e.description ? `<p>${esc(e.description)}</p>` : ""}</a></li>`;
  });
  const body = `<h1>API Anything</h1>
<p class="lede">${esc(TAGLINE)} It learns the requests a site's own pages make, then your agent calls them over MCP, the CLI or TypeScript and gets JSON back.</p>
<p class="note">Paste this into Claude Code, Codex or another coding agent:</p>
${command(esc(INSTALL))}
<h2 id="sites">Shared sites</h2>
<p class="note">Specs other people taught it, ready to pull. Each read that runs without an account is called every day with its examples; the badge says how many worked.</p>
<input id="q" type="search" placeholder="Search: book ratings, flight prices…" aria-label="Search shared sites" autocomplete="off">
<ul class="sites" id="site-list">
${rows.join("\n")}
</ul>
<p class="note" id="none" hidden>No shared site matches. Your agent can learn it: ask it to turn the site into an API.</p>`;
  return layout({
    title: "API Anything: call any website like an API from your agent",
    description: `${TAGLINE} Shared, unofficial APIs for ${entries.slice(0, 6).map(titleOf).join(", ")} and more.`,
    path: "",
    root: "./",
    body,
    script: SCRIPT_SEARCH,
  });
}

export function sitePage({ site, entry, notes, contributors }: SitePage): string {
  const name = entry.site;
  const title = titleOf(entry);
  const rows = entry.operations.map((o, i) => {
    return `<tr>
<td class="sig" data-label="Operation"><code>${esc(o.op)}</code>${o.description ? `<p>${esc(o.description)}</p>` : ""}</td>
<td data-label="Method">${esc(o.method)}</td>
<td data-label="Login">${o.login ? '<span class="yes">needed</span>' : "no"}</td>
<td data-label="Writes">${o.write ? '<span class="yes">yes</span>' : "no"}</td>
<td data-label="Health">${healthCell(o, site.operations[i]!)}</td>
</tr>`;
  });
  const h = healthSummary(entry);
  const checked = lastChecked(entry);
  const health = checked
    ? `<p class="note"><span class="h ${h.tone}">${esc(h.label)}</span> at the last check, ${day(checked)}. The check calls each read that needs no account with its example args, from GitHub's servers.</p>`
    : "";
  const specUrl = `https://github.com/${REPO}/blob/main/sites/${encodeURIComponent(name)}.json`;
  const opNames = site.operations.map((o) => o.name).join(", ");
  const description = clip(
    `Unofficial ${title} API for your agent${site.description ? `: ${site.description}` : ""} Operations: ${opNames}.`,
    300,
  );
  const body = `<h1>${esc(title)} API<span class="tag">unofficial</span></h1>
${site.description ? `<p class="lede">${esc(site.description)}</p>` : ""}
<ul class="chips" aria-label="Domains">${entry.domains.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
${health}
<h2>Try it</h2>
<p class="note">Install API Anything: paste this into Claude Code, Codex or another coding agent.</p>
${command(esc(INSTALL))}
<p class="note">Then fetch this spec and call it, or ask your agent, which finds it by itself.</p>
${command(sampleCommands(name, sampleOp(site, entry)))}
<h2>Operations</h2>
<table class="ops">
<thead><tr><th>Operation</th><th>Method</th><th>Login</th><th>Writes</th><th>Health</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
${notes ? `<h2>Notes</h2>\n<div class="notes">${markdown(notes)}</div>` : ""}
<h2>About this spec</h2>
<p>A spec is a set of requests learned from ${esc(title)}'s own web pages: API Anything replays them over plain HTTP and falls back to a browser when it must. <a href="${esc(specUrl)}">Read the spec on GitHub</a>.</p>
${contributors.length ? `<p class="note">Contributors: ${contributors.map(esc).join(", ")}</p>` : ""}
<p><a href="../../">← All shared sites</a></p>`;
  return layout({
    title: `${title} API (unofficial), via API Anything`,
    description,
    path: `sites/${encodeURIComponent(name)}/`,
    root: "../../",
    body,
  });
}

export function sitemap(names: string[]): string {
  const urls = ["", ...names.map((n) => `sites/${encodeURIComponent(n)}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${esc(`${PAGES}/${u}`)}</loc></url>`).join("\n")}
</urlset>
`;
}
