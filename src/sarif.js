/* SARIF 2.1.0 output, so findings show up in GitHub code scanning (the
 * Security tab) next to CodeQL. Formatting only: every rule still lives in
 * checks.js, and a finding's id becomes its SARIF rule id.
 */

const LEVEL = { crit: "error", warn: "warning", info: "note" };
// GitHub ranks code scanning alerts by this 0.0 to 10.0 score.
const SECURITY_SEVERITY = { crit: "8.0", warn: "5.0", info: "2.0" };

/** Where findings point: the scanned page's project-relative path, or its URL. */
export const sarifTarget = (report) =>
  String(report.url || "").startsWith("file:///") ? report.url.slice("file:///".length) : report.url || report.host;

/**
 * @param {{findings, score, band, url?, host?}} report  from scan()
 * @param {{version: string, target: string}} opts  target is the URL or the
 *   project-relative path that was scanned
 */
export function toSarif(report, { version, target }) {
  const rules = [];
  const results = [];
  for (const f of report.findings) {
    if (!rules.some((r) => r.id === f.id)) {
      rules.push({
        id: f.id,
        name: f.id.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase()),
        shortDescription: { text: f.title.replace(/^\d+ /, "") },
        fullDescription: { text: f.detail },
        help: { text: f.fix, markdown: `**Flush it:** ${f.fix}` },
        helpUri: "https://diarea.tools/",
        defaultConfiguration: { level: LEVEL[f.sev] },
        properties: { tags: ["security", "frontend"], "security-severity": SECURITY_SEVERITY[f.sev] },
      });
    }
    results.push({
      ruleId: f.id,
      level: LEVEL[f.sev],
      message: { text: f.title + (f.evidence.length ? ". Evidence: " + f.evidence.join("; ") : "") + ". Fix: " + f.fix },
      locations: [{ physicalLocation: { artifactLocation: { uri: target } } }],
      partialFingerprints: { diareaFinding: `${f.id}:${target}` },
    });
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "Diarea", semanticVersion: version, informationUri: "https://diarea.tools/", rules } },
      results,
      properties: { leakScore: report.score, band: report.band },
    }],
  };
}
