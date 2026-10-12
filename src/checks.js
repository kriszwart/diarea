/* Diarea - canonical detection engine.
 *
 * This is the single source of truth for what counts as a leak. It is pure and
 * isomorphic: it takes an already-collected snapshot of a page and returns
 * findings. The browser extension and the CLI each collect that snapshot in
 * their own way (real DOM, Playwright, or jsdom) and then call analyse().
 *
 * A finding is { sev, title, detail, fix, evidence[] }.
 * sev is "crit" | "warn" | "info".
 */

export const SEV_WEIGHT = { crit: 26, warn: 11, info: 3 };

export const BANDS = [
  { max: 15, label: "Sealed", colour: "#35c47a", line: "Tight. An agent would come away with very little." },
  { max: 40, label: "Seeping", colour: "#f5a623", line: "A few things are showing. Worth a wipe-down." },
  { max: 70, label: "Leaking", colour: "#f5733a", line: "Your logic and data are readable from the browser." },
  { max: 101, label: "Gushing", colour: "#ff4d4d", line: "Most of how this works is sitting in the open." },
];

export const SEV_ORDER = { crit: 0, warn: 1, info: 2 };

const uniq = (a) => Array.from(new Set(a));
// Never print a found secret: show a short prefix and its length only.
export const redact = (s) => { s = String(s); return s.slice(0, 4) + "... (" + s.length + " chars)"; };

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
 *   hiddenFields             - string[] names of hidden inputs
 *   dataAttrs                - string[] telltale data-* strings
 *   frameworks               - string[] detected framework names
 *   networkUrls              - string[] endpoints observed on the wire (optional)
 * @returns {{url, host, findings}}
 */
export function analyse(input = {}) {
  const i = {
    url: "", host: "", origin: "",
    inlineScripts: [], bundles: [], html: "",
    globals: [], biggestStateBytes: 0, biggestJsonBytes: 0,
    liveMapFound: false, hiddenFields: [], dataAttrs: [],
    frameworks: [], networkUrls: [],
    ...input,
  };

  const F = [];
  const add = (sev, title, detail, fix, evidence) =>
    F.push({ sev, title, detail, fix, evidence: (evidence || []).filter(Boolean) });

  const js = i.inlineScripts.concat(i.bundles.map((b) => b.body || "")).join("\n");
  const html = i.html || "";
  const haystack = js + "\n" + html;
  const pathOf = (u) => { try { return new URL(u, i.url || i.origin || "http://x/").pathname; } catch { return u; } };

  // 1. Source maps in production
  const mapRefs = uniq((js.match(/sourceMappingURL=([^\s'"]+)/g) || [])
    .map((s) => s.replace("sourceMappingURL=", "")));
  if (mapRefs.length || i.liveMapFound) {
    add("crit", "Source maps are published",
      "Source maps hand a reader your original, un-minified source: real file names, comments and logic. This is the single biggest shortcut for anyone rebuilding your product.",
      "Disable source map output for production builds, or stop serving .map files.",
      mapRefs.slice(0, 4).map(pathOf));
  }

  // 2. Secrets in client code or markup
  // Each token must start a word (so "task-item-..." is not an "sk-" key), and
  // keys that are random strings must look random: digits plus both cases.
  const B = "(?<![A-Za-z0-9_-])";
  const looksRandom = (v) => /[0-9]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v);
  const secretRules = [
    { re: new RegExp(B + "sk_live_[0-9a-zA-Z]{16,}", "g"), label: "Stripe secret key", sev: "crit", random: true },
    { re: new RegExp(B + "sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}", "g"), label: "OpenAI-style secret key", sev: "crit", random: true },
    { re: new RegExp(B + "AKIA[0-9A-Z]{16}(?![0-9A-Z])", "g"), label: "AWS access key id", sev: "crit" },
    { re: new RegExp(B + "AIza[0-9A-Za-z_-]{35}", "g"), label: "Google API key", sev: "warn" },
    { re: new RegExp(B + "xox[baprs]-[0-9A-Za-z-]{10,}", "g"), label: "Slack token", sev: "crit" },
    { re: new RegExp(B + "gh[pousr]_[A-Za-z0-9]{30,}", "g"), label: "GitHub token", sev: "crit", random: true },
    { re: new RegExp(B + "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{6,}", "g"), label: "JWT / bearer token", sev: "warn" },
    { re: new RegExp(B + "sk_test_[0-9a-zA-Z]{16,}", "g"), label: "Stripe test secret key", sev: "warn", random: true },
  ];
  const secretHits = [];
  for (const rule of secretRules) {
    for (const h of uniq(haystack.match(rule.re) || [])) {
      if (rule.random && !looksRandom(h.replace(/^(sk_live_|sk_test_|sk-(?:proj-|svcacct-|admin-)?|gh[pousr]_)/, ""))) continue;
      secretHits.push({ sev: rule.sev, label: rule.label, value: h });
    }
  }
  const assignRe = /["']?(api[_-]?key|secret|token|password|passwd|auth[_-]?token|access[_-]?key)["']?\s*[:=]\s*["']([^"']{8,})["']/gi;
  let am;
  const seen = new Set();
  while ((am = assignRe.exec(js)) !== null) {
    const key = am[1], val = am[2];
    if (/process\.env|import\.meta|YOUR_|xxxx|changeme|example|placeholder|\$\{|<%/.test(val)) continue;
    if (val.length > 120) continue;
    const sig = key.toLowerCase() + ":" + val.slice(0, 6);
    if (seen.has(sig)) continue;
    seen.add(sig);
    secretHits.push({ sev: "warn", label: "Hard-coded " + key.toLowerCase(), value: val });
  }
  if (secretHits.length) {
    const anyCrit = secretHits.some((s) => s.sev === "crit");
    add(anyCrit ? "crit" : "warn",
      secretHits.length + " possible secret" + (secretHits.length > 1 ? "s" : "") + " in client code",
      "Credentials in shipped JavaScript or markup are readable by anyone, no tooling required. Publishable keys (pk_) are fine. Secret keys and tokens are not.",
      "Move secret keys behind your server. The browser should only ever hold publishable keys.",
      secretHits.slice(0, 5).map((s) => s.label + ": " + redact(s.value)));
  }

  // 3. Proprietary logic shipped to the client
  const logicTerms = ["weight", "weighting", "threshold", "calibrat", "coefficient",
    "rubric", "sectorweight", "scorematrix", "scoring", "formula", "heuristic", "ruleset"];
  const low = js.toLowerCase();
  const logicFound = uniq(logicTerms.filter((t) => low.includes(t)));
  if (logicFound.length >= 3 && js.length > 400) {
    add("crit", "Scoring or business logic looks client-side",
      "Terms tied to how you score, weight or decide are present in the browser bundle. If your methodology runs here, a reader can copy the thing that makes you different, not just the look.",
      "Run scoring and weightings on the server. Ship verdicts and explanations to the browser, never the rules.",
      logicFound.slice(0, 8));
  }

  // 4. Hydration / global state exposure
  const stateKB = Math.round(Math.max(i.biggestStateBytes || 0, i.biggestJsonBytes || 0) / 1024);
  if (i.globals.length && stateKB >= 8) {
    add("warn", "Large hydration payload in the page (" + stateKB + " KB)",
      "Frameworks embed a serialised data blob to boot the UI. It often contains more than what is on screen: ids, flags, records and fields the user never sees.",
      "Send the browser only the fields it renders. Keep internal records and server-only fields out of the hydration payload.",
      i.globals.slice(0, 4).map((g) => "window." + g));
  } else if (i.globals.length) {
    add("info", "Hydration state exposed",
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
    const hasComments = /\/\*[\s\S]{10,}?\*\/|\/\/\s?(TODO|FIXME|HACK|NOTE|BUG)/.test(body);
    if ((avgLen < 220 && lines.length > 40) || hasComments) {
      readable = { url: b.url, comments: hasComments };
      break;
    }
  }
  if (readable) {
    add("warn", "Shipped code is readable",
      "A production bundle is not minified, or carries comments and developer notes. That turns reading your logic from a chore into a scroll.",
      "Minify for production. Strip comments and dev notes from shipped code.",
      [pathOf(readable.url) + (readable.comments ? "  (contains comments / TODOs)" : "  (not minified)")]);
  }

  // 6. API surface is easy to map
  const urlRe = /(["'`])(\/(?:api|graphql|v\d|rest|rpc|internal|admin)(?![A-Za-z0-9])(?:\/[A-Za-z0-9_\-\/.:]*)?|https?:\/\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_\-\/.]*)\1/g;
  let um;
  const endpoints = new Set(i.networkUrls || []);
  while ((um = urlRe.exec(js)) !== null) {
    let p = um[2];
    try { if (p.startsWith("http")) { const u = new URL(p); p = u.origin + u.pathname; } } catch {}
    if (p.length < 120) endpoints.add(p);
  }
  const eps = Array.from(endpoints);
  const graphql = eps.some((e) => /graphql/i.test(e));
  if (eps.length >= 6 || graphql) {
    add("info", eps.length + " API endpoints visible" + (graphql ? " (GraphQL)" : ""),
      "Endpoints in the bundle or on the wire let someone draw your API map without guessing. Expected to a degree, but a fully introspectable API makes bulk extraction trivial.",
      "Add auth, rate limits and per-account quotas. If GraphQL, disable introspection in production.",
      eps.slice(0, 5));
  }

  // 7. Hidden fields and data-* carrying meaning
  const leakyFields = uniq((i.hiddenFields || [])
    .filter((n) => /id|price|cost|token|key|secret|internal|flag|role|admin|user/i.test(n)));
  if (leakyFields.length || (i.dataAttrs || []).length) {
    add("info", "Hidden fields and data attributes carry meaning",
      "Hidden inputs and data- attributes travel in the markup. When they hold ids, prices or flags, they describe your model to anyone who reads the DOM.",
      "Keep identifiers and internal flags server-side. Do not trust or expose values the browser can edit.",
      uniq(leakyFields.concat(i.dataAttrs || [])).slice(0, 5));
  }

  // 8. AI system prompt shipped to the client
  const promptRe = /\b(system[_-]?prompt|system[_-]?message|system[_-]?instructions?)\b\s*[:=]|\brole\s*:\s*["'`]system["'`]/gi;
  const promptHits = uniq((js.match(promptRe) || []).map((m) => m.replace(/\s+/g, " ").trim()));
  if (promptHits.length) {
    add("warn", "AI system prompt is in the bundle",
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
    add("warn", "Browser talks to an AI model API directly",
      "The page calls a model provider straight from the browser. That usually means a provider key is in the client, and anyone can lift it to run the model on your bill, with your prompts.",
      "Put a thin server endpoint in front of the model. The browser talks to you; only your server holds the provider key.",
      aiCalls.slice(0, 4));
  }

  // 10. Framework fingerprint (informational)
  if ((i.frameworks || []).length) {
    add("info", "Stack is easy to fingerprint",
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
