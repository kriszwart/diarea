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
      if (r.ok) bundles.push({ url: u, body: await r.text() });
    } catch { /* blocked; skip */ }
  }));

  // Probe a few same-origin bundles for a sibling .map
  let liveMapFound = false;
  for (const b of bundles.slice(0, 4)) {
    try {
      const r = await fetch(b.url + ".map", { credentials: "omit" });
      if (r.ok) { liveMapFound = true; break; }
    } catch {}
  }

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
    globals, biggestStateBytes, biggestJsonBytes, liveMapFound,
    hiddenFields, dataAttrs, frameworks: fp, networkUrls: [],
    scanned: bundles.length,
    external: externalSrcs.length,
  };
}
