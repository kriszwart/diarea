/* Diarea - frontend leak scanner (extension popup)
 * Everything runs locally. collectPage() is injected into the active tab's page
 * context (MAIN world) so it can see page globals and inline scripts. It only
 * gathers evidence; every rule lives in the shared engine. Both come from src/
 * and are copied to lib/ by `npm run build:extension`. Nothing is sent anywhere.
 */
import { analyse, scoreOf, bandOf, SEV_ORDER } from "./lib/checks.js";
import { collectPage } from "./lib/collect-page.js";

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
