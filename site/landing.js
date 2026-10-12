/* Landing page demo. Runs the real engine (lib/ is copied from src/ by
 * scripts/build.js) against Colander AI in the iframe beside it. It only ever
 * scans its own demo page, and nothing is sent anywhere.
 */
import { analyse, scoreOf, bandOf, SEV_ORDER } from "./lib/checks.js";
import { collectPage } from "./lib/collect-page.js";

const $ = (id) => document.getElementById(id);
const frame = $("demo-frame");
const btn = $("scan-btn");
const list = $("findings");
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const CIRC = 327; // 2 * pi * 52
const CHIP = { crit: "critical", warn: "exposed", info: "minor" };
const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const BAND_VAR = { Sealed: "--sealed", Seeping: "--seeping", Leaking: "--leaking", Gushing: "--gushing" };

function reloadFrame() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The demo took too long to load.")), 15000);
    frame.addEventListener("load", () => { clearTimeout(t); resolve(); }, { once: true });
    frame.src = "demo/?fresh=" + Date.now();
  });
}

// Run the shared collector inside the demo's own window, the same way the
// extension injects it into a tab.
async function collectFromFrame() {
  const run = new frame.contentWindow.Function("return (" + collectPage.toString() + ")();");
  return await run();
}

function setGauge(score, colour) {
  const fill = $("gauge-fill");
  fill.style.stroke = colour;
  fill.style.strokeDashoffset = String(CIRC - (CIRC * score) / 100);
  $("gauge").setAttribute("aria-label", "Leak score " + score + " out of 100");
}

async function countTo(score) {
  const el = $("score");
  if (reduced) { el.textContent = String(score); return; }
  const start = performance.now();
  const dur = 1400;
  await new Promise((done) => {
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = String(Math.round(score * (1 - Math.pow(1 - p, 3))));
      p < 1 ? requestAnimationFrame(tick) : done();
    };
    requestAnimationFrame(tick);
  });
}

function findingNode(f) {
  const li = document.createElement("li");
  li.className = "finding enter " + f.sev;
  const top = document.createElement("div");
  top.className = "f-top";
  const title = document.createElement("span");
  title.className = "f-title";
  title.textContent = f.title;
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = CHIP[f.sev] || f.sev;
  top.append(title, chip);
  li.append(top);
  if ((f.evidence || []).length) {
    const ev = document.createElement("div");
    ev.className = "f-ev";
    for (const e of f.evidence.slice(0, 3)) {
      const c = document.createElement("code");
      c.textContent = e;
      ev.append(c);
    }
    li.append(ev);
  }
  const fix = document.createElement("p");
  fix.className = "f-fix";
  const label = document.createElement("b");
  label.textContent = "Flush it: ";
  fix.append(label, document.createTextNode(f.fix));
  li.append(fix);
  return li;
}

let running = false;
async function scan() {
  if (running) return;
  running = true;
  btn.disabled = true;
  btn.textContent = "Examining...";
  list.replaceChildren();
  $("score").textContent = "?";
  setGauge(0, cssVar("--sealed"));
  $("band").textContent = "Examining the patient";
  $("band").style.color = "";
  $("band-line").textContent = "Reading scripts, globals, hidden fields and anything else left lying about.";
  frame.closest(".browser").classList.add("scanning");

  try {
    await reloadFrame();
    await sleep(500);
    const snapshot = await collectFromFrame();
    const result = analyse(snapshot);
    const findings = result.findings.slice().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    const score = scoreOf(findings);
    const band = bandOf(score);
    const colour = cssVar(BAND_VAR[band.label]) || band.colour;

    frame.closest(".browser").classList.remove("scanning");
    setGauge(score, colour);
    await countTo(score);
    $("band").textContent = band.label;
    $("band").style.color = colour;
    $("band-line").textContent = band.line;

    for (const f of findings) {
      list.append(findingNode(f));
      await sleep(220);
    }
    $("scan-note").textContent = "Read " + snapshot.scanned + " of " + snapshot.external +
      " scripts, found " + findings.length + " findings. Same engine as the extension, CLI and GitHub Action.";
    btn.textContent = "Run it again";
  } catch (err) {
    frame.closest(".browser").classList.remove("scanning");
    $("band").textContent = "Could not examine the patient";
    $("band-line").textContent = (err && err.message) || "Something went wrong. Reload and try again.";
    btn.textContent = "Try again";
  } finally {
    btn.disabled = false;
    running = false;
  }
}

btn.addEventListener("click", scan);

// "Scan the leaky demo" links scroll to the demo and start it.
for (const a of document.querySelectorAll("[data-autoscan]")) {
  a.addEventListener("click", () => setTimeout(scan, reduced ? 0 : 450));
}

// Copy buttons on the install snippets.
for (const b of document.querySelectorAll(".copy")) {
  b.addEventListener("click", async () => {
    const text = b.parentElement.querySelector("code").textContent;
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select it";
    }
    setTimeout(() => { b.textContent = "Copy"; }, 1600);
  });
}
