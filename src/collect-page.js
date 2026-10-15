/* In-page collector. Runs inside a real page (the extension injects it with
 * chrome.scripting, the live CLI with Playwright's page.evaluate, the landing
 * page inside its demo iframe) and returns the snapshot checks.analyse()
 * expects. It only gathers evidence; every rule lives in src/checks.js.
 *
 * It must stay fully self-contained: callers serialise this function and run
 * it in the page, so it cannot use imports or anything outside its own body.
 * It reads same-origin scripts only and never sends anything anywhere.
 */
export async function collectPage() {
  const uniq = (a) => Array.from(new Set(a));
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);
  const origin = location.origin;
  const scripts = Array.from(document.scripts);
  const inlineScripts = scripts.filter((s) => !s.src).map((s) => s.textContent || "");
  const externalSrcs = uniq(scripts.filter((s) => s.src).map((s) => s.src));

  // Best-effort: fetch same-origin bundles so we can read what ships to the browser.
  const sameOrigin = externalSrcs.filter((u) => {
    try { return new URL(u, origin).origin === origin; } catch { return false; }
  });
  const bundles = [];
  await Promise.all(sameOrigin.slice(0, 16).map(async (u) => {
    try {
      const r = await fetch(u, { credentials: "omit" });
      if (!r.ok) return;
      // A SourceMap header points at a map without leaving a comment in the file.
      const header = r.headers.get("SourceMap") || r.headers.get("X-SourceMap") || "";
      bundles.push({ url: u, body: await r.text(), mapHeader: header });
    } catch { /* blocked; skip */ }
  }));

  // Probe a few same-origin bundles for a map: the one a SourceMap header
  // names, or a sibling .map. Query strings and hashes (app.js?v=3) are
  // dropped first, or the probe would ask for app.js?v=3.map.
  let liveMapFound = false;
  const mapFiles = [];
  for (const b of bundles.slice(0, 4)) {
    try {
      const m = new URL(b.mapHeader || b.url, b.url);
      if (!b.mapHeader) { m.search = ""; m.hash = ""; m.pathname += ".map"; }
      if (m.origin !== origin) continue;
      const r = await fetch(m.href, { credentials: "omit" });
      // Single-page apps often answer any path with index.html, so a 200 is
      // not enough: it has to be a source map (JSON with a "sources" list).
      const body = r.ok ? await r.text() : "";
      if (/^\s*(?:\)\]\}'[^\n]*\n)?\s*\{/.test(body) && /"sources"\s*:/.test(body)) {
        liveMapFound = true; mapFiles.push(m.pathname); break;
      }
    } catch {}
  }
  for (const b of bundles) delete b.mapHeader;

  const names = ["__NEXT_DATA__", "__NUXT__", "__APOLLO_STATE__", "__PRELOADED_STATE__",
    "__INITIAL_STATE__", "__remixContext", "__sveltekit", "__REDUX_DEVTOOLS_EXTENSION__"];
  const globals = names.filter((g) => { try { return typeof window[g] !== "undefined"; } catch { return false; } });
  let biggestStateBytes = 0;
  for (const g of globals) {
    try { biggestStateBytes = Math.max(biggestStateBytes, JSON.stringify(window[g] || "").length); } catch {}
  }
  const jsonBlocks = Array.from(document.querySelectorAll('script[type="application/json"]'))
    .map((s) => (s.textContent || "").length);
  const biggestJsonBytes = jsonBlocks.length ? Math.max(...jsonBlocks) : 0;

  const hiddenFields = Array.from(document.querySelectorAll('input[type="hidden"]'))
    .map((el) => el.name || el.id).filter(Boolean);
  const dataAttrs = [];
  document.querySelectorAll("[data-id],[data-price],[data-cost],[data-user-id],[data-plan],[data-internal],[data-score],[data-tier]")
    .forEach((el) => {
      for (const a of el.attributes) {
        if (a.name.startsWith("data-") && /id|price|cost|plan|internal|score|tier|user/i.test(a.name)) {
          dataAttrs.push(a.name + '="' + clip(a.value, 24) + '"');
        }
      }
    });

  // Names of storage keys only. Values (live sessions, tokens) are never read.
  const storageKeys = [];
  for (const [label, store] of [["localStorage", "localStorage"], ["sessionStorage", "sessionStorage"]]) {
    try {
      const st = window[store];
      for (let k = 0; k < Math.min(st.length, 100); k++) storageKeys.push(label + ": " + clip(String(st.key(k)), 60));
    } catch { /* blocked; skip */ }
  }

  const fp = [];
  if (window.__NEXT_DATA__ || document.querySelector("#__next")) fp.push("Next.js");
  if (window.__NUXT__) fp.push("Nuxt");
  if (window.React || document.querySelector("[data-reactroot]")) fp.push("React");
  if (window.__VUE__ || document.querySelector("[data-v-app]")) fp.push("Vue");
  if (document.querySelector("[ng-version]")) fp.push("Angular");
  if (window.__svelte || window.__sveltekit) fp.push("Svelte");
  if (window.jQuery) fp.push("jQuery");

  return {
    ok: true,
    url: location.href, host: location.host, origin,
    inlineScripts, bundles, html: document.documentElement.outerHTML,
    globals, biggestStateBytes, biggestJsonBytes, liveMapFound, mapFiles,
    hiddenFields, dataAttrs, frameworks: fp, networkUrls: [], storageKeys,
    scanned: bundles.length,
    external: externalSrcs.length,
    // Every script URL, so the caller can read the site's own CDN scripts,
    // which this page context cannot fetch across origins.
    scriptSrcs: externalSrcs.slice(0, 200),
  };
}
