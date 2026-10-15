#!/usr/bin/env node
/* diarea - see what an agent could reverse-engineer from your frontend.
 * Local and read-only. Usage: diarea scan <url|file> [options]
 */
import fs from "node:fs";
import { scoreOf, bandOf, SEV_ORDER, basisLine } from "../src/checks.js";
import { scan, isUrl } from "../src/scan.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `
diarea ${VERSION}  -  frontend leak scanner (local, read-only)

Usage:
  diarea scan <url>              Scan a live site (needs Playwright + a browser)
  diarea scan <file.html>        Scan a saved page, no browser
  diarea scan <folder>           Scan a build folder: index.html plus every script (dist/)
  diarea scan --html <file>      Same, explicit
  cat page.html | diarea scan -  Scan HTML from stdin
  diarea login <url>             Log in once in a real browser and save it, to scan pages behind a login
  diarea setup                   Let your coding agent run Diarea (Claude Code, MCP)
  diarea setup --project         ...for everyone on this project (.mcp.json)
  diarea setup --print           Show the MCP config for other agents
  diarea setup --allow-private   ...and let the agent scan localhost and private networks
  diarea mcp                     Run the MCP server (agents start this for you)

Options:
  --json             Output the report as JSON
  --sarif            Output SARIF 2.1.0 (GitHub code scanning)
  --fail-on <n>      Exit 1 if the leak score is n or more (for CI)
  --strict           Exit 1 if any critical finding is present
  --timeout <ms>     Navigation timeout for live scans (default 30000)
  --storage-state <file>  Scan as a logged-in user (a file saved by diarea login)
  --no-color         Disable colour
  -h, --help         Show this help
  -v, --version      Show version

Examples:
  diarea scan https://your-site.com --fail-on 40
  diarea scan --html dist/index.html --json
  diarea login https://your-site.com/login
  diarea scan https://your-site.com/dashboard --storage-state .diarea/login.json
`;

function parseArgs(argv) {
  const o = { _: [], json: false, sarif: false, strict: false, color: true, timeout: 30000, failOn: null, html: null, storageState: null, errors: [] };
  // A flag that needs a value must get one, and numbers must be numbers:
  // a typo should fail loudly, not quietly turn off a CI gate.
  const value = (k, name) => {
    const v = argv[k];
    if (v === undefined || (v.startsWith("--") && v.length > 2)) o.errors.push(`${name} needs a value.`);
    return v;
  };
  const number = (v, name, min, max) => {
    const n = Number(v);
    if (v === undefined || v === "" || !Number.isFinite(n) || n < min || n > max) {
      if (v !== undefined) o.errors.push(`${name} must be a number from ${min} to ${max}, not "${v}".`);
      return null;
    }
    return n;
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--json") o.json = true;
    else if (a === "--sarif") o.sarif = true;
    else if (a === "--strict") o.strict = true;
    else if (a === "--no-color") o.color = false;
    else if (a === "--html") o.html = value(++k, "--html");
    else if (a === "--storage-state") o.storageState = value(++k, "--storage-state");
    else if (a === "--fail-on") o.failOn = number(value(++k, "--fail-on"), "--fail-on", 0, 100);
    else if (a === "--timeout") o.timeout = number(value(++k, "--timeout"), "--timeout", 1000, 600000) ?? 30000;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else if (a.startsWith("-") && a !== "-") o.errors.push(`Unknown option: ${a}`);
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
  out.push(`  ${s.dim(basisLine(findings))}`);
  out.push("");

  if (!findings.length) {
    out.push(`  ${s.good("Nothing obvious leaking.")} No common exposure tells on this page.`);
    out.push(`  ${s.dim("Keep the real defences server-side.")}`);
  }
  for (const f of findings) {
    const tag = f.sev === "crit" ? s.crit("[CRIT]") : f.sev === "warn" ? s.warn("[WARN]") : s.info("[INFO]");
    out.push(`  ${tag} ${s.bold(f.title)}${f.basis ? "  " + s.dim(f.basis) : ""}`);
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
  if (cmd === "mcp") {
    const { serve } = await import("../src/mcp.js");
    const argv = process.argv.slice(3);
    // Only whoever configures the server can allow private addresses, never the agent.
    const allowPrivate = argv.includes("--allow-private") || process.env.DIAREA_ALLOW_PRIVATE === "1";
    serve({ version: VERSION, allowPrivate });
    return null; // keep running until the agent closes stdin
  }
  if (cmd === "login") {
    const { login } = await import("../src/login.js");
    return login(process.argv.slice(3));
  }
  if (cmd === "setup") {
    const { setup } = await import("../src/setup.js");
    return setup(process.argv.slice(3));
  }
  if (cmd !== "scan") { console.error(`Unknown command: ${cmd}\n${HELP}`); return 2; }

  if (o.errors.length) { console.error(o.errors.join("\n") + "\n" + HELP); return 2; }

  const target = o.html || o._[1];
  if (!target) { console.error("Nothing to scan. Give a URL or a file.\n" + HELP); return 2; }

  const s = makeStyle(o.color && process.stdout.isTTY && !process.env.NO_COLOR);
  let result;
  try {
    if (o.storageState && (o.html || !isUrl(target))) throw new Error("--storage-state only applies to live scans of a URL.");
    result = await scan(target, { timeout: o.timeout, forceStatic: Boolean(o.html), storageState: o.storageState });
  } catch (err) {
    console.error(`\n  ${s.crit("Could not scan.")} ${err.message}\n`);
    return 2;
  }
  const { score, mode } = result;

  if (o.sarif) {
    const { toSarif, sarifTarget } = await import("../src/sarif.js");
    console.log(JSON.stringify(toSarif(result, { version: VERSION, target: sarifTarget(result) }), null, 2));
  } else if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderHuman(result, mode, s));
  }

  const hasCrit = result.findings.some((f) => f.sev === "crit");
  if (o.failOn != null && score >= o.failOn) return 1;
  if (o.strict && hasCrit) return 1;
  return 0;
}

main().then((code) => { if (code !== null) process.exit(code); }).catch((e) => { console.error(e); process.exit(2); });
