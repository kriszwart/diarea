# Contributing to Diarea

Thanks for helping seal the leaks. This is a small, honest project and contributions are very welcome.

## The most useful thing you can add

**Detection rules.** The core idea is simple: if an agent can read it from the frontend, Diarea should flag it. New or sharper checks are the highest-value contribution.

Every check lives in `analyse()` in `src/checks.js`, the one detection engine shared by the CLI and the extension. Never copy a rule anywhere else. A check calls `add(sev, title, detail, fix, evidence)`:

- `sev` is `"crit"`, `"warn"` or `"info"`.
- `title` is the short headline shown in the report.
- `detail` is one or two sentences on what a reader sees.
- `fix` is the one-line "flush it" instruction.
- `evidence` is a short array of concrete strings found on the page. Pass secret values through `redact()` so only a prefix and length are shown.

Keep checks local and read-only. The scanner must never send anything off the machine, and must never modify the page.

## Running it

```
npm install
npm test                    # no browser needed
npm run build               # copies the engine into extension/lib/ and site/lib/
```

Load `extension/` unpacked at `chrome://extensions` with Developer mode on. After editing `src/checks.js`, rebuild and reload the extension. If a check needs new evidence, collect it in `src/collect-static.js` (files, jsdom) and `src/collect-page.js` (real pages: the extension, live CLI and landing page all use it). Add a case to `test/fixtures/` so it can be verified, and give Colander AI (`site/demo/`) a leak that trips it: the tests check the demo fires every check.

## Ground rules

- Local only. No network calls of Diarea's own, no storage, no telemetry.
- Minimum permissions. Do not add host permissions or background workers without a clear reason.
- Low false positives. A noisy scanner gets ignored. Prefer a missed finding to a wrong one.
- British English in the UI copy, and keep the tone dry rather than crude.

## Pull requests

Open an issue first for anything large. For a new check, include an example page or snippet that triggers it so it can be verified. Small, focused PRs get merged faster.
