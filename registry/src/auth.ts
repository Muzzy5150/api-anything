/** Who sent a request: the install's key from its signature (src/registry-api.ts), and its network, hashed. */
import { signingText } from "../../src/registry-api.js";

const SKEW_MS = 5 * 60_000;

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return undefined;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export type Signer = { key: string } | { error: string } | undefined;

/**
 * The key that signed the request, an error when its signature does not hold, or undefined when it is
 * not signed. The signed path is the pathname with its query; the bare pathname is accepted too.
 */
export async function signer(request: Request, body: Uint8Array<ArrayBuffer>, now = Date.now()): Promise<Signer> {
  const key = request.headers.get("x-aa-key");
  const ts = request.headers.get("x-aa-ts");
  const sig = request.headers.get("x-aa-sig");
  if (!key && !ts && !sig) return undefined;
  if (!key || !ts || !sig) return { error: "a signed request needs x-aa-key, x-aa-ts and x-aa-sig" };
  if (!/^\d{1,16}$/.test(ts) || Math.abs(now - Number(ts)) > SKEW_MS)
    return { error: "x-aa-ts is more than 5 minutes off the server's clock" };
  const raw = fromBase64url(key);
  const signature = fromBase64url(sig);
  if (raw?.length !== 32) return { error: "x-aa-key is not a 32-byte Ed25519 public key, base64url" };
  if (signature?.length !== 64) return { error: "x-aa-sig is not a 64-byte Ed25519 signature, base64url" };
  const url = new URL(request.url);
  const bodyHash = await sha256Hex(body);
  const publicKey = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  for (const path of new Set([url.pathname + url.search, url.pathname])) {
    const text = new TextEncoder().encode(signingText(request.method, path, ts, bodyHash));
    if (await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, text)) return { key };
  }
  return { error: "the signature does not match the request" };
}

/** An IP's /24 (v4) or /48 (v6); a v4-mapped v6 address is read as v4. */
export function prefixOf(ip: string): string {
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}`;
  if (!ip.includes(":")) return "unknown";
  const [head = "", tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups
    .slice(0, 3)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":");
}

/**
 * The request's networks, hashed with the salt: `network` (its ASN, else its IP prefix) is what promotion
 * counts; `prefix` (always the IP prefix) is what rate limits count, since one ASN holds a whole ISP.
 */
export async function networksOf(request: Request, salt: string): Promise<{ network: string; prefix: string }> {
  const asn = (request as Request & { cf?: { asn?: number } }).cf?.asn;
  const ip = `ip:${prefixOf(request.headers.get("cf-connecting-ip") ?? "")}`;
  const hash = async (s: string) => (await sha256Hex(`${salt}\n${s}`)).slice(0, 32);
  const prefix = await hash(ip);
  return { network: asn ? await hash(`asn:${asn}`) : prefix, prefix };
}
