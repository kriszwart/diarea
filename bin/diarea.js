#!/usr/bin/env node
/* diarea - see what an agent could reverse-engineer from your frontend.
 * Local and read-only. Usage: diarea scan <url|file> [options]
 */
import fs from "node:fs";
import path from "node:path";
import { analyse, scoreOf, bandOf, SEV_ORDER } from "../src/checks.js";
import { collectStatic } from "../src/collect-static.js";

const VERSION = "0.3.0";

const HELP = `
diarea ${VERSION}  -  frontend leak scanner (local, read-only)

Usage:
  diarea scan <url>              Scan a live site (needs Playwright + a browser)
  diarea scan <file.html>        Scan a saved page, no browser
  diarea scan --html <file>      Same, explicit
  cat page.html | diarea scan -  Scan HTML from stdin

Options:
  --json             Output the report as JSON
  --fail-on <n>      Exit 1 if the leak score is n or more (for CI)
  --strict           Exit 1 if any critical finding is present
  --timeout <ms>     Navigation timeout for live scans (default 30000)
  --no-color         Disable colour
  -h, --help         Show this help
  -v, --version      Show version

Examples:
  diarea scan https://your-site.com --fail-on 40
  diarea scan --html dist/index.html --json
`;

function parseArgs(argv) {
  const o = { _: [], json: false, strict: false, color: true, timeout: 30000, failOn: null, html: null };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--json") o.json = true;
    else if (a === "--strict") o.strict = true;
    else if (a === "--no-color") o.color = false;
    else if (a === "--html") o.html = argv[++k];
    else if (a === "--fail-on") o.failOn = Number(argv[++k]);
    else if (a === "--timeout") o.timeout = Number(argv[++k]);
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else o._.push(a);
  }
  return o;
}

// ---- colour helpers ----
function makeStyle(on) {
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    dim: c("90"), bold: c("1"),
    crit: c("91"), warn: c("33"), info: c("36"), good: c("32"), mag: c("95"),
  };
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = []; let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) { lines.push(line); line = w; }
    else line = (line ? line + " " : "") + w;
  }
  if (line) lines.push(line);
  return lines.map((l, idx) => (idx === 0 ? l : indent + l)).join("\n");
}

function renderHuman(result, mode, s) {
  const findings = result.findings.slice().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
  const score = scoreOf(findings);
  const band = bandOf(score);
  const counts = { crit: 0, warn: 0, info: 0 };
  findings.forEach((f) => counts[f.sev]++);
  const bandColour = band.label === "Sealed" ? s.good : band.label === "Seeping" ? s.warn : s.crit;

  const out = [];
  out.push("");
  out.push(`  ${s.mag("\u{1F4A9} diarea")}  ${s.dim(result.host || result.url || "")}`);
  out.push(`  ${s.bold(`Leak Score ${score}/100`)}  ${bandColour(band.label)}  ${s.dim(band.line)}`);
  out.push(`  ${s.crit(counts.crit + " critical")}   ${s.warn(counts.warn + " exposed")}   ${s.info(counts.info + " minor")}`);
  out.push("");

  if (!findings.length) {
    out.push(`  ${s.good("Nothing obvious leaking.")} No common exposure tells on this page.`);
    out.push(`  ${s.dim("Keep the real defences server-side.")}`);
  }
  for (const f of findings) {
    const tag = f.sev === "crit" ? s.crit("[CRIT]") : f.sev === "warn" ? s.warn("[WARN]") : s.info("[INFO]");
    out.push(`  ${tag} ${s.bold(f.title)}`);
    out.push(`         ${wrap(f.detail, 74, "         ")}`);
    for (const e of (f.evidence || []).slice(0, 4)) out.push(`         ${s.dim("- " + e)}`);
    out.push(`         ${s.mag("flush it:")} ${wrap(f.fix, 74, "         ")}`);
    out.push("");
  }

  out.push(`  ${s.dim(`mode: ${mode}  -  a diagnosis, not a shield. The real cure is server-side.`)}`);
  out.push("");
  return out.join("\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.version) { console.log(VERSION); return 0; }
  if (o.help || o._.length === 0) { console.log(HELP); return o.help ? 0 : 2; }

  const cmd = o._[0];
  if (cmd !== "scan") { console.error(`Unknown command: ${cmd}\n${HELP}`); return 2; }

  const target = o.html || o._[1];
  if (!target) { console.error("Nothing to scan. Give a URL or a file.\n" + HELP); return 2; }

  const s = makeStyle(o.color && process.stdout.isTTY && !process.env.NO_COLOR);
  let input, mode;

  try {
    const isUrl = /^https?:\/\//i.test(target);
    if (isUrl && !o.html) {
      mode = "live (playwright)";
      const { collectLive } = await import("../src/collect-live.js");
      input = await collectLive(target, { timeout: o.timeout });
    } else {
      mode = "static (jsdom)";
      let html, base = "http://localhost/";
      if (target === "-") {
        html = fs.readFileSync(0, "utf8");
      } else {
        html = fs.readFileSync(target, "utf8");
        base = "file://" + target;
      }
      // For a file, also read its local scripts (inside its own folder only).
      input = collectStatic(html, base, target === "-" ? {} : { root: path.dirname(path.resolve(target)) });
      input.host = target === "-" ? "stdin" : target;
    }
  } catch (err) {
    console.error(`\n  ${s.crit("Could not scan.")} ${err.message}\n`);
    return 2;
  }

  const result = analyse(input);
  const score = scoreOf(result.findings);

  if (o.json) {
    console.log(JSON.stringify({ ...result, score, band: bandOf(score).label, mode }, null, 2));
  } else {
    console.log(renderHuman(result, mode, s));
  }

  const hasCrit = result.findings.some((f) => f.sev === "crit");
  if (o.failOn != null && !Number.isNaN(o.failOn) && score >= o.failOn) return 1;
  if (o.strict && hasCrit) return 1;
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
