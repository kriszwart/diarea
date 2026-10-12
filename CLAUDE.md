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
- `src/collect-static.js` collects page evidence with jsdom (no browser, safe on untrusted markup, good for CI and build output). Never execute page scripts in this path.
- `src/collect-live.js` collects with Playwright (real page load: globals, fetched bundles, network map).
- `bin/diarea.js` is the CLI entry point.
- `extension/` holds the Chrome extension. It should consume `src/checks.js` via a small build step, not an inline copy.
- `test/fixtures/` holds deliberately leaky and clean pages. `npm test` must run without a browser.

## Checks (current eight)

Eight checks covering things like exposed keys, source maps, un-minified or commented bundles, API/GraphQL endpoint maps (including a bare `/graphql`) and debug globals; see `src/checks.js` for the authoritative list. The report rolls findings into a 0 to 100 score with tiered labels (top tier is "Gushing"). A leaky fixture should score high; a clean page should score 0.

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
- [ ] GitHub Action (`action.yml`) wrapping `--fail-on`
- [ ] Publish to npm as `diarea`
- [ ] Live API watcher
