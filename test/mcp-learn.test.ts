import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.js";
import { learnTool } from "../src/mcp-learn.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function tools(): Promise<string[]> {
  const client = new Client({ name: "probe", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  await client.connect(b);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

test("learn_site is listed by default, and hidden when learning is off", async () => {
  assert.ok((await tools()).includes("learn_site"));
  learnTool.enabled = false;
  try {
    const names = await tools();
    assert.ok(!names.includes("learn_site"));
    assert.ok(names.includes("call_operation"));
  } finally {
    learnTool.enabled = true;
  }
});

test("api-anything mcp --no-learn serves no learn_site; a write asked of learn_site is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "aa-mcp-learn-"));
  const env = { ...(process.env as Record<string, string>), API_ANYTHING_HOME: home };
  const serve = (...flags: string[]) =>
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(ROOT, "src", "cli.ts"), "mcp", ...flags],
      cwd: ROOT,
      env,
    });
  const off = new Client({ name: "probe", version: "0" });
  const on = new Client({ name: "probe", version: "0" });
  try {
    await off.connect(serve("--no-learn"));
    assert.ok(!(await off.listTools()).tools.some((t) => t.name === "learn_site"));
    await on.connect(serve());
    const r = await on.callTool({
      name: "learn_site",
      arguments: {
        trigger: "http://127.0.0.1:1/compose",
        args: { t: "aaa" },
        args2: { t: "bbb" },
        args3: { t: "ccc" },
        write: true,
      },
    });
    const out = JSON.parse((r.content as { text: string }[])[0]!.text);
    assert.equal(r.isError, true);
    assert.deepEqual([out.ok, out.class], [false, "refused"]);
  } finally {
    await off.close();
    await on.close();
    rmSync(home, { recursive: true, force: true });
  }
});
