/* Turns the Action's JSON report into a SARIF file for GitHub code scanning.
 * Reads REPORT, writes SARIF, prints the path as the step's `sarif` output.
 */
import fs from "node:fs";
import { toSarif, sarifTarget } from "../src/sarif.js";

const { REPORT, SARIF, GITHUB_OUTPUT } = process.env;
const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
let report;
try {
  report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
} catch {
  console.log("::warning::No Diarea report to convert to SARIF (the scan itself failed).");
  process.exit(0);
}
fs.writeFileSync(SARIF, JSON.stringify(toSarif(report, { version, target: sarifTarget(report) }), null, 2));
if (GITHUB_OUTPUT) fs.appendFileSync(GITHUB_OUTPUT, `sarif=${SARIF}\n`);
console.log(`SARIF written to ${SARIF}`);
