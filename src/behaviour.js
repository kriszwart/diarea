/* The watcher's rule engine: parsed log events in, findings out. Pure: no
 * I/O, no clock, no randomness, so a middleware can reuse it later. Every
 * watcher rule lives here and only here; src/checks.js stays the engine for
 * frontend scans.
 *
 * An event is { t, actor, net, method, route, ids, params, status, ua }, made
 * by src/watch-parse.js. `params` holds raw query values for this run only;
 * nothing built here may copy a value into a finding.
 */

// Starting thresholds, tuned against the logs in test/watch.js.
export const LIMITS = {
  sweepValues: 12, sweepWindow: 10 * 60e3,
  enumIds: 25, enumWindow: 10 * 60e3, enumRun: 20,
  signups: 5, signupsAutomation: 10, signupWindow: 60 * 60e3,
  probeRoutes: 30, probeMissRate: 0.4,
  cadenceRequests: 200, cadenceAutomation: 100, cadenceCv: 0.15, cadenceWindow: 60 * 60e3,
};

export const BEHAVIOUR_BASIS = {
  "param-sweep": "inferred", "id-enumeration": "inferred", "signup-burst": "inferred",
  "route-probe": "inferred", "machine-cadence": "inferred",
};

export const BEHAVIOUR_SEV = {
  "param-sweep": "crit", "id-enumeration": "crit", "signup-burst": "warn",
  "route-probe": "warn", "machine-cadence": "info",
};

// The same four bands as scan, in the watcher's words.
export const WATCH_BANDS = {
  Sealed: "Nothing in this log reads like an agent at work.",
  Seeping: "A little automation about. Worth a look.",
  Leaking: "Someone is working your API out, one request at a time.",
  Gushing: "Something is reading your API like a manual.",
};

export const TIERS = ["watch", "slow", "challenge", "block"];

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{32,})$/i;

const FILE_NAME = /^[\w-]*\.(?:m?js|css|map|json|html?|php|aspx?|xml|txt|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|pdf|zip|ya?ml|env)$/i;
const PHONE = /^\+?[\d\s().-]{7,}$/;
const IP_LIKE = (d) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(d) || (d.includes(":") && /^[0-9a-f:.]+$/i.test(d));

// Segments that could be a person, an address or a secret, or that would
// write control characters to a terminal.
function personal(s) {
  if (/[\x00-\x1f\x7f]/.test(s)) return true;
  let d = s;
  try { d = decodeURIComponent(s); } catch {}
  if (ID_SEGMENT.test(s) || s.length > 40 || /@|%40|%20|\+|\s/i.test(s) || IP_LIKE(d) || PHONE.test(d) || /^[A-Za-z]{16,}$/.test(s)) return true;
  return s.includes(".") && !s.startsWith(".") && !FILE_NAME.test(s);
}

/** Template a path: ids, UUIDs, hashes, IPs, phone numbers, dotted names and anything with an @ become :id. */
export function routeOf(pathname) {
  const ids = [];
  const segs = String(pathname || "").split("/").map((s) => {
    if (!s) return s;
    if (/^\d{1,15}$/.test(s)) { ids.push(Number(s)); return ":id"; }
    return personal(s) ? ":id" : s;
  });
  return { route: segs.join("/") || "/", ids };
}

export const uniq = (a) => Array.from(new Set(a));

export function groupBy(items, keyOf) {
  const m = new Map();
  for (const x of items) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export const minutes = (w) => `${Math.max(1, Math.round((w[w.length - 1].t - w[0].t) / 60e3))} min`;

// Windows no longer than `span` ending at each item, over items sorted by t.
// `ok` runs when a window first holds `min` items, then every n/16 items as
// it grows, so a long dense log stays close to linear. Returns the first
// window `ok` accepts, or null.
export function findWindow(items, span, min, ok) {
  let i = 0, last = -Infinity;
  for (let j = 0; j < items.length; j++) {
    while (items[j].t - items[i].t > span) i++;
    const n = j - i + 1;
    if (n < min) continue;
    if (j - last < Math.max(1, Math.floor(n / 16)) && j < items.length - 1) continue;
    last = j;
    const w = items.slice(i, j + 1);
    if (ok(w)) return w;
  }
  return null;
}

function tierOf(ids) {
  const sevs = Array.from(ids, (id) => BEHAVIOUR_SEV[id]);
  if (sevs.includes("crit")) return "block";
  if (ids.has("signup-burst") || sevs.filter((s) => s === "warn").length >= 2) return "challenge";
  if (sevs.includes("warn")) return "slow";
  return "watch";
}

// Paging, cursors and cache busters step through values on purpose.
const PAGING = /page|offset|cursor|since|seq|rev|version|^(?:p|pg|skip|start|limit|size|after|before|from|_|t|ts|timestamp|v|cb)$/i;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** A query parameter a sweep could be made of: numeric, not paging, not an epoch time. */
export const sweepable = (name, raw) => !PAGING.test(name) && NUMERIC.test(raw) && Math.abs(Number(raw)) < 1e9;

// Declared crawlers and health checks reading pages are expected; on the API they get no pass.
const API_ROUTE = /^\/(?:api|graphql|trpc|rest|v\d+)(?:\/|$)/i;
const HEALTH = /^\/(?:health|healthz|healthcheck|ready|readyz|live|livez|ping|status)\/?$/i;
const exempt = (e) => e.ua === "bot" && !API_ROUTE.test(e.route);

const dedupe = (vals) => vals.filter((v, k) => k === 0 || v !== vals[k - 1]);
const gaps = (vals) => vals.slice(1).map((v, k) => Math.abs(v - vals[k])).filter((d) => d > 0);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function evenSteps(vals) {
  const d = gaps(vals);
  if (d.length < 4) return false;
  const m = median(d);
  return d.filter((x) => Math.abs(x - m) <= m * 0.1).length / d.length >= 0.75;
}

function halving(vals) {
  const d = gaps(vals);
  if (d.length < 4) return false;
  let n = 0;
  for (let k = 1; k < d.length; k++) { const r = d[k] / d[k - 1]; if (r >= 0.35 && r <= 0.65) n++; }
  return n / (d.length - 1) >= 0.6;
}

// How many distinct ids sit in runs of three or more consecutive values.
function inRuns(ids) {
  const v = uniq(ids).sort((a, b) => a - b);
  let inRuns = 0, len = 1;
  for (let k = 1; k <= v.length; k++) {
    if (k < v.length && v[k] - v[k - 1] === 1) len++;
    else { if (len >= 3) inRuns += len; len = 1; }
  }
  return inRuns;
}

function push(map, key, item) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(item);
}

function sweeps(ev) {
  const groups = new Map();
  for (const e of ev) for (const [name, raw] of e.params) {
    if (!sweepable(name, raw)) continue;
    push(groups, `${e.actor}\0${e.method} ${e.route}\0${name}`, { t: e.t, v: Number(raw) });
  }
  const hits = [];
  for (const [key, items] of groups) {
    let kind = "";
    const w = findWindow(items, LIMITS.sweepWindow, LIMITS.sweepValues, (w) => {
      if (new Set(w.map((x) => x.v)).size < LIMITS.sweepValues) return false;
      const vals = dedupe(w.map((x) => x.v));
      kind = evenSteps(vals) ? "even steps" : halving(vals) ? "halving the gap" : "";
      return Boolean(kind);
    });
    if (!w) continue;
    const [actor, where, name] = key.split("\0");
    hits.push({ actors: [actor], line: `actor ${actor}: ${where} ?${name}, ${new Set(w.map((x) => x.v)).size} values in ${minutes(w)}, ${kind}` });
  }
  return hits;
}

function walks(ev) {
  const groups = new Map();
  for (const e of ev) {
    if (exempt(e)) continue;
    e.ids.forEach((v, k) => push(groups, `${e.actor}\0${e.method} ${e.route}\0${k}`, { t: e.t, v }));
  }
  const hits = [];
  for (const [key, items] of groups) {
    const w = findWindow(items, LIMITS.enumWindow, LIMITS.enumIds, (w) => {
      const ids = w.map((x) => x.v);
      return new Set(ids).size >= LIMITS.enumIds && inRuns(ids) >= LIMITS.enumRun;
    });
    if (!w) continue;
    const [actor, where] = key.split("\0");
    const ids = w.map((x) => x.v);
    hits.push({ actors: [actor], line: `actor ${actor}: ${where}, ${new Set(ids).size} ids in ${minutes(w)}, ${inRuns(ids)} of them consecutive` });
  }
  return hits;
}

const SIGNUP = /^(?:\/api)?(?:\/v\d+)?(?:\/auth)?\/(?:signup|sign-up|sign_up|register|users)\/?$/i;
const SENSITIVE = /(?:^|\/)(?:admin|internal|debug|_debug|actuator|wp-admin|wp-login\.php|phpmyadmin|server-status|\.env[^/]*|\.git|\.aws)(?:\/|$)/i;

function bursts(ev) {
  const su = ev.filter((e) => e.method === "POST" && e.status >= 200 && e.status < 400 && SIGNUP.test(e.route));
  const hits = [];
  const scan = (groups, label, min, needActors = 1) => {
    for (const [key, items] of groups) {
      const w = findWindow(items, LIMITS.signupWindow, min, (w) => new Set(w.map((e) => e.actor)).size >= needActors);
      if (w) hits.push({ actors: uniq(w.map((e) => e.actor)), line: `${label} ${key}: ${w.length} sign-ups in ${minutes(w)} (POST ${w[0].route})` });
    }
  };
  scan(groupBy(su, (e) => e.actor), "actor", LIMITS.signups);
  // A network counts when several actors share it; one actor is caught above.
  scan(groupBy(su, (e) => e.net), "network", LIMITS.signups, 2);
  scan(groupBy(su.filter((e) => e.ua === "automation"), () => "automation"), "user agent class", LIMITS.signupsAutomation, 2);
  return hits;
}

function probes(byActor) {
  const hits = [];
  for (const [actor, list] of byActor) {
    const mine = list.filter((e) => !exempt(e));
    const routes = new Set(mine.map((e) => e.route));
    const misses = mine.filter((e) => e.status === 404 || e.status === 405).length;
    if (routes.size >= LIMITS.probeRoutes && misses / mine.length >= LIMITS.probeMissRate)
      hits.push({ actors: [actor], line: `actor ${actor}: ${routes.size} routes, ${misses} of ${mine.length} answered 404 or 405` });
    // Redirects to a login page and 401s after a session ends are not probes.
    const touchy = list.filter((e) => SENSITIVE.test(e.route) && e.status >= 400 && e.status !== 401);
    if (touchy.length)
      hits.push({ actors: [actor], line: `actor ${actor}: ${uniq(touchy.map((e) => `${e.method} ${e.route} (${e.status})`)).slice(0, 3).join(", ")}` });
  }
  return hits;
}

// Running sums over an hour-long window, so this stays one pass per actor.
function cadence(byActor) {
  const hits = [];
  for (const [actor, list] of byActor) {
    const mine = list.filter((e) => !exempt(e) && !HEALTH.test(e.route));
    if (mine.length < 2) continue;
    const ts = mine.map((e) => e.t);
    const automation = mine[0].ua === "automation";
    let i = 0, sum = 0, sq = 0, found = null;
    for (let j = 1; j < ts.length && !found; j++) {
      const g = ts[j] - ts[j - 1];
      sum += g; sq += g * g;
      while (ts[j] - ts[i] > LIMITS.cadenceWindow) { const h = ts[i + 1] - ts[i]; sum -= h; sq -= h * h; i++; }
      const n = j - i;
      const count = n + 1;
      if (automation && count >= LIMITS.cadenceAutomation) found = `${count} requests in an hour from an automation client`;
      else if (count >= LIMITS.cadenceRequests && sum > 0) {
        const mean = sum / n;
        const cv = Math.sqrt(Math.max(0, sq / n - mean * mean)) / mean;
        if (cv < LIMITS.cadenceCv) found = `${count} requests in an hour, ${Math.round(mean / 1000)}s apart, near-identical gaps`;
      }
    }
    if (found) hits.push({ actors: [actor], line: `actor ${actor}: ${found}` });
  }
  return hits;
}

export function analyseEvents(events) {
  const ev = events.slice().sort((a, b) => a.t - b.t);
  const byActor = groupBy(ev, (e) => e.actor);
  const F = [];
  const flagged = new Map();
  // One finding per check; each hit is { actors: string[], line: string }.
  const add = (id, title, detail, fix, hits) => {
    if (!hits.length) return;
    F.push({ id, sev: BEHAVIOUR_SEV[id], basis: BEHAVIOUR_BASIS[id], title, detail, fix, evidence: hits.map((h) => h.line) });
    for (const h of hits) for (const a of h.actors) {
      if (!flagged.has(a)) flagged.set(a, new Set());
      flagged.get(a).add(id);
    }
  };

  add("param-sweep", "Something is sweeping a parameter",
    "An actor stepped one numeric parameter through many values in a few minutes, in even steps or by halving the gap. That is how an agent finds a threshold, a price break or a limit without being told it.",
    "Keep thresholds and limits server-side and out of responses, rate-limit per route and actor, and answer near-threshold probes with the same response.",
    sweeps(ev));
  add("id-enumeration", "Something is walking your ids",
    "An actor asked for a long run of consecutive record ids. Sequential ids let anyone list every record, and any gap in your authorisation checks becomes a data export.",
    "Use opaque ids (UUIDs), check authorisation on every record, and rate-limit per actor.",
    walks(ev));
  add("signup-burst", "Sign-ups are arriving in bursts",
    "Many accounts were created from one actor, one network or one automation client within an hour. Free tiers, trials and referral credit are usually the prize.",
    "Add a bot challenge and email verification to sign-up, and limit sign-ups per network.",
    bursts(ev));
  add("route-probe", "Something is probing your routes",
    "An actor tried many routes that do not exist, or went looking for admin, debug or config paths. That is a map being drawn.",
    "Remove dead and debug routes, alert on admin probes, and never answer them with detail.",
    probes(byActor));
  add("machine-cadence", "Traffic at machine cadence",
    "An actor made requests at a rhythm no person keeps, or announced itself as an automation client at volume. Not always hostile, but worth knowing who it is.",
    "Slow such actors gradually rather than blocking them outright, and give known integrations an API key so they stand out.",
    cadence(byActor));

  const actors = Array.from(flagged, ([actor, ids]) => ({
    actor, ua: byActor.get(actor)[0].ua, events: byActor.get(actor).length, checks: Array.from(ids), tier: tierOf(ids),
  })).sort((a, b) => TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier) || b.events - a.events);

  const iso = (t) => new Date(t).toISOString();
  return {
    findings: F,
    actors,
    stats: { events: ev.length, actors: byActor.size, from: ev.length ? iso(ev[0].t) : null, to: ev.length ? iso(ev[ev.length - 1].t) : null },
  };
}
