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
import { handle } from "../src/mcp.js";
import { setup, SERVER } from "../src/setup.js";
import os from "node:os";

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

// Regression from the first real scan (revoluaition.com): words ending in
// "sk-" (task-, mask-, risk-) were reported as OpenAI keys.
const secretTitles = (js) => analyse({ inlineScripts: [js] }).findings.filter((f) => /secret/.test(f.title));
check(secretTitles('const a = "task-item-description-text-and-more"; const b = "mask-image-linear-gradient-to-bottom"; ' +
  'const c = "risk-indicator-badge-large-and-loud"; const d = "desk_live_ABCdef1234567890ABCD";').length === 0,
  "ordinary words are not mistaken for keys");
const realShaped = "sk-" + "Ab3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7sU9wY1aC";
check(secretTitles(`const k = "${realShaped}";`).length === 1, "a real-shaped key is still caught");

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
check((await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, {})) === null, "notifications get no reply");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diarea-setup-"));
fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
setup(["--project"], { cwd: tmp, log: () => {} });
const written = JSON.parse(fs.readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
check(written.mcpServers.other && JSON.stringify(written.mcpServers.diarea) === JSON.stringify(SERVER), "setup --project merges into an existing .mcp.json");
const calls = [];
setup([], { log: () => {}, run: (cmd, args) => { calls.push(args.join(" ")); return { status: 0, stdout: "", stderr: "" }; } });
check(calls[1] === "mcp add --scope user diarea -- npx -y diarea@latest mcp", "setup registers with Claude Code at user scope");
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failed === 0
  ? `\nAll ${expected.length} checks fired and every guard passed. Engine is working.\n`
  : `\n${failed} test(s) failed.\n`);

process.exit(failed === 0 ? 0 : 1);
