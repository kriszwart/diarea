# Changelog

All notable changes to Diarea. Versions follow [semantic versioning](https://semver.org/); while it is 0.x, a minor bump can add checks that change scores.

## 0.6.0

- **A new check: sensitive fields.** Live scans read the shape of the site's own JSON responses (field names, never values), and every scan reads the shape of the page's boot payload. Password hashes and secrets in that data are critical; costs, margins, internal notes and risk scores are flagged wherever they appear; emails, phone numbers and admin flags only when they sit in a list of records, which means other people's. Third-party responses are left alone. Eleven checks now.
- **The first live scan no longer dead-ends.** On a fresh machine a live scan used to stop at Playwright's "Executable doesn't exist" message. Diarea now explains what is missing, offers to download Chromium there and then (only when a person is at the keyboard), and has `diarea install-browser` for doing it up front. It installs with Diarea's own Playwright, so the browser always matches; a bare `npx playwright install` could fetch a different version. `diarea login` uses the same launcher.
- **The demo button works from the first click.** On a slow first visit, "Run the diagnosis" (and "Scan the leaky demo") could be clicked before the demo script had loaded, and nothing happened. The button now says "Preparing the demo..." until it is ready, and early clicks are remembered and run as soon as it is.

## 0.5.0

- **Seen, Inferred and Unknown.** Every finding now says whether a reader gets it as is (`seen`: secrets, source maps, prompts, payloads) or works it out from what is there (`inferred`: the API map, the logic, the stack). The report opens with the tally, and the goal is the third bucket: Unknown, which is anything kept on your server. The new `basis` field is in `--json`, SARIF (`properties.basis`), the MCP report, the Action summary, the extension and the website.
- **The API map reads names, not just URLs.** Named GraphQL operations (`mutation GrantCredits`), tRPC procedures (from React hooks and from batched calls on the wire) and client routes (router tables and Next.js build manifests) now count, and admin, internal and staff routes are called out first. A GraphQL or tRPC app used to look small because it has one URL. SDK request descriptors such as `{ path: "/client", method: "GET" }` are not routes.
- **Storage keys.** Telling key names in `localStorage` and `sessionStorage` (tokens, roles, plans) are reported with the hidden fields, from the page and from the code that sets them. Only names are ever read, never values. A session token in `localStorage` gets its own fix: use an HttpOnly cookie.
- **Debug logging.** Live scans count the console messages the site's own scripts print while the page loads (a count only, never the messages), and report three or more.
- **A bigger false-positive corpus.** `npm run corpus` now also covers React Router, Vue Router, Apollo Client, graphql-js, tRPC and TanStack Query, and still finds nothing in library code.

- **Scan behind the login.** `diarea login <url>` opens a real browser, you log in yourself and press Enter, and the session is saved to `.diarea/login.json` (readable by you only, kept out of git). `--storage-state` scans as that user, in the CLI, the Action (`storage-state` input) and the MCP tool (`storage_state`). Diarea never sees or stores your password.
- **The site's own CDN gets read.** Bundles served from `cdn.your-site.com` or a CloudFront-style host used to go unread, because a page cannot fetch across origins. Live scans now read them from Node, and the extension offers to: one click, and Chrome asks for that one site (an optional host permission, nothing at install). Third-party scripts are never read. Until they are read, an all-clear says it only covers what was read.
- **More secrets caught.** PEM private keys (only with a key body after the header, so crypto libraries are not flagged), Stripe restricted keys (`rk_live_`), Anthropic keys (named as such, no longer as "OpenAI-style"), GitHub fine-grained tokens, Hugging Face, Replicate and SendGrid tokens, and Twilio API key SIDs. `npm run corpus` now includes two crypto libraries, still with no false positives.
- **A shorter lead for agents.** The MCP server only scans files inside its project (symlinks resolved), never reads stdin (its own protocol channel), and only loads public sites: localhost, private networks and anything resolving to them are refused unless you set it up with `diarea setup --allow-private`, and cloud metadata addresses are always refused. Redirects and every request the page makes are checked too.
- **No false source map on single-page apps.** Hosts that answer every path with `index.html` made the `.map` probe succeed. A map now has to be a source map.
- **Whole build folders.** `diarea scan dist` now reads every script and script map in the folder, not just what `index.html` names. Vite and webpack only name the entry chunk, so lazy routes, preloaded chunks and "hidden" source maps (built without the comment, deployed all the same) were never checked. Page scans also read `<link rel="modulepreload">` files. The walk never leaves the folder or follows symlinks. Scores can rise for builds that were hiding something.
- **Source maps behind query strings and headers.** Live and extension scans probed `app.js?v=3.map` instead of `app.js.map`, and ignored the `SourceMap` header. Both are fixed, and the map that was found is named in the evidence. An inline (`data:`) source map is reported as one, instead of printing the blob.
- **No stray browsers.** A live scan that failed to load left Chromium running. The CLI exited anyway, but the long-running MCP server kept one per failed scan. The browser is now always closed, and a page that never goes quiet is no longer loaded twice.
- **Typos fail loudly.** An unknown option, or `--fail-on` / `--timeout` without a sensible number, is now an error (exit 2) instead of being ignored, which could quietly turn off a CI gate.
- **Node 22 or later.** Node 20 reached end of life in April 2026. CI tests on 22 and 24, and the Action runs on 22 by default.
- **Releases in one step.** Pushing a version tag runs `.github/workflows/release.yml`: it checks the tag, `package.json`, the manifest and this changelog agree, runs the tests, publishes to npm with provenance, attaches the extension zip to a GitHub Release and moves the Action's `v0` tag.

## 0.4.0

- **Let your coding agent fix it.** `diarea mcp` runs an MCP server with one read-only tool, `diarea_scan`, so Claude Code, Cursor and any MCP client can scan your build or site, fix the causes in your code and scan again to prove the score dropped. `diarea setup` registers it with Claude Code; `--project` writes `.mcp.json` for the team; `--print` shows the config for other agents. No new dependencies.
- **One scan path.** The CLI and the MCP server share `src/scan.js`. File scans report project-relative paths, so reports and pull request comments never show local folder names.
- **No false all-clear.** Scanning a file that is not HTML (a `package.json`, a folder, piped JSON) is now an error, not a score of 0. Errors for missing files name the path you gave, never the absolute local one.
- **An honest endpoint count.** Only URLs that look like an API (an `api.` host or a path such as `/api/`, `/v1/`, `/graphql`, `/_serverFn/`) count from the bundle, so page links, XML namespaces, docs and CDN scripts no longer pad the map. Live scans stop counting the bundles and source maps Diarea fetches itself. Hashed paths are grouped, for example `/_serverFn/* (5)`. On revoluaition.com the count fell from 38 to 4.
- **Quiet on library code.** Run against twelve popular libraries (React, Vue, jQuery, lodash, three.js, Supabase, Firebase, Stripe.js, Clerk and more), minified vendor code no longer trips two checks. Licence banners, lint directives and comment-like strings are not developer notes. Business-logic words now have to cluster in one small block next to tuned decimals, so three.js morph weights and CSS font weights are not your pricing. `npm run corpus` repeats the check.
- **SARIF for GitHub code scanning.** `--sarif` prints SARIF 2.1.0, and the Action's new `sarif` input writes a file for `github/codeql-action/upload-sarif`, so findings appear in the Security tab. Every finding now carries a stable `id` (`source-maps`, `secrets`, `client-logic`...), also in `--json`.
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
