/* One scan, from target to scored report, shared by the CLI and the MCP
 * server. A URL is loaded in a real browser (live mode); anything else is read
 * as an HTML file, or stdin, without running its scripts (static mode).
 */
import fs from "node:fs";
import path from "node:path";
import { analyse, scoreOf, bandOf } from "./checks.js";
import { collectStatic } from "./collect-static.js";

export const isUrl = (target) => /^https?:\/\//i.test(String(target));

// A JSON or text file would otherwise score a misleading 0 (Sealed).
const looksLikeHtml = (text) => /<(?:!doctype|html|head|body|script|meta|link|div|main)\b/i.test(text);
const notHtml = (name) => new Error(`${name} is not an HTML page. Give a built page such as dist/index.html, or an https:// URL.`);

// Read a page without letting fs errors print absolute local paths.
function readPage(file, target) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`${target} does not exist.`);
    throw new Error(`${target} could not be read (${err.code || "unknown error"}).`);
  }
}

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
      const html = stdin ?? fs.readFileSync(0, "utf8");
      if (!looksLikeHtml(html)) throw notHtml("stdin");
      input = collectStatic(html, "http://localhost/");
      input.host = "stdin";
    } else {
      let file = path.resolve(cwd, target);
      // A build folder (dist/, out/, build/) means its index.html.
      if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) {
        file = path.join(file, "index.html");
        if (!fs.existsSync(file)) throw new Error(`${target} is a folder with no index.html. Give the page to scan, such as ${path.posix.join(target, "page.html")}.`);
      }
      // For a file, also read its local scripts (inside its own folder only).
      // Evidence paths are relative to the project, so reports never show
      // local folder names (yours, or a CI runner's).
      const rel = path.relative(cwd, file).split(path.sep).join("/");
      const base = "file:///" + (rel.startsWith("..") ? path.basename(file) : rel);
      const html = readPage(file, target);
      if (!looksLikeHtml(html)) throw notHtml(target);
      input = collectStatic(html, base, { root: path.dirname(file) });
      input.host = target;
    }
  }
  const result = analyse(input);
  const score = scoreOf(result.findings);
  return { ...result, score, band: bandOf(score).label, mode };
}
