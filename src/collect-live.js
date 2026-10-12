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

  const collected = await page.evaluate(collectPage);

  await browser.close();
  collected.networkUrls = Array.from(networkUrls);
  return collected;
}
