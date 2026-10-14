/* Live collector. Loads a real URL in headless Chromium via Playwright and
 * builds the snapshot that checks.analyse() expects, including page globals and
 * same-origin bundle contents that only exist after rendering. This is the mode
 * to run on your own machine against a deployed site.
 *
 * Playwright is an optional dependency so that the static/CI path works without
 * a browser. If it is missing, this throws a clear, actionable error.
 *
 * Options:
 *   timeout       navigation timeout in ms
 *   storageState  path to a Playwright storage state (cookies and local
 *                 storage, saved by `diarea login`) to scan pages behind a login
 *   guard         async (url) => void, throws for a URL that must not load.
 *                 The MCP server passes one (src/guard.js); every request the
 *                 page makes, and every hop of the page's redirects, is checked.
 */

import { collectPage } from "./collect-page.js";
import { crossOriginScripts, mapUrlFor, isSourceMap } from "./cross-origin.js";

const MAX_CDN_SCRIPTS = 16;
const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;

// The page cannot read scripts across origins, but its own CDN's scripts are
// its code too. Read those from Node (third-party scripts are left alone).
async function readCdnScripts(request, pageUrl, srcs, guard) {
  const { related } = crossOriginScripts(pageUrl, srcs);
  const urls = related.flatMap((g) => g.urls).slice(0, MAX_CDN_SCRIPTS);
  const bundles = [];
  await Promise.all(urls.map(async (u) => {
    try {
      if (guard) await guard(u);
      const r = await request.get(u, { maxRedirects: 0, timeout: 15000 });
      if (!r.ok()) return;
      const body = await r.text();
      if (body.length > MAX_SCRIPT_BYTES) return;
      bundles.push({ url: u, body, mapHeader: r.headers()["sourcemap"] || r.headers()["x-sourcemap"] || "" });
    } catch { /* blocked or gone; skip */ }
  }));
  const mapFiles = [];
  for (const b of bundles.slice(0, 4)) {
    try {
      const m = new URL(mapUrlFor(b.url, b.mapHeader));
      if (m.origin !== new URL(b.url).origin) continue;
      if (guard) await guard(m.href);
      const r = await request.get(m.href, { maxRedirects: 0, timeout: 15000 });
      if (r.ok() && isSourceMap(await r.text())) { mapFiles.push(m.host + m.pathname); break; }
    } catch {}
  }
  return { bundles: bundles.map(({ url, body }) => ({ url, body })), mapFiles };
}

export async function collectLive(url, opts = {}) {
  const timeout = opts.timeout || 30000;
  const guard = opts.guard || null;
  if (guard) await guard(url);

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

  // Always close the browser, even when navigation or collection throws:
  // the MCP server is long-lived, so a leaked Chromium would outlast the scan.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
      // Requests a service worker makes never reach the route below, so a
      // guarded scan runs without them.
      ...(guard ? { serviceWorkers: "block" } : {}),
    });
    if (guard) await context.route("**/*", async (route) => {
      try { await guard(route.request().url()); } catch { return route.abort("blockedbyclient"); }
      return route.continue();
    });
    const page = await context.newPage();

    const networkUrls = new Set();
    // Only API traffic counts towards the endpoint map, not the page's own
    // documents, scripts, styles, fonts and images.
    const API_TYPES = new Set(["fetch", "xhr", "websocket", "eventsource"]);
    page.on("request", (req) => {
      try {
        if (!API_TYPES.has(req.resourceType())) return;
        const u = new URL(req.url());
        if (/^(https?|wss?):$/.test(u.protocol)) networkUrls.add(u.origin + u.pathname);
      } catch {}
    });

    // Load once, then give the app a moment to go quiet. Sites that never
    // go idle (analytics, websockets) are scanned as they are, rather than
    // being loaded a second time.
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 15000) }).catch(() => {});

    // The browser follows redirects itself, so check where the page ended up,
    // and every hop on the way, before reading anything from it.
    if (guard) {
      for (let r = response && response.request(); r; r = r.redirectedFrom()) await guard(r.url());
      await guard(page.url());
    }

    // Snapshot the page's own traffic first: collectPage fetches bundles and
    // .map files itself, and those requests are the scanner's, not the site's.
    const pageTraffic = Array.from(networkUrls);
    const collected = await page.evaluate(collectPage);
    collected.networkUrls = pageTraffic;

    // From a fresh context, without the saved login: a CDN script should not need one.
    const bare = await browser.newContext();
    const cdn = await readCdnScripts(bare.request, collected.url, collected.scriptSrcs || [], guard);
    collected.bundles = collected.bundles.concat(cdn.bundles);
    if (cdn.mapFiles.length) {
      collected.liveMapFound = true;
      collected.mapFiles = (collected.mapFiles || []).concat(cdn.mapFiles);
    }
    collected.scanned = collected.bundles.length;
    return collected;
  } finally {
    await browser.close().catch(() => {});
  }
}
