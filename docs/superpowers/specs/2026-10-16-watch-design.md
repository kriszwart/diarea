# Diarea Watch v1: design

Date: 2026-10-16. Status: approved in conversation, awaiting spec review.

## Purpose

The scanner shows what a frontend gives away. The watcher shows who is using it: agent-style behaviour against your running API, read from logs you already have. It is the v3 item in `docs/roadmap.md`, cut down to a first version that detects and reports.

Success for v1:

- `diarea watch access.log` names actors that sweep parameters, walk IDs, burst sign-ups, probe routes or run at machine cadence, with a fix for each.
- A log of ordinary browsing scores 0.
- No raw IP address, query value or personal data reaches any report.
- Real researchers and institutional customers can be kept out of the findings with an allowlist.

## Constraints

- Defensive only. Diarea reports; it never blocks, slows or answers traffic in v1.
- Node 22+, plain ES modules, no new dependencies.
- `npm test` runs without a browser or network.
- British English, no em dashes, cheeky but useful report copy, the 💩 stays.
- Exit codes as for `scan`: 0 clean or under threshold, 1 when score >= `--fail-on`, 2 on tool error.

## Out of scope for v1

`--follow` (tailing a live file), middleware, a reverse proxy, platform log pulls (Vercel, Cloudflare APIs), an MCP tool, an Action input, SARIF output, and any response that touches traffic. The engine is built so middleware can reuse it later.

## Command

```
diarea watch <log-file|-> [--json] [--fail-on <score>] [--since <duration>] [--allow <file>]
```

- `<log-file>` is a path, or `-` for stdin (the CLI may read stdin; the MCP server never does, and v1 adds no MCP tool).
- `--since 24h` keeps only events newer than that, relative to the newest event in the log, not the wall clock, so old logs replay the same way every time. Units: `m`, `h`, `d`.
- `--allow <file>` reads an allowlist (below).
- `--json` prints the report as JSON. Without it, a readable report like `scan`'s.
- Unknown options, or `--fail-on` / `--since` without a sensible value, exit 2, as `scan` does.

## Log formats

Detected per file from the first non-empty lines.

1. **Combined Log Format** (nginx and Apache defaults; Common Log Format also accepted, without referrer and user agent).
2. **JSON lines.** Field names are matched from a short list of aliases, which covers Vercel and Cloudflare log drains and most structured loggers:
   - time: `timestamp`, `time`, `ts`, `EdgeStartTimestamp`, `@timestamp`
   - IP: `ip`, `clientIp`, `client_ip`, `ClientIP`, `remote_addr`, `proxy.clientIp`
   - method: `method`, `ClientRequestMethod`, `proxy.method`
   - path (with query): `path`, `url`, `ClientRequestURI`, `request.url`, `proxy.path`
   - status: `status`, `statusCode`, `EdgeResponseStatus`, `proxy.statusCode`
   - user agent: `userAgent`, `user_agent`, `ClientRequestUserAgent`, `proxy.userAgent`

Lines that do not parse are counted and reported as one info line ("312 lines skipped"), never fatal. A file where nothing parses is a tool error (exit 2) naming the formats tried.

## Event

Every parsed line becomes:

```js
{ t, actor, method, route, params, status, ua }
```

- `t`: epoch milliseconds.
- `actor`: a salted SHA-256 of IP plus user agent, first 10 hex characters. The salt is random per run, so actor ids cannot be joined across runs or reversed from a report.
- `route`: the path templated by `routeOf` (below), without the query string.
- `params`: `Map` of query parameter name to raw value. Values live only in memory, during the run, for the checks that need them, and never reach a finding.
- `status`: number.
- `ua`: user agent class only: `browser`, `app` (mobile HTTP stacks such as okhttp and CFNetwork), `automation` (curl, python-requests, Go-http-client, axios, node-fetch, HeadlessChrome, Playwright, Puppeteer and similar), `bot` (declared crawlers) or `unknown`. The raw string is dropped after classing.
- The IP is kept only long enough to hash it and to derive its /24 (IPv4) or /48 (IPv6) network, itself hashed with the same salt, for `signup-burst`.

## Modules

- `src/watch-parse.js`: format detection and `parseLine`, returning an event or `null`. Owns the salt, hashing and user agent classing.
- `src/behaviour.js`: the watcher's rule engine. `analyseEvents(events, { allow }) -> { findings, actors, stats }`. Pure: no I/O, no clock, no randomness. It holds every watcher rule and only watcher rules; `src/checks.js` stays the engine for frontend scans. Also exports `routeOf(path)` and `BEHAVIOUR_BASIS`.
- `src/watch.js`: reads the file or stdin line by line (streaming, so big logs stay out of memory except for the per-actor state), applies `--since`, runs `analyseEvents`, scores with `scoreOf` from `checks.js` and builds the report.
- `bin/diarea.js`: the `watch` subcommand, its options and printing.

CLAUDE.md's architecture section gains a line for each new file, and its "Checks" section notes that watcher rules live in `src/behaviour.js`.

## Route templating

`routeOf` replaces path segments that are numbers, UUIDs, long hex or long mixed tokens (the same shape `checks.js` collapses in the API map) with `:id`, so `/users/8812/orders` becomes `/users/:id/orders`. The raw numeric segment is kept beside the route, in memory only, for `id-enumeration`.

## Checks

Every finding has a stable `id` (never renamed), `sev` (`crit`, `warn`, `info`), `basis: "inferred"`, a title, evidence that names routes, parameter names, counts and actor ids only, a fix, and a recommended tier. Thresholds are named constants at the top of `behaviour.js`; the numbers below are the starting values, tuned against the fixtures.

| id | Fires when | Sev | Fix |
|---|---|---|---|
| `param-sweep` | One actor, one route, one numeric query parameter takes 12 or more distinct values within 10 minutes, and the values move in near-constant steps or halve their gap (binary search). | crit | Keep thresholds and limits server-side and out of responses; rate-limit per route and actor; answer near-threshold probes with the same response. |
| `id-enumeration` | One actor requests 25 or more distinct numeric ids on one templated route within 10 minutes, and 80% of them sit in a run of consecutive values. | crit | Use opaque ids (UUIDs); check authorisation on every record; rate-limit per actor. |
| `signup-burst` | 5 or more successful (2xx or 3xx) POSTs to a sign-up route (`/signup`, `/register`, `/sign-up`, `/auth/register`, `/users` and `/api/` variants) from one actor or one network within 1 hour, or 10 or more from one user agent class `automation`. | warn | Add a bot challenge and email verification; limit sign-ups per network. |
| `route-probe` | One actor requests 30 or more distinct routes with 40% or more answered 404 or 405, or requests any admin, internal, debug or `.env`-style route that is not answered 2xx. | warn | Remove dead and debug routes; alert on admin probes; never answer them with detail. |
| `machine-cadence` | One actor makes 200 or more requests in an hour with a coefficient of variation of the gaps below 0.15, or 100 or more with a user agent class of `automation`. | info | Slow such actors gradually rather than blocking them outright. |

A browser actor reloading pages, an SPA polling one endpoint at a fixed interval below 200 requests an hour, and a declared crawler reading HTML pages must not fire any check (the fixtures enforce this).

## Tiers

Each flagged actor gets the highest tier any of its findings recommends:

- `watch` (info findings): note it, nothing more.
- `slow` (one warn): rate-limit that actor.
- `challenge` (two or more warns, or a sign-up burst): bot challenge before further writes.
- `block` (any crit): stop serving that actor until a person reviews it.

Tiers are advice in the report. Diarea applies none of them.

## Allowlist

`--allow` reads a JSON file:

```json
{
  "networks": ["203.0.113.0/24"],
  "userAgents": ["ResearchBot/"],
  "apiKeyPrefixes": ["pk_partner_"]
}
```

Matching happens in `watch-parse.js` before hashing, so allowlisted traffic never enters the engine. `apiKeyPrefixes` match an `Authorization` header field in JSON lines when the log has one (Combined Log Format has none). The report states how many events the allowlist removed.

## Score and report

- Score: `scoreOf(findings)` from `checks.js`, so the 0 to 100 scale and weights match `scan`.
- Labels and colours: the same four bands (`bandOf`), with watcher wording for each band's line, kept in `behaviour.js` (for example, Gushing: "Something is reading your API like a manual.").
- The report opens with events read, actors seen, lines skipped, events allowlisted and the time span, then findings ordered by severity, then the flagged actors with their tier.
- `--json` emits `{ tool: "diarea", mode: "watch", score, band, stats, findings, actors }`.

## Error handling

- Missing or unreadable file, empty input, or nothing parsable: exit 2 with a one-line reason naming the path as given (never an absolute local path).
- Malformed allowlist: exit 2 naming the bad field.
- A single bad line never stops the run.

## Testing

`test/run.js` gains a watcher section, with no fixtures stored as files: logs are assembled in the test.

- Each of the five checks fires on its own synthetic log and on a JSON-lines copy of it.
- A clean log of ordinary browsing (several browser actors, an SPA poll, a declared crawler) scores 0.
- The allowlist removes a sweeping actor and the score drops to 0.
- No report, text or JSON, contains an IP address, a query value or a raw user agent string (asserted against the inputs).
- `routeOf` cases: numbers, UUIDs, hashes, and paths that must not be templated.
- `--since` is relative to the newest event.
- Exit codes: 0, 1 with `--fail-on`, 2 on an empty or unparsable file.
