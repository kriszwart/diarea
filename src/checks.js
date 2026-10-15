/* Diarea - canonical detection engine.
 *
 * This is the single source of truth for what counts as a leak. It is pure and
 * isomorphic: it takes an already-collected snapshot of a page and returns
 * findings. The browser extension and the CLI each collect that snapshot in
 * their own way (real DOM, Playwright, or jsdom) and then call analyse().
 *
 * A finding is { id, sev, basis, title, detail, fix, evidence[] }.
 * sev is "crit" | "warn" | "info".
 * basis is "seen" (sitting in the page, readable as is) or "inferred" (a
 * reader can work it out from what is there). Anything kept on your server is
 * Unknown to a reader, which is where you want everything to be.
 */

export const SEV_WEIGHT = { crit: 26, warn: 11, info: 3 };

export const BANDS = [
  { max: 15, label: "Sealed", colour: "#35c47a", line: "Tight. An agent would come away with very little." },
  { max: 40, label: "Seeping", colour: "#f5a623", line: "A few things are showing. Worth a wipe-down." },
  { max: 70, label: "Leaking", colour: "#f5733a", line: "Your logic and data are readable from the browser." },
  { max: 101, label: "Gushing", colour: "#ff4d4d", line: "Most of how this works is sitting in the open." },
];

export const SEV_ORDER = { crit: 0, warn: 1, info: 2 };

// Seen: readable as is. Inferred: worked out from what is there.
export const BASIS = {
  "source-maps": "seen", secrets: "seen", "public-anon-key": "seen", "hydration-payload": "seen",
  "hydration-state": "seen", "readable-code": "seen", "hidden-fields": "seen", "ai-system-prompt": "seen",
  "sensitive-fields": "seen",
  "client-logic": "inferred", "api-map": "inferred", "ai-direct-call": "inferred", fingerprint: "inferred",
};

/** One line on how much of the product a reader gets, in Seen, Inferred and Unknown. */
export function basisLine(findings) {
  const seen = findings.filter((f) => f.basis === "seen").length;
  const inferred = findings.filter((f) => f.basis === "inferred").length;
  if (!seen && !inferred) return "Seen 0, Inferred 0. Everything a reader wants is Unknown. Keep it that way.";
  return `Seen ${seen}, Inferred ${inferred}. Push it all into Unknown: on your server, not in the page.`;
}

const uniq = (a) => Array.from(new Set(a));
// Never print a found secret: show a short prefix and its length only.
export const redact = (s) => { s = String(s); return s.slice(0, 4) + "... (" + s.length + " chars)"; };

// The "role" claim of a JWT, decoded locally, or "" if unreadable.
function jwtRole(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
    return typeof json.role === "string" ? json.role : "";
  } catch { return ""; }
}

/**
 * @param {object} input
 *   url, host, origin        - strings
 *   inlineScripts            - string[]  text of inline <script> tags
 *   bundles                  - {url, body}[]  fetched same-origin external scripts
 *   html                     - string   full serialised markup
 *   globals                  - string[] names of exposed hydration globals present
 *   biggestStateBytes        - number   size of the largest hydration payload
 *   biggestJsonBytes         - number   size of the largest inline application/json
 *   liveMapFound             - boolean  a sibling .map was reachable
 *   mapFiles                 - string[] paths of .map files found (optional)
 *   hiddenFields             - string[] names of hidden inputs
 *   dataAttrs                - string[] telltale data-* strings
 *   frameworks               - string[] detected framework names
 *   networkUrls              - string[] endpoints observed on the wire (optional)
 *   storageKeys              - string[] "localStorage: name" key names, never values (optional)
 *   consoleLogs              - number   log/debug messages the site's own scripts printed (optional, live)
 *   dataShapes               - {source, keys[]}[] key paths (never values) of API responses and
 *                              hydration payloads, from src/shape.js (optional)
 * @returns {{url, host, findings}}
 */
export function analyse(input = {}) {
  const i = {
    url: "", host: "", origin: "",
    inlineScripts: [], bundles: [], html: "",
    globals: [], biggestStateBytes: 0, biggestJsonBytes: 0,
    liveMapFound: false, mapFiles: [], hiddenFields: [], dataAttrs: [],
    frameworks: [], networkUrls: [], storageKeys: [], consoleLogs: 0, dataShapes: [],
    ...input,
  };

  const F = [];
  // id is stable across releases (SARIF rule ids, dashboards); titles are not.
  const add = (id, sev, title, detail, fix, evidence) =>
    F.push({ id, sev, basis: BASIS[id], title, detail, fix, evidence: (evidence || []).filter(Boolean) });

  const js = i.inlineScripts.concat(i.bundles.map((b) => b.body || "")).join("\n");
  const html = i.html || "";
  const haystack = js + "\n" + html;
  const pathOf = (u) => { try { return new URL(u, i.url || i.origin || "http://x/").pathname; } catch { return u; } };

  // 1. Source maps in production
  const mapRefs = uniq((js.match(/sourceMappingURL=([^\s'"]+)/g) || [])
    .map((s) => s.replace("sourceMappingURL=", "")));
  // A data: URI is the whole map inlined in the bundle; show that, not the blob.
  const mapEvidence = uniq(mapRefs.map((r) => (/^data:/i.test(r) ? "inline source map (data: URI)" : pathOf(r)))
    .concat(i.mapFiles || []));
  if (mapRefs.length || i.liveMapFound) {
    add("source-maps", "crit", "Source maps are published",
      "Source maps hand a reader your original, un-minified source: real file names, comments and logic. This is the single biggest shortcut for anyone rebuilding your product.",
      "Disable source map output for production builds, or stop serving .map files. \"Hidden\" source maps still ship if the .map files are deployed.",
      mapEvidence.slice(0, 4));
  }

  // 2. Secrets in client code or markup
  // Each token must start a word (so "task-item-..." is not an "sk-" key), and
  // keys that are random strings must look random: digits plus both cases.
  const B = "(?<![A-Za-z0-9_-])";
  const looksRandom = (v) => /[0-9]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v);
  // `random` is the prefix to strip before checking the rest looks random.
  const secretRules = [
    // A PEM header alone is just a format string (crypto libraries parse them),
    // so a real key needs its base64 body after the header.
    { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:\s|\\[rn])*[A-Za-z0-9+/=]{40,}/g, label: "Private key (PEM block)", sev: "crit", pem: true },
    { re: new RegExp(B + "sk_live_[0-9a-zA-Z]{16,}", "g"), label: "Stripe secret key", sev: "crit", random: /^sk_live_/ },
    { re: new RegExp(B + "rk_live_[0-9a-zA-Z]{16,}", "g"), label: "Stripe restricted key", sev: "crit", random: /^rk_live_/ },
    { re: new RegExp(B + "sk-ant-(?:api|admin)\\d{2}-[A-Za-z0-9_-]{80,}", "g"), label: "Anthropic API key", sev: "crit", random: /^sk-ant-(?:api|admin)\d{2}-/ },
    { re: new RegExp(B + "sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}", "g"), label: "OpenAI-style secret key", sev: "crit", random: /^sk-(?:proj-|svcacct-|admin-)?/ },
    { re: new RegExp(B + "AKIA[0-9A-Z]{16}(?![0-9A-Z])", "g"), label: "AWS access key id", sev: "crit" },
    { re: new RegExp(B + "AIza[0-9A-Za-z_-]{35}", "g"), label: "Google API key", sev: "warn" },
    { re: new RegExp(B + "xox[baprs]-[0-9A-Za-z-]{10,}", "g"), label: "Slack token", sev: "crit" },
    { re: new RegExp(B + "gh[pousr]_[A-Za-z0-9]{30,}", "g"), label: "GitHub token", sev: "crit", random: /^gh[pousr]_/ },
    { re: new RegExp(B + "github_pat_[A-Za-z0-9_]{60,}", "g"), label: "GitHub token", sev: "crit", random: /^github_pat_/ },
    { re: new RegExp(B + "hf_[A-Za-z0-9]{34}(?![A-Za-z0-9])", "g"), label: "Hugging Face token", sev: "crit", random: /^hf_/ },
    { re: new RegExp(B + "r8_[A-Za-z0-9]{37}(?![A-Za-z0-9])", "g"), label: "Replicate API token", sev: "crit", random: /^r8_/ },
    { re: new RegExp(B + "SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])", "g"), label: "SendGrid API key", sev: "crit" },
    // A Twilio API key SID is not the secret itself, but its secret is never far away.
    { re: new RegExp(B + "SK[0-9a-f]{32}(?![0-9A-Za-z])", "g"), label: "Twilio API key SID", sev: "warn" },
    { re: new RegExp(B + "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{6,}", "g"), label: "JWT / bearer token", sev: "warn", jwt: true },
    { re: new RegExp(B + "sk_test_[0-9a-zA-Z]{16,}", "g"), label: "Stripe test secret key", sev: "warn", random: /^sk_test_/ },
    { re: new RegExp(B + "rk_test_[0-9a-zA-Z]{16,}", "g"), label: "Stripe test restricted key", sev: "warn", random: /^rk_test_/ },
  ];
  const secretHits = [];
  const anonKeys = [];
  for (const rule of secretRules) {
    for (const h of uniq(haystack.match(rule.re) || [])) {
      if (rule.random && !looksRandom(h.replace(rule.random, ""))) continue;
      if (rule.jwt) {
        // Read only the role claim, locally. Public "anon" keys (Supabase and
        // similar) are meant for the browser; a "service_role" key never is.
        const role = jwtRole(h);
        if (role === "anon") { anonKeys.push(h); continue; }
        if (role === "service_role") { secretHits.push({ sev: "crit", label: "Service-role JWT (full database access)", value: h }); continue; }
      }
      // For a PEM block, show its header (a format name, not a secret) and nothing of the key.
      if (rule.pem) { secretHits.push({ sev: rule.sev, label: rule.label, value: h, shown: h.slice(0, h.indexOf("-----", 5) + 5) }); continue; }
      secretHits.push({ sev: rule.sev, label: rule.label, value: h });
    }
  }
  const assignRe = /["']?(api[_-]?key|secret|token|password|passwd|auth[_-]?token|access[_-]?key)["']?\s*[:=]\s*["']([^"']{8,})["']/gi;
  let am;
  const seen = new Set();
  while ((am = assignRe.exec(js)) !== null) {
    const key = am[1], val = am[2];
    if (/process\.env|import\.meta|YOUR_|xxxx|changeme|example|placeholder|\$\{|<%/.test(val)) continue;
    // Not secrets: names (token: "access_token") and minified code caught
    // between two unrelated quotes (token="",g))...).
    if (/^[A-Za-z_$][A-Za-z_$.-]*$/.test(val)) continue;
    if (/[\s(){}\[\];,<>|&+!?]/.test(val)) continue;
    if (val.length > 120) continue;
    const sig = key.toLowerCase() + ":" + val.slice(0, 6);
    if (seen.has(sig)) continue;
    seen.add(sig);
    secretHits.push({ sev: "warn", label: "Hard-coded " + key.toLowerCase(), value: val });
  }
  if (secretHits.length) {
    const anyCrit = secretHits.some((s) => s.sev === "crit");
    add("secrets", anyCrit ? "crit" : "warn",
      secretHits.length + " possible secret" + (secretHits.length > 1 ? "s" : "") + " in client code",
      "Credentials in shipped JavaScript or markup are readable by anyone, no tooling required. Publishable keys (pk_) are fine. Secret keys, tokens and private keys are not.",
      "Rotate the exposed keys, then move them behind your server. The browser should only ever hold publishable keys.",
      secretHits.slice(0, 5).map((s) => s.label + ": " + (s.shown || redact(s.value))));
  }

  if (anonKeys.length) {
    add("public-anon-key", "info", "Public anon key in the page",
      "A Supabase-style anon key (a JWT with role \"anon\") is in the client. That is normal, but it lets anyone call your database directly, so it is only safe while row level security guards every table.",
      "Check row level security is on for every table and that each policy is as strict as the UI. Never ship the service_role key.",
      anonKeys.slice(0, 2).map((k) => "role \"anon\": " + redact(k)));
  }

  // 3. Proprietary logic shipped to the client
  const logicTerms = ["weight", "weighting", "threshold", "calibrat", "coefficient",
    "rubric", "sectorweight", "scorematrix", "scoring", "formula", "heuristic", "ruleset"];
  // Libraries use these words too (three.js morph weights, CSS font weights),
  // spread thinly over a big bundle. Business rules cluster: three or more
  // terms within one small block, next to tuned decimal constants.
  const low = js.toLowerCase();
  const termRe = new RegExp("(?<!font[-_]?)(" + logicTerms.join("|") + ")", "g");
  const hits = Array.from(low.matchAll(termRe), (m) => ({ t: m[1], at: m.index }));
  let logicFound = [];
  for (let a = 0, b = 0; a < hits.length; a++) {
    while (b < hits.length && hits[b].at - hits[a].at <= 600) b++;
    const terms = uniq(hits.slice(a, b).map((h) => h.t));
    if (terms.length < 3 || terms.length <= logicFound.length) continue;
    const decimals = js.slice(hits[a].at, hits[b - 1].at + 200).match(/(?<![\w.])\d*\.\d+(?![\w.])/g) || [];
    if (decimals.length >= 2) logicFound = terms;
  }
  if (logicFound.length >= 3) {
    add("client-logic", "crit", "Scoring or business logic looks client-side",
      "Terms tied to how you score, weight or decide are present in the browser bundle. If your methodology runs here, a reader can copy the thing that makes you different, not just the look.",
      "Run scoring and weightings on the server. Ship verdicts and explanations to the browser, never the rules.",
      logicFound.slice(0, 8));
  }

  // 4. Hydration / global state exposure
  const stateKB = Math.round(Math.max(i.biggestStateBytes || 0, i.biggestJsonBytes || 0) / 1024);
  if (i.globals.length && stateKB >= 8) {
    add("hydration-payload", "warn", "Large hydration payload in the page (" + stateKB + " KB)",
      "Frameworks embed a serialised data blob to boot the UI. It often contains more than what is on screen: ids, flags, records and fields the user never sees.",
      "Send the browser only the fields it renders. Keep internal records and server-only fields out of the hydration payload.",
      i.globals.slice(0, 4).map((g) => "window." + g));
  } else if (i.globals.length) {
    add("hydration-state", "info", "Hydration state exposed",
      "A readable boot payload is present. Small for now, but check it does not grow to carry internal fields.",
      "Review what is serialised into the page on each route.",
      i.globals.slice(0, 4).map((g) => "window." + g));
  }

  // 5. Un-minified / commented bundles
  let readable = null;
  for (const b of i.bundles) {
    const body = b.body || "";
    if (body.length < 2000) continue;
    const lines = body.split("\n");
    const avgLen = body.length / Math.max(lines.length, 1);
    // Minifiers keep licence banners and bundler annotations; neither is a
    // developer note. A "comment" holding ; { } = or string concatenation
    // ran across code or sits in a string (such as "*/*"), so it is not one either.
    const devNote = (c) => !/[;{}=]|^[!#@*]|@license|@preserve|copyright|\(c\)|licen[cs]e|\b(?:MIT|BSD|ISC|Apache)\b|\bv?\d+\.\d+\.\d+|["'`]\s*\+|\+\s*["'`]|^\s*(?:global|globals|exported|jshint|jslint)\b|__PURE__|webpack|vite|eslint|istanbul|@ts-|sourceMappingURL/i.test(c);
    const hasComments = /(?<!:)\/\/\s?(TODO|FIXME|HACK|NOTE|BUG)\b/.test(body) ||
      Array.from(body.matchAll(/\/\*([\s\S]{10,400}?)\*\//g), (m) => m[1]).some(devNote);
    if ((avgLen < 220 && lines.length > 40) || hasComments) {
      readable = { url: b.url, comments: hasComments };
      break;
    }
  }
  // Debug logging from the site's own scripts (live scans count it).
  const logs = i.consoleLogs >= 3 ? i.consoleLogs + " console messages on load (debug logging left on)" : "";
  if (readable) {
    add("readable-code", "warn", "Shipped code is readable",
      "A production bundle is not minified, or carries comments and developer notes. That turns reading your logic from a chore into a scroll.",
      "Minify for production. Strip comments and dev notes from shipped code.",
      [pathOf(readable.url) + (readable.comments ? "  (contains comments / TODOs)" : "  (not minified)"), logs]);
  } else if (logs) {
    add("readable-code", "info", "Debug logging left on in production",
      "The site's own scripts print to the console as the page loads. Debug output narrates what the code is doing, often with ids, state and internal names.",
      "Drop console logging from production builds (most bundlers have a drop_console or pure_funcs option).",
      [logs]);
  }

  // 6. API surface is easy to map
  const urlRe = /(["'`])(\/(?:api|graphql|v\d|rest|rpc|internal|admin)(?![A-Za-z0-9])(?:\/[A-Za-z0-9_\-\/.:]*)?|https?:\/\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_\-\/.]*)\1/g;
  // An absolute URL in the bundle only counts when it looks like an API: an
  // api.* host or an API path. Page links, XML namespaces, docs and CDN
  // scripts are not part of anyone's API map, and neither are static files.
  const apiPath = /\/(?:api|graphql|gql|v\d+|rest|rpc|trpc|internal|admin|_serverFn|functions)(?:\/|$)/i;
  const staticFile = /\.(?:js|mjs|css|map|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|html?)$/i;
  let um;
  const endpoints = new Set((i.networkUrls || []).filter((u) => !staticFile.test(u)));
  while ((um = urlRe.exec(js)) !== null) {
    let p = um[2];
    if (p.startsWith("http")) {
      try {
        const u = new URL(p);
        if (!/^api\./i.test(u.hostname) && !apiPath.test(u.pathname)) continue;
        p = u.origin + u.pathname;
      } catch { continue; }
    }
    if (p.length < 120 && !staticFile.test(p)) endpoints.add(p);
  }
  const eps = Array.from(endpoints);
  // Hashed segments (server functions, ids) collapse to one line each.
  const groups = new Map();
  for (const e of eps) {
    const g = e.replace(/\/(?:[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{32,})(?=\/|$)/gi, "/*");
    groups.set(g, (groups.get(g) || 0) + 1);
  }
  // Named GraphQL operations (in gql strings and persisted-query documents)
  // and tRPC procedures map the API by name, however few URLs there are.
  const gqlOps = uniq(Array.from(haystack.matchAll(/(?<![\w$.])(query|mutation|subscription)\s+([A-Z][A-Za-z0-9_]{2,})\s*[({]/g),
    (m) => m[1] + " " + m[2]));
  const trpcProcs = uniq(Array.from(js.matchAll(/\.([a-z][A-Za-z0-9_]*\.[a-z][A-Za-z0-9_]*)\.(?:useQuery|useSuspenseQuery|useInfiniteQuery|useMutation)\(/g), (m) => m[1])
    .concat((i.networkUrls || []).flatMap((u) => { const m = u.match(/\/trpc\/([^?#]+)$/); return m ? decodeURIComponent(m[1]).split(",") : []; })));
  // Client routes: router tables and Next.js build manifests. A route entry
  // names what it renders (element, component...), which keeps out the
  // { path: "/client", method: "GET" } request descriptors SDKs carry.
  const routeOf = /^\/[A-Za-z0-9_\-\/:.*\[\]]*$/;
  // Next.js pages manifest: each page route maps to its chunk list.
  const at = js.indexOf("__BUILD_MANIFEST");
  const manifest = at < 0 ? "" : js.slice(at, at + 20000);
  const rendersRe = "(?:element|component|Component|components|loader|lazy|children|redirect|redirectTo|loadChildren|loadComponent)\\s*:";
  const routeEntry = new RegExp("(?<![\\w$])path\\s*:\\s*[\"'`](\\/[^\"'`\\s]{1,80})[\"'`]\\s*,[^{}]{0,200}?(?<![\\w$])" + rendersRe, "g");
  const routes = uniq(Array.from(js.matchAll(routeEntry), (m) => m[1])
    .concat(Array.from(manifest.matchAll(/["'](\/[^"'\s]{1,80})["']\s*:\s*\[/g), (m) => m[1]))
    .filter((r) => r.length > 1 && routeOf.test(r) && !/^\/(?:_|404$|500$)/.test(r)));
  const tender = /^\/(?:admin|internal|staff|debug|dev|backoffice|back-office|ops|superuser|sudo|moderat\w*|impersonat\w*)(?:[\/:]|$)/i;
  const tenderRoutes = routes.filter((r) => tender.test(r));
  const graphql = eps.some((e) => /graphql/i.test(e)) || gqlOps.length > 0;
  if (eps.length >= 6 || graphql || trpcProcs.length || tenderRoutes.length || routes.length >= 8) {
    const parts = [];
    if (eps.length) parts.push(eps.length + " API endpoint" + (eps.length > 1 ? "s" : ""));
    if (gqlOps.length) parts.push(gqlOps.length + " GraphQL operation" + (gqlOps.length > 1 ? "s" : ""));
    if (trpcProcs.length) parts.push(trpcProcs.length + " tRPC procedure" + (trpcProcs.length > 1 ? "s" : ""));
    if (routes.length) parts.push(routes.length + " route" + (routes.length > 1 ? "s" : ""));
    const title = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
    const list = (label, a) => (a.length ? label + a.slice(0, 4).join(", ") + (a.length > 4 ? ` (+${a.length - 4} more)` : "") : "");
    add("api-map", "info", title + " visible" + (graphql && !gqlOps.length ? " (GraphQL)" : ""),
      "Endpoints, operation names and routes in the bundle or on the wire let someone draw your API and your app's map without guessing, including the admin and internal pages. Expected to a degree, but a fully mapped API makes bulk extraction trivial.",
      "Add auth, rate limits and per-account quotas. If GraphQL, disable introspection in production. Keep admin and internal pages out of the public bundle, and check every one of them on the server.",
      // Names and hidden routes first: they say more than one more URL.
      [list("routes: ", tenderRoutes.length ? tenderRoutes : routes), list("GraphQL: ", gqlOps), list("tRPC: ", trpcProcs)]
        .concat(Array.from(groups).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, n]) => (n > 1 ? `${g} (${n})` : g))));
  }

  // 7. Hidden fields and data-* carrying meaning
  const leakyFields = uniq((i.hiddenFields || [])
    .filter((n) => /id|price|cost|token|key|secret|internal|flag|role|admin|user/i.test(n)));
  // Storage key names, from the live page and from the code that sets them.
  const tellingKey = /token|auth|jwt|session|secret|role|admin|permission|plan|tier|credit/i;
  const storageKeys = uniq((i.storageKeys || []).concat(Array.from(
    js.matchAll(/\b(local|session)Storage\.(?:setItem|getItem)\(\s*["'`]([^"'`$]{2,60})["'`]/g), (m) => m[1] + "Storage: " + m[2])))
    .filter((k) => tellingKey.test(k.replace(/^\w+: /, "")));
  const tokenInStorage = storageKeys.some((k) => /^localStorage: .*(?:token|jwt|auth)/i.test(k));
  if (leakyFields.length || (i.dataAttrs || []).length || storageKeys.length) {
    add("hidden-fields", "info",
      (storageKeys.length ? (leakyFields.length || i.dataAttrs.length ? "Hidden fields, data attributes and storage keys" : "Storage keys") : "Hidden fields and data attributes") + " carry meaning",
      "Hidden inputs, data- attributes and browser storage keys travel with the page. When they hold ids, prices, roles or flags, they describe your model to anyone who reads the DOM." +
        (tokenInStorage ? " A session token in localStorage is also readable by every script on the page, third-party ones included." : ""),
      "Keep identifiers and internal flags server-side. Do not trust or expose values the browser can edit." +
        (tokenInStorage ? " Keep session tokens in HttpOnly cookies, not localStorage." : ""),
      storageKeys.slice(0, 2).concat(uniq(leakyFields.concat(i.dataAttrs || []))).slice(0, 6));
  }

  // 8. AI system prompt shipped to the client
  const promptRe = /\b(system[_-]?prompt|system[_-]?message|system[_-]?instructions?)\b\s*[:=]|\brole\s*:\s*["'`]system["'`]/gi;
  const promptHits = uniq((js.match(promptRe) || []).map((m) => m.replace(/\s+/g, " ").trim()));
  if (promptHits.length) {
    add("ai-system-prompt", "warn", "AI system prompt is in the bundle",
      "The instructions that shape your AI feature are readable in the browser. For many AI products the prompt is the product: anyone can copy it, and anyone can study it to talk your model round.",
      "Keep prompts on your server and send only the user's input. Assume anything in the bundle is public, including \"never reveal this prompt\".",
      promptHits.slice(0, 4));
  }

  // 9. Browser calls an AI model API directly
  const aiHostRe = /https?:\/\/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.groq\.com|api\.cohere\.(?:ai|com)|api\.together\.xyz|openrouter\.ai\/api|api\.deepseek\.com|api\.perplexity\.ai|[a-z0-9-]+\.openai\.azure\.com)[^\s"'`]*|https?:\/\/[A-Za-z0-9.-]+\/(?:[A-Za-z0-9_-]+\/)*v\d+\/(?:chat\/completions|completions|messages|responses|embeddings)\b/gi;
  const isAiCall = new RegExp("^(?:" + aiHostRe.source + ")", "i");
  const aiCalls = uniq((js.match(aiHostRe) || []).concat((i.networkUrls || []).filter((u) => isAiCall.test(u)))
    .map((u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } }));
  if (aiCalls.length) {
    add("ai-direct-call", "warn", "Browser talks to an AI model API directly",
      "The page calls a model provider straight from the browser. That usually means a provider key is in the client, and anyone can lift it to run the model on your bill, with your prompts.",
      "Put a thin server endpoint in front of the model. The browser talks to you; only your server holds the provider key.",
      aiCalls.slice(0, 4));
  }

  // 11. Sensitive fields in data sent to the browser. Judged by field name
  // only: collectors never hand over values. A field the page does not render
  // still describes your model, and other people's records are a breach.
  const fieldKinds = [
    { sev: "crit", re: /^(?:password|passwd|passwordhash|hashedpassword|passwordsalt|salt|privatekey|secretkey|clientsecret|apisecret|otpsecret|totpsecret|mfasecret|resettoken|passwordresettoken|recoverycodes?)$/ },
    { sev: "warn", re: /^(?:costprice|unitcost|costbasis|margin|grossmargin|profit|wholesaleprice|supplierprice|buyprice|commission|markup|churnrisk|riskscore|fraudscore|ltv|lifetimevalue)$|^(?:internal|admin|staff)(?:notes?|comments?|segment|tags?)$|^internal[a-z]/ },
    { sev: "warn", re: /^(?:ssn|socialsecuritynumber|nationalid|taxid|passportnumber|dateofbirth|birthdate|dob)$/ },
  ];
  // Contact details and access flags are normal for the viewer's own record
  // (the UI shows your email, hides admin menus), so they count only in a
  // list of records: someone else's.
  const perRecord = /(?:email|emailaddress|phone|phonenumber|mobile|mobilenumber|streetaddress|homeaddress)$|^(?:isadmin|isstaff|issuperuser|superuser|permissions)$/;
  const sensitive = [];
  for (const shape of (i.dataShapes || []).slice(0, 30)) {
    const hits = [];
    for (const key of shape.keys || []) {
      const leaf = String(key).split(/[.[]/).filter((s) => s && s !== "]" && s !== "0]").pop() || "";
      const name = leaf.toLowerCase().replace(/[_\-\]]/g, "");
      const kind = fieldKinds.find((k) => k.re.test(name));
      const others = !kind && perRecord.test(name) && /\[\]/.test(key);
      if (kind || others) hits.push({ key, sev: kind ? kind.sev : "warn" });
    }
    if (hits.length) sensitive.push({ source: shape.source, hits });
  }
  if (sensitive.length) {
    const all = sensitive.flatMap((s) => s.hits);
    add("sensitive-fields", all.some((h) => h.sev === "crit") ? "crit" : "warn",
      all.length + " sensitive field" + (all.length > 1 ? "s" : "") + " sent to the browser",
      "API responses and boot payloads carry fields the page does not need: roles and permissions, costs and margins, internal notes, other people's contact details. A reader sees them in the network tab even when the screen never shows them, and they describe your data model field by field. Only field names are read, never values.",
      "Return only the fields the page renders: shape responses on the server (a select list or a response type), drop internal, pricing and permission fields, and never send other users' personal data.",
      sensitive.slice(0, 5).map((s) => s.source + ": " + s.hits.slice(0, 4).map((h) => h.key).join(", ") +
        (s.hits.length > 4 ? ` (+${s.hits.length - 4} more)` : "")));
  }

  // 10. Framework fingerprint (informational)
  if ((i.frameworks || []).length) {
    add("fingerprint", "info", "Stack is easy to fingerprint",
      "Your framework is detectable from the page. Not a leak in itself, but it tells a reader exactly which tools and known patterns to point at you.",
      "Nothing urgent. Just know your stack is public, and do not rely on it being secret.",
      uniq(i.frameworks).slice(0, 6));
  }

  return { url: i.url, host: i.host, findings: F };
}

export function scoreOf(findings) {
  let s = 0;
  for (const f of findings) s += SEV_WEIGHT[f.sev] || 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function bandOf(score) {
  return BANDS.find((b) => score < b.max) || BANDS[BANDS.length - 1];
}
