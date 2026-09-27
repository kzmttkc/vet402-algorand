import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type TargetCheck = { ok: true; url: URL } | { ok: false; detail: string };

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateV4(mapped[1]) : false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true;
}

/**
 * Reject URLs vet402 must not fetch on a customer's behalf.
 * With allowPrivate=false: https only, and every resolved address must be public.
 * Residual risk: DNS rebinding between this check and the fetch (documented).
 */
export async function checkTarget(
  raw: string,
  allowPrivate: boolean,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address),
): Promise<TargetCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, detail: "not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, detail: `scheme ${url.protocol} not allowed` };
  if (url.username || url.password) return { ok: false, detail: "credentials in URL not allowed" };
  if (allowPrivate) return { ok: true, url };
  if (url.protocol !== "https:") return { ok: false, detail: "https required" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : await resolve(host);
  } catch {
    return { ok: false, detail: "host does not resolve" };
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) return { ok: false, detail: "private or unresolvable address" };
  return { ok: true, url };
}
