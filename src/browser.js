/* Starting Chromium for live scans and `diarea login`, and installing it.
 *
 * Playwright's own error for a missing browser tells people to run
 * `npx playwright install`, which can fetch a different Playwright from the
 * one Diarea runs and so download a browser that still does not match. Diarea
 * installs with its own bundled Playwright instead: `diarea install-browser`.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

export const INSTALL_COMMAND = "npx diarea install-browser";

export class BrowserMissingError extends Error {
  constructor(missingPackage = false) {
    super(missingPackage
      ? "Live scans need Playwright, which is not installed here.\n  Install it:  npm install playwright\n  Then once:   " + INSTALL_COMMAND +
        "\n  Or scan your build without a browser:  npx diarea scan dist/"
      : "Live scans need a browser, and Chromium is not installed yet.\n  Install it once:  " + INSTALL_COMMAND +
        "\n  Or scan your build without a browser:  npx diarea scan dist/");
    this.code = "NO_BROWSER";
    this.missingPackage = missingPackage;
  }
}

export async function launchChromium(options = {}) {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { throw new BrowserMissingError(true); }
  try {
    return await chromium.launch(options);
  } catch (err) {
    if (/Executable doesn't exist|playwright install|browserType\.launch: .*not found/i.test(err.message)) throw new BrowserMissingError();
    throw err;
  }
}

/** Download Chromium with the Playwright Diarea itself uses. Returns the exit code. */
export function installBrowser({ stdio = "inherit" } = {}) {
  let cli;
  try {
    const pkg = createRequire(import.meta.url).resolve("playwright/package.json");
    cli = path.join(path.dirname(pkg), "cli.js");
  } catch {
    console.error("Playwright is not installed here. Run: npm install playwright");
    return 2;
  }
  const res = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio });
  return res.status ?? 2;
}
