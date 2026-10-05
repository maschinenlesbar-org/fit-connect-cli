# Developing & integrating

This document covers `fit-connect-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`fit-connect`) and a typed API client
(`FitConnectClient`) for the
[FIT-Connect Routing API](https://docs.fitko.de/fit-connect/docs/apis/routing-api/)
(`routing-api-prod.fit-connect.fitko.net`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface and response shapes derived from the routing-api 2.0.0 OpenAPI spec.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only scope** — wraps only the Routing API; no Submission/write path.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
fit-connect --help
```

## Library usage

```ts
import { FitConnectClient, FitConnectApiError } from "@maschinenlesbar.org/fit-connect-cli";

const client = new FitConnectClient(); // defaults to the prod routing service, v2

// "who is responsible for service X in area Y?"
const result = await client.routes({
  leikaKey: "99123456760610",
  ars: "160510000000", // exactly one of ags / ars / areaId
});
for (const route of result.routes) {
  console.log(route.destinationName, route.destinationId);
}

// resolve a place name -> area ids
const areas = await client.areas({ search: "Hanau" });

try {
  await client.info();
} catch (err) {
  if (err instanceof FitConnectApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new FitConnectClient({
  baseUrl: "https://routing-api-prod.fit-connect.fitko.net",
  apiVersion: "v2",           // "v1" | "v2" — path prefix; v2 is current
  timeoutMs: 30_000,
  maxRetries: 2,              // 429 / 503 and resets are retried (honours Retry-After, else linear backoff)
  maxResponseBytes: 100 << 20,// abort responses larger than 100 MiB (0 = unlimited)
  userAgent: "my-app/1.0",    // default is accepted; some UA strings are blocked by bot detection
  transport: customTransport, // inject your own HTTP transport (the engine enforces timeoutMs / maxResponseBytes)
});
```

Only an omitted (`undefined`) `baseUrl` selects the production default; an empty
or blank one, a non-http(s) URL, one with a `?query` or `#fragment`, surrounding
whitespace or a control character, and one whose user name or password has a `%`
that isn't an escape (write a literal `%` as `%25`) throw a
`FitConnectValidationError` (`Invalid baseUrl: Expected an absolute http(s) URL.`),
as `--base-url` rejects them in the CLI. One rule, `baseUrlProblem` (exported),
decides for both, and its reasons never repeat the value.

The constructor range-checks the numeric options and throws a
`FitConnectValidationError` (`Invalid maxRetries: Expected an integer between 0 and
10.`) unless each is a safe integer in range: `timeoutMs` 0..`MAX_TIMEOUT_MS`
(2147483647), `maxRetries` 0..`MAX_RETRIES` (10), `retryDelayMs` and
`maxResponseBytes` non-negative. `0` keeps its documented meaning (no timeout, no
size cap, no retries); a negative, `NaN`, fractional or infinite value is rejected
rather than silently disabling the limit. The CLI's `--timeout`, `--max-retries` and
`--max-response-bytes` parsers use the same bounds (`intRangeProblem`).

### Client surface

- `routes({ leikaKey, ags? , ars?, areaId?, offset?, limit? })` → `RouteResult`.
  Requires `leikaKey` and **exactly one** of `ags` / `ars` / `areaId`; both rules
  are enforced client-side (a `FitConnectValidationError` rejection) before any request.
  Selectors are trimmed, and a blank one (`""` or whitespace) rejects with a
  `FitConnectValidationError` (`Invalid ags: Value must not be blank.`, the
  `nonBlankProblem` rule the CLI's `--area-id` parser uses too) rather than counting
  as not given; `ags` / `ars` must match `AGS_PATTERN` / `ARS_PATTERN` (the API's lengths),
  and `areaId` must be a positive whole number without leading zeros, at most
  `MAX_AREA_ID` (`areaIdProblem`, which `--area-id` uses too): the API answers `0940` or a
  20-digit id with HTTP 500. The int32 bound is an assumption; ids seen have ≤ 5 digits.
  On `routes` and `areas`, `offset` must be an integer 0..`MAX_OFFSET` (2147483647)
  and `limit` 1..`MAX_LIMIT` (500), and `offset + limit` (the limit defaulting to
  `DEFAULT_LIMIT`, 100) at most `MAX_OFFSET` — the API adds them in a 32-bit integer and
  answers an overflow with HTTP 500 — else a `FitConnectValidationError`.
- `areas({ search, offset?, limit? })` → `AreaResult`. `search` is a string or
  string array; each term is normalised to NFKC (the API 500s on a decomposed
  umlaut or fullwidth digits), and combining marks NFKC leaves over are dropped (the
  API 500s on those too: `"Kö\u0308ln"` searches `Köln`); the result is split into
  words on whitespace and punctuation (`"Halle (Westf.)"` → `Halle`, `Westf`; `*` is kept). Words with fewer than 2
  non-wildcard characters are left out and a repeated word is sent once; a search
  with no word left, more than 10 words, or a `*` inside a word part shorter than 2
  characters rejects (the API answers each with a 400). `areaSearchWords(search)`
  (exported) returns the `words` sent and the `dropped` ones. The wildcard rule is the
  spec's `^(\*?([^\*]{2,})\*?)*$`, checked by `isAreaSearchWord` (exported) in one
  linear scan rather than with that regex, whose nested quantifiers backtrack
  exponentially (a 45-character word with a misplaced `*` took 57 s);
  `test/area-word.test.ts` checks it against the pattern on every short word and times
  the worst cases.
- `info()` → `Info` (the deployed API's semantic version).
- `routes()` and `areas()` reject a parameter they don't take (`areaid`, `ARS`, a
  `__proto__` key from JSON) and a value of the wrong type (`areaId: 940`, `ars: ["16"]`,
  `limit: "50"`, a number in the `search` array) with a `FitConnectValidationError`
  naming the key or the value (`Invalid areaId: expected a string, got 940.`) before any
  request. They used to drop such a value as "not given", so `routes({ ars: "16",
  areaId: 940 })` answered for the whole Land.
- Every method checks the answer's shape before returning it: `routes` / `areas` need
  `{ count, offset, totalCount, routes|areas: [object, …] }` with integer counts,
  `info` `{ version: { major, minor, patch } }`. Anything else — `null`, `{}`, an array,
  a string, an error envelope a proxy answered with `200` — is a `FitConnectParseError`
  (`Unexpected response from /v2/routes: "routes" is not an array, not the documented
  shape.`), never data, since the skills read `count: 0` as a valid answer.
- `client.apiVersion` reflects the configured version.

## Authentication internals

The FIT-Connect **Routing API requires no authentication and no API key** — it is
the open, read-only routing service. The client attaches no credential headers.

Two non-obvious upstream behaviours the client handles:

- **Bot detection.** The Routing API filters on the `User-Agent`: the default
  (`fit-connect-cli`) is accepted, but some UA strings are blocked with `403`, so
  overriding `--user-agent` may cause failures. A missing or blank UA is *not*
  itself rejected; the client falls back to the default for an empty or
  whitespace-only `--user-agent` regardless. One rule, `resolveUserAgent` (exported),
  decides this for the library and the CLI: the raw value is checked first
  (`headerValueProblem`: no control character other than tab, nothing above U+00FF,
  else a `FitConnectValidationError`), so whitespace such as `"\n"`, `" \r\n "`,
  U+2028, U+FEFF or U+3000 is rejected rather than falling back; only spaces, tabs
  and other Latin-1 whitespace (U+00A0) fall back.
- **`--base-url` is trusted input**: the CLI fetches whatever host you point it
  at; only `http:`/`https:` URLs are accepted, and redirects are **not** followed
  — a `3xx` surfaces as an error rather than being chased to another host.
- **Credentials in `--base-url` never reach the output.** A `user:password@` in the
  base URL (a credentialed mirror or proxy) is sent as Basic auth by Node, and is
  redacted everywhere the CLI prints: `run.ts` (`withRedactedOutput`) takes the exact
  userinfo of every argument (`credentialsIn`, exported) and replaces it with `***` in
  every line — commander's usage errors, which echo a rejected `--base-url` value or an
  unknown command, and the CLI's own messages — so a password with spaces, quotes, `#`,
  `?` or `/` is caught as well as an ordinary one. `redactUrl` (exported) falls back to
  the same text-based cut for a value that doesn't parse as a URL.
- **The library keeps them out of what a service logs.** The engine holds the base URL
  in a real `#private` field, so `console.log(client)`, `util.inspect` and
  `JSON.stringify` never show it; `FitConnectApiError.url` carries the request URL with
  its userinfo redacted (`https://***@host/…`); and the userinfo (raw and
  percent-decoded) is scrubbed from error bodies, transport error text and the `cause`
  chain. Whatever a custom transport throws reaches the caller as a
  `FitConnectNetworkError` (the original, scrubbed, as `cause`).
- **`destinationSignature` is passed through unverified.** Each route carries a
  JWS (RFC 7515) over its addressing information. This client treats it as an
  **opaque string** — it does no JWS/JWK/crypto validation of any kind (there is
  no `node:crypto`/JWT/jose code in the repo, by design). **Verifying the JWS is
  the consumer's responsibility:** validate it against FITKO's published
  FIT-Connect keys per the FIT-Connect spec before trusting `destinationId` to
  submit an application, so a spoofed/MITM'd routing response cannot misdirect a
  submission. Do **not** add home-rolled JWT validation here.

## Architecture

```
src/
  client/
    types.ts     # response interfaces (Route, RouteResult, Area, AreaResult, Info, ...)
    query.ts     # dependency-free query-string builder (repeats keys for arrays)
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON decoding, error mapping
    errors.ts    # FitConnectError / …ApiError / …NetworkError / …ParseError / …ValidationError
    validate.ts  # the Problem type + assertValid(): input rules shared by library and CLI
    client.ts    # FitConnectClient — routes() / areas() / info() over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr) + client factory
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # routes, areas, info
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`).
  The default uses `node:http`/`https`; tests inject a mock. This keeps the client
  free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole
  program can be driven in-process by tests with a mocked client and captured
  output — no subprocesses.
- The Routing API version (`v1`/`v2`) is a **path prefix**; the client owns it as
  `apiVersion` and builds `/${apiVersion}/{routes,areas,info}` from it.

### Library / technical terms

**API client.** [`FitConnectClient`](src/client/client.ts) — the typed wrapper
over the Routing API. Usable as a library independently of the CLI; defaults to
the production routing service and API `v2`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in `http`/`https`;
tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON responses and maps
errors. Sits between the client's methods and the transport.

**Query-string builder.** [`query.ts`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, **repeats keys for arrays** (used for the
multi-valued `areaSearchexpression`), and encodes spaces as `%20`. Note the API
**ANDs** repeated `areaSearchexpression` values (every term must match the same
area) and answers `500` when a value contains a space or punctuation such as `(`,
`.` or `-`; the client therefore splits each search term on whitespace and
punctuation into separate values, keeping letters, digits and `*`. The spec
(`routing-api.yaml`) also limits the values to 1..10, each with at least 2
non-wildcard characters, so `areaSearchWords` drops shorter words and rejects the rest.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output.

**Error types.** [`errors.ts`](src/client/errors.ts): `FitConnectApiError`
(non-2xx; carries `status`/`detail`/`url`/`body`; `detail` is read from the
RFC 7807 `application/problem+json` body's `detail`/`title`/`message`, followed by
its `violations[]` as `(field: message; …)` — a 400 "Constraint Violation" names the
rejected parameter and rule only there), `FitConnectNetworkError`
(transport failure/timeout), `FitConnectParseError` (bad JSON or a 2xx body without
the documented shape) and `FitConnectValidationError` (every input the library rejects
before a request: client options, `apiVersion`, the leikaKey, selectors, search words,
paging), all extending `FitConnectError`. A `catch (e) { if (e instanceof
FitConnectValidationError) … }` therefore catches every rejected input, never a raw
`TypeError`. A server `detail` in a message is cut at 500 characters (`body` keeps it
all), and an echoed input (`Invalid leikaKey "…"`) is cut at 100 characters and quoted
with control and bidi characters escaped (`quoteValue`).

**Input validation.** [`validate.ts`](src/client/validate.ts): a rule is a pure
`<thing>Problem(value)` function that returns why a value is invalid, or `undefined`.
The library enforces it with `assertValid(name, value, problem)` before any request,
which throws `FitConnectValidationError` (extends `FitConnectError`, exported) with the
message `Invalid <name>: <reason>`; a method that returns a promise rejects with it. The
CLI's option parsers call the same `…Problem` functions, so an input gets the same
outcome on both sides, and `run.ts` reports a `FitConnectValidationError` raised in an
action as a usage error (`Error: <message>`, exit `1`).

**Retry / backoff.** Transient `429` and `503` are retried automatically with
backoff, up to `maxRetries` (default `2`; `0`..`MAX_RETRIES` = 10, checked by the library).
Each retry waits `retryDelayMs * attempt` (`retryDelayMs` 0..30 000, default 200), or a
`Retry-After` header when that is longer (delta-seconds or an IMF-fixdate HTTP-date,
parsed strictly by `parseRetryAfter`; a malformed, negative or fractional value falls
back to linear backoff): the header can lengthen a wait, never shorten it, so
`Retry-After: 0` or a past date doesn't turn the retries into a burst. Without a usable `Retry-After`, the
`RateLimit-Reset` header is used — the Routing API documents it as the 429 backoff
signal and sends no `Retry-After`; `parseRateLimitReset` reads delta-seconds, or a
Unix timestamp for values ≥ 10^9, because the spec's wording allows both. A wait
above `MAX_RETRY_AFTER_MS` (30 s) is not retried at all: the error surfaces at once,
with `retryAfterMs` set and a message that names the wait (`…; the server asked to
retry after 120 s, longer than the 30 s the client waits; not retried — try again after
that`). After spent retries the message ends `(after N retries)` and `retries` holds the
count. `FitConnectApiError.isRetryable` reflects the transient statuses. A connection reset (`ECONNRESET`,
`EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the error's `cause`
chain) is retried the same way with linear backoff; a refused connection, a DNS
failure and a timeout are not.

**Custom transports.** The engine, not the transport, enforces the documented limits:
every call runs under the `timeoutMs` deadline (the request carries an `AbortSignal`
in `signal`, which the built-in transport honours and a `fetch` transport should pass
on), and a body over `maxResponseBytes` is rejected after the fact. Headers are read in
any letter case and from a `Headers` object or a `Map`, the body may be any
ArrayBuffer view or an ArrayBuffer, and whatever a transport throws or returns that
isn't a usable response becomes a `FitConnectNetworkError`.

**problem+json content type.** The Routing API serves the `/areas` *success* body
as `application/problem+json` (not `application/json`). The engine does not gate
on content type — it parses any JSON body — so this is handled transparently.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation (array repetition, wildcards, spaces).
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, UA fallback — mocked transport.
- **`client.test.ts`** — path/version building, query params, area-selector validation — mocked transport.
- **`validate.test.ts`** — `assertValid` and the `parity()` helper (`test/helpers.ts`), which sends one input through `run()` and through the library, each on a recording mock transport, so a test can assert both give the same outcome.
- **`shared.test.ts`** — option parsing (`parseIntArg`, `parseApiVersion`) and `toClientOptions` mapping.
- **`parity.test.ts`** — CLI ↔ library parity: one input through `run()` and through the library (`parity()`), asserting the same outcome.
- **`cli.test.ts`** — end-to-end command parsing, rendering, error/exit codes and option flow-through — mocked client.
- **`io.test.ts`** — `handleOutputErrors` (EPIPE on a closed stdout exits 0; on a closed stderr it is ignored, so the run keeps its exit code) — fake streams.
- **`conformance-p*.test.ts`** — the workspace's shared conformance checks from the 2026-10-05 review
  (P1 credential redaction in CLI output, …); copied across the `*-cli` repos, only the adapter
  block at the top differs.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, generate CycloneDX SBOMs, and create a GitHub Release.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/fit-connect-cli/> in English and
<https://maschinenlesbar-org.github.io/fit-connect-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/fit-connect-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
