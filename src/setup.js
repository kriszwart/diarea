/* `diarea setup`: register Diarea's MCP server with coding agents.
 *
 *   diarea setup             Claude Code, for you (user scope), via `claude mcp add`
 *   diarea setup --project   write .mcp.json here, so everyone on the project gets it
 *   diarea setup --print     just print the config for other agents
 *   --allow-private          with any of the above: let the agent scan localhost
 *                            and private networks (off by default)
 *
 * It never edits another tool's settings files behind your back: for agents
 * other than Claude Code it prints the snippet to paste.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SERVER = { command: "npx", args: ["-y", "diarea@latest", "mcp"] };
export const serverFor = (allowPrivate) =>
  (allowPrivate ? { ...SERVER, args: [...SERVER.args, "--allow-private"] } : SERVER);
const addArgs = (server) => ["mcp", "add", "--scope", "user", "diarea", "--", server.command, ...server.args];

const snippet = (server) => JSON.stringify({ mcpServers: { diarea: server } }, null, 2);

function printOthers(log, server) {
  log("");
  log("Other agents (Cursor, Windsurf, Claude Desktop and most MCP clients) take this in their MCP config,");
  log("for Cursor ~/.cursor/mcp.json or .cursor/mcp.json in a project:");
  log("");
  log(snippet(server).split("\n").map((l) => "  " + l).join("\n"));
  log("");
  log(`On Windows, use "command": "cmd" with args ${JSON.stringify(["/c", server.command, ...server.args])}.`);
}

function writeProjectConfig(dir, log, server) {
  const file = path.join(dir, ".mcp.json");
  let config = {};
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      log(`  ${file} exists but is not valid JSON, so I left it alone. Add this by hand:`);
      log(snippet(server));
      return 2;
    }
  }
  config.mcpServers = { ...(config.mcpServers || {}), diarea: server };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  log(`  💩 Added Diarea to ${file}.`);
  log("  Claude Code will ask to trust it the next time it opens this project. Commit the file to share it.");
  return 0;
}

export function setup(argv, { log = console.log, cwd = process.cwd(), run = spawnSync } = {}) {
  const allowPrivate = argv.includes("--allow-private");
  const server = serverFor(allowPrivate);
  const ADD_ARGS = addArgs(server);
  log("");
  if (allowPrivate) {
    log("  Private addresses allowed: the agent may scan localhost and your private network, such as a dev server.");
    log("");
  }
  if (argv.includes("--print")) {
    log("Claude Code:");
    log(`  claude ${ADD_ARGS.join(" ")}`);
    printOthers(log, server);
    return 0;
  }
  if (argv.includes("--project")) return writeProjectConfig(cwd, log, server);

  const probe = run("claude", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    log("  Claude Code's `claude` command was not found, so nothing was registered.");
    log("  Install Claude Code and run `diarea setup` again, or add Diarea to your agent by hand:");
    log("");
    log(`  claude ${ADD_ARGS.join(" ")}`);
    printOthers(log, server);
    return 0;
  }
  const res = run("claude", ADD_ARGS, { encoding: "utf8" });
  const said = `${res.stdout || ""}${res.stderr || ""}`;
  if (res.status === 0) {
    log("  💩 Diarea is registered with Claude Code (all your projects).");
  } else if (/already exists/i.test(said)) {
    log("  💩 Diarea was already registered with Claude Code. Nothing to do.");
  } else {
    log(`  Could not register with Claude Code: ${said.trim() || "unknown error"}`);
    log(`  Try it yourself: claude ${ADD_ARGS.join(" ")}`);
    return 2;
  }
  log("");
  log("  Now ask your agent: \"Scan my site for leaks with Diarea and fix what it finds.\"");
  log("  It scans, fixes the causes in your code, and scans again to prove the score dropped.");
  printOthers(log, server);
  return 0;
}
