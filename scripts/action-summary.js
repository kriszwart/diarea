/* Markdown for the Action's job summary and pull request comment, built from
 * the CLI's JSON report. Evidence is already redacted by src/checks.js.
 */
import { SEV_ORDER, basisLine } from "../src/checks.js";

const LABEL = { crit: "critical", warn: "exposed", info: "minor" };
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (s) => "`" + String(s).replace(/`/g, "'") + "`";

export function countsOf(findings) {
  const counts = { crit: 0, warn: 0, info: 0 };
  for (const f of findings || []) counts[f.sev] = (counts[f.sev] || 0) + 1;
  return counts;
}

export function gateText(failOn, strict) {
  const gate = [];
  if (failOn !== "" && failOn != null) gate.push(`fails at ${failOn} or more`);
  if (strict) gate.push("fails on any critical finding");
  return gate.join(" and ");
}

/** Title line, scan line, findings table and the pass/fail verdict. */
export function renderSummary({ report, exitCode, failOn = "", strict = false, headline = "" }) {
  const findings = report.findings || [];
  const counts = countsOf(findings);
  const gate = gateText(failOn, strict);
  const lines = [];
  lines.push(`## 💩 Diarea: ${report.score}/100, ${report.band}`);
  lines.push("");
  if (headline) { lines.push(headline); lines.push(""); }
  lines.push(`Scanned ${code(report.host || report.url || "")} in ${report.mode} mode. ` +
    `${counts.crit} critical, ${counts.warn} exposed, ${counts.info} minor. ${basisLine(findings)}`);
  lines.push("");
  if (findings.length) {
    lines.push("| Severity | Finding | Evidence | Flush it |");
    lines.push("|---|---|---|---|");
    for (const f of findings.slice().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev])) {
      const ev = (f.evidence || []).slice(0, 3).map(code).join("<br>");
      lines.push(`| ${LABEL[f.sev] || f.sev} | ${cell(f.title)} | ${cell(ev)} | ${cell(f.fix)} |`);
    }
  } else {
    lines.push("Nothing obvious leaking. Keep the real defences server-side.");
  }
  lines.push("");
  lines.push(exitCode === 1
    ? `**Failed.** This build ${gate}.`
    : `Passed${gate ? ` (this build ${gate})` : ""}.`);
  return lines.join("\n") + "\n";
}
