import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Helpers for making server-side requests to URLs that users control.
 * Blocks loopback, private, link-local and other non-public addresses.
 *
 * Two layers are needed:
 * - assertPublicUrl: rejects IP-literal URLs (Node never calls `lookup` for those)
 * - the agents' `lookup`: rejects hostnames that resolve to non-public IPs,
 *   checked at connect time so DNS rebinding can't swap the address afterwards
 */

const blocked = new net.BlockList();
// IPv4
for (const [net_, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net_, prefix, "ipv4");
}
// IPv6
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast

// Expands a valid IPv6 string (net.isIP() === 6) into its 8 hextets, so the
// embedded-IPv4 forms below can read groups at fixed positions. Handles the
// "::" compression and a dotted-quad tail (::1.2.3.4). Returns null on
// anything it can't expand; callers fall back to the plain IPv6 check
const expandIPv6 = (ip: string): number[] | null => {
  let body = ip.toLowerCase();
  const dotted = body.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) {
      return null;
    }
    body =
      body.slice(0, body.length - dotted[1].length) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }
  const halves = body.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return groups.map((g) => parseInt(g, 16));
};

// Two hextets holding an IPv4 (e.g. 7f00:1) → dotted quad, for the
// blocked.check(ipv4) reuse below
const ipv4FromHextets = (hi: number, lo: number) =>
  `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPrivateIP(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return blocked.check(ip, "ipv4");
  }
  if (family === 6) {
    const groups = expandIPv6(ip);
    if (groups) {
      // NAT64 64:ff9b::/96: the address's last 32 bits are the IPv4
      if (
        groups[0] === 0x64 &&
        groups[1] === 0xff9b &&
        groups.slice(2, 6).every((g) => g === 0)
      ) {
        return blocked.check(ipv4FromHextets(groups[6], groups[7]), "ipv4");
      }
      // 6to4 2002::/16: the IPv4 follows the prefix
      if (groups[0] === 0x2002) {
        return blocked.check(ipv4FromHextets(groups[1], groups[2]), "ipv4");
      }
    }
    const lower = ip.toLowerCase();
    // IPv4-mapped, dotted form (::ffff:127.0.0.1)
    const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
      return blocked.check(dotted[1], "ipv4");
    }
    // IPv4-mapped, hex form (::ffff:7f00:1)
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return blocked.check(
        `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`,
        "ipv4",
      );
    }
    return blocked.check(ip, "ipv6");
  }
  // Not an IP at all, fail closed
  return true;
}

/**
 * Throws unless the URL is http(s) and doesn't point at a non-public IP literal or localhost.
 * Hostnames are checked again at connect time by the agents below.
 */
export function assertPublicUrl(input: string | URL): URL {
  const url = typeof input === "string" ? new URL(input) : input;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported protocol");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Blocked host");
  }
  if (net.isIP(host) && isPrivateIP(host)) {
    throw new Error("Blocked address");
  }
  return url;
}

const safeLookup = (
  hostname: string,
  options: any,
  callback: (err: any, address?: any, family?: any) => void,
) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err);
      return;
    }
    // With `all: true` the address is an array
    const addresses: string[] = Array.isArray(address)
      ? address.map((a: { address: string }) => a.address)
      : [address as string];
    const bad = addresses.find((a) => isPrivateIP(a));
    if (bad) {
      callback(new Error(`Blocked address ${bad}`));
      return;
    }
    callback(null, address, family);
  });
};

const safeHttpAgent = new http.Agent({ lookup: safeLookup });
const safeHttpsAgent = new https.Agent({ lookup: safeLookup });

/**
 * Spread into an axios request config.
 * Redirect targets are re-validated since IP-literal redirects skip DNS lookup.
 */
export const safeAxiosConfig = {
  httpAgent: safeHttpAgent,
  httpsAgent: safeHttpsAgent,
  maxRedirects: 3,
  timeout: 15000,
  beforeRedirect: (options: { protocol?: string; hostname?: string }) => {
    assertPublicUrl(`${options.protocol}//${options.hostname}`);
  },
};
