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
  enumIds: 25, enumWindow: 10 * 60e3, enumRun: 0.8,
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

/** Template a path: ids, UUIDs, hashes, long segments and anything with an @ become :id. */
export function routeOf(pathname) {
  const ids = [];
  const segs = String(pathname || "").split("/").map((s) => {
    if (!s) return s;
    if (/^\d{1,15}$/.test(s)) { ids.push(Number(s)); return ":id"; }
    if (ID_SEGMENT.test(s) || s.length > 40 || /@|%40/i.test(s)) return ":id";
    return s;
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

// Windows no longer than `span` over items sorted by t, each starting halfway
// through the last, so a long log costs about two passes. Returns the first
// window with at least `min` items that `ok` accepts, or null.
export function findWindow(items, span, min, ok) {
  let j = 0;
  for (let i = 0; i < items.length; ) {
    if (j < i) j = i;
    while (j < items.length && items[j].t - items[i].t <= span) j++;
    const w = items.slice(i, j);
    if (w.length >= min && ok(w)) return w;
    if (j >= items.length) return null;
    i += Math.max(1, Math.floor((j - i) / 2));
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
const PAGING = /^(?:page|p|pg|offset|skip|start|limit|per_?page|size|page_?size|cursor|after|before|from|_|t|ts|timestamp|v|cb)$/i;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

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

function runRatio(ids) {
  const v = uniq(ids).sort((a, b) => a - b);
  let inRuns = 0, len = 1;
  for (let k = 1; k <= v.length; k++) {
    if (k < v.length && v[k] - v[k - 1] === 1) len++;
    else { if (len >= 3) inRuns += len; len = 1; }
  }
  return v.length ? inRuns / v.length : 0;
}

function push(map, key, item) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(item);
}

function sweeps(ev) {
  const groups = new Map();
  for (const e of ev) for (const [name, raw] of e.params) {
    if (PAGING.test(name) || !NUMERIC.test(raw)) continue;
    const v = Number(raw);
    if (Math.abs(v) >= 1e9) continue; // epoch times, not a probe
    push(groups, `${e.actor}\0${e.method} ${e.route}\0${name}`, { t: e.t, v });
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
    if (e.ua === "bot") continue;
    e.ids.forEach((v, k) => push(groups, `${e.actor}\0${e.method} ${e.route}\0${k}`, { t: e.t, v }));
  }
  const hits = [];
  for (const [key, items] of groups) {
    const w = findWindow(items, LIMITS.enumWindow, LIMITS.enumIds, (w) => {
      const ids = w.map((x) => x.v);
      return new Set(ids).size >= LIMITS.enumIds && runRatio(ids) >= LIMITS.enumRun;
    });
    if (!w) continue;
    const [actor, where] = key.split("\0");
    const ids = w.map((x) => x.v);
    hits.push({ actors: [actor], line: `actor ${actor}: ${where}, ${new Set(ids).size} ids in ${minutes(w)}, ${Math.round(runRatio(ids) * 100)}% consecutive` });
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
  // CHECKS

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
