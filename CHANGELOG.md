# Changelog

All notable changes to Diarea. Versions follow [semantic versioning](https://semver.org/); while it is 0.x, a minor bump can add checks that change scores.

## Unreleased

- **Leak Score on pull requests.** The GitHub Action posts the score as one comment and updates it on every push, with how it moved since the last one. New inputs `comment` (on by default), `comment-key` and `github-token`; the job needs `pull-requests: write`. It never fails the build: forked pull requests get a warning instead.

## 0.2.0

- **Two new checks for AI apps (ten in total).** Flags an AI system prompt shipped in the bundle, and the browser calling an AI model API directly (which usually means a provider key is in the client). Scores can rise for pages with either.
- **Landing page** at [kriszwart.github.io/diarea](https://kriszwart.github.io/diarea/), with a live diagnosis of the demo run by the real engine, the score bands, install snippets, an FAQ and the trailer (YouTube loads only when you press play).
- **New demo: PromptPlop**, a fictional AI app builder that leaks on purpose and trips every check.
- **"What a clone can't copy"** in the README and on the site: data, people, trust and the physical world.
- **One page collector** (`src/collect-page.js`) shared by the extension, the live CLI scan and the landing page. `npm run build` copies it and the engine where the browser needs them.

## 0.1.0

- Chrome extension (MV3), CLI (`diarea scan`) and GitHub Action (`fail-on`, `strict`, job summary) on one engine, `src/checks.js`, with eight checks.
- Static scans of a file read its local scripts and source maps, never outside its folder and never over the network. Live scans use Playwright.
- Secrets are always redacted to a short prefix and length.
