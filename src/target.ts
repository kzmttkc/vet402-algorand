import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type TargetCheck = { ok: true; url: URL } | { ok: false; detail: string };

/** IPv4 ranges vet402 never fetches: private, loopback, link-local (cloud metadata), CGNAT, reserved. */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, 169.254.169.254 metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

/** IPv6 ranges vet402 never fetches, including every form that can carry an IPv4 address. */
const V6_BLOCKED: [string, number][] = [
  ["::", 96], // ::, ::1 and IPv4-compatible ::a.b.c.d
  ["::ffff:0:0", 96], // IPv4-mapped (checked again as IPv4 below; blocked if it cannot be unwrapped)
  ["::ffff:0:0:0", 96], // IPv4-translated
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (Teredo 2001::/32 embeds IPv4)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 embeds IPv4
  ["fc00::", 7], // unique local (fd00:ec2::254 metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const V4 = new BlockList();
for (const [a, p] of V4_BLOCKED) V4.addSubnet(a, p, "ipv4");
const V6 = new BlockList();
for (const [a, p] of V6_BLOCKED) V6.addSubnet(a, p, "ipv6");

/** Canonical compressed IPv6 (lower case, hex groups), or null if it does not parse (e.g. a zone id). */
function canonicalV6(ip: string): string | null {
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

/** ::ffff:a.b.c.d in any spelling (dotted or hex) -> "a.b.c.d". */
function unmapV4(canon: string): string | null {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return V4.check(ip, "ipv4");
  if (v === 6) {
    const canon = canonicalV6(ip);
    if (!canon) return true;
    const mapped = unmapV4(canon);
    if (mapped) return V4.check(mapped, "ipv4");
    return V6.check(canon, "ipv6");
  }
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

/** How long the check before a charge waits for DNS (the unpaid request pays for this lookup). */
export const PRECHARGE_DNS_TIMEOUT_MS = 3000;

export type PrechargeCheck =
  | { ok: true; url: URL }
  | { ok: false; status: 400 | 422; reason: "invalid_target" | "self_dealing"; detail: string };

/**
 * The target checks that need no seller contact, run before vet402 asks the customer to pay
 * (unpaid request: no 402 for a URL vet402 cannot buy) and again after verify, before settle.
 * checkTarget (https only, resolves, public addresses only) with DNS bounded by `timeoutMs`,
 * then vet402's own hosts. The checks after settlement (probe.ts) stay as they are.
 */
export async function checkBeforeCharge(
  raw: string,
  o: {
    allowPrivate: boolean;
    resolve?: (host: string) => Promise<string[]>;
    /** Host names that are vet402 itself (a match also covers subdomains). */
    isOwnHost: (hostname: string) => boolean;
    /** host[:port] serving this request: a target on it is vet402 itself. */
    requestHost?: string;
    timeoutMs?: number;
  },
): Promise<PrechargeCheck> {
  const ms = o.timeoutMs ?? PRECHARGE_DNS_TIMEOUT_MS;
  const base = o.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  let timedOut = false;
  const bounded = (h: string) =>
    new Promise<string[]>((resolve, reject) => {
      const t = setTimeout(() => {
        timedOut = true;
        reject(new Error("dns timeout"));
      }, ms);
      base(h).then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      );
    });
  const t = await checkTarget(raw, o.allowPrivate, bounded);
  if (!t.ok) {
    const detail = timedOut ? `host did not resolve within ${ms / 1000} s` : t.detail;
    return { ok: false, status: 400, reason: "invalid_target", detail };
  }
  const host = t.url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (o.isOwnHost(host) || (o.requestHost !== undefined && t.url.host.toLowerCase() === o.requestHost.toLowerCase())) {
    return { ok: false, status: 422, reason: "self_dealing", detail: "this URL is vet402 itself; vet402 never buys from itself" };
  }
  return { ok: true, url: t.url };
}
