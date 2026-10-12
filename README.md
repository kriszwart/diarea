<div align="center">

# 💩 Diarea

### The frontend leak scanner. Agent versus agent.

**An AI agent can now read your frontend and rebuild your product. Diarea finds what your frontend leaks (exposed keys, source maps, API maps and debug globals) so there is nothing left worth taking. Chrome extension and CLI.**

![status](https://img.shields.io/badge/status-prototype-f5a623?style=flat-square)
![platform](https://img.shields.io/badge/Chrome-MV3-e0218a?style=flat-square)
![local only](https://img.shields.io/badge/data-stays_local-38c884?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-ededea?style=flat-square)

[What it finds](#what-it-finds) · [Install](#install-load-unpacked) · [The honest bit](#the-honest-bit) · [GitHub Action](#github-action) · [Containment Score](#the-containment-score) · [Roadmap](#roadmap)

</div>

---

## Why this exists

There is an open-source agent called [REA](https://github.com/morluto/rea) that reverse-engineers anything, from app behaviour down to native binaries. Tens of thousands of people have starred it. You point it at a product, it explains how a feature works, shows the evidence, and builds a copy.

You cannot stop an agent reading your frontend. Everything the browser receives, the agent receives too. No plugin on their side, no obfuscation, no screenshot block changes that.

So Diarea does the useful thing instead. It reads **your own** site the way REA would, scores how much is leaking, and hands you the points to seal it. Same fight, your corner. Locally, before anyone else looks.

> It is a diagnosis and a coach, not armour.

## What it finds

Running on the active tab, locally, it sniffs out the six things an agent loves:

| # | Leak | Why it matters |
|---|------|----------------|
| 01 | **Source maps in production** | Your original, un-minified source. File names, comments, logic. Gift-wrapped. |
| 02 | **Secrets in client code** | Hard-coded keys and tokens in shipped JS or markup. Publishable `pk_` keys are ignored; secret keys and tokens are flagged. |
| 03 | **Client-side scoring or logic** | Weightings, thresholds and rules running in the browser. The part that makes you different. |
| 04 | **Fat hydration payloads** | Boot blobs carrying ids, flags and fields the user never sees. |
| 05 | **Readable code** | Un-minified bundles with developer notes still attached. |
| 06 | **A self-mapping API** | Every endpoint listed in the bundle. GraphQL introspection left on. |

Plus hidden fields that carry meaning and a stack fingerprint. Each finding comes with what a reader sees and a one-line fix. The overall **Leak Score** runs from Sealed to Gushing.

## Install (load unpacked)

1. Clone this repo and run `npm install && npm run build:extension`. The build copies the shared engine (`src/checks.js`) into `extension/lib/`.
2. Open `chrome://extensions` in Chrome or Edge.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/` folder.
5. Pin the icon, open one of your own deployed sites, and click it.

It auto-scans on open. Use **Re-scan** after a deploy. Point it at your own staging site first and watch the score.

## CLI

The same detection engine runs headless, so you can scan from your terminal and in CI. The checks live in one shared module (`src/checks.js`); the extension and the CLI both use it. Found secret values are never printed, only a short prefix and their length.

```
# a saved page or build output, no browser needed
npx diarea scan dist/index.html

# a live site (needs a browser once, see below)
npx diarea scan https://your-site.com

# machine-readable, and fail a build above a threshold
npx diarea scan dist/index.html --json
npx diarea scan https://your-site.com --fail-on 40
```

Two modes:

- **Static (jsdom).** Point it at a `.html` file, stdin (`-`), or use `--html`. No browser, fast, safe on untrusted markup. Reads inline scripts, hydration blobs and the DOM. It will not see data that only appears after client-side rendering.
- **Live (Playwright).** Point it at a URL. Loads the real page in headless Chromium, so it sees page globals, fetched bundles and the live network map. One-time setup:

```
npm install playwright
npx playwright install chromium
```

Options: `--json`, `--fail-on <score>`, `--strict` (exit 1 on any critical finding), `--timeout <ms>`, `--no-color`. Exit codes make it a drop-in CI check: `0` clean or under your threshold, `1` when the score reaches `--fail-on` (or any critical finding with `--strict`), `2` on error.

## GitHub Action

Gate your builds on the Leak Score. Scan your built HTML (no browser needed) or a deployed preview URL you own:

```yaml
- uses: actions/checkout@v4
- run: npm ci && npm run build
- uses: kriszwart/diarea@v0
  with:
    target: dist/index.html   # or https://your-preview.example.com
    fail-on: 40               # fail at a score of 40 or more
    strict: true              # also fail on any critical finding
```

The step fails when the CLI would (score at or over `fail-on`, or a critical finding with `strict`) and writes the score and findings to the job summary. Leave `fail-on` empty to report without failing.

`@v0` follows the latest 0.x release. Pin to `@v0.1.0` (or a commit SHA) for a fixed version.

| Input | Default | |
|---|---|---|
| `target` | required | A built `.html` file (static) or an `https://` URL (live, installs Chromium) |
| `fail-on` | `40` | Fail at this score or more |
| `strict` | `false` | Fail on any critical finding |
| `timeout` | `30000` | Live scan timeout in ms |
| `node-version` | `20` | Node to run on |

Outputs: `score`, `band`, `critical` and `report` (path to the JSON report).

## Privacy

Everything stays in your browser. Diarea makes no outbound requests of its own, reads only the page you are on, and stores nothing. Permissions are the minimum: `activeTab` (the current tab, only when you click) and `scripting` (to run the scan). Same-origin scripts are read in full; cross-origin bundles are listed but not fetched, exactly as the browser would allow anyone.

## The honest bit

Diarea surfaces exposure. The durable protections are server-side, and no browser extension can provide them:

- **Keep the scoring engine private.** Rules, weightings and thresholds run on the server. The browser gets verdicts and explanations, never the method.
- **Thin your API responses.** Return only what the page renders.
- **Strip source maps** and minify shipped code.
- **Secrets never touch the browser.** Publishable keys only on the client.
- **Guard the API.** Auth, per-account quotas, rate limits, anomaly detection on bulk probing.
- **Isolate tenant data** and block unapproved bulk exports.

Your moat was never hard-to-copy software. It is that the things worth copying never reach the browser, and that people trust your result enough to make a clone start from zero.

## The Containment Score

Every defensive move earns points. Get to 100 and there is nothing left to reverse-engineer.

| Move | Points |
|------|-------:|
| Private scoring engine (server-side) | +25 |
| Thin API responses | +15 |
| Strip source maps | +15 |
| Secrets off the client | +15 |
| API auth, quotas, rate limits | +15 |
| Tenant isolation, no bulk export | +10 |
| Signed reports for provenance | +5 |

## Roadmap

Diarea is the defensive agent. The plan is to let it fight everywhere your code ships. See [docs/roadmap.md](docs/roadmap.md) for detail.

- **v0 (done)** Chrome extension. Scan your own page, get the score.
- **v1 (done)** CLI: `npx diarea scan <url|file>`, static and live modes, shared engine.
- **v2 (in progress)** CI gate. The GitHub Action wraps `--fail-on` and `--strict` and writes a job summary; posting the score as a PR comment is next.
- **v3** Watcher: spot agent-style probing hitting your API live.

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). New detection rules are the highest-value contribution: if REA can read it, Diarea should flag it.

## Disclaimer

Diarea is a defensive tool that inspects pages you own and control, to help you harden them. It does not reverse-engineer third parties and is not a substitute for server-side security. You are responsible for how you use it.

## Star history

If this saved you from shipping your logic to the browser, a star helps other people find it.

[![Star History Chart](https://api.star-history.com/svg?repos=kriszwart/diarea&type=Date)](https://star-history.com/#kriszwart/diarea&Date)

## License

[MIT](LICENSE) · Built in Kuala Lumpur.
