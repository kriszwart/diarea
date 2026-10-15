/* Diarea - frontend leak scanner (extension popup)
 * Everything runs locally. collectPage() is injected into the active tab's page
 * context (MAIN world) so it can see page globals and inline scripts. It only
 * gathers evidence; every rule lives in the shared engine. All three modules
 * come from src/ and are copied to lib/ by `npm run build:extension`.
 * Nothing is sent anywhere.
 *
 * The page cannot read scripts on other origins, so a site that serves its
 * bundles from its own CDN (cdn.example.com) would go half unread. The popup
 * offers to read those, and only those: it asks Chrome for that origin with an
 * optional host permission, then fetches the scripts itself.
 */
import { analyse, scoreOf, bandOf, SEV_ORDER, basisLine } from "./lib/checks.js";
import { collectPage } from "./lib/collect-page.js";
import { crossOriginScripts, mapUrlFor, isSourceMap } from "./lib/cross-origin.js";

const MAX_CDN_SCRIPTS = 16;
const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;

async function hasOrigin(origin) {
  try { return await chrome.permissions.contains({ origins: [origin + "/*"] }); } catch { return false; }
}

// Read the site's own CDN scripts we have permission for, and look for a map.
async function readCdnScripts(groups) {
  const bundles = [];
  const urls = groups.flatMap((g) => g.urls).slice(0, MAX_CDN_SCRIPTS);
  await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(u, { credentials: "omit" });
      if (!r.ok || Number(r.headers.get("content-length") || 0) > MAX_SCRIPT_BYTES) return;
      const body = await r.text();
      if (body.length > MAX_SCRIPT_BYTES) return;
      bundles.push({ url: u, body, mapHeader: r.headers.get("SourceMap") || r.headers.get("X-SourceMap") || "" });
    } catch { /* blocked or gone; skip */ }
  }));
  const mapFiles = [];
  for (const b of bundles.slice(0, 4)) {
    try {
      const m = new URL(mapUrlFor(b.url, b.mapHeader));
      if (m.origin !== new URL(b.url).origin) continue;
      const r = await fetch(m.href, { credentials: "omit" });
      if (r.ok && isSourceMap(await r.text())) { mapFiles.push(m.host + m.pathname); break; }
    } catch {}
  }
  return { bundles: bundles.map(({ url, body }) => ({ url, body })), mapFiles };
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

  // The site's own scripts on other origins: read the ones Chrome lets us,
  // offer to read the rest.
  const { related } = crossOriginScripts(result.url, result.scriptSrcs || []);
  const granted = [], pending = [];
  for (const g of related) (await hasOrigin(g.origin) ? granted : pending).push(g);
  if (granted.length) {
    const cdn = await readCdnScripts(granted);
    result.bundles = result.bundles.concat(cdn.bundles);
    if (cdn.mapFiles.length) {
      result.liveMapFound = true;
      result.mapFiles = (result.mapFiles || []).concat(cdn.mapFiles);
    }
  }
  render({ ...analyse(result), scanned: result.bundles.length, external: result.external, pending });
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
  tpl.querySelector(".basis").textContent = basisLine(findings);

  const list = tpl.querySelector(".findings");
  if (!findings.length) {
    const ok = document.createElement("div");
    ok.className = "empty-ok";
    // A clean bill of health only counts for what was read.
    ok.innerHTML = res.pending && res.pending.length
      ? "<b>Nothing obvious leaking</b> in what Diarea could read.<br>Read the scripts above before you trust this score."
      : "<b>Nothing obvious leaking.</b><br>No common exposure tells on this page. Keep the real defences server-side.";
    list.appendChild(ok);
  } else {
    for (const f of findings) list.appendChild(buildFinding(f));
  }

  view().innerHTML = "";
  view().appendChild(tpl);

  const report = view().querySelector(".report");
  // Unread scripts go above the findings: the score is incomplete without them.
  if (res.pending && res.pending.length) report.insertBefore(buildOffer(res.pending), report.querySelector(".findings"));

  const note = document.createElement("p");
  note.className = "read-note";
  note.textContent = "Read " + res.scanned + " of " + res.external + " scripts. Other companies' scripts are never read.";
  report.appendChild(note);
}

// "These scripts look like your own. Read them too?" One click, one Chrome prompt.
function buildOffer(pending) {
  const count = pending.reduce((n, g) => n + g.urls.length, 0);
  const hosts = pending.map((g) => new URL(g.origin).host);
  const box = document.createElement("div");
  box.className = "cdn-offer";
  const p = document.createElement("p");
  const b = document.createElement("b");
  b.textContent = count + (count === 1 ? " script" : " scripts") + " on " + hosts.slice(0, 2).join(", ") +
    (hosts.length > 2 ? " and " + (hosts.length - 2) + " more" : "");
  p.append(b, " went unread. They look like this site's own files on a CDN, and can leak too.");
  const btn = document.createElement("button");
  btn.className = "rescan";
  btn.textContent = "Read them too";
  btn.addEventListener("click", async () => {
    let ok = false;
    try { ok = await chrome.permissions.request({ origins: pending.map((g) => g.origin + "/*") }); } catch {}
    if (ok) run();
  });
  const small = document.createElement("p");
  small.className = "small";
  small.textContent = "Chrome asks once for each site. Diarea only reads those scripts, and only when you scan.";
  box.append(p, btn, small);
  return box;
}

function buildFinding(f) {
  const node = document.getElementById("finding-tpl").content.cloneNode(true);
  const det = node.querySelector(".finding");
  det.classList.add("sev-" + f.sev);
  node.querySelector(".f-title").textContent = f.title;
  node.querySelector(".f-chip").textContent =
    (f.sev === "crit" ? "critical" : f.sev === "warn" ? "exposed" : "minor") + (f.basis ? " · " + f.basis : "");
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
