/* Browser-free test: run the shared engine over the leaky and clean fixtures,
 * check secrets are redacted, and check the extension uses the shared engine
 * rather than a copy of the rules. No Playwright, no network. `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyse, scoreOf, bandOf } from "../src/checks.js";
import { collectStatic } from "../src/collect-static.js";

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
check(demoMissing.length === 0, "demo site fires all eight checks" + (demoMissing.length ? ` (missing: ${demoMissing.join(", ")})` : ""));
check(bandOf(scoreOf(demo.findings)).label === "Gushing", "demo site scores Gushing");

const escape = collectStatic(
  '<script src="../run.js"></script><script src="/../../package.json"></script>' +
  '<script src="%2e%2e/run.js"></script><script src="https://example.invalid/x.js"></script>' +
  '<script src="//example.invalid/y.js"></script>',
  "file:///fixtures/index.html", { root: path.join(here, "fixtures") });
check(escape.bundles.length === 0, "never reads scripts outside the scanned folder or over the network");

console.log("Extension:");
const popup = fs.readFileSync(path.join(here, "..", "extension", "popup.js"), "utf8");
check(/from "\.\/lib\/checks\.js"/.test(popup), "popup imports the shared engine");
check(!/sk_live_|sourceMappingURL=|function analyse/.test(popup), "popup holds no copy of the rules");

console.log(failed === 0
  ? `\nAll ${expected.length} checks fired and every guard passed. Engine is working.\n`
  : `\n${failed} test(s) failed.\n`);

process.exit(failed === 0 ? 0 : 1);
