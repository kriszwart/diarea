/* Static collector. Parses HTML with jsdom WITHOUT executing page scripts, and
 * builds the snapshot that checks.analyse() expects. This powers the CLI's
 * --html / file / stdin mode and runs anywhere Node runs, no browser needed.
 *
 * Scripts are never executed, so this is safe to point at untrusted markup.
 * When given a root directory (scanning a file such as dist/index.html), it
 * also reads the page's local <script src> and modulepreload files and checks
 * for sibling .map files. With `folder: true` (scanning a build folder such as
 * dist/) it reads every script and script map in the folder, since lazy
 * chunks and hidden source maps deploy too. It only reads inside that
 * directory and never follows symlinks. It will not see data that only appears after
 * client-side rendering; for a full single-page app, use the live collector.
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const MAX_BUNDLES = 16;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
// A whole build folder: every script it would deploy, within sane limits.
const MAX_FOLDER_BUNDLES = 300;
const MAX_FOLDER_BYTES = 60 * 1024 * 1024;
const SCRIPT_FILE = /\.(?:m|c)?js$/i;
const SCRIPT_MAP = /\.(?:m|c)?js\.map$/i;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// Resolve a script src to a file inside root, or null. Remote and
// protocol-relative scripts are skipped; nothing leaves the machine.
function localScriptPath(src, root) {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return null;
  let clean;
  try { clean = decodeURIComponent(src.split(/[?#]/)[0]); } catch { return null; }
  const file = path.resolve(root, "." + path.posix.join("/", clean));
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return file;
}

const relUrl = (root, file) => "/" + path.relative(root, file).split(path.sep).join("/");

// Every script and script map in a build folder. Vite, webpack and friends
// only name the entry chunk in index.html; lazy routes, preloaded chunks and
// "hidden" source maps sit beside it and get deployed all the same.
// Symlinks are not followed, so the walk never leaves the folder.
function walkFolder(root) {
  const scripts = [], maps = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); }
      else if (e.isFile() && SCRIPT_MAP.test(e.name)) maps.push(full);
      else if (e.isFile() && SCRIPT_FILE.test(e.name)) scripts.push(full);
    }
  }
  return { scripts: scripts.sort(), maps: maps.sort() };
}

function readLocalBundles(srcs, root, { folder = false } = {}) {
  const bundles = [];
  const seen = new Set();
  const mapFiles = [];
  let total = 0;
  const limit = folder ? MAX_FOLDER_BUNDLES : MAX_BUNDLES;
  const realRoot = fs.realpathSync(root);
  const read = (file) => {
    if (bundles.length >= limit || seen.has(file)) return;
    seen.add(file);
    try {
      // A script named by the page could be a symlink out of the folder.
      const rel = path.relative(realRoot, fs.realpathSync(file));
      if (rel.startsWith("..") || path.isAbsolute(rel)) return;
      const size = fs.statSync(file).size;
      if (size > MAX_BUNDLE_BYTES || (folder && total + size > MAX_FOLDER_BYTES)) return;
      total += size;
      bundles.push({ url: relUrl(root, file), body: fs.readFileSync(file, "utf8") });
      if (fs.existsSync(file + ".map")) mapFiles.push(relUrl(root, file + ".map"));
    } catch { /* missing or unreadable; skip */ }
  };
  // The page's own scripts first, so they are always read.
  for (const src of srcs) {
    const file = localScriptPath(src, root);
    if (file) read(file);
  }
  if (folder) {
    const all = walkFolder(root);
    for (const file of all.scripts) read(file);
    for (const m of all.maps) mapFiles.push(relUrl(root, m));
  }
  const maps = Array.from(new Set(mapFiles));
  return { bundles, liveMapFound: maps.length > 0, mapFiles: maps };
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

  // Script tags plus module preloads: Vite names its shared chunks only in
  // <link rel="modulepreload">.
  const srcs = scripts.map((el) => el.getAttribute("src"))
    .concat(Array.from(doc.querySelectorAll('link[rel="modulepreload"][href]'), (el) => el.getAttribute("href")))
    .filter(Boolean);
  const local = opts.root ? readLocalBundles(srcs, path.resolve(opts.root), { folder: Boolean(opts.folder) })
    : { bundles: [], liveMapFound: false, mapFiles: [] };

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
    mapFiles: local.mapFiles,
    hiddenFields,
    dataAttrs,
    frameworks,
    networkUrls: [],
  };
}
