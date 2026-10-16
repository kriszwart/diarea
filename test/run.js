/* Browser-free test: run the shared engine over the leaky and clean fixtures,
 * check secrets are redacted, and check the extension uses the shared engine
 * rather than a copy of the rules. No Playwright, no network. `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyse, scoreOf, bandOf, basisLine } from "../src/checks.js";
import { collectStatic } from "../src/collect-static.js";
import { renderSummary } from "../scripts/action-summary.js";
import { commentBody, keyOf, movement, previousScore, upsertComment } from "../scripts/pr-comment.js";
import { handle } from "../src/mcp.js";
import { toSarif } from "../src/sarif.js";
import { setup, SERVER } from "../src/setup.js";
import { classifyIp, makeGuard } from "../src/guard.js";
import { saveLogin } from "../src/login.js";
import { keyPaths } from "../src/shape.js";
import { baseDomain, crossOriginScripts, isSourceMap, mapUrlFor } from "../src/cross-origin.js";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { scan } from "../src/scan.js";
import { watchTests } from "./watch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root0 = () => path.join(here, "..");
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
  ["sensitive fields", /sensitive field/i],
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

// Regression from the first real scan (revoluaition.com): words ending in
// "sk-" (task-, mask-, risk-) were reported as OpenAI keys.
const secretTitles = (js) => analyse({ inlineScripts: [js] }).findings.filter((f) => /secret/.test(f.title));
check(secretTitles('const a = "task-item-description-text-and-more"; const b = "mask-image-linear-gradient-to-bottom"; ' +
  'const c = "risk-indicator-badge-large-and-loud"; const d = "desk_live_ABCdef1234567890ABCD";').length === 0,
  "ordinary words are not mistaken for keys");
const findingsForSecrets = (js) => analyse({ inlineScripts: [js] }).findings.filter((f) => f.id === "secrets");
const realShaped = "sk-" + "Ab3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7sU9wY1aC";
check(secretTitles(`const k = "${realShaped}";`).length === 1, "a real-shaped key is still caught");

// More providers. Every fake is assembled here from a filler, never stored
// whole, and each must be caught once, under its own name, and redacted.
const fill = (n) => "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7sU9wY1".repeat(4).slice(0, n);
const hexFill = (n) => "0123456789abcdef".repeat(4).slice(0, n);
const PROVIDERS = [
  ["Anthropic API key", "sk-" + "ant-" + "api03-" + fill(93) + "AA"],
  ["Stripe restricted key", "rk_" + "live_" + fill(24)],
  ["GitHub token", "github_" + "pat_" + fill(22) + "_" + fill(59)],
  ["Hugging Face token", "hf" + "_" + fill(34)],
  ["Replicate API token", "r8" + "_" + fill(37)],
  ["SendGrid API key", "S" + "G." + fill(22) + "." + fill(43)],
  ["Twilio API key SID", "S" + "K" + hexFill(32)],
];
for (const [label, value] of PROVIDERS) {
  const found = findingsForSecrets(`const k = "${value}";`);
  const ev = found.length === 1 ? found[0].evidence : [];
  check(ev.length === 1 && ev[0].startsWith(label + ":") && !JSON.stringify(found).includes(value.slice(0, 12)),
    `${label} is caught once and redacted`);
}
const pemBody = fill(64);
const pem = findingsForSecrets(`const k = "-----BEGIN PRIVATE KEY-----\\n${pemBody}\\n-----END PRIVATE KEY-----";`);
check(pem.length === 1 && pem[0].sev === "crit" && pem[0].evidence[0] === "Private key (PEM block): -----BEGIN PRIVATE KEY-----" &&
  !JSON.stringify(pem).includes(pemBody.slice(0, 8)), "a PEM private key is critical, and none of the key is shown");
check(findingsForSecrets('if (s.indexOf("-----BEGIN RSA PRIVATE KEY-----") === 0) parse(s);').length === 0,
  "a PEM header on its own (a crypto library) is not a key");

// Regression from the second real scan: a public anon JWT, a property name
// ("access_token") and minified code were all reported as secrets.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtWith = (claims) => "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + b64url(claims) + ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const findingsFor = (js) => analyse({ inlineScripts: [js] }).findings;
const anon = findingsFor(`const k = "${jwtWith({ iss: "supabase", role: "anon" })}";`);
check(anon.length === 1 && anon[0].sev === "info" && /anon key/.test(anon[0].title) && !anon[0].evidence.join("").includes("supabase"),
  "a public anon JWT is a minor note, and its claims are not printed");
const service = findingsFor(`const k = "${jwtWith({ role: "service_role" })}";`);
check(service.length === 1 && service[0].sev === "crit" && /Service-role/.test(service[0].evidence[0]),
  "a service-role JWT is critical");
check(secretTitles('a.token = "access_token"; b.token = "",g)).x = 1; d = { secret: "client_secret" };').length === 0,
  "property names and minified code are not secrets");
check(secretTitles('const config = { password: "hunter2-but-longer" };').length === 1,
  "a real hard-coded password is still caught");

// Third pass on revoluaition.com: 38 "API endpoints" were mostly page links,
// XML namespaces, CDN scripts, and bundles the scanner itself had fetched.
const endpointFinding = (input) => analyse(input).findings.find((f) => /api endpoints/i.test(f.title));
const pageLinks = ["", "pricing", "about", "terms", "privacy", "blog", "docs", "start"]
  .map((p) => `"https://app.example.test/${p}"`).join(",");
check(!endpointFinding({ inlineScripts: [`const links=[${pageLinks}]; const ns="http://www.w3.org/2000/svg";` +
  ` const e="https://react.dev/errors/"; s.src="https://cdn.example.test/lib/v2/lib.js"; img="https://app.example.test/og.svg";`],
  networkUrls: ["https://app.example.test/assets/index-abc.js", "https://app.example.test/assets/index-abc.js.map"] }),
  "page links, namespaces, CDN scripts and static files are not API endpoints");
const hashed = (n) => "https://app.example.test/_serverFn/" + String(n).repeat(64);
const grouped = endpointFinding({ inlineScripts: ['fetch("/api/broadcast"); fetch("https://api.example.test/v1/users");'],
  networkUrls: [1, 2, 3, 4, 5].map(hashed) });
check(grouped && /^7 API endpoints/.test(grouped.title) && grouped.evidence.some((e) => /_serverFn\/\* \(5\)$/.test(e)) &&
  grouped.evidence.some((e) => e.includes("/api/broadcast")) && grouped.evidence.some((e) => e.includes("api.example.test/v1/users")),
  "real API calls still count, and hashed server functions are grouped");

// Library corpus (react-dom, vue, jquery, lodash, three, clerk, firebase...):
// minified vendor code tripped the readable-code and business-logic checks.
const titlesOf = (body) => analyse({ bundles: [{ url: "https://app.example.test/assets/vendor.js", body }] }).findings.map((f) => f.title);
const filler = (n) => Array.from({ length: n }, (_, k) => `function f${k}(a,b){return a*b+${k}}`).join(";");
const minified = "/*! lib v1.2.3 | (c) Someone | MIT */\n/*\n Modernizr 3.0.0pre (Custom Build) | MIT\n*/\n" +
  "/* global __DEVTOOLS_HOOK__ */" + filler(60) + ';var h={Accept:"application/json, text/plain, */*"};' +
  'var w="{\\n/* [wrapped with "+t+"] */\\n";var p=/*#__PURE__*/x();' + filler(60);
check(!titlesOf(minified).some((t) => /readable/i.test(t)), "licence banners, lint directives and comment-like strings are not dev notes");
check(titlesOf(minified.replace("var p=", "/* recalculates the discount before the coupon is applied */var p=")).some((t) => /readable/i.test(t)),
  "a real developer comment in a minified bundle is still caught");
const spread = ["morphTargetWeights", "alphaThreshold", "fontWeight", "drawingFormula", "scoringTable", "lightCoefficient"]
  .map((t) => `var ${t}=0.5;` + filler(15)).join(";");
check(!titlesOf(spread).some((t) => /business logic/i.test(t)), "logic words spread through a library are not business logic");

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

console.log("Build folders:");
// A Vite-style dist/: index.html names only the entry chunk and a preload.
// The lazy route and the "hidden" source map are deployed all the same.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "diarea-dist-"));
fs.mkdirSync(path.join(dist, "assets"));
fs.writeFileSync(path.join(dist, "index.html"),
  '<!doctype html><html><head><script type="module" src="/assets/index-a1.js"></script>' +
  '<link rel="modulepreload" href="/assets/vendor-b2.js"></head><body><div id="app"></div></body></html>');
fs.writeFileSync(path.join(dist, "assets", "index-a1.js"), "import('./admin-c3.js');");
fs.writeFileSync(path.join(dist, "assets", "vendor-b2.js"), "export const v=1;");
fs.writeFileSync(path.join(dist, "assets", "admin-c3.js"), 'export const cfg = { password: "hunter2-but-longer" };');
fs.writeFileSync(path.join(dist, "assets", "admin-c3.js.map"), "{}");
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "diarea-outside-"));
fs.writeFileSync(path.join(outside, "secret.js"), 'export const k = { token: "should-never-be-read-1" };');
try { fs.symlinkSync(outside, path.join(dist, "linked")); } catch { /* no symlinks here; the guard still holds */ }

const page = collectStatic(fs.readFileSync(path.join(dist, "index.html"), "utf8"), "file:///index.html", { root: dist });
check(page.bundles.some((b) => b.url === "/assets/vendor-b2.js") && !page.bundles.some((b) => /admin/.test(b.url)),
  "a page scan reads module preloads, and only what the page names");
const whole = await scan(path.relative(root0(), dist) || dist, { cwd: root0() });
const ids = whole.findings.map((f) => f.id);
check(ids.includes("secrets") && ids.includes("source-maps"), "a folder scan reads lazy chunks and finds hidden source maps");
check(whole.findings.find((f) => f.id === "source-maps").evidence.includes("/assets/admin-c3.js.map"),
  "the map file is named in the evidence");
check(!JSON.stringify(whole).includes("should-never-be-read"), "a folder scan never follows symlinks out of the folder");
fs.rmSync(dist, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

const inline = analyse({ inlineScripts: ["x()//# sourceMappingURL=data:application/json;base64," + "A".repeat(500)] })
  .findings.find((f) => f.id === "source-maps");
check(inline && inline.evidence[0] === "inline source map (data: URI)", "an inline source map is named, not dumped");

console.log("CLI:");
const cli = (...args) => spawnSync(process.execPath, [path.join(root0(), "bin/diarea.js"), ...args], { encoding: "utf8", cwd: root0() });
check(cli("scan", "site/demo", "--jsn").status === 2, "an unknown option is an error, not a target");
check(cli("scan", "site/demo", "--fail-on", "abc").status === 2, "a non-numeric --fail-on is an error, not a silent pass");
check(cli("scan", "site/demo", "--fail-on").status === 2, "--fail-on without a value is an error");
check(cli("scan", "site/demo", "--fail-on", "40").status === 1, "--fail-on still gates");
check(cli("scan", "test/fixtures/clean.html", "--fail-on", "1").status === 0, "a clean page passes the gate");

const read = (...p) => fs.readFileSync(path.join(here, "..", ...p), "utf8");
console.log("The site's own CDN:");
check(baseDomain("cdn.example.com") === "example.com" && baseDomain("static.shop.example.co.uk") === "example.co.uk" &&
  baseDomain("assets.example.com.my") === "example.com.my" && baseDomain("localhost") === "localhost", "registrable domains, near enough");
const xo = crossOriginScripts("https://www.example.com/app", [
  "/assets/same.js", "https://www.example.com/x.js",
  "https://cdn.example.com/a.js", "https://cdn.example.com/b.js?v=2", "https://d1234.cloudfront.net/c.js",
  "https://www.googletagmanager.com/gtm.js", "https://js.stripe.com/v3", "https://cdn.jsdelivr.net/npm/lib.js",
]);
check(xo.related.map((g) => g.origin).join() === "https://cdn.example.com,https://d1234.cloudfront.net" &&
  xo.related[0].urls.length === 2, "the site's own CDN and hosting CDNs are offered");
check(xo.other.length === 3 && !xo.related.some((g) => /stripe|googletagmanager|jsdelivr/.test(g.origin)),
  "third-party scripts are never offered");
check(mapUrlFor("https://cdn.example.com/app.js?v=3#x") === "https://cdn.example.com/app.js.map" &&
  mapUrlFor("https://cdn.example.com/a/app.js", "/maps/app.map") === "https://cdn.example.com/maps/app.map",
  "map URLs drop query strings and follow the SourceMap header");
check(isSourceMap('{"version":3,"sources":["a.ts"],"mappings":"AA"}') && isSourceMap(")]}'\n{\"version\":3,\"sources\":[]}") &&
  !isSourceMap("<!doctype html><html>app shell</html>") && !isSourceMap(""), "a single-page app's HTML fallback is not a source map");
const manifest = JSON.parse(read("extension/manifest.json"));
check(manifest.permissions.join() === "activeTab,scripting" && !manifest.host_permissions &&
  JSON.stringify(manifest.optional_host_permissions) === '["https://*/*","http://*/*"]',
  "the extension asks for no sites up front; CDN access is optional and per site");

console.log("One engine:");
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

console.log("SARIF:");
check(result.findings.every((f) => /^[a-z]+(-[a-z]+)*$/.test(f.id)) && new Set(result.findings.map((f) => f.id)).size === result.findings.length,
  "every finding has its own stable id");
const sarif = toSarif({ ...result, score, band: band.label, mode: "static (jsdom)", host: "dist/index.html" }, { version: "test", target: "dist/index.html" });
const sarifRun = sarif.runs[0];
check(sarif.version === "2.1.0" && sarifRun.tool.driver.name === "Diarea" && sarifRun.results.length === result.findings.length,
  "SARIF 2.1.0 with one result per finding");
check(sarifRun.results.every((r) => sarifRun.tool.driver.rules.some((rule) => rule.id === r.ruleId)) &&
  sarifRun.results.some((r) => r.level === "error") && sarifRun.results.every((r) => ["error", "warning", "note"].includes(r.level)),
  "SARIF results point at rules and map severities to levels");
check(sarifRun.results.every((r) => r.locations[0].physicalLocation.artifactLocation.uri === "dist/index.html"),
  "SARIF results are located on the scanned file");
check(!Object.values(FAKE_SECRETS).some((v) => JSON.stringify(sarif).includes(v.slice(0, 12))), "SARIF output stays redacted");

console.log("MCP server and setup:");
const root = path.join(here, "..");
const rpc = (id, method, params) => handle({ jsonrpc: "2.0", id, method, params }, { version: "test", cwd: root });
const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
check(init.result.protocolVersion === "2025-06-18" && init.result.capabilities.tools && /defensive/i.test(init.result.instructions),
  "initialize negotiates the version and explains the workflow");
const tools = (await rpc(2, "tools/list")).result.tools;
check(tools.length === 1 && tools[0].name === "diarea_scan" && tools[0].annotations.readOnlyHint === true, "lists one read-only scan tool");
const call = (await rpc(3, "tools/call", { name: "diarea_scan", arguments: { target: "site/demo/index.html" } })).result;
check(!call.isError && /100\/100, Gushing/.test(call.content[0].text) && !call.content[0].text.includes(root),
  "scans for an agent, without leaking local folder names");
const demoKey = fs.readFileSync(path.join(root, "site/demo/app.js"), "utf8").match(/apiKey: "([^"]+)"/)[1];
check(/\/demo\/|apikey/i.test(call.content[0].text) && !call.content[0].text.includes(demoKey),
  "agent reports carry redacted evidence only");
const nope = (await rpc(5, "tools/call", { name: "diarea_scan", arguments: { target: "file:///etc/passwd" } })).result;
check(nope.isError === true, "refuses anything but http(s) URLs and local HTML files");
const notHtml = (await rpc(6, "tools/call", { name: "diarea_scan", arguments: { target: "package.json" } })).result;
check(notHtml.isError === true && /not an HTML page/.test(notHtml.content[0].text),
  "a file that is not HTML is an error, not a clean score");
const missing = (await rpc(7, "tools/call", { name: "diarea_scan", arguments: { target: "nope/index.html" } })).result;
check(missing.isError === true && !missing.content[0].text.includes(root), "errors do not leak local folder names");
const folder = (await rpc(8, "tools/call", { name: "diarea_scan", arguments: { target: "site/demo" } })).result;
check(!folder.isError && /100\/100, Gushing/.test(folder.content[0].text), "a build folder scans its index.html");
const noIndex = (await rpc(9, "tools/call", { name: "diarea_scan", arguments: { target: "test" } })).result;
check(noIndex.isError === true && /no index\.html/.test(noIndex.content[0].text), "a folder without index.html is an error");
check((await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, {})) === null, "notifications get no reply");

console.log("Agent guard rails:");
const toolCall = async (args, opts = {}) => (await handle({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "diarea_scan", arguments: args } },
  { version: "test", cwd: root, ...opts })).result;
const outsideFile = path.join(os.tmpdir(), "diarea-outside-" + process.pid + ".html");
fs.writeFileSync(outsideFile, "<html><body>outside</body></html>");
let refused = await toolCall({ target: outsideFile });
check(refused.isError && /outside this project/.test(refused.content[0].text) && !refused.content[0].text.includes(root),
  "a file outside the project is refused");
check((await toolCall({ target: "../../../../../../etc/hosts" })).isError, "a path climbing out of the project is refused");
const linkInside = path.join(root, "test", "fixtures", ".link-out-" + process.pid + ".html");
let linked = false;
try { fs.symlinkSync(outsideFile, linkInside); linked = true; } catch {}
if (linked) {
  refused = await toolCall({ target: path.relative(root, linkInside) });
  check(refused.isError && /outside this project/.test(refused.content[0].text), "a symlink out of the project is refused");
  fs.rmSync(linkInside, { force: true });
}
fs.rmSync(outsideFile, { force: true });
check((await toolCall({ target: "-" })).isError, "stdin (the protocol channel) is never read as a page");
for (const url of ["http://127.0.0.1:3000/", "http://localhost/", "http://192.168.1.10/", "http://[::1]/", "http://2130706433/"]) {
  refused = await toolCall({ target: url });
  check(refused.isError && /private network/.test(refused.content[0].text) && /--allow-private/.test(refused.content[0].text),
    `${url} is refused unless private addresses are allowed`);
}
for (const url of ["http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/", "http://[fd00:ec2::254]/"]) {
  refused = await toolCall({ target: url }, { allowPrivate: true });
  check(refused.isError && /metadata/.test(refused.content[0].text), `${url} is refused even with --allow-private`);
}
refused = await toolCall({ target: "https://example.test/", storage_state: "../../login.json" });
check(refused.isError && /outside this project/.test(refused.content[0].text), "a saved login outside the project is refused");
check((await toolCall({ target: "site/demo", storage_state: "x.json" })).isError, "a saved login only applies to live scans");
check(["10.0.0.1", "172.16.5.4", "100.64.1.1", "fc00::1", "::ffff:10.0.0.1"].every((ip) => classifyIp(ip) === "private") &&
  ["169.254.169.254", "fe80::1", "64:ff9b::a9fe:a9fe"].every((ip) => classifyIp(ip) === "metadata") &&
  ["8.8.8.8", "172.32.0.1", "2606:4700::1111"].every((ip) => classifyIp(ip) === "public"),
  "addresses are sorted into public, private and metadata");
const rebind = makeGuard({ lookup: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }] });
check(await rebind("https://looks-public.test/").then(() => false, (e) => /private network/.test(e.message)),
  "a public name that also resolves to a private address is refused");
const pub = makeGuard({ lookup: async () => [{ address: "93.184.216.34" }] });
check(await pub("https://example.test/app.js").then(() => true, () => false), "a public site is allowed");

console.log("Saved logins:");
const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), "diarea-login-"));
const savedTo = saveLogin(".diarea/login.json", { cookies: [], origins: [] }, { cwd: loginDir });
check((fs.statSync(savedTo).mode & 0o777) === 0o600 || process.platform === "win32", "a saved login is readable by its owner only");
check(fs.readFileSync(path.join(loginDir, ".diarea", ".gitignore"), "utf8").includes("*"), "the .diarea folder keeps itself out of git");
fs.rmSync(loginDir, { recursive: true, force: true });
check(cli("scan", "site/demo", "--storage-state", "x.json").status === 2, "--storage-state on a file scan is an error");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diarea-setup-"));
fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
setup(["--project"], { cwd: tmp, log: () => {} });
const written = JSON.parse(fs.readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
check(written.mcpServers.other && JSON.stringify(written.mcpServers.diarea) === JSON.stringify(SERVER), "setup --project merges into an existing .mcp.json");
const calls = [];
setup([], { log: () => {}, run: (cmd, args) => { calls.push(args.join(" ")); return { status: 0, stdout: "", stderr: "" }; } });
check(calls[1] === "mcp add --scope user diarea -- npx -y diarea@latest mcp", "setup registers with Claude Code at user scope");
calls.length = 0;
setup(["--allow-private"], { log: () => {}, run: (cmd, args) => { calls.push(args.join(" ")); return { status: 0, stdout: "", stderr: "" }; } });
check(calls[1] === "mcp add --scope user diarea -- npx -y diarea@latest mcp --allow-private", "setup --allow-private opts the server in, explicitly");
fs.rmSync(tmp, { recursive: true, force: true });

console.log("Seen, Inferred and Unknown:");
const demoReport = await scan(path.join(root0(), "site", "demo"));
check(demoReport.findings.every((f) => f.basis === "seen" || f.basis === "inferred"), "every finding is Seen or Inferred");
check(/^Seen \d+, Inferred \d+\./.test(basisLine(demoReport.findings)) && /Unknown/.test(basisLine([])), "the report says how much a reader gets");
check(toSarif(demoReport, { version: "0", target: "x" }).runs[0].results.every((r) => r.properties && r.properties.basis), "SARIF results carry the basis");

console.log("Maps by name:");
const apiMap = (input) => analyse(input).findings.find((f) => f.id === "api-map");
const demoMap = demoReport.findings.find((f) => f.id === "api-map");
check(/GraphQL operations/.test(demoMap.title) && demoMap.evidence.some((e) => /mutation GrantCredits/.test(e)), "GraphQL operations are listed by name");
check(demoMap.evidence.some((e) => /^routes: .*\/admin\/users/.test(e)), "admin and internal routes are called out");
check(/tRPC procedure/.test((apiMap({ inlineScripts: ["a.billing.refund.useMutation({});"] }) || {}).title), "tRPC procedures from hooks");
check(/2 tRPC procedures/.test((apiMap({ networkUrls: ["https://x.test/api/trpc/user.me,post.list"] }) || {}).title), "tRPC procedures from batched calls on the wire");
check(/^2 routes/.test((apiMap({ inlineScripts: ['self.__BUILD_MANIFEST={__rewrites:{afterFiles:[]},"/":["a.js"],"/staff/payouts":["b.js"],"/_error":["c.js"],"/posts/[id]":["d.js"]}'] }) || {}).title),
  "routes from a Next.js build manifest, without framework pages");
// SDKs describe API requests as { path, method }; that is not a route table.
check(!apiMap({ inlineScripts: ['c={path:"/client",method:"GET"};d={path:"/admin/x",method:"POST"};'] }), "request descriptors are not routes");

console.log("Storage keys and console output:");
const hidden = (input) => analyse(input).findings.find((f) => f.id === "hidden-fields");
const store = hidden({ inlineScripts: ['localStorage.setItem("auth_token",t);localStorage.getItem("theme");'] });
check(store && store.evidence.includes("localStorage: auth_token") && /HttpOnly/.test(store.fix), "a token in localStorage is flagged by name");
check(!hidden({ storageKeys: ["localStorage: theme", "sessionStorage: scroll"] }), "harmless storage keys are left alone");
check(demoReport.findings.find((f) => f.id === "hidden-fields").evidence.some((e) => /promptplop_session_token/.test(e)), "the demo's session key is found");
const logs = analyse({ consoleLogs: 7 }).findings.find((f) => f.id === "readable-code");
check(logs && logs.sev === "info" && /7 console messages/.test(logs.evidence[0]), "debug logging on load is reported, as a count");
check(!analyse({ consoleLogs: 2 }).findings.length, "a couple of console messages are not");

console.log("Sensitive fields:");
const shaped = keyPaths({ users: [{ email: "a@example.invalid", isAdmin: true }, { email: "b@example.invalid", isAdmin: false }], me: { email: "me@example.invalid" } });
check(shaped.includes("users[].email") && shaped.includes("me.email") && !JSON.stringify(shaped).includes("@example"), "shapes keep key paths and drop every value");
const fieldsOf = (keys) => analyse({ dataShapes: [{ source: "GET /api/x", keys }] }).findings.find((f) => f.id === "sensitive-fields");
check(!fieldsOf(["email", "name", "isAdmin", "permissions", "messages[].role"]), "the viewer's own email and admin flag are fine, and so are chat roles");
check(fieldsOf(["users[].email", "users[].isAdmin"]).sev === "warn", "other people's emails and admin flags are flagged");
check(fieldsOf(["items[0].costPrice", "internal_notes"]).evidence[0] === "GET /api/x: items[0].costPrice, internal_notes", "costs and internal notes are flagged anywhere");
check(fieldsOf(["user.password_hash"]).sev === "crit", "a password hash is critical");
check(demoReport.findings.some((f) => f.id === "sensitive-fields" && /churnRisk/.test(f.evidence.join(" "))), "the demo's boot payload is read by shape");

await watchTests(check);

console.log(failed === 0
  ? `\nAll ${expected.length} checks fired and every guard passed. Engine is working.\n`
  : `\n${failed} test(s) failed.\n`);

process.exit(failed === 0 ? 0 : 1);
