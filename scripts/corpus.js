/* False-positive check against real libraries:
 *
 *   npm run corpus
 *
 * Downloads the published packages below with `npm pack` into a temporary
 * folder, reads their minified browser bundles as text (nothing is run) and
 * scans each package as if it were a site's vendor code. Library code is not
 * your secret, so anything beyond "source maps" and "not minified" (for
 * packages that ship un-minified ES modules) is a false positive to fix, with
 * a small regression snippet in test/run.js. Needs network; not part of npm test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyse } from "../src/checks.js";

const PACKAGES = [
  "react-dom@18.3.1", "vue@3.5.12", "jquery@3.7.1", "lodash@4.17.21", "three@0.169.0",
  "axios@1.7.7", "socket.io-client@4.8.0", "@supabase/supabase-js@2.45.4", "firebase@10.14.1",
  "@stripe/stripe-js@4.8.0", "@clerk/clerk-js@5.26.0", "posthog-js@1.167.0",
  // Crypto libraries carry PEM headers as format strings, not keys.
  "node-forge@1.3.1", "jose@5.9.6",
];
const EXPECTED = /source maps|not minified/i;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diarea-corpus-"));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

let surprises = 0;
for (const spec of PACKAGES) {
  const out = path.join(dir, spec.replace(/[@/]/g, "_"));
  fs.mkdirSync(out);
  const tgz = execFileSync("npm", ["pack", "-q", spec, "--pack-destination", out], { encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("tar", ["-xzf", path.join(out, tgz), "-C", out]);

  let files = walk(out).filter((f) => /\.(min\.js|umd\.js|browser\.js|prod\.js)$/.test(f) ||
    (/\/dist\/.*\.m?js$/.test(f) && !/node|cjs/.test(f)));
  const minified = files.filter((f) => /\.min\.js$|prod/.test(f));
  if (minified.length) files = minified;
  files = files.filter((f) => fs.statSync(f).size < 3e6).slice(0, 40);
  const bundles = files.map((f) => ({ url: "https://app.example.test/assets/" + path.basename(f), body: fs.readFileSync(f, "utf8") }));

  const findings = analyse({ url: "https://app.example.test/", host: "app.example.test", bundles }).findings;
  // An un-minified file may be flagged for its comments first; that is fair.
  const unminified = (f) => /readable/i.test(f.title) && f.evidence.every((e) => !/\.min\.js|prod/.test(e));
  const unexpected = findings.filter((f) => !EXPECTED.test(f.title + " " + f.evidence.join(" ")) && !unminified(f));
  surprises += unexpected.length;
  console.log(`${unexpected.length ? "SURPRISE" : "ok      "}  ${spec}  (${files.length} files)`);
  for (const f of unexpected) console.log(`          [${f.sev}] ${f.title}: ${f.evidence.slice(0, 4).join(", ")}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(surprises ? `\n${surprises} unexpected finding(s) in library code.` : "\nNo false positives in library code.");
process.exit(surprises ? 1 : 0);
