/* Copies the shared engine and in-page collector to where the browser needs
 * them, so src/ stays the only place they are written. Outputs are generated
 * and ignored by git.
 *
 *   node scripts/build.js extension   -> extension/lib/
 *   node scripts/build.js site        -> site/lib/ and site/assets/ (GitHub Pages)
 *   node scripts/build.js             -> both
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = ["src/checks.js", "src/collect-page.js"];
const TARGETS = {
  extension: { "extension/lib": [...ENGINE, "src/cross-origin.js"] },
  site: {
    "site/lib": ENGINE,
    "site/assets": ["docs/assets/mascot.svg", "docs/assets/social-preview.png", "docs/assets/og-image.png"],
  },
};

const which = process.argv[2] ? [process.argv[2]] : Object.keys(TARGETS);
for (const name of which) {
  if (!TARGETS[name]) { console.error(`Unknown target: ${name}`); process.exit(2); }
  for (const [dir, files] of Object.entries(TARGETS[name])) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of files) {
      const to = path.join(root, dir, path.basename(file));
      if (file.endsWith(".js")) {
        fs.writeFileSync(to, `/* Generated from ${file} by scripts/build.js. Do not edit. */\n` +
          fs.readFileSync(path.join(root, file), "utf8"));
      } else {
        fs.copyFileSync(path.join(root, file), to);
      }
    }
    console.log(`Built ${dir}/ (${files.map((f) => path.basename(f)).join(", ")})`);
  }
}
