/* `diarea login <url>`: save a login so live scans can see pages behind it.
 *
 * Opens a real browser window on your site. You log in as you normally would,
 * press Enter in the terminal, and Diarea saves that browser's cookies and
 * local storage (a Playwright storage state) to a file. Pass the file to
 * `diarea scan <url> --storage-state <file>`.
 *
 * Diarea never sees or types your password: you log in yourself. The file
 * does hold a live session, so it is written readable by you only, and the
 * default folder (.diarea/) gets its own .gitignore so it is never committed.
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_LOGIN_FILE = ".diarea/login.json";

function waitForEnter(input) {
  return new Promise((resolve) => {
    const rl = createInterface({ input });
    rl.once("line", () => { rl.close(); resolve(); });
    rl.once("close", resolve);
  });
}

/** Write a storage state file readable by its owner only, and keep .diarea/ out of git. */
export function saveLogin(file, state, { cwd = process.cwd() } = {}) {
  const full = path.resolve(cwd, file);
  const dir = path.dirname(full);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (path.basename(dir) === ".diarea" && !fs.existsSync(path.join(dir, ".gitignore"))) {
    fs.writeFileSync(path.join(dir, ".gitignore"), "# Saved logins hold live sessions. Never commit them.\n*\n");
  }
  fs.writeFileSync(full, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(full, 0o600); // also when the file already existed
  return full;
}

export async function login(argv, { log = console.log, cwd = process.cwd(), input = process.stdin } = {}) {
  let url = null, file = DEFAULT_LOGIN_FILE;
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === "--save") file = argv[++k];
    else if (!url) url = argv[k];
  }
  if (!url || !/^https?:\/\//i.test(url) || !file) {
    log("Usage: diarea login <https://your-site.com/login> [--save .diarea/login.json]");
    return 2;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    log("Saving a login needs Playwright and a browser:\n  npm install playwright\n  npx playwright install chromium");
    return 2;
  }

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    log("");
    log("  💩 A browser window has opened on " + new URL(url).host + ".");
    log("  Log in there as you normally would (Diarea never sees your password),");
    log("  then come back here and press Enter.");
    await waitForEnter(input);
    const state = await context.storageState();
    const saved = saveLogin(file, state, { cwd });
    const rel = path.relative(cwd, saved) || saved;
    log("");
    log(`  Saved to ${rel}. It holds a live session: treat it like a password and delete it when you are done.`);
    if (!rel.startsWith(".diarea" + path.sep)) log("  Keep it out of git (add it to .gitignore).");
    log(`  Now scan as that user:  diarea scan ${url} --storage-state ${rel}`);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}
