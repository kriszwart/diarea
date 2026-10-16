/* Watcher tests: logs are built here, never stored as files. No browser,
 * no network. Run from test/run.js.
 */
import { routeOf, analyseEvents } from "../src/behaviour.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeParser, uaClass, loadAllow } from "../src/watch-parse.js";

export const T0 = Date.UTC(2026, 9, 14, 9, 0, 0);
export const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
export const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const pad = (n) => String(n).padStart(2, "0");
const clfDate = (t) => {
  const d = new Date(t);
  return `${pad(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
};
// One request, written the way nginx or a Vercel log drain would write it.
export const req = (ip, t, method, p, status = 200, ua = BROWSER) => ({ ip, t, method, path: p, status, ua });
export const asClf = (r) => `${r.ip} - - [${clfDate(r.t)}] "${r.method} ${r.path} HTTP/1.1" ${r.status} 512 "-" "${r.ua}"`;
export const asJson = (r) => JSON.stringify({ timestamp: new Date(r.t).toISOString(), proxy: { clientIp: r.ip, method: r.method, path: r.path, statusCode: r.status, userAgent: r.ua } });
const tmp = (name, body) => { const f = path.join(os.tmpdir(), `diarea-watch-${process.pid}-${name}`); fs.writeFileSync(f, body); return f; };

export async function watchTests(check) {
  console.log("Watch:");
  const r = (p) => routeOf(p).route;
  check(r("/users/8812/orders") === "/users/:id/orders" && routeOf("/users/8812/orders").ids[0] === 8812,
    "numeric ids are templated and kept beside the route");
  check(r("/files/3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b") === "/files/:id", "UUIDs are templated");
  check(r("/blob/0123456789abcdef0123") === "/blob/:id", "long hex is templated");
  check(r("/api/v2/users") === "/api/v2/users" && r("/blog/launch-notes") === "/blog/launch-notes",
    "ordinary segments are left alone");
  check(r("/users/jane@example.com/orders") === "/users/:id/orders" && r("/u/jane%40example.com") === "/u/:id",
    "emails in paths never reach a route");
  check(r("") === "/" && r("/") === "/", "an empty path is the root");
  const empty = analyseEvents([]);
  check(empty.findings.length === 0 && empty.actors.length === 0 && empty.stats.events === 0,
    "no events, no findings");
  const line = req("198.51.100.7", T0, "GET", "/api/quote?amount=120&plan=pro");
  const a = makeParser({ salt: "test" }).parseLine(asClf(line));
  const b = makeParser({ salt: "test" }).parseLine(asJson(line));
  check(a && b && a.t === T0 && b.t === T0 && a.actor === b.actor && a.route === "/api/quote"
    && a.params.get("amount") === "120" && a.status === 200 && a.method === "GET",
    "Combined Log Format and JSON lines give the same event");
  check(a.ua === "browser" && !JSON.stringify({ ...a, params: [] }).includes("198.51.100"), "the IP is hashed and the user agent classed");
  check(makeParser({ salt: "other" }).parseLine(asClf(line)).actor !== a.actor, "a new salt gives new actor ids");
  check(uaClass("curl/8.4.0") === "automation" && uaClass("Mozilla/5.0 (X11) HeadlessChrome/129.0") === "automation"
    && uaClass(GOOGLEBOT) === "bot" && uaClass(BROWSER) === "browser" && uaClass("") === "unknown", "user agents are classed");
  const p1 = makeParser({ salt: "test" });
  check(p1.parseLine(`198.51.100.7 - - [14/Oct/2026:11:00:00 +0200] "GET / HTTP/1.1" 200 5 "-" "x"`).t === T0, "Combined Log Format time zones are honoured");
  check(p1.parseLine(`198.51.100.7 - - [14/Oct/2026:09:00:00 +0000] "GET / HTTP/1.1" 200 5`).ua === "unknown", "Common Log Format without a user agent parses");
  const cf = p1.parseLine(JSON.stringify({ EdgeStartTimestamp: T0 * 1e6, ClientIP: "2001:db8::1", ClientRequestMethod: "POST",
    ClientRequestURI: "/api/signup", EdgeResponseStatus: 201, ClientRequestUserAgent: "python-requests/2.32" }));
  check(cf && cf.t === T0 && cf.method === "POST" && cf.status === 201 && cf.ua === "automation", "Cloudflare field names and nanosecond times parse");

  // Review Focus 4: messy input never stops a run.
  const p2 = makeParser({ salt: "test" });
  ["", "   ", "garbage", '{"broken', asClf(line) + "\r"].forEach((l) => p2.parseLine(l));
  check(p2.lines === 3 && p2.parsed === 1, "blank lines are ignored, bad lines counted, CRLF tolerated");

  // Review Focus 5: IPv6.
  const p3 = makeParser({ salt: "test" });
  const v6 = (ip) => p3.parseLine(asClf(req(ip, T0, "GET", "/")));
  check(v6("2001:db8:1::5").net === v6("2001:db8:1:ffff::9").net && v6("2001:db8:1::5").net !== v6("2001:db8:2::5").net
    && v6("2001:db8:1::5").actor !== v6("2001:db8:1::6").actor, "IPv6 actors hash and /48 networks group");

  const allowFile = tmp("allow.json", JSON.stringify({ networks: ["198.51.100.0/24", "2001:db8::/32"], userAgents: ["ResearchBot/"], apiKeyPrefixes: ["pk_partner_"] }));
  const allow = loadAllow(allowFile);
  const p4 = makeParser({ salt: "test", allow });
  p4.parseLine(asClf(req("198.51.100.44", T0, "GET", "/")));
  p4.parseLine(asClf(req("2001:db8:9::1", T0, "GET", "/")));
  p4.parseLine(asClf(req("192.0.2.5", T0, "GET", "/", 200, "ResearchBot/1.0")));
  p4.parseLine(JSON.stringify({ timestamp: new Date(T0).toISOString(), ip: "192.0.2.9", method: "GET", path: "/api/x", status: 200,
    userAgent: BROWSER, headers: { authorization: "Bearer pk_partner_abc123" } }));
  const kept = p4.parseLine(asClf(req("192.0.2.10", T0, "GET", "/")));
  check(p4.allowed === 4 && kept && kept.route === "/", "the allowlist removes networks, user agents and API key prefixes");
  let bad = "";
  try { loadAllow(tmp("bad.json", JSON.stringify({ networks: ["not-a-range"] }))); } catch (e) { bad = e.message; }
  check(/networks/.test(bad) && !bad.includes(os.tmpdir()), "a bad allowlist names the field, not a local folder");
}
