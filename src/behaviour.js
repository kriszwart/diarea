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
