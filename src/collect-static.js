/* Static collector. Parses HTML with jsdom WITHOUT executing page scripts, and
 * builds the snapshot that checks.analyse() expects. This powers the CLI's
 * --html / file / stdin mode and runs anywhere Node runs, no browser needed.
 *
 * Scripts are never executed, so this is safe to point at untrusted markup.
 * When given a root directory (scanning a file such as dist/index.html), it
 * also reads the page's local <script src> files and checks for sibling .map
 * files, so build output is judged on what it actually ships. It only reads
 * inside that directory. It will not see data that only appears after
 * client-side rendering; for a full single-page app, use the live collector.
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const MAX_BUNDLES = 16;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

// Resolve a script src to a file inside root, or null. Remote and
// protocol-relative scripts are skipped; nothing leaves the machine.
function localScriptPath(src, root) {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return null;
  const clean = decodeURIComponent(src.split(/[?#]/)[0]);
  const file = path.resolve(root, "." + path.posix.join("/", clean));
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return file;
}

function readLocalBundles(scripts, root) {
  const bundles = [];
  const seen = new Set();
  let liveMapFound = false;
  for (const el of scripts) {
    if (bundles.length >= MAX_BUNDLES) break;
    const src = el.getAttribute("src");
    const file = src && localScriptPath(src, root);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try {
      if (fs.statSync(file).size > MAX_BUNDLE_BYTES) continue;
      bundles.push({ url: "/" + path.relative(root, file).split(path.sep).join("/"), body: fs.readFileSync(file, "utf8") });
      if (fs.existsSync(file + ".map")) liveMapFound = true;
    } catch { /* missing or unreadable; skip */ }
  }
  return { bundles, liveMapFound };
}

const GLOBAL_MARKERS = [
  ["__NEXT_DATA__", /__NEXT_DATA__/],
  ["__NUXT__", /window\.__NUXT__/],
  ["__APOLLO_STATE__", /__APOLLO_STATE__/],
  ["__PRELOADED_STATE__", /__PRELOADED_STATE__/],
  ["__INITIAL_STATE__", /__INITIAL_STATE__/],
  ["__remixContext", /__remixContext/],
  ["__sveltekit", /__sveltekit/],
];

export function collectStatic(html, baseUrl = "http://localhost/", opts = {}) {
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

  const local = opts.root ? readLocalBundles(scripts.filter((s) => s.src), path.resolve(opts.root))
    : { bundles: [], liveMapFound: false };

  let origin = "", host = "";
  try { const u = new URL(baseUrl); origin = u.origin; host = u.host; } catch {}

  return {
    url: baseUrl, host, origin,
    inlineScripts,
    bundles: local.bundles, // local files only, never fetched over the network
    html: serialised,
    globals,
    biggestStateBytes,
    biggestJsonBytes,
    liveMapFound: local.liveMapFound,
    hiddenFields,
    dataAttrs,
    frameworks,
    networkUrls: [],
  };
}
