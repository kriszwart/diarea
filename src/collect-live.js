/* Live collector. Loads a real URL in headless Chromium via Playwright and
 * builds the snapshot that checks.analyse() expects, including page globals and
 * same-origin bundle contents that only exist after rendering. This is the mode
 * to run on your own machine against a deployed site.
 *
 * Playwright is an optional dependency so that the static/CI path works without
 * a browser. If it is missing, this throws a clear, actionable error.
 */

import { collectPage } from "./collect-page.js";

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

  // Always close the browser, even when navigation or collection throws:
  // the MCP server is long-lived, so a leaked Chromium would outlast the scan.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 15000) }).catch(() => {});

    // Snapshot the page's own traffic first: collectPage fetches bundles and
    // .map files itself, and those requests are the scanner's, not the site's.
    const pageTraffic = Array.from(networkUrls);
    const collected = await page.evaluate(collectPage);
    collected.networkUrls = pageTraffic;
    return collected;
  } finally {
    await browser.close().catch(() => {});
  }
}
