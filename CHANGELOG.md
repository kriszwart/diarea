# Changelog

All notable changes to Diarea. Versions follow [semantic versioning](https://semver.org/); while it is 0.x, a minor bump can add checks that change scores.

## 0.4.0

- **Let your coding agent fix it.** `diarea mcp` runs an MCP server with one read-only tool, `diarea_scan`, so Claude Code, Cursor and any MCP client can scan your build or site, fix the causes in your code and scan again to prove the score dropped. `diarea setup` registers it with Claude Code; `--project` writes `.mcp.json` for the team; `--print` shows the config for other agents. No new dependencies.
- **One scan path.** The CLI and the MCP server share `src/scan.js`. File scans report project-relative paths, so reports and pull request comments never show local folder names.
- **No false all-clear.** Scanning a file that is not HTML (a `package.json`, a folder, piped JSON) is now an error, not a score of 0. Errors for missing files name the path you gave, never the absolute local one.
- **An honest endpoint count.** Only URLs that look like an API (an `api.` host or a path such as `/api/`, `/v1/`, `/graphql`, `/_serverFn/`) count from the bundle, so page links, XML namespaces, docs and CDN scripts no longer pad the map. Live scans stop counting the bundles and source maps Diarea fetches itself. Hashed paths are grouped, for example `/_serverFn/* (5)`. On revoluaition.com the count fell from 38 to 4.
- **Scan a build folder.** `diarea scan dist` scans `dist/index.html`, in the CLI, the Action and the MCP tool.

## 0.3.2

Fixes from the first real scans, of revoluaition.com.

- **Fewer false alarms on secrets.** Words ending in `sk-`, such as `task-item-...` or `mask-image-...`, were reported as OpenAI keys. Key patterns now have to start a token, and OpenAI, Stripe and GitHub keys have to look random (32 or more characters mixing digits and both cases).
- **JWTs are judged by their role**, read locally from the token (only the role is ever shown). A Supabase-style `anon` key is public by design, so it is now a minor note reminding you to check row level security; a `service_role` key is critical.
- **Property names and minified code are no longer "hard-coded tokens"**, for example `token: "access_token"` or code caught between two unrelated quotes.
- **Live scans count only API traffic** (fetch, XHR, websockets) towards the endpoint map, not the page's own scripts, styles, fonts and images.
- **`diarea --version` reads the version from package.json**, so it can no longer disagree with npm (0.3.1 printed 0.3.0).

## 0.3.1

- **Chrome Web Store kit.** Extension icons from the mascot, a manifest with icons and a homepage, `npm run package:extension` for the upload zip, a privacy policy page on the site, and `docs/store/` with the listing copy, permission justifications, three screenshots of the real popup and both promo tiles.
- **The site moves to [diarea.tools](https://diarea.tools/)**, with a copyable quick start in the hero and the README.

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
