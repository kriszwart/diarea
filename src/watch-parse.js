/* Log lines to watcher events. Combined (or Common) Log Format and JSON
 * lines. The IP is hashed with a per-run salt and the user agent reduced to
 * a class before anything leaves this file; query values stay in memory.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { routeOf, sweepable } from "./behaviour.js";
import { inV4, v6Groups } from "./guard.js";

const CLF = /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Za-z]+) (\S+)[^"]*" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const FIELDS = {
  t: ["timestamp", "time", "ts", "EdgeStartTimestamp", "@timestamp"],
  ip: ["ip", "clientIp", "client_ip", "ClientIP", "remote_addr", "proxy.clientIp", "request.remote_ip", "request.client_ip"],
  method: ["method", "ClientRequestMethod", "proxy.method", "request.method"],
  path: ["path", "url", "ClientRequestURI", "request.url", "request.uri", "proxy.path"],
  status: ["status", "statusCode", "EdgeResponseStatus", "proxy.statusCode"],
  ua: ["userAgent", "user_agent", "ClientRequestUserAgent", "proxy.userAgent", "request.headers.User-Agent"],
  auth: ["authorization", "headers.authorization", "request.headers.authorization", "proxy.authorization"],
};

const AUTOMATION = /curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|axios|node-fetch|undici|java\/|libwww|headlesschrome|playwright|puppeteer|selenium|phantomjs|scrapy|postman/i;
const BOT = /bot\b|crawler|spider|slurp|facebookexternalhit|healthchecker|kube-probe|googlehc|uptimerobot|pingdom|statuscake|consul/i;
// Mobile app HTTP stacks: real people, not scripts.
const APP = /okhttp|cfnetwork|dart\/|dalvik|alamofire/i;

export function uaClass(ua) {
  if (!ua || ua === "-") return "unknown";
  if (APP.test(ua)) return "app";
  if (AUTOMATION.test(ua)) return "automation";
  if (BOT.test(ua)) return "bot";
  if (/mozilla\/5\.0/i.test(ua)) return "browser";
  return "unknown";
}

const pick = (o, keys) => {
  for (const k of keys) {
    const v = k.split(".").reduce((x, p) => (x == null ? undefined : x[p]), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

// Seconds, milliseconds or nanoseconds since the epoch, or a date string.
function toTime(v) {
  const n = typeof v === "number" ? v : /^\d+(?:\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
  if (Number.isFinite(n)) return n > 1e17 ? Math.round(n / 1e6) : n > 1e14 ? Math.round(n / 1e3) : n > 1e11 ? n : Math.round(n * 1000);
  return Date.parse(v);
}

function clfTime(s) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m || !(m[2] in MONTHS)) return NaN;
  const utc = Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]);
  return utc - (m[7] === "+" ? 1 : -1) * (+m[8] * 60 + +m[9]) * 60e3;
}

function fromClf(line) {
  const m = CLF.exec(line);
  if (!m) return null;
  return { t: clfTime(m[2]), ip: m[1], method: m[3], path: m[4], status: Number(m[5]), ua: m[6] || "", auth: "" };
}

function fromJson(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  return {
    t: toTime(pick(o, FIELDS.t)), ip: String(pick(o, FIELDS.ip) ?? ""), method: String(pick(o, FIELDS.method) ?? ""),
    path: String(pick(o, FIELDS.path) ?? ""), status: Number(pick(o, FIELDS.status)), ua: String(pick(o, FIELDS.ua) ?? ""),
    auth: String(pick(o, FIELDS.auth) ?? ""),
  };
}

function splitPath(p) {
  let pathname = p, query = "";
  if (/^https?:\/\//i.test(p)) {
    try { const u = new URL(p); pathname = u.pathname; query = u.search.slice(1); } catch { return null; }
  } else {
    const q = p.indexOf("?");
    if (q >= 0) { pathname = p.slice(0, q); query = p.slice(q + 1); }
  }
  return { pathname, params: new Map(new URLSearchParams(query)) };
}

// The /24 (IPv4) or /48 (IPv6) an address sits in.
function networkOf(ip) {
  if (isIP(ip) === 4) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (isIP(ip) === 6) return v6Groups(ip).slice(0, 3).map((g) => g.toString(16)).join(":") + "::/48";
  return ip;
}

function inCidr(ip, cidr) {
  const [base, b] = cidr.split("/");
  const bits = Number(b);
  if (isIP(ip) === 4 && isIP(base) === 4) return inV4(ip, base, bits);
  if (isIP(ip) !== 6 || isIP(base) !== 6) return false;
  const x = v6Groups(ip), y = v6Groups(base);
  for (let k = 0, left = bits; left > 0; k++, left -= 16) {
    const mask = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff;
    if ((x[k] & mask) !== (y[k] & mask)) return false;
  }
  return true;
}

const validCidr = (c) => {
  const m = /^(.+)\/(\d{1,3})$/.exec(String(c));
  if (!m) return false;
  const v = isIP(m[1]);
  return (v === 4 && +m[2] <= 32) || (v === 6 && +m[2] <= 128);
};

/** Read an allowlist file. Errors name the file as given (basename) and the bad field. */
export function loadAllow(file) {
  const name = path.basename(file);
  let o;
  try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`Allowlist ${name} is not readable JSON.`); }
  const list = (k) => {
    const v = o[k] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw new Error(`Allowlist ${name}: "${k}" must be a list of strings.`);
    return v;
  };
  const allow = { networks: list("networks"), userAgents: list("userAgents"), apiKeyPrefixes: list("apiKeyPrefixes") };
  const badNet = allow.networks.find((c) => !validCidr(c));
  if (badNet) throw new Error(`Allowlist ${name}: "networks" must hold CIDR ranges such as 203.0.113.0/24, not "${badNet}".`);
  return allow;
}

function isAllowed(r, allow) {
  if (allow.networks.some((c) => inCidr(r.ip, c))) return true;
  if (r.ua && allow.userAgents.some((s) => r.ua.includes(s))) return true;
  const key = r.auth.replace(/^(?:Bearer|Token|Basic)\s+/i, "");
  return Boolean(key) && allow.apiKeyPrefixes.some((s) => key.startsWith(s));
}

// Only values a sweep could be made of stay in memory, which keeps big logs small.
const NONE = new Map();
function keep(params) {
  const kept = new Map();
  for (const [name, raw] of params) if (sweepable(name, raw)) kept.set(name, raw);
  return kept.size ? kept : NONE;
}

export function makeParser({ salt, allow = null }) {
  const hash = (s) => crypto.createHmac("sha256", salt).update(s).digest("hex").slice(0, 10);
  const p = { lines: 0, parsed: 0, allowed: 0, parseLine };
  function parseLine(line) {
    if (!line || !line.trim()) return null;
    p.lines++;
    const text = line.trim();
    const r = text.startsWith("{") ? fromJson(text) : fromClf(text);
    if (!r || !Number.isFinite(r.t) || !r.ip || !/^[A-Za-z]{1,16}$/.test(r.method) || !r.path || !Number.isFinite(r.status)) return null;
    const split = splitPath(r.path);
    if (!split) return null;
    p.parsed++;
    if (allow && isAllowed(r, allow)) { p.allowed++; return null; }
    const { route, ids } = routeOf(split.pathname);
    return {
      t: r.t, actor: hash(r.ip + "\0" + r.ua), net: hash(networkOf(r.ip)), method: r.method.toUpperCase(),
      route, ids, params: keep(split.params), status: r.status, ua: uaClass(r.ua),
    };
  }
  return p;
}
