# Diarea 💩

Defensive agent that finds what a website's frontend leaks to anyone with DevTools: exposed keys, source maps, API endpoint maps, debug globals and similar. The frontend counterpart to REA (backend reverse-engineering agent): REA and DIA share the same last letters.

Open source (MIT). Author: Kris Zwart, ZwartifyDesign.

## Product shape

1. **Chrome extension (MV3)**: scans the current tab and shows a scored leak report.
2. **CLI**: `npx diarea scan <url|file|folder>` with `--json`, `--sarif`, `--fail-on <score>`, `--strict`, `--timeout`, `--storage-state`; `diarea login <url>` saves a login for live scans.
3. **CI gate (v2)**: a thin GitHub Action wrapping the CLI exit codes.
4. **MCP server for coding agents**: `diarea mcp` (stdio, no SDK) with one read-only tool, `diarea_scan`; `diarea setup` registers it with Claude Code (or `--project` writes `.mcp.json`, `--print` shows other agents' config).
5. **Live API watcher (later)**.

First real target: revoluAItion (revoluaition.com), a client-rendered app, so the live (browser) path matters.

## Architecture

- `src/checks.js` is the single canonical detection engine. Every rule lives here and only here. The CLI and the extension both import it; never duplicate rules elsewhere.
- `src/collect-static.js` collects page evidence with jsdom (no browser, safe on untrusted markup, good for CI and build output). When scanning a file it also reads that page's local `<script src>` and `modulepreload` files and sibling `.map` files; when scanning a build folder it reads every script and script map in it (no symlinks followed). Only inside that folder. Never execute page scripts or fetch anything in this path.
- `src/collect-page.js` is the in-page collector, a self-contained function run inside a real page. The extension (chrome.scripting), the live CLI (`src/collect-live.js`, Playwright) and the landing page (demo iframe) all use it; never write another one.
- `src/collect-live.js` loads the page with Playwright, runs `collectPage` and adds the network map. The browser is always closed in a `finally`, because the MCP server is long-lived.
- `src/scan.js` runs one scan from target to scored report; the CLI and the MCP server both use it. File scans use project-relative paths so reports never show local folder names.
- `src/mcp.js` is the MCP server (JSON-RPC over stdio, stdout is protocol only) and `src/setup.js` the `diarea setup` command. Keep the tool read-only and the server instructions defensive. File targets must stay inside the project (symlinks resolved), stdin is never read, and every URL goes through `src/guard.js`: private and loopback addresses only with `--allow-private` (set by the user in the server config, never by a tool argument), link-local and cloud metadata never.
- `src/guard.js` classifies hosts by name and by every address they resolve to; `collect-live.js` also routes each page request and checks the redirect chain through it.
- `src/login.js` is `diarea login`: the user logs in themselves in a headed browser and the storage state is saved 0600, with `.diarea/.gitignore`. Diarea never types or stores passwords.
- `src/cross-origin.js` decides which cross-origin scripts are the site's own (same registrable domain, or a hosting CDN such as CloudFront). The live collector reads those from Node; the extension offers to read them with an optional host permission requested per site. Third-party scripts are never read.
- `bin/diarea.js` is the CLI entry point. `src/sarif.js` formats a report as SARIF 2.1.0 (`--sarif`, and the Action's `sarif` input via `scripts/action-sarif.js`); it holds no rules. Every finding has a stable `id`, which is its SARIF rule id: never rename one. Each finding also carries a `basis` (`seen` or `inferred`, from `BASIS` in `checks.js`), REA's labels; Unknown is what stays on the server.
- `action.yml` is the GitHub Action: it runs the CLI with `--json` and `scripts/action-report.js` turns the report into outputs, a job summary (`scripts/action-summary.js`), a sticky pull request comment (`scripts/pr-comment.js`, updated in place, never fatal) and the CLI's exit code.
- `extension/` holds the Chrome extension. `npm run build` (`scripts/build.js`) copies `src/checks.js` and `src/collect-page.js` into `extension/lib/` and `site/lib/` (plus `src/cross-origin.js` into `extension/lib/`); both are git-ignored, never edit them. The extension asks for no host permissions at install: CDN access is `optional_host_permissions`, requested from a click. Keep it that way, and keep `site/privacy.html` and `docs/store/listing.md` in step with it.
- `test/fixtures/` holds deliberately leaky and clean pages. `npm test` must run without a browser. Fake secrets are assembled in the test, never stored as credential-shaped strings (GitHub push protection blocks them).
- `site/` is published to GitHub Pages at https://diarea.tools (custom domain set in the repo's Pages settings; no CNAME file, since Actions deploys ignore it): the landing page (`index.html`, `landing.css`, `landing.js`) at the root, which runs the real engine on the demo in an iframe and loads nothing from third parties (not even fonts) until someone presses play on the YouTube trailer, which only then swaps in a youtube-nocookie player. `site/demo/` is PromptPlop, a fake AI app builder that leaks on purpose (every check must fire on it; the tests enforce this). It must stay generic: never model it on, or name it after, a real company. It is the only thing the docs and landing page ever scan.
- `docs/store/` is the Chrome Web Store kit: `listing.md` (copy, permission justifications, privacy answers), screenshots and promo tiles rendered by `scripts/render-store-assets.js` (the real popup with stubbed `chrome.*` APIs), plus `extension/icons/` from the mascot. `npm run package:extension` builds `dist/diarea-extension-<version>.zip`. `site/privacy.html` is the privacy policy; keep it true to what the code does.
- `docs/assets/scan.svg` is rendered from real CLI output by `scripts/render-terminal-svg.js`; `social-preview.png` is a screenshot of `social-preview.html`.

## Checks (current eleven)

Eleven checks covering things like exposed keys, source maps, un-minified or commented bundles, API/GraphQL endpoint maps (including a bare `/graphql`), debug globals, AI system prompts in the bundle, direct calls to AI model APIs and sensitive field names in API responses and boot payloads (judged from key paths made by `src/shape.js`, never values); see `src/checks.js` for the authoritative list. The report rolls findings into a 0 to 100 score with tiered labels (top tier is "Gushing"). A leaky fixture should score high; a clean page should score 0.

## Conventions

- Node 22+, plain ES modules, minimal dependencies.
- British English in docs and report copy. No em dashes anywhere.
- Report tone is cheeky but useful; the 💩 stays.
- Exit codes: 0 clean or under threshold, 1 when score >= `--fail-on`, 2 on tool error.
- Diarea is defensive: scan sites you own or are authorised to test. Never add features that exploit or exfiltrate what it finds; redact secret values in output (show prefix and length only).

## Commands

```
npm install
npx playwright install chromium   # only needed for live scans
npm test
npm run corpus                     # false-positive check against real libraries (network)
node bin/diarea.js scan https://example.com
node bin/diarea.js scan ./dist/index.html --json
```

## Roadmap

- [x] Port the CLI, engine and tests into this repo
- [x] Point the extension at `src/checks.js` (one source of truth)
- [x] GitHub Action (`action.yml`) wrapping `--fail-on`
- [x] Landing page on GitHub Pages
- [x] Post the score as a PR comment from the Action
- [x] Publish to npm as `diarea`
- [x] MCP server and `diarea setup`, so coding agents run it like REA
- [x] Release workflow: a version tag publishes to npm and GitHub Releases and moves `v0`
- [ ] Live API watcher
