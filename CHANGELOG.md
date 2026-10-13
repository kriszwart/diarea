# Changelog

All notable changes to Diarea. Versions follow [semantic versioning](https://semver.org/); while it is 0.x, a minor bump can add checks that change scores.

## Unreleased

- **Fewer false alarms on secrets** (from the first real scan, of revoluaition.com). Words ending in `sk-`, such as `task-item-...` or `mask-image-...`, were reported as OpenAI keys. Key patterns now have to start a token, and OpenAI, Stripe and GitHub keys have to look random (32 or more characters mixing digits and both cases).
- **Supabase keys are read, not just matched.** A JWT whose role is `anon` (Supabase's public key, meant for the browser) is no longer reported; one whose role is `service_role` is now critical, since it bypasses row level security.
- **Minified code is not a hard-coded token.** A `token: "..."` match is skipped when the value runs across code (spaces, brackets, commas) or is a constant name such as `access_token`.
- **Live scans count only API traffic** (fetch, XHR, websockets) towards the endpoint map, not the page's own scripts, styles, fonts and images.
- **Chrome Web Store kit.** Extension icons from the mascot, a manifest with icons and a homepage, `npm run package:extension` for the upload zip, a privacy policy page on the site, and `docs/store/` with the listing copy, permission justifications, three screenshots of the real popup and both promo tiles.

## 0.3.0

- **Leak Score on pull requests.** The GitHub Action posts the score as one comment and updates it on every push, with how it moved since the last one. New inputs `comment` (on by default), `comment-key` and `github-token`; the job needs `pull-requests: write`. It never fails the build: forked pull requests get a warning instead.
- **Ready for npm** as `diarea`, so `npx diarea scan` works without cloning. The package holds only the CLI and engine (9 files, about 18 kB); Playwright stays optional for live scans.

## 0.2.0

- **Two new checks for AI apps (ten in total).** Flags an AI system prompt shipped in the bundle, and the browser calling an AI model API directly (which usually means a provider key is in the client). Scores can rise for pages with either.
- **Landing page** at [diarea.tools](https://diarea.tools/), with a live diagnosis of the demo run by the real engine, the score bands, install snippets, an FAQ and the trailer (YouTube loads only when you press play).
- **New demo: PromptPlop**, a fictional AI app builder that leaks on purpose and trips every check.
- **"What a clone can't copy"** in the README and on the site: data, people, trust and the physical world.
- **One page collector** (`src/collect-page.js`) shared by the extension, the live CLI scan and the landing page. `npm run build` copies it and the engine where the browser needs them.

## 0.1.0

- Chrome extension (MV3), CLI (`diarea scan`) and GitHub Action (`fail-on`, `strict`, job summary) on one engine, `src/checks.js`, with eight checks.
- Static scans of a file read its local scripts and source maps, never outside its folder and never over the network. Live scans use Playwright.
- Secrets are always redacted to a short prefix and length.
