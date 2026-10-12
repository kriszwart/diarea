# Diarea 💩

Defensive agent that finds what a website's frontend leaks to anyone with DevTools: exposed keys, source maps, API endpoint maps, debug globals and similar. The frontend counterpart to REA (backend reverse-engineering agent): REA and DIA share the same last letters.

Open source (MIT). Author: Kris Zwart, ZwartifyDesign.

## Product shape

1. **Chrome extension (MV3)**: scans the current tab and shows a scored leak report.
2. **CLI**: `npx diarea scan <url|file>` with `--json`, `--fail-on <score>`, `--strict`, `--timeout`.
3. **CI gate (v2)**: a thin GitHub Action wrapping the CLI exit codes.
4. **Live API watcher (later)**.

First real target: revoluAItion (revoluaition.com), a client-rendered app, so the live (browser) path matters.

## Architecture

- `src/checks.js` is the single canonical detection engine. Every rule lives here and only here. The CLI and the extension both import it; never duplicate rules elsewhere.
- `src/collect-static.js` collects page evidence with jsdom (no browser, safe on untrusted markup, good for CI and build output). When scanning a file it also reads that page's local `<script src>` files and sibling `.map` files, only inside the file's own folder. Never execute page scripts or fetch anything in this path.
- `src/collect-page.js` is the in-page collector, a self-contained function run inside a real page. The extension (chrome.scripting), the live CLI (`src/collect-live.js`, Playwright) and the landing page (demo iframe) all use it; never write another one.
- `src/collect-live.js` loads the page with Playwright, runs `collectPage` and adds the network map.
- `bin/diarea.js` is the CLI entry point.
- `action.yml` is the GitHub Action: it runs the CLI with `--json` and `scripts/action-report.js` turns the report into outputs, a job summary and the CLI's exit code.
- `extension/` holds the Chrome extension. `npm run build` (`scripts/build.js`) copies `src/checks.js` and `src/collect-page.js` into `extension/lib/` and `site/lib/`; both are git-ignored, never edit them.
- `test/fixtures/` holds deliberately leaky and clean pages. `npm test` must run without a browser. Fake secrets are assembled in the test, never stored as credential-shaped strings (GitHub push protection blocks them).
- `site/` is published to GitHub Pages: the landing page (`index.html`, `landing.css`, `landing.js`) at the root, which runs the real engine on the demo in an iframe and loads nothing from third parties (not even fonts) until someone presses play on the YouTube trailer, which only then swaps in a youtube-nocookie player. `site/demo/` is PromptPlop, a fake AI app builder that leaks on purpose (every check must fire on it; the tests enforce this). It must stay generic: never model it on, or name it after, a real company. It is the only thing the docs and landing page ever scan.
- `docs/assets/scan.svg` is rendered from real CLI output by `scripts/render-terminal-svg.js`; `social-preview.png` is a screenshot of `social-preview.html`.

## Checks (current ten)

Ten checks covering things like exposed keys, source maps, un-minified or commented bundles, API/GraphQL endpoint maps (including a bare `/graphql`), debug globals, AI system prompts in the bundle and direct calls to AI model APIs; see `src/checks.js` for the authoritative list. The report rolls findings into a 0 to 100 score with tiered labels (top tier is "Gushing"). A leaky fixture should score high; a clean page should score 0.

## Conventions

- Node 20+, plain ES modules, minimal dependencies.
- British English in docs and report copy. No em dashes anywhere.
- Report tone is cheeky but useful; the 💩 stays.
- Exit codes: 0 clean or under threshold, 1 when score >= `--fail-on`, 2 on tool error.
- Diarea is defensive: scan sites you own or are authorised to test. Never add features that exploit or exfiltrate what it finds; redact secret values in output (show prefix and length only).

## Commands

```
npm install
npx playwright install chromium   # only needed for live scans
npm test
node bin/diarea.js scan https://example.com
node bin/diarea.js scan ./dist/index.html --json
```

## Roadmap

- [x] Port the CLI, engine and tests into this repo
- [x] Point the extension at `src/checks.js` (one source of truth)
- [x] GitHub Action (`action.yml`) wrapping `--fail-on`
- [x] Landing page on GitHub Pages
- [ ] Post the score as a PR comment from the Action
- [ ] Publish to npm as `diarea`
- [ ] Live API watcher
