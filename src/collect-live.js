/* Live collector. Loads a real URL in headless Chromium via Playwright and
 * builds the snapshot that checks.analyse() expects, including page globals and
 * same-origin bundle contents that only exist after rendering. This is the mode
 * to run on your own machine against a deployed site.
 *
 * Playwright is an optional dependency so that the static/CI path works without
 * a browser. If it is missing, this throws a clear, actionable error.
 */

export async function collectLive(url, opts = {}) {
  const timeout = opts.timeout || 30000;

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "Live scanning needs Playwright and a browser.\n" +
      "  npm install playwright\n" +
      "  npx playwright install chromium\n" +
      "Or scan a saved page without a browser:  diarea scan --html page.html"
    );
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const networkUrls = new Set();
  page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (/^https?:$/.test(u.protocol)) networkUrls.add(u.origin + u.pathname);
    } catch {}
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout });
  } catch {
    // fall back to a lighter wait if the site never goes idle
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  }

  const collected = await page.evaluate(async () => {
    const uniq = (a) => Array.from(new Set(a));
    const origin = location.origin;
    const scripts = Array.from(document.scripts);
    const inlineScripts = scripts.filter((s) => !s.src).map((s) => s.textContent || "");
    const externalSrcs = uniq(scripts.filter((s) => s.src).map((s) => s.src));

    const sameOrigin = externalSrcs.filter((u) => {
      try { return new URL(u, origin).origin === origin; } catch { return false; }
    });
    const bundles = [];
    await Promise.all(sameOrigin.slice(0, 16).map(async (u) => {
      try {
        const r = await fetch(u, { credentials: "omit" });
        if (r.ok) bundles.push({ url: u, body: await r.text() });
      } catch {}
    }));

    let liveMapFound = false;
    for (const b of bundles.slice(0, 4)) {
      try { const r = await fetch(b.url + ".map", { credentials: "omit" }); if (r.ok) { liveMapFound = true; break; } } catch {}
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
            dataAttrs.push(a.name + '="' + (a.value.length > 24 ? a.value.slice(0, 24) + "..." : a.value) + '"');
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
      url: location.href, host: location.host, origin,
      inlineScripts, bundles, html: document.documentElement.outerHTML,
      globals, biggestStateBytes, biggestJsonBytes, liveMapFound,
      hiddenFields, dataAttrs, frameworks: fp,
    };
  });

  await browser.close();
  collected.networkUrls = Array.from(networkUrls);
  return collected;
}
