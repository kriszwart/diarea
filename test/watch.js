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

const makeRand = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

export const LOGS = {
  sweep: () => Array.from({ length: 15 }, (_, k) => req("198.51.100.7", T0 + k * 20e3, "GET", `/api/quote?plan=pro&amount=${100 + k * 10}`)),
  halving: () => {
    const out = [];
    let lo = 0, hi = 10000;
    for (let k = 0; k < 14; k++) {
      const mid = Math.round((lo + hi) / 2);
      out.push(req("198.51.100.8", T0 + k * 15e3, "GET", `/api/limits/check?amount=${mid}`));
      if (k % 3 === 0) lo = mid; else hi = mid;
    }
    return out;
  },
  walk: () => Array.from({ length: 40 }, (_, k) => req("198.51.100.9", T0 + k * 5e3, "GET", `/api/users/${1001 + k}/profile`)),
  signups: () => Array.from({ length: 6 }, (_, k) => req(`203.0.113.${10 + k}`, T0 + k * 4 * 60e3, "POST", "/api/signup", 201)),
  probe: () => [
    ...Array.from({ length: 34 }, (_, k) => req("192.0.2.66", T0 + k * 2e3, "GET", `/old-page-${k}`, 404)),
    req("192.0.2.66", T0 + 70e3, "GET", "/.env", 404),
  ],
  cadence: () => Array.from({ length: 360 }, (_, k) => req("192.0.2.77", T0 + k * 10e3, "GET", "/api/feed")),
  // Ordinary use: people browsing and paging, an SPA polling, a declared crawler.
  clean: () => {
    const rand = makeRand(7);
    const out = [];
    const pages = ["/", "/pricing", "/blog", "/blog/launch-notes", "/docs", "/docs/getting-started", "/about", "/login", "/app", "/app/projects", "/app/settings", "/missing-page"];
    for (let a = 0; a < 5; a++) {
      let t = T0 + a * 90e3;
      for (let k = 0; k < 14; k++) {
        t += 5e3 + rand() * 115e3;
        const p = pages[Math.floor(rand() * pages.length)];
        out.push(req(`198.51.100.${120 + a}`, t, "GET", p, p === "/missing-page" ? 404 : 200));
      }
      // Review Focus 1: infinite scroll with a cache buster.
      for (let pg = 1; pg <= 15; pg++) out.push(req(`198.51.100.${120 + a}`, t + pg * 4e3, "GET", `/api/posts?page=${pg}&_=${T0 + pg * 4e3}`));
    }
    for (let k = 0; k < 120; k++) out.push(req("198.51.100.130", T0 + k * 30e3, "GET", "/api/notifications"));
    for (let k = 0; k < 25; k++) out.push(req("66.249.66.1", T0 + k * 7e3, "GET", `/blog/post-${k}`, 200, GOOGLEBOT));
    out.push(req("198.51.100.121", T0 + 30e3, "GET", "/users/42/orders"));
    return out.sort((x, y) => x.t - y.t);
  },
};

export const run = (records, fmt = asClf) => {
  const p = makeParser({ salt: "test" });
  return analyseEvents(records.map(fmt).map((l) => p.parseLine(l)).filter(Boolean));
};
const idsOf = (res) => res.findings.map((f) => f.id);

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
  for (const fmt of [asClf, asJson]) {
    const label = fmt === asClf ? "(Combined Log Format)" : "(JSON lines)";
    const sweep = run(LOGS.sweep(), fmt);
    check(idsOf(sweep).includes("param-sweep") && sweep.findings[0].sev === "crit" && /even steps/.test(sweep.findings[0].evidence[0]),
      `a parameter stepped in even steps is a sweep ${label}`);
    check(/halving/.test((run(LOGS.halving(), fmt).findings.find((f) => f.id === "param-sweep") || { evidence: [""] }).evidence[0]),
      `a binary search is a sweep ${label}`);
    check(idsOf(run(LOGS.walk(), fmt)).includes("id-enumeration"), `consecutive ids are a walk ${label}`);
  }
  const rand = makeRand(3);
  const noisy = Array.from({ length: 15 }, (_, k) => req("198.51.100.7", T0 + k * 20e3, "GET", `/api/quote?amount=${Math.round(rand() * 5000)}`));
  check(!idsOf(run(noisy)).includes("param-sweep"), "random values are not a sweep");
  const cleanIds = idsOf(run(LOGS.clean()));
  check(!cleanIds.includes("param-sweep") && !cleanIds.includes("id-enumeration"), "paging, cache busters and a person's own record are not sweeps or walks");
  const sweepJson = JSON.stringify(run(LOGS.sweep()));
  check(!/amount=|198\.51\.100|\b240\b|Mozilla/.test(sweepJson), "sweep findings hold names and counts, never values, IPs or user agents");
  for (const fmt of [asClf, asJson]) {
    const label = fmt === asClf ? "(Combined Log Format)" : "(JSON lines)";
    check(idsOf(run(LOGS.signups(), fmt)).includes("signup-burst"), `six sign-ups from one network in half an hour are a burst ${label}`);
    const probe = run(LOGS.probe(), fmt).findings.find((f) => f.id === "route-probe");
    check(probe && probe.evidence.length === 2 && /\.env/.test(probe.evidence[1]), `missing routes and a .env request are a probe ${label}`);
    check(idsOf(run(LOGS.cadence(), fmt)).includes("machine-cadence"), `a request every ten seconds for an hour is machine cadence ${label}`);
  }
  const auto = Array.from({ length: 12 }, (_, k) => req(`198.18.${k}.9`, T0 + k * 5 * 60e3, "POST", "/auth/register", 201, "python-requests/2.32"));
  check(idsOf(run(auto)).includes("signup-burst"), "a dozen sign-ups from an automation client are a burst, across networks");
  const clean = run(LOGS.clean());
  check(clean.findings.length === 0 && clean.actors.length === 0, "ordinary browsing, an SPA poll and a crawler raise nothing");

  const mix = run([...LOGS.clean(), ...LOGS.sweep(), ...LOGS.signups(), ...LOGS.cadence()]);
  const tierOfIp = (ip, ua = BROWSER) => {
    const id = makeParser({ salt: "test" }).parseLine(asClf(req(ip, T0, "GET", "/", 200, ua))).actor;
    return (mix.actors.find((a) => a.actor === id) || {}).tier;
  };
  check(tierOfIp("198.51.100.7") === "block" && tierOfIp("203.0.113.10") === "challenge" && tierOfIp("192.0.2.77") === "watch",
    "tiers: a sweep is block, a sign-up burst challenge, cadence alone watch");
  check(mix.actors[0].tier === "block", "the worst actors come first");

  // Review Focus 3: big logs stay fast.
  const bigRand = makeRand(11);
  let t = T0;
  const big = Array.from({ length: 100000 }, (_, k) => { t += 200 + bigRand() * 4000; return req("192.0.2.200", t, "GET", `/api/items?q=${Math.floor(bigRand() * 50)}`); });
  const p = makeParser({ salt: "test" });
  const events = big.map(asClf).map((l) => p.parseLine(l));
  const started = Date.now();
  analyseEvents(events);
  check(Date.now() - started < 5000, "100,000 events from one actor analyse in under 5 seconds");
}
