/* Copies the shared engine into the extension so the popup can import it.
 * src/checks.js stays the only place rules are written; extension/lib/ is
 * generated and ignored by git. `npm run build:extension`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "checks.js");
const to = path.join(root, "extension", "lib", "checks.js");

fs.mkdirSync(path.dirname(to), { recursive: true });
fs.writeFileSync(to,
  "/* Generated from src/checks.js by scripts/build-extension.js. Do not edit. */\n" +
  fs.readFileSync(from, "utf8"));
console.log("Built extension/lib/checks.js from src/checks.js");
