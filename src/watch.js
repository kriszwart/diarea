/* diarea watch: read a server log, find agent-style use of the API, score it
 * like a scan. Reads only; never touches traffic.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { makeParser } from "./watch-parse.js";
import { analyseEvents, WATCH_BANDS } from "./behaviour.js";
import { scoreOf, bandOf } from "./checks.js";

const UNITS = { m: 60e3, h: 3600e3, d: 86400e3 };

/** "30m", "24h", "7d" to milliseconds, or null. */
export function parseDuration(s) {
  const m = /^(\d+)([mhd])$/.exec(String(s ?? ""));
  return m && Number(m[1]) > 0 ? Number(m[1]) * UNITS[m[2]] : null;
}

export async function watchLines(lines, { since = null, allow = null, salt = crypto.randomBytes(16).toString("hex") } = {}) {
  const parser = makeParser({ salt, allow });
  let events = [];
  for await (const line of lines) {
    const e = parser.parseLine(line);
    if (e) events.push(e);
  }
  if (!parser.lines) throw new Error("The log is empty.");
  if (!parser.parsed) throw new Error(`No line could be read as Combined Log Format or JSON lines (${parser.lines} tried).`);
  if (since != null && events.length) {
    // Relative to the newest event, so an old log replays the same way every time.
    const newest = events.reduce((m, e) => (e.t > m ? e.t : m), -Infinity);
    events = events.filter((e) => e.t >= newest - since);
  }
  const { findings, actors, stats } = analyseEvents(events);
  const score = scoreOf(findings);
  const band = bandOf(score);
  return {
    tool: "diarea", mode: "watch", score,
    band: { label: band.label, line: WATCH_BANDS[band.label] },
    stats: { ...stats, lines: parser.lines, skipped: parser.lines - parser.parsed, allowlisted: parser.allowed },
    findings, actors,
  };
}

/** Watch a log file, or stdin when target is "-". Errors name the target as given. */
export async function watch(target, opts = {}) {
  let input = process.stdin;
  if (target !== "-") {
    let st;
    try { st = fs.statSync(target); } catch { throw new Error(`Cannot read ${target}.`); }
    if (!st.isFile()) throw new Error(`${target} is not a file. Give a log file, or - for stdin.`);
    input = fs.createReadStream(target, "utf8");
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  return watchLines(rl, opts);
}
