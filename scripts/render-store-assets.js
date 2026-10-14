/* Renders the Chrome Web Store kit with headless Chromium (Playwright):
 * extension icons from the mascot, screenshots of the real popup scanning
 * the PromptPlop demo and a clean page, and the promo tiles.
 *
 *   npm run build:extension && node scripts/render-store-assets.js
 *
 * Needs Playwright (an optional dependency). Set CHROMIUM_PATH to use a
 * specific Chromium binary instead of Playwright's own.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (...p) => path.join(root, ...p);
const { chromium } = await import("playwright");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// Serve the repo root so the popup, demo and store pages share one origin.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".map": "application/json" };
const server = http.createServer((q, r) => {
  const file = path.join(root, decodeURIComponent(q.url.split("?")[0]));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  r.end(fs.readFileSync(file));
}).listen(0);
await new Promise((res) => server.once("listening", res));
const base = `http://localhost:${server.address().port}`;

// 1. Icons: the mascot on a transparent background. The 128 store icon keeps
// the artwork inside 96px with 16px padding, as the store guidelines ask.
// The mascot's own canvas has generous margins; crop to the artwork so small
// icons stay legible.
const svg = fs.readFileSync(out("docs/assets/mascot.svg"), "utf8");
const iconSvg = svg.replace('viewBox="0 0 200 200"', 'viewBox="18 22 166 166"').replace("<svg ", '<svg width="100%" height="100%" ');
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const art = size === 128 ? 96 : size;
  await page.setContent(`<html><body style="margin:0;background:transparent;display:grid;place-items:center;width:${size}px;height:${size}px">
    <div style="width:${art}px;height:${art}px">${iconSvg}</div></body></html>`);
  await page.screenshot({ path: out(`extension/icons/icon-${size}.png`), omitBackground: true });
  await page.close();
}

// 2. Screenshots and promo tiles: docs/store/*.html pages, each of which
// embeds the real popup. The stub below stands in for the chrome.* APIs inside
// the popup frame and runs the injected collector in the "tab" frame instead.
const stub = () => {
  if (!location.pathname.endsWith("/extension/popup.html")) return;
  const tab = () => window.parent.document.querySelector("#tab");
  window.chrome = {
    tabs: { query: async () => [{ id: 1, url: tab().dataset.url }] },
    permissions: { contains: async () => false, request: async () => false },
    scripting: {
      executeScript: async ({ func }) => {
        const w = tab().contentWindow;
        return [{ result: await new w.Function("return (" + func.toString() + ")();")() }];
      },
    },
  };
};

const shots = [
  ["docs/store/screenshot-1.html", "docs/store/screenshot-1-gushing.png", 1280, 800],
  ["docs/store/screenshot-2.html", "docs/store/screenshot-2-findings.png", 1280, 800],
  ["docs/store/screenshot-3.html", "docs/store/screenshot-3-sealed.png", 1280, 800],
  ["docs/store/promo-small.html", "docs/store/promo-small-440x280.png", 440, 280],
  ["docs/store/promo-marquee.html", "docs/store/promo-marquee-1400x560.png", 1400, 560],
];
for (const [src, dest, width, height] of shots) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: "light" });
  await page.addInitScript(stub);
  await page.goto(`${base}/${src}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  await page.screenshot({ path: out(dest) });
  await page.close();
  console.log("Rendered", dest);
}

await browser.close();
server.close();
console.log("Icons in extension/icons/, store images in docs/store/.");
