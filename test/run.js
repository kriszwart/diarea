/* Browser-free test: run the shared engine over the leaky and clean fixtures,
 * check secrets are redacted, and check the extension uses the shared engine
 * rather than a copy of the rules. No Playwright, no network. `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyse, scoreOf, bandOf } from "../src/checks.js";
import { collectStatic } from "../src/collect-static.js";
import { renderSummary } from "../scripts/action-summary.js";
import { commentBody, keyOf, movement, previousScore, upsertComment } from "../scripts/pr-comment.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Fake keys are assembled here, not stored in the fixture, so the repo never
// holds a string that secret scanners (and GitHub push protection) mistake
// for a real credential.
const FAKE_SECRETS = {
  __FAKE_STRIPE_SECRET__: "sk_" + "live_" + "51HabcDEF1234567890ghiJKL",
  __FAKE_GOOGLE_KEY__: "AI" + "za" + "SyA1234567890abcdefghijklmnopqrstuvw",
};
const plant = (s) => s.replace(/__FAKE_[A-Z_]+__/g, (m) => FAKE_SECRETS[m] || m);
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");
const html = plant(fixture("leaky.html"));

const input = collectStatic(html, "file:///leaky.html");
// The static collector never fetches external scripts, so hand the engine a
// same-origin bundle directly, as the live collector and the extension would.
input.bundles = [{ url: "file:///_next/static/chunks/checkout.js", body: fixture("readable-bundle.js") }];
const result = analyse(input);
const score = scoreOf(result.findings);
const band = bandOf(score);

const expected = [
  ["source maps", /source maps/i],
  ["secrets", /secret/i],
  ["client-side logic", /scoring or business logic/i],
  ["hydration payload", /hydration/i],
  ["readable bundle", /shipped code is readable/i],
  ["API endpoints", /api endpoints/i],
  ["hidden fields", /hidden fields/i],
  ["AI system prompt", /system prompt/i],
  ["direct AI API call", /ai model api/i],
  ["stack fingerprint", /fingerprint/i],
];

let failed = 0;
console.log(`\nLeak Score: ${score}/100  (${band.label})`);
console.log("Checks:");
for (const [name, re] of expected) {
  const hit = result.findings.some((f) => re.test(f.title));
  console.log(`  ${hit ? "PASS" : "FAIL"}  ${name}`);
  if (!hit) failed++;
}

if (score <= 0) { console.log("  FAIL  score should be above zero"); failed++; }

const check = (ok, name) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; };

console.log("Safety:");
const report = JSON.stringify(result);
check(Object.values(FAKE_SECRETS).every((v) => !report.includes(v.slice(0, 12))),
  "secret values are redacted in the report");

const clean = analyse(collectStatic(fixture("clean.html"), "file:///clean.html"));
check(scoreOf(clean.findings) === 0, "clean fixture scores 0");

console.log("Static file scans:");
const demoDir = path.join(here, "..", "site", "demo");
const demo = analyse(collectStatic(fs.readFileSync(path.join(demoDir, "index.html"), "utf8"),
  "file:///demo/index.html", { root: demoDir }));
const demoMissing = expected.filter(([, re]) => !demo.findings.some((f) => re.test(f.title))).map(([n]) => n);
check(demoMissing.length === 0, `demo site fires all ${expected.length} checks` + (demoMissing.length ? ` (missing: ${demoMissing.join(", ")})` : ""));
check(bandOf(scoreOf(demo.findings)).label === "Gushing", "demo site scores Gushing");

const escape = collectStatic(
  '<script src="../run.js"></script><script src="/../../package.json"></script>' +
  '<script src="%2e%2e/run.js"></script><script src="https://example.invalid/x.js"></script>' +
  '<script src="//example.invalid/y.js"></script>',
  "file:///fixtures/index.html", { root: path.join(here, "fixtures") });
check(escape.bundles.length === 0, "never reads scripts outside the scanned folder or over the network");

console.log("One engine:");
const read = (...p) => fs.readFileSync(path.join(here, "..", ...p), "utf8");
const RULE_COPY = /sk_live_|sourceMappingURL=|function analyse|secretRules|logicTerms/;
for (const [name, file] of [["extension popup", "extension/popup.js"], ["landing page", "site/landing.js"]]) {
  const src = read(file);
  check(/from "\.\/lib\/checks\.js"/.test(src) && /from "\.\/lib\/collect-page\.js"/.test(src),
    `${name} imports the shared engine and collector`);
  check(!RULE_COPY.test(src), `${name} holds no copy of the rules`);
}
check(!RULE_COPY.test(read("src/collect-page.js")), "page collector gathers evidence only");

console.log("Pull request comment:");
// A fake GitHub API: records calls and serves a list of existing comments.
function fakeGitHub(existing, failWith) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ method: opts.method, path: url.replace("https://api.test", ""), body: opts.body && JSON.parse(opts.body).body });
    if (failWith) return { ok: false, status: failWith };
    if (opts.method === "GET") return { ok: true, status: 200, json: async () => existing };
    return { ok: true, status: 201, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}
const prReport = { ...result, score, band: band.label, mode: "static (jsdom)" };
const key = keyOf("dist/index.html");
const render = (prev) => commentBody({ key, score, sha: "abcdef123", summary: renderSummary({ report: prReport, exitCode: 1, failOn: "40", headline: movement(prev, score) }) });
const base = { api: "https://api.test", repo: "o/r", pr: 7, token: "t", key, render };

let gh = fakeGitHub([]);
let res = await upsertComment({ ...base, fetchImpl: gh.fetchImpl });
const posted = gh.calls.find((c) => c.method === "POST");
check(res.ok && res.action === "created" && posted && posted.path === "/repos/o/r/issues/7/comments", "creates one comment when there is none");
check(previousScore(posted.body, key) === score && /Failed\./.test(posted.body), "comment carries the score marker and the verdict");
check(!Object.values(FAKE_SECRETS).some((v) => posted.body.includes(v.slice(0, 12))), "comment never contains secret values");

const old = { id: 99, user: { type: "Bot" }, body: commentBody({ key, score: 12, summary: "old" }) };
gh = fakeGitHub([{ id: 5, user: { type: "User" }, body: "nice PR" }, old]);
res = await upsertComment({ ...base, fetchImpl: gh.fetchImpl });
const patched = gh.calls.find((c) => c.method === "PATCH");
check(res.action === "updated" && patched && patched.path === "/repos/o/r/issues/comments/99" && /Up from 12/.test(patched.body),
  "updates its own comment in place and says how the score moved");

const other = { id: 42, user: { type: "Bot" }, body: commentBody({ key: keyOf("another/target.html"), score: 5, summary: "x" }) };
const pasted = { id: 43, user: { type: "User" }, body: commentBody({ key, score: 3, summary: "pasted by a human" }) };
gh = fakeGitHub([other, pasted]);
res = await upsertComment({ ...base, fetchImpl: gh.fetchImpl });
check(res.action === "created" && !gh.calls.some((c) => c.method === "PATCH"),
  "leaves other targets' comments and human comments alone");

gh = fakeGitHub([], 403);
res = await upsertComment({ ...base, fetchImpl: gh.fetchImpl });
check(res.ok === false && res.error.status === 403, "a read-only token (forked pull request) fails softly");

console.log(failed === 0
  ? `\nAll ${expected.length} checks fired and every guard passed. Engine is working.\n`
  : `\n${failed} test(s) failed.\n`);

process.exit(failed === 0 ? 0 : 1);
