/* Diarea - frontend leak scanner
 * Everything runs locally. The scan function below is injected into the active
 * tab's page context (MAIN world) so it can see page globals and inline scripts.
 * It returns a plain object of findings; nothing is sent anywhere.
 */

const SEV_WEIGHT = { crit: 26, warn: 11, info: 3 };
const BANDS = [
  { max: 15, label: "Sealed", colour: "#35c47a", line: "Tight. REA would come away with very little." },
  { max: 40, label: "Seeping", colour: "#f5a623", line: "A few things are showing. Worth a wipe-down." },
  { max: 70, label: "Leaking", colour: "#f5733a", line: "Your logic and data are readable from the browser." },
  { max: 101, label: "Gushing", colour: "#ff4d4d", line: "Most of how this works is sitting in the open." },
];

/* ----- the injected scanner (must be fully self-contained) ----- */
async function scanPage() {
  const F = [];
  const add = (sev, title, detail, fix, evidence) =>
    F.push({ sev, title, detail, fix, evidence: evidence || [] });
  const uniq = (a) => Array.from(new Set(a));
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);

  const scripts = Array.from(document.scripts);
  const inlineBodies = scripts.filter((s) => !s.src).map((s) => s.textContent || "");
  const externalSrcs = uniq(scripts.filter((s) => s.src).map((s) => s.src));
  const origin = location.origin;

  const sameOrigin = externalSrcs.filter((u) => {
    try { return new URL(u, origin).origin === origin; } catch { return false; }
  });

  // Best-effort: fetch same-origin bundles so we can read what ships to the browser.
  const fetched = [];
  await Promise.all(
    sameOrigin.slice(0, 12).map(async (u) => {
      try {
        const r = await fetch(u, { credentials: "omit" });
        if (r.ok) fetched.push({ url: u, body: await r.text() });
      } catch (e) { /* cross-origin or blocked; skip */ }
    })
  );

  const jsBlobs = inlineBodies.concat(fetched.map((f) => f.body));
  const js = jsBlobs.join("\n");
  const html = document.documentElement.outerHTML;

  // 1. Source maps in production
  const mapRefs = uniq((js.match(/sourceMappingURL=([^\s'"]+)/g) || [])
    .map((s) => s.replace("sourceMappingURL=", "")));
  // also probe one same-origin bundle for a sibling .map
  let liveMap = null;
  for (const f of fetched.slice(0, 4)) {
    try {
      const mu = f.url + ".map";
      const r = await fetch(mu, { credentials: "omit" });
      if (r.ok) { liveMap = mu; break; }
    } catch (e) {}
  }
  if (mapRefs.length || liveMap) {
    add("crit", "Source maps are published",
      "Source maps hand a reader your original, un-minified source: real file names, comments and logic. This is the single biggest shortcut for anyone rebuilding your product.",
      "Disable source map output for production builds, or stop serving .map files.",
      uniq([liveMap, ...mapRefs].filter(Boolean)).slice(0, 4).map(clipMap));
  }
  function clipMap(s) { try { return new URL(s, origin).pathname; } catch { return s; } }

  // 2. Secrets in client code / markup
  const haystack = js + "\n" + html;
  const secretRules = [
    { re: /sk_live_[0-9a-zA-Z]{8,}/g, label: "Stripe secret key", sev: "crit" },
    { re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, label: "OpenAI-style secret key", sev: "crit" },
    { re: /AKIA[0-9A-Z]{16}/g, label: "AWS access key id", sev: "crit" },
    { re: /AIza[0-9A-Za-z\-_]{35}/g, label: "Google API key", sev: "warn" },
    { re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, label: "Slack token", sev: "crit" },
    { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, label: "GitHub token", sev: "crit" },
    { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, label: "JWT / bearer token", sev: "warn" },
    { re: /sk_test_[0-9a-zA-Z]{8,}/g, label: "Stripe test secret key", sev: "warn" },
  ];
  const secretHits = [];
  for (const rule of secretRules) {
    const hits = uniq(haystack.match(rule.re) || []);
    for (const h of hits) secretHits.push({ sev: rule.sev, label: rule.label, value: h });
  }
  // generic assignment pattern, filtering obvious non-secrets
  const assignRe = /["']?(api[_-]?key|secret|token|password|passwd|auth[_-]?token|access[_-]?key)["']?\s*[:=]\s*["']([^"']{8,})["']/gi;
  let am;
  const seenGeneric = new Set();
  while ((am = assignRe.exec(js)) !== null) {
    const key = am[1], val = am[2];
    if (/process\.env|import\.meta|YOUR_|xxxx|changeme|example|placeholder|\$\{|<%/.test(val)) continue;
    if (val.length > 120) continue;
    const sig = key.toLowerCase() + ":" + val.slice(0, 6);
    if (seenGeneric.has(sig)) continue;
    seenGeneric.add(sig);
    secretHits.push({ sev: "warn", label: "Hard-coded " + key.toLowerCase(), value: val });
  }
  if (secretHits.length) {
    const anyCrit = secretHits.some((s) => s.sev === "crit");
    add(anyCrit ? "crit" : "warn",
      secretHits.length + " possible secret" + (secretHits.length > 1 ? "s" : "") + " in client code",
      "Credentials in shipped JavaScript or markup are readable by anyone, no tooling required. Publishable keys (pk_) are fine here. Secret keys and tokens are not.",
      "Move secret keys behind your server. The browser should only ever hold publishable keys.",
      secretHits.slice(0, 5).map((s) => s.label + ": " + clip(s.value, 38)));
  }

  // 3. Proprietary logic shipped to the client
  const logicTerms = ["weight", "weighting", "threshold", "calibrat", "coefficient",
    "rubric", "sectorweight", "scorematrix", "scoring", "formula", "heuristic", "ruleset"];
  const readable = js.toLowerCase();
  const logicFound = uniq(logicTerms.filter((t) => readable.includes(t)));
  // only meaningful if the JS is actually human-readable (see check 5)
  if (logicFound.length >= 3 && js.length > 400) {
    add("crit", "Scoring or business logic looks client-side",
      "Terms tied to how you score, weight or decide are present in the browser bundle. If your methodology runs here, a reader can copy the thing that makes you different, not just the look.",
      "Run scoring and weightings on the server. Ship verdicts and explanations to the browser, never the rules.",
      logicFound.slice(0, 8));
  }

  // 4. Hydration / global state exposure
  const globals = ["__NEXT_DATA__", "__NUXT__", "__APOLLO_STATE__", "__PRELOADED_STATE__",
    "__INITIAL_STATE__", "__remixContext", "__sveltekit", "__REDUX_DEVTOOLS_EXTENSION__"];
  const presentGlobals = globals.filter((g) => {
    try { return typeof window[g] !== "undefined"; } catch (e) { return false; }
  });
  let biggestState = 0;
  for (const g of presentGlobals) {
    try {
      const size = JSON.stringify(window[g] || "").length;
      if (size > biggestState) biggestState = size;
    } catch (e) {}
  }
  // large inline JSON blocks
  const jsonBlocks = Array.from(document.querySelectorAll('script[type="application/json"]'))
    .map((s) => (s.textContent || "").length);
  const biggestJson = jsonBlocks.length ? Math.max(...jsonBlocks) : 0;
  const stateKB = Math.round(Math.max(biggestState, biggestJson) / 1024);
  if (presentGlobals.length && stateKB >= 8) {
    add("warn", "Large hydration payload in the page (" + stateKB + " KB)",
      "Frameworks embed a serialised data blob to boot the UI. It often contains more than what is on screen: ids, flags, records and fields the user never sees.",
      "Send the browser only the fields it renders. Keep internal records and server-only fields out of the hydration payload.",
      presentGlobals.slice(0, 4).map((g) => "window." + g));
  } else if (presentGlobals.length) {
    add("info", "Hydration state exposed",
      "A readable boot payload is present. Small for now, but check it does not grow to carry internal fields.",
      "Review what is serialised into the page on each route.",
      presentGlobals.slice(0, 4).map((g) => "window." + g));
  }

  // 5. Un-minified / commented bundles
  let readableBundle = null;
  for (const f of fetched) {
    const b = f.body;
    if (b.length < 2000) continue;
    const lines = b.split("\n");
    const avgLen = b.length / Math.max(lines.length, 1);
    const hasComments = /\/\*[\s\S]{10,}?\*\/|\/\/\s?(TODO|FIXME|HACK|NOTE|BUG)/.test(b);
    if ((avgLen < 220 && lines.length > 40) || hasComments) {
      readableBundle = { url: f.url, lines: lines.length, comments: hasComments };
      break;
    }
  }
  if (readableBundle) {
    add("warn", "Shipped code is readable",
      "A production bundle is not minified, or carries comments and developer notes. That turns reading your logic from a chore into a scroll.",
      "Minify for production. Strip comments and dev notes from shipped code.",
      [new URL(readableBundle.url, origin).pathname + (readableBundle.comments ? "  (contains comments / TODOs)" : "  (not minified)")]);
  }

  // 6. API surface is easy to map
  const urlRe = /(["'`])(\/(?:api|graphql|v\d|rest|rpc|internal|admin)\/[A-Za-z0-9_\-\/.:]*|https?:\/\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_\-\/.]*)\1/g;
  let um;
  const endpoints = new Set();
  while ((um = urlRe.exec(js)) !== null) {
    let p = um[2];
    try { p = p.startsWith("http") ? new URL(p).origin + new URL(p).pathname : p; } catch (e) {}
    if (p.length < 120) endpoints.add(p);
  }
  const eps = Array.from(endpoints);
  const graphql = eps.some((e) => /graphql/i.test(e));
  if (eps.length >= 6 || graphql) {
    add("info", eps.length + " API endpoints visible in client code" + (graphql ? " (GraphQL)" : ""),
      "Endpoints in the bundle let someone draw your API map without guessing. This is expected to some degree, but a fully introspectable API makes bulk extraction trivial.",
      "Add auth, rate limits and per-account quotas. If GraphQL, disable introspection in production.",
      eps.slice(0, 5));
  }

  // 7. Hidden fields and data-* carrying meaning
  const hidden = Array.from(document.querySelectorAll('input[type="hidden"]'))
    .map((i) => i.name || i.id).filter(Boolean);
  const telltaleData = [];
  document.querySelectorAll("[data-id],[data-price],[data-cost],[data-user-id],[data-plan],[data-internal],[data-score],[data-tier]")
    .forEach((el) => {
      for (const a of el.attributes) {
        if (a.name.startsWith("data-") && /id|price|cost|plan|internal|score|tier|user/i.test(a.name)) {
          telltaleData.push(a.name + '="' + clip(a.value, 24) + '"');
        }
      }
    });
  const leakyFields = uniq(hidden.filter((n) => /id|price|cost|token|key|secret|internal|flag|role|admin|user/i.test(n)));
  if (leakyFields.length || telltaleData.length) {
    add("info", "Hidden fields and data attributes carry meaning",
      "Hidden inputs and data- attributes travel in the markup. When they hold ids, prices or flags, they describe your model to anyone who reads the DOM.",
      "Keep identifiers and internal flags server-side. Do not trust or expose values the browser can edit.",
      uniq(leakyFields.concat(telltaleData)).slice(0, 5));
  }

  // 8. Framework fingerprint (informational)
  const fp = [];
  if (window.__NEXT_DATA__ || document.querySelector("#__next")) fp.push("Next.js");
  if (window.__NUXT__) fp.push("Nuxt");
  if (window.React || document.querySelector("[data-reactroot]")) fp.push("React");
  if (window.__VUE__ || document.querySelector("[data-v-app]")) fp.push("Vue");
  if (document.querySelector("[ng-version]")) fp.push("Angular");
  if (window.__svelte || window.__sveltekit) fp.push("Svelte");
  if (window.jQuery) fp.push("jQuery");
  if (fp.length) {
    add("info", "Stack is easy to fingerprint",
      "Your framework is detectable from the page. Not a leak in itself, but it tells a reader exactly which tools and known patterns to point at you.",
      "Nothing urgent. Just know your stack is public, and do not rely on it being secret.",
      uniq(fp));
  }

  return {
    ok: true,
    url: location.href,
    host: location.host,
    scanned: fetched.length,
    external: externalSrcs.length,
    findings: F,
  };
}

/* ----- driver (runs in the popup) ----- */
async function run() {
  showLoading();
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { return showCannot("No active tab to scan."); }

  const url = tab && tab.url ? tab.url : "";
  if (!/^https?:\/\//i.test(url)) {
    return showCannot("Diarea can only scan live web pages. Open your own deployed site and try again.");
  }
  setTarget(tab.url);

  let result;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: scanPage,
    });
    result = out && out[0] && out[0].result;
  } catch (e) {
    return showCannot("This page blocks inspection (its security policy stops the scan). Try your own site.");
  }
  if (!result || !result.ok) return showCannot("The scan returned nothing. Reload the page and retry.");
  render(result);
}

/* ----- rendering ----- */
const view = () => document.getElementById("view");

function showLoading() {
  view().innerHTML =
    '<section class="state"><div class="spinner"></div><p>Running the diagnosis...</p></section>';
}
function showCannot(msg) {
  view().innerHTML =
    '<section class="state cannot"><p class="big">Cannot scan this page</p><p>' +
    escapeHtml(msg) + "</p></section>";
}
function setTarget(u) {
  try { document.getElementById("target").textContent = new URL(u).host; } catch (e) {}
}

function scoreOf(findings) {
  let s = 0;
  for (const f of findings) s += SEV_WEIGHT[f.sev] || 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}
function bandOf(score) {
  return BANDS.find((b) => score < b.max) || BANDS[BANDS.length - 1];
}

function render(res) {
  const findings = (res.findings || []).slice().sort((a, b) => {
    const order = { crit: 0, warn: 1, info: 2 };
    return order[a.sev] - order[b.sev];
  });
  const score = scoreOf(findings);
  const band = bandOf(score);
  const counts = { crit: 0, warn: 0, info: 0 };
  findings.forEach((f) => counts[f.sev]++);

  const tpl = document.getElementById("report-tpl").content.cloneNode(true);

  // gauge
  const C = 327; // 2*pi*52 approx
  const fill = tpl.querySelector(".fill");
  fill.style.stroke = band.colour;
  fill.style.strokeDashoffset = String(C - (C * score) / 100);
  tpl.querySelector(".score-num").textContent = String(score);
  const bandEl = tpl.querySelector(".band");
  bandEl.textContent = band.label;
  bandEl.style.color = band.colour;
  tpl.querySelector(".verdict").textContent = band.line;

  const pills = tpl.querySelectorAll(".pill b");
  pills[0].textContent = counts.crit;
  pills[1].textContent = counts.warn;
  pills[2].textContent = counts.info;

  const list = tpl.querySelector(".findings");
  if (!findings.length) {
    const ok = document.createElement("div");
    ok.className = "empty-ok";
    ok.innerHTML = "<b>Nothing obvious leaking.</b><br>No common exposure tells on this page. Keep the real defences server-side.";
    list.appendChild(ok);
  } else {
    for (const f of findings) list.appendChild(buildFinding(f));
  }

  view().innerHTML = "";
  view().appendChild(tpl);

  const note = document.createElement("p");
  note.style.cssText = "font-size:10px;color:var(--ink-faint);margin:10px 0 0;text-align:center;";
  note.textContent = "Read " + res.scanned + " of " + res.external + " scripts (same-origin only).";
  view().querySelector(".report").appendChild(note);
}

function buildFinding(f) {
  const node = document.getElementById("finding-tpl").content.cloneNode(true);
  const det = node.querySelector(".finding");
  det.classList.add("sev-" + f.sev);
  node.querySelector(".f-title").textContent = f.title;
  node.querySelector(".f-chip").textContent =
    f.sev === "crit" ? "critical" : f.sev === "warn" ? "exposed" : "minor";
  node.querySelector(".f-detail").textContent = f.detail;
  node.querySelector(".fix-text").textContent = f.fix;

  const ev = node.querySelector(".f-evidence");
  const items = (f.evidence || []).slice(0, 6);
  if (!items.length) { ev.remove(); }
  else {
    items.forEach((e) => {
      const c = document.createElement("code");
      c.textContent = e;
      ev.appendChild(c);
    });
    if ((f.evidence || []).length > items.length) {
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = "+ " + ((f.evidence.length - items.length)) + " more";
      ev.appendChild(more);
    }
  }
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

document.getElementById("rescan").addEventListener("click", run);
run();
