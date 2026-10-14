/* Network guard for scans an agent asks for (the MCP server).
 *
 * A person typing `diarea scan <url>` chose that URL. An agent might have
 * been talked into one by something it read, so the agent server only loads
 * public sites by default:
 *
 *   - link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10,
 *     metadata.google.internal...) are always refused;
 *   - loopback and private networks (localhost, 10/8, 192.168/16, fc00::/7...)
 *     are refused unless the server was started with --allow-private.
 *
 * Every hostname is resolved and every address it resolves to is checked, so
 * a public name pointing at a private address is caught too. The live
 * collector also runs each request the page makes through the guard, and
 * checks the redirect chain of the page itself.
 */
import dns from "node:dns/promises";
import net from "node:net";

export const ALWAYS_BLOCKED = "metadata";
export const PRIVATE = "private";
export const PUBLIC = "public";
export const UNRESOLVED = "unresolved";

const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal"]);

function v4ToInt(ip) {
  return ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}
const inV4 = (ip, base, bits) => bits === 0 || (v4ToInt(ip) >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits));

function classifyV4(ip) {
  if (inV4(ip, "169.254.0.0", 16)) return ALWAYS_BLOCKED;
  const priv = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]];
  return priv.some(([b, n]) => inV4(ip, b, n)) ? PRIVATE : PUBLIC;
}

// Expand an IPv6 address to eight 16-bit groups.
function v6Groups(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + (n >>> 16).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill("0");
  return h.concat(fill, t).map((g) => parseInt(g || "0", 16));
}

function classifyV6(ip) {
  const g = v6Groups(ip);
  const embeddedV4 = () => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyV4(embeddedV4());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(embeddedV4());
  if ((g[0] & 0xffc0) === 0xfe80) return ALWAYS_BLOCKED; // link-local
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return ALWAYS_BLOCKED; // AWS IPv6 metadata
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return PRIVATE; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return PRIVATE; // unique local
  if ((g[0] & 0xff00) === 0xff00) return PRIVATE; // multicast
  return PUBLIC;
}

/** "public", "private" or "metadata" for one IP address. */
export function classifyIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return classifyV4(ip);
  if (kind === 6) return classifyV6(ip);
  return PRIVATE; // not an address we understand: treat it as not public
}

const worst = (kinds) => (kinds.includes(ALWAYS_BLOCKED) ? ALWAYS_BLOCKED : kinds.includes(PRIVATE) ? PRIVATE : PUBLIC);

/** Classify a hostname by its name and by every address it resolves to. */
export async function classifyHost(hostname, { lookup = dns.lookup } = {}) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (net.isIP(host)) return classifyIp(host);
  if (METADATA_HOSTS.has(host)) return ALWAYS_BLOCKED;
  if (host === "localhost" || host.endsWith(".localhost")) return PRIVATE;
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); } catch { return UNRESOLVED; }
  return addrs.length ? worst(addrs.map((a) => classifyIp(a.address))) : UNRESOLVED;
}

/**
 * A guard for one scan: an async function that throws for a URL the scan
 * must not load. Results are cached per host for the life of the scan.
 */
export function makeGuard({ allowPrivate = false, lookup } = {}) {
  const cache = new Map();
  const guard = async (rawUrl) => {
    let u;
    try { u = new URL(rawUrl); } catch { throw new Error(`${rawUrl} is not a valid URL.`); }
    if (!/^(?:https?|wss?):$/.test(u.protocol)) return; // data:, blob: and friends never leave the browser
    if (!cache.has(u.hostname)) cache.set(u.hostname, classifyHost(u.hostname, { lookup }));
    const kind = await cache.get(u.hostname);
    if (kind === ALWAYS_BLOCKED) {
      throw new Error(`${u.host} is a link-local or cloud metadata address. Diarea never scans those.`);
    }
    // A name the guard cannot check is not loaded: the browser's own lookup
    // could answer differently.
    if (kind === UNRESOLVED) throw new Error(`${u.hostname} could not be resolved.`);
    if (kind === PRIVATE && !allowPrivate) {
      throw new Error(`${u.host} is on this machine or a private network. Diarea's agent server only scans public sites ` +
        "unless it was started with --allow-private (run `diarea setup --allow-private`). Or scan the build output instead, such as dist.");
    }
  };
  return guard;
}
