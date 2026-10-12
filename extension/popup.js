/* Diarea - frontend leak scanner (extension popup)
 * Everything runs locally. collectPage() is injected into the active tab's page
 * context (MAIN world) so it can see page globals and inline scripts. It only
 * gathers evidence; every rule lives in the shared engine (src/checks.js, copied
 * to lib/checks.js by `npm run build:extension`). Nothing is sent anywhere.
 */
import { analyse, scoreOf, bandOf, SEV_ORDER } from "./lib/checks.js";

/* ----- the injected collector (must be fully self-contained) -----
 * Builds the same snapshot shape as src/collect-live.js.
 */
async function collectPage() {
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
  await Promise.all(sameOrigin.slice(0, 12).map(async (u) => {
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

/* ----- driver (runs in the popup) ----- */
async function run() {
  showLoading();
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { return showCannot("No active tab to scan."); }

  const url = tab && tab.url ? tab.url : "";
  if (!/^https?:\/\//i.test(url)) {
    return showCannot("Diarea can only scan live web pages. Open your own deployed site and try again.");
  }
  setTarget(tab.url);

  let result;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectPage,
    });
    result = out && out[0] && out[0].result;
  } catch (e) {
    return showCannot("This page blocks inspection (its security policy stops the scan). Try your own site.");
  }
  if (!result || !result.ok) return showCannot("The scan returned nothing. Reload the page and retry.");
  render({ ...analyse(result), scanned: result.scanned, external: result.external });
}

/* ----- rendering ----- */
const view = () => document.getElementById("view");

function showLoading() {
  view().innerHTML =
    '<section class="state"><div class="spinner"></div><p>Running the diagnosis...</p></section>';
}
function showCannot(msg) {
  view().innerHTML =
    '<section class="state cannot"><p class="big">Cannot scan this page</p><p>' +
    escapeHtml(msg) + "</p></section>";
}
function setTarget(u) {
  try { document.getElementById("target").textContent = new URL(u).host; } catch (e) {}
}

function render(res) {
  const findings = (res.findings || []).slice().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
  const score = scoreOf(findings);
  const band = bandOf(score);
  const counts = { crit: 0, warn: 0, info: 0 };
  findings.forEach((f) => counts[f.sev]++);

  const tpl = document.getElementById("report-tpl").content.cloneNode(true);

  // gauge
  const C = 327; // 2*pi*52 approx
  const fill = tpl.querySelector(".fill");
  fill.style.stroke = band.colour;
  fill.style.strokeDashoffset = String(C - (C * score) / 100);
  tpl.querySelector(".score-num").textContent = String(score);
  const bandEl = tpl.querySelector(".band");
  bandEl.textContent = band.label;
  bandEl.style.color = band.colour;
  tpl.querySelector(".verdict").textContent = band.line;

  const pills = tpl.querySelectorAll(".pill b");
  pills[0].textContent = counts.crit;
  pills[1].textContent = counts.warn;
  pills[2].textContent = counts.info;

  const list = tpl.querySelector(".findings");
  if (!findings.length) {
    const ok = document.createElement("div");
    ok.className = "empty-ok";
    ok.innerHTML = "<b>Nothing obvious leaking.</b><br>No common exposure tells on this page. Keep the real defences server-side.";
    list.appendChild(ok);
  } else {
    for (const f of findings) list.appendChild(buildFinding(f));
  }

  view().innerHTML = "";
  view().appendChild(tpl);

  const note = document.createElement("p");
  note.style.cssText = "font-size:10px;color:var(--ink-faint);margin:10px 0 0;text-align:center;";
  note.textContent = "Read " + res.scanned + " of " + res.external + " scripts (same-origin only).";
  view().querySelector(".report").appendChild(note);
}

function buildFinding(f) {
  const node = document.getElementById("finding-tpl").content.cloneNode(true);
  const det = node.querySelector(".finding");
  det.classList.add("sev-" + f.sev);
  node.querySelector(".f-title").textContent = f.title;
  node.querySelector(".f-chip").textContent =
    f.sev === "crit" ? "critical" : f.sev === "warn" ? "exposed" : "minor";
  node.querySelector(".f-detail").textContent = f.detail;
  node.querySelector(".fix-text").textContent = f.fix;

  const ev = node.querySelector(".f-evidence");
  const items = (f.evidence || []).slice(0, 6);
  if (!items.length) { ev.remove(); }
  else {
    items.forEach((e) => {
      const c = document.createElement("code");
      c.textContent = e;
      ev.appendChild(c);
    });
    if ((f.evidence || []).length > items.length) {
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = "+ " + ((f.evidence.length - items.length)) + " more";
      ev.appendChild(more);
    }
  }
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

document.getElementById("rescan").addEventListener("click", run);
run();
