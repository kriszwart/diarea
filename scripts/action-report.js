/* Turns the CLI's JSON report into GitHub Action outputs, a job summary, an
 * optional pull request comment and an exit code. Run by action.yml after
 * `diarea scan --json`; the scan's own exit code arrives in CODE so the Action
 * fails exactly when the CLI would. Evidence is already redacted by
 * src/checks.js.
 */
import fs from "node:fs";
import { countsOf, gateText, renderSummary } from "./action-summary.js";
import { commentBody, keyOf, movement, upsertComment } from "./pr-comment.js";

const env = process.env;
const exitCode = Number(env.CODE ?? "2");
const failOn = env.FAIL_ON || "";
const strict = env.STRICT === "true";

let report = null;
try { report = JSON.parse(fs.readFileSync(env.REPORT, "utf8")); } catch {}

if (!report || exitCode === 2) {
  console.log("::error title=Diarea::The scan could not run. See the Scan step log for the reason.");
  process.exit(2);
}

const counts = countsOf(report.findings);
if (env.GITHUB_OUTPUT) {
  fs.appendFileSync(env.GITHUB_OUTPUT, `score=${report.score}\nband=${report.band}\ncritical=${counts.crit}\n`);
}

const summary = renderSummary({ report, exitCode, failOn, strict });
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);

// Pull request comment: only on pull request events, and never fatal.
const prEvent = /^pull_request(_target)?$/.test(env.GITHUB_EVENT_NAME || "");
if (env.COMMENT === "true" && prEvent) {
  let pr = null, sha = "";
  try {
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    pr = event.pull_request && event.pull_request.number;
    sha = (event.pull_request && event.pull_request.head && event.pull_request.head.sha) || "";
  } catch {}
  if (!pr || !env.GITHUB_TOKEN) {
    console.log("::warning title=Diarea::Skipped the pull request comment: no pull request number or token.");
  } else {
    const key = keyOf(env.COMMENT_KEY || env.TARGET || "");
    const res = await upsertComment({
      api: env.GITHUB_API_URL || "https://api.github.com",
      repo: env.GITHUB_REPOSITORY, pr, token: env.GITHUB_TOKEN, key,
      render: (prev) => commentBody({
        key, score: report.score, sha,
        summary: renderSummary({ report, exitCode, failOn, strict, headline: movement(prev, report.score) }),
      }),
    });
    if (res.ok) console.log(`Diarea: ${res.action} the Leak Score comment on pull request #${pr}.`);
    else console.log(`::warning title=Diarea::Could not comment on the pull request (${res.error.message}). ` +
      "Forked pull requests get a read-only token, and the job needs `pull-requests: write`. The job summary has the full report.");
  }
}

if (exitCode === 1) {
  console.log(`::error title=Diarea::Leak score ${report.score}/100 (${report.band}). This build ${gateText(failOn, strict)}.`);
}
process.exit(exitCode);
