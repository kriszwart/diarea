/* One scan, from target to scored report, shared by the CLI and the MCP
 * server. A URL is loaded in a real browser (live mode); anything else is read
 * as an HTML file, or stdin, without running its scripts (static mode).
 */
import fs from "node:fs";
import path from "node:path";
import { analyse, scoreOf, bandOf } from "./checks.js";
import { collectStatic } from "./collect-static.js";

export const isUrl = (target) => /^https?:\/\//i.test(String(target));

/**
 * @param {string} target  URL, file path, or "-" for stdin
 * @param {{timeout?: number, forceStatic?: boolean, cwd?: string, stdin?: string}} opts
 * @returns {Promise<{url, host, findings, score, band, mode}>}
 */
export async function scan(target, { timeout = 30000, forceStatic = false, cwd = process.cwd(), stdin } = {}) {
  let input, mode;
  if (isUrl(target) && !forceStatic) {
    mode = "live (playwright)";
    const { collectLive } = await import("./collect-live.js");
    input = await collectLive(target, { timeout });
  } else {
    mode = "static (jsdom)";
    if (target === "-") {
      input = collectStatic(stdin ?? fs.readFileSync(0, "utf8"), "http://localhost/");
      input.host = "stdin";
    } else {
      const file = path.resolve(cwd, target);
      // For a file, also read its local scripts (inside its own folder only).
      // Evidence paths are relative to the project, so reports never show
      // local folder names (yours, or a CI runner's).
      const rel = path.relative(cwd, file).split(path.sep).join("/");
      const base = "file:///" + (rel.startsWith("..") ? path.basename(file) : rel);
      input = collectStatic(fs.readFileSync(file, "utf8"), base, { root: path.dirname(file) });
      input.host = target;
    }
  }
  const result = analyse(input);
  const score = scoreOf(result.findings);
  return { ...result, score, band: bandOf(score).label, mode };
}
