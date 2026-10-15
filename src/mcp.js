/* Diarea as an MCP server, so coding agents (Claude Code, Cursor and friends)
 * can scan for leaks themselves: `diarea mcp`, registered by `diarea setup`.
 *
 * Plain JSON-RPC 2.0 over stdio, newline-delimited, no SDK dependency.
 * stdout carries protocol messages only; anything else goes to stderr.
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { SEV_ORDER, basisLine } from "./checks.js";
import { scan, isUrl } from "./scan.js";
import { makeGuard } from "./guard.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LABEL = { crit: "CRITICAL", warn: "EXPOSED", info: "MINOR" };

export const INSTRUCTIONS = `Diarea finds what a website's frontend leaks to anyone with DevTools: secrets, source maps, API maps, AI system prompts, hydration data and more, scored 0 to 100 from Sealed to Gushing. It is defensive: only scan sites and builds the user owns or is authorised to test.

Workflow:
1. Pick the target. Prefer the project's build folder (for example dist after a build) or its deployed URL. Confirm a URL belongs to the user before scanning it. Files must be inside this project. Addresses on this machine or a private network (localhost, 192.168.x.x) are refused unless the user started the server with --allow-private, so scan the build output instead of a dev server. For pages behind a login, the user can save one with \`diarea login <url>\` and you pass that file as storage_state.
2. Call diarea_scan. Each finding has a severity, evidence and a "flush it" fix.
3. Fix the causes in the code, most severe first: move secrets and business logic to the server, turn off production source maps, trim hydration payloads, minify. If a real secret was exposed, tell the user to rotate it; never print secret values (Diarea only reports a prefix and a length).
4. Rebuild and scan again to show the score went down. Report the before and after scores.`;

export const TOOLS = [
  {
    name: "diarea_scan",
    title: "Scan for frontend leaks",
    description: "Scan a web page for what its frontend leaks (exposed keys, source maps, API endpoint maps, AI system prompts, hydration payloads, readable bundles, hidden fields). Give an https:// URL for a live scan in a headless browser, or a path inside the project to a built HTML file or build folder for a static scan that also reads its scripts. Private and local network addresses are refused unless the user allowed them. Returns a 0 to 100 Leak Score, its band and each finding with evidence and a fix. Secret values are redacted. Only scan sites the user owns or is authorised to test.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "An https:// URL, or a path to an HTML file or build folder (relative to the project root), for example dist/index.html or dist." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "Navigation timeout for live scans. Default 30000." },
        storage_state: { type: "string", description: "Live scans only: a saved login made by `diarea login <url>` (a path inside the project, for example .diarea/login.json), to scan pages behind a login." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { title: "Scan for frontend leaks", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/** Markdown an agent can act on, plus the full report as JSON. */
export function renderReport(r) {
  const findings = r.findings.slice().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
  const out = [`Diarea Leak Score for ${r.host || r.url}: ${r.score}/100, ${r.band} (${r.mode}).`, ""];
  out.push(basisLine(findings), "");
  if (!findings.length) out.push("Nothing obvious leaking. Keep the real defences server-side.");
  findings.forEach((f, i) => {
    out.push(`${i + 1}. [${LABEL[f.sev] || f.sev}${f.basis ? ", " + f.basis : ""}] ${f.title}`);
    out.push(`   What a reader sees: ${f.detail}`);
    if (f.evidence && f.evidence.length) out.push(`   Evidence: ${f.evidence.slice(0, 5).join("; ")}`);
    out.push(`   Fix: ${f.fix}`);
  });
  out.push("", "Full report (JSON):", "```json", JSON.stringify({ url: r.url, score: r.score, band: r.band, mode: r.mode, findings }, null, 2), "```");
  return out.join("\n");
}

// True when file (once symlinks are resolved) is inside root.
function insideRoot(file, root) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rel = path.relative(real(root), real(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function callTool(name, args = {}, { cwd, allowPrivate }) {
  if (name !== "diarea_scan") throw rpcError(-32602, `Unknown tool: ${name}`);
  const target = typeof args.target === "string" ? args.target.trim() : "";
  if (!target) return toolError("Give a target: an https:// URL or a path to an HTML file.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !isUrl(target)) return toolError("Only http(s) URLs and local HTML files can be scanned.");
  // stdin is this server's own protocol channel, never a page.
  if (target === "-") return toolError("Give a URL or a file path. Reading from stdin is not available to agents.");
  if (!isUrl(target) && !insideRoot(path.resolve(cwd, target), cwd)) {
    return toolError(`${target} is outside this project. Diarea's agent server only scans files inside the project it was started in.`);
  }
  let storageState;
  if (args.storage_state !== undefined) {
    if (typeof args.storage_state !== "string" || !args.storage_state.trim()) return toolError("storage_state must be a file path.");
    if (!isUrl(target)) return toolError("storage_state only applies to live scans of a URL.");
    storageState = args.storage_state.trim();
    if (!insideRoot(path.resolve(cwd, storageState), cwd)) return toolError(`${storageState} is outside this project.`);
  }
  const timeout = Number.isInteger(args.timeout_ms) ? Math.min(Math.max(args.timeout_ms, 1000), 120000) : 30000;
  try {
    const guard = makeGuard({ allowPrivate });
    const report = await scan(target, { timeout, cwd, storageState, guard });
    return { content: [{ type: "text", text: renderReport(report) }], isError: false };
  } catch (err) {
    return toolError(`Could not scan ${target}: ${err.message}`);
  }
}

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });
const rpcError = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });

/** Handle one JSON-RPC message; returns the response object, or null for notifications. */
export async function handle(msg, { version, cwd = process.cwd(), allowPrivate = false } = {}) {
  const isRequest = msg && typeof msg === "object" && "id" in msg && msg.id !== null;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isRequest ? { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Invalid request" } } : null;
  }
  if (!isRequest) return null; // notifications (initialized, cancelled, ...) need no reply
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params && msg.params.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "diarea", title: "Diarea 💩", version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const p = msg.params || {};
        return reply(await callTool(p.name, p.arguments, { cwd, allowPrivate }));
      }
      default: throw rpcError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    return { jsonrpc: "2.0", id: msg.id, error: err.rpc || { code: -32603, message: err.message } };
  }
}

/** Run the server on stdin/stdout until stdin closes. */
export function serve({ version, allowPrivate = false }) {
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const pending = new Set();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const batch = Array.isArray(msg);
    const job = Promise.all((batch ? msg : [msg]).map((m) => handle(m, { version, allowPrivate })))
      .then((res) => {
        const replies = res.filter(Boolean);
        if (replies.length) send(batch ? replies : replies[0]);
      })
      .finally(() => pending.delete(job));
    pending.add(job);
  });
  rl.on("close", async () => { await Promise.all(pending); process.exit(0); });
  process.stderr.write(`diarea ${version} MCP server ready on stdio` +
    (allowPrivate ? " (private network addresses allowed)" : "") + "\n");
}
