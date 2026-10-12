/* Static collector. Parses HTML with jsdom WITHOUT executing page scripts, and
 * builds the snapshot that checks.analyse() expects. This powers the CLI's
 * --html / file / stdin mode and runs anywhere Node runs, no browser needed.
 *
 * Scripts are never executed, so this is safe to point at untrusted markup.
 * It will not see data that only appears after client-side rendering; for a
 * full single-page app, use the live (Playwright) collector instead.
 */
import { JSDOM } from "jsdom";

const GLOBAL_MARKERS = [
  ["__NEXT_DATA__", /__NEXT_DATA__/],
  ["__NUXT__", /window\.__NUXT__/],
  ["__APOLLO_STATE__", /__APOLLO_STATE__/],
  ["__PRELOADED_STATE__", /__PRELOADED_STATE__/],
  ["__INITIAL_STATE__", /__INITIAL_STATE__/],
  ["__remixContext", /__remixContext/],
  ["__sveltekit", /__sveltekit/],
];

export function collectStatic(html, baseUrl = "http://localhost/") {
  const dom = new JSDOM(html, { url: baseUrl }); // runScripts omitted = no execution
  const doc = dom.window.document;
  const serialised = dom.serialize();

  const scripts = Array.from(doc.scripts);
  const inlineScripts = scripts.filter((s) => !s.src).map((s) => s.textContent || "");

  // Hydration globals, detected by their textual signatures (no script run).
  const globals = GLOBAL_MARKERS.filter(([, re]) => re.test(serialised)).map(([name]) => name);

  // Largest inline JSON block, and largest inline script that mentions a global.
  const jsonBlocks = Array.from(doc.querySelectorAll('script[type="application/json"]'))
    .map((s) => (s.textContent || "").length);
  const biggestJsonBytes = jsonBlocks.length ? Math.max(...jsonBlocks) : 0;
  let biggestStateBytes = 0;
  for (const body of inlineScripts) {
    if (GLOBAL_MARKERS.some(([, re]) => re.test(body))) {
      biggestStateBytes = Math.max(biggestStateBytes, body.length);
    }
  }

  const hiddenFields = Array.from(doc.querySelectorAll('input[type="hidden"]'))
    .map((el) => el.getAttribute("name") || el.getAttribute("id"))
    .filter(Boolean);

  const dataAttrs = [];
  doc.querySelectorAll("[data-id],[data-price],[data-cost],[data-user-id],[data-plan],[data-internal],[data-score],[data-tier]")
    .forEach((el) => {
      for (const a of Array.from(el.attributes)) {
        if (a.name.startsWith("data-") && /id|price|cost|plan|internal|score|tier|user/i.test(a.name)) {
          const v = a.value.length > 24 ? a.value.slice(0, 24) + "..." : a.value;
          dataAttrs.push(a.name + '="' + v + '"');
        }
      }
    });

  const frameworks = [];
  if (/__NEXT_DATA__/.test(serialised) || doc.querySelector("#__next")) frameworks.push("Next.js");
  if (/window\.__NUXT__/.test(serialised)) frameworks.push("Nuxt");
  if (/data-reactroot/.test(serialised) || /__REACT/.test(serialised)) frameworks.push("React");
  if (doc.querySelector("[data-v-app]") || /__VUE__/.test(serialised)) frameworks.push("Vue");
  if (doc.querySelector("[ng-version]")) frameworks.push("Angular");
  if (/__sveltekit/.test(serialised)) frameworks.push("Svelte");
  if (/jquery(\.min)?\.js/i.test(serialised)) frameworks.push("jQuery");

  let origin = "", host = "";
  try { const u = new URL(baseUrl); origin = u.origin; host = u.host; } catch {}

  return {
    url: baseUrl, host, origin,
    inlineScripts,
    bundles: [], // static mode does not fetch external bundles
    html: serialised,
    globals,
    biggestStateBytes,
    biggestJsonBytes,
    liveMapFound: false,
    hiddenFields,
    dataAttrs,
    frameworks,
    networkUrls: [],
  };
}
