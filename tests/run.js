/* Browser-free test: run the shared engine over the leaky fixture and assert
 * every check fires. No Playwright, no network. `npm test`.
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
const html = plant(fs.readFileSync(path.join(here, "fixtures", "leaky.html"), "utf8"));

const input = collectStatic(html, "file:///leaky.html");
const result = analyse(input);
const score = scoreOf(result.findings);
const band = bandOf(score);

const expected = [
  ["source maps", /source maps/i],
  ["secrets", /secret/i],
  ["client-side logic", /scoring or business logic/i],
  ["hydration payload", /hydration/i],
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

console.log(failed === 0
  ? `\nAll ${expected.length} checks fired. Engine is working.\n`
  : `\n${failed} check(s) did not fire.\n`);

process.exit(failed === 0 ? 0 : 1);
