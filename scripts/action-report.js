/* Turns the CLI's JSON report into GitHub Action outputs, a job summary and
 * an exit code. Run by action.yml after `diarea scan --json`; the scan's own
 * exit code arrives in CODE so the Action fails exactly when the CLI would.
 * Evidence is already redacted by src/checks.js.
 */
import fs from "node:fs";
import { SEV_ORDER } from "../src/checks.js";

const { REPORT, CODE = "2", FAIL_ON = "", STRICT = "false", GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
const code = Number(CODE);

let report = null;
try { report = JSON.parse(fs.readFileSync(REPORT, "utf8")); } catch {}

if (!report || code === 2) {
  console.log("::error title=Diarea::The scan could not run. See the Scan step log for the reason.");
  process.exit(2);
}

const findings = report.findings || [];
const counts = { crit: 0, warn: 0, info: 0 };
for (const f of findings) counts[f.sev] = (counts[f.sev] || 0) + 1;

if (GITHUB_OUTPUT) {
  fs.appendFileSync(GITHUB_OUTPUT,
    `score=${report.score}\nband=${report.band}\ncritical=${counts.crit}\n`);
}

const LABEL = { crit: "critical", warn: "exposed", info: "minor" };
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code_ = (s) => "`" + String(s).replace(/`/g, "'") + "`";

const lines = [];
lines.push(`## 💩 Diarea: ${report.score}/100, ${report.band}`);
lines.push("");
lines.push(`Scanned ${code_(report.host || report.url || "")} in ${report.mode} mode. ` +
  `${counts.crit} critical, ${counts.warn} exposed, ${counts.info} minor.`);
lines.push("");
if (findings.length) {
  lines.push("| Severity | Finding | Evidence | Flush it |");
  lines.push("|---|---|---|---|");
  for (const f of findings.slice().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev])) {
    const ev = (f.evidence || []).slice(0, 3).map(code_).join("<br>");
    lines.push(`| ${LABEL[f.sev] || f.sev} | ${cell(f.title)} | ${cell(ev)} | ${cell(f.fix)} |`);
  }
} else {
  lines.push("Nothing obvious leaking. Keep the real defences server-side.");
}
lines.push("");

const gate = [];
if (FAIL_ON !== "") gate.push(`fails at ${FAIL_ON} or more`);
if (STRICT === "true") gate.push("fails on any critical finding");
lines.push(code === 1
  ? `**Failed.** This build ${gate.join(" and ")}.`
  : `Passed${gate.length ? ` (this build ${gate.join(" and ")})` : ""}.`);

const summary = lines.join("\n") + "\n";
if (GITHUB_STEP_SUMMARY) fs.appendFileSync(GITHUB_STEP_SUMMARY, summary);
console.log(summary);

if (code === 1) {
  console.log(`::error title=Diarea::Leak score ${report.score}/100 (${report.band}). This build ${gate.join(" and ")}.`);
}
process.exit(code);
