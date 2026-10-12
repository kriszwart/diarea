# Roadmap

Diarea is the defensive agent in an agent-versus-agent world. REA and tools like it read frontends and rebuild features. The plan is to let Diarea fight at every point your code ships, not just in the browser.

## v0 - Scanner (now)

A Chrome MV3 extension. Open your own deployed page, click, and get a Leak Score with findings and fixes. Everything local. This is the diagnosis.

**Done:** source maps, client-side secrets, client-side logic, hydration payloads, un-minified code, API surface, hidden fields, stack fingerprint.

## v1 - CLI

```
npx diarea scan https://your-site.com
```

The same checks, headless, in your terminal. Outputs a score and a JSON report. The point is to run it where humans and pipelines already live, not only in a browser popup.

- Same detection core as the extension, shared in one module.
- `--json` for machines, a readable table for humans.
- Exit non-zero above a configurable leak threshold.

## v2 - CI gate

A GitHub Action wrapping the CLI (`action.yml`, see the README).

- Runs on every deploy preview.
- Fails the build when the leak score rises above your line, or a critical finding appears (a source map slips into production, a secret lands in the bundle).
- Writes the score and findings to the job summary. **Done.**
- Posts the score as a PR comment, so a regression is visible before merge. **Next.**

This turns "we should harden the frontend" into a check that cannot be forgotten.

## v3 - Watcher

The defensive agent goes live. Instead of only scanning static output, watch for agent-style behaviour against your running API:

- Systematic parameter sweeps designed to infer thresholds.
- Bulk or rapid automated account creation.
- Repeated structured probing that looks like extraction rather than use.

Graduated responses, not blanket blocking, so real researchers and institutional customers are never caught. This is the part that pairs with the server-side hardening the scanner recommends.

## Guiding principle

Every feature keeps the same promise: Diarea helps you seal your own leaks. It never reverse-engineers third parties, and it never pretends to be the whole defence. The whole defence is server-side. Diarea is the thing that keeps you honest about getting there.
