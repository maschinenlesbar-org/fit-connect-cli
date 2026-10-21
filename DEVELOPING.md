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
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
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
  onWarning: (message) => log.warn(message), // an answer delivered changed: invalid text replaced with U+FFFD (else silent)
  bigIntegerKeys: new Set(["id"]), // members whose numbers may pass 2^53: delivered as their exact literal, a string (default none)
});
```

Every optional field of the option and parameter types (`FitConnectClientOptions`,
`EngineOptions`, `RouteQuery`, `AreaQuery`) is typed `?: T | undefined`, and an option given
as `undefined` means what an omitted one means, so `{ baseUrl: process.env.X }` compiles under
`exactOptionalPropertyTypes` too.

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
  20-digit id with HTTP 500. The API has no bound of its own: live (2026-10-06) it answers
  that 500 for every id it doesn't know — `99999`, `123456789`, `2147483647` and
  `2147483648` alike — so the int32 cap only keeps the value a plain number; real ids have
  ≤ 5 digits.
  On `routes` and `areas`, `offset` must be an integer 0..`MAX_OFFSET` (2147483647)
  and `limit` 1..`MAX_LIMIT` (500), and `offset + limit` (the limit defaulting to
  `DEFAULT_LIMIT`, 100) at most `MAX_OFFSET` — the API adds them in a 32-bit integer and
  answers an overflow with HTTP 500 — else a `FitConnectValidationError`.
- `areas({ search, offset?, limit? })` → `AreaResult`. `search` is a string or
  string array; each term is normalised to NFKC (the API 500s on a decomposed
  umlaut or fullwidth digits), and combining marks NFKC leaves over are dropped (the
  API 500s on those too: `"Kö\u0308ln"` searches `Köln`); digits of another script are
  written as ASCII digits by value (`٦٠٣١١` → `60311`), and any other letter, digit or symbol
  than A–Z, a–z, Ä, Ö, Ü, ä, ö, ü, ß and 0–9 (`É`, Cyrillic, `Ł`, `+`, an emoji) rejects with
  a `FitConnectValidationError` naming it (`UNSEARCHABLE`; the API answered each with HTTP 500
  live, 2026-10-21); the result is split into
  words on whitespace and punctuation (`"Halle (Westf.)"` → `Halle`, `Westf`; `*` is kept). Words with fewer than 2
  non-wildcard characters are left out and a repeated word is sent once; a search
  with no word left, more than 10 words, or a `*` inside a word part shorter than 2
  characters rejects (the API answers each with a 400). `areaSearchWords(search)`
  (exported) returns the `words` sent, the `dropped` ones and the `separators` the search
  was split at (distinct characters other than a plain space, in order of first
  appearance), which the CLI lists in two stderr notes — invisible separators as `U+XXXX`,
  dropped words each once and at most 10 of them (`quoteValues`, which also bounds the
  typed terms a "No usable search word" error quotes). The client
  does not fold `ß` to `ss` itself: the API matches them alike (live, 2026-10-06: `Giessen` and
  `Gießen` each return the same 45 areas). The wildcard rule is the
  spec's `^(\*?([^\*]{2,})\*?)*$`, checked by `isAreaSearchWord` (exported) in one
  linear scan rather than with that regex, whose nested quantifiers backtrack
  exponentially (a 45-character word with a misplaced `*` took 57 s);
  `packages/client/test/area-word.test.ts` checks it against the pattern on every short word and times
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
  (`GET https://routing-api-prod.fit-connect.fitko.net/v2/routes?…: unexpected response
  shape: "routes" is not an array.`), never data, since the skills read `count: 0` as a valid
  answer. So are an empty body (`GET <url>: empty response body.`), one that isn't JSON
  (`GET <url>: the answer is not valid JSON (expected JSON, got Content-Type "text/html").`),
  a body too large to become one string (512 MB and more, possible only with
  `maxResponseBytes: 0`: `GET <url>: the answer is too large to read as text (N bytes; the
  longest string is 536870888 characters).`; an error status with such a body keeps its
  `FitConnectApiError`, without the body) and an answer with a number `JSON.parse` cannot
  carry exactly (`GET <url>: the number 12345678901234567890 cannot be represented
  exactly.`): one out of
  a double's range (`1e400`), one past 2^53 in any written form (`9007199254740993e0`,
  `9007199254740992.5`), a non-zero one too small (`1e-400`), or a subnormal one (below
  2.2250738585072014e-308, where a double has fewer digits) that doesn't print as written
  (`3e-324` prints as `5e-324`; `5e-324` and `1e-310` pass), rather than a changed
  value. Past 2^53 the number as written is compared with the number as printed
  (`String(value)`), not with the double's exact binary value: `12345678901234567890` prints
  as `12345678901234567000` and is refused, while `1E23` or `1.7976931348623157E308` (a
  double a server printed in its shortest form) print as the same number and pass. Below
  2^53 a decimal fraction keeps a double's precision. The answer's numbers are
  counts, offsets, version parts and durations, none near 2^53.
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
  — a `3xx` surfaces as an error rather than being chased to another host. The error names
  the target so the base URL can be fixed: `HTTP 301 for GET <url>: redirect to <target> not
  followed` (or `redirect not followed (no Location header)`), and
  `FitConnectApiError.location` holds it — resolved against the request URL, userinfo
  redacted, control and bidi characters dropped. A base URL on
  plain `http:` to a host other than loopback (`localhost`, `127.0.0.0/8`, `::1`) gets one
  `WARN` record of `fit-connect.http` on stderr per run, before the first request (`action()` in
  `apps/cli/src/cli/shared.ts`); the sentence comes from the exported `cleartextProblem(baseUrl,
  secrets?)`, names the host and, for a `user:password@`, "the base URL's credentials"
  (never the value). Help, version and usage errors never warn.
- **Credentials in `--base-url` never reach the output.** A `user:password@` in the
  base URL (a credentialed mirror or proxy) is sent as Basic auth by Node, and is
  redacted everywhere the CLI prints: `run.ts` (`redactionFor`, used by
  `withRedactedOutput`) takes the exact userinfo of every URL argument (`credentialsIn`,
  exported) and replaces it with `***` — in commander's usage errors, which echo a
  rejected `--base-url` value or an unknown command, and in the CLI's own messages — so a
  password with spaces, quotes, `#`, `?` or `/` is caught as well as an ordinary one. Only
  a value that starts with a scheme counts (a bare `a:b@c` is a search text or a
  User-Agent as often as a credential, and stays as it is), except as the `--base-url`
  value, where a `user:password@host` typed without its scheme is still a credential. On
  stderr the log replaces them in each record's message, before the record is cut and
  escaped (`createLogger({ redact })`), so a password holding DEL, C1 or bidi characters
  is found in its raw form, and the record's frame (time, level, topic) is never touched;
  `io.out` (stdout) is redacted as a whole. The forms a server echoes a userinfo back in
  are replaced too: the `Basic` value and the decoded `user:password` on stdout and
  stderr, the password alone (4 characters or more) on stderr only, since it may well
  occur in the data. `redactUrl` (exported) falls back to
  the same text-based cut for a value that doesn't parse as a URL.
- **The library keeps them out of what a service logs.** The engine holds the base URL
  in a real `#private` field, so `console.log(client)`, `util.inspect` and
  `JSON.stringify` never show it; `FitConnectApiError.url` carries the request URL with
  its userinfo redacted (`https://***@host/…`); and the userinfo (raw and
  percent-decoded), and the forms a server echoes it back in (the `Basic` value, the
  decoded `user:password`, the password alone from 4 characters: `echoedCredentialForms`),
  are scrubbed from error bodies, transport error text and the `cause` chain. Whatever a custom transport throws reaches the caller as a
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

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/fit-connect-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/fit-connect-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/fit-connect-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
routing-api.yaml     # the Routing API's OpenAPI spec, for reference (not shipped)
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { FitConnectClient } from
  "@maschinenlesbar.org/fit-connect-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/fit-connect-client/internal/engine`) for what the
  CLI needs beyond that; `"./test/*"` reaches the client's test helpers from the CLI's
  tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    types.ts     # response interfaces (Route, RouteResult, Area, AreaResult, Info, ...)
    query.ts     # dependency-free query-string builder (repeats keys for arrays)
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON decoding, error mapping
    errors.ts    # FitConnectError / …ApiError / …NetworkError / …ParseError / …ValidationError
    validate.ts  # the Problem type + assertValid(): input rules shared by library and CLI
    client.ts    # FitConnectClient — routes() / areas() / info() over the engine
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O seam (stdout/stderr) + client factory, the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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
- **Rendering** (`renderJson` in `shared.ts`): an answer that can't be printed is an
  `OutputError`, an ERROR record of `fit-connect.output` naming the real cause: `The answer is
  nested too deeply to pretty-print.` (a stack overflow) or `The answer is too large (more than
  536870888 characters of JSON) to pretty-print.` (V8's longest string). `; try --compact` is
  added only when the compact form of that very answer prints (probed, not assumed from the Node
  version). `holdsHugeString` walks the answer iteratively, without an allocation per value
  (`Object.entries` made a pair per element: 7 GB and a crash on 48M numbers).
  `escapeControlChars` (DEL, C1 and the bidi controls as `\uXXXX`) counts first and refuses an
  output past V8's longest string (`The answer is too large to print (N characters once its
  control characters are escaped).`), then builds the text in 64 Ki chunks: one `+=` per
  character crashed the heap on 95 MiB of DEL. `--compact` takes V8's fast `JSON.stringify` path,
  which on Node 26 is the only one that prints very deep nesting, unless the answer holds a
  string or key of 64 Mi characters or more (`holdsHugeString`): there the fast path aborts
  the process on Node 26, so such an answer goes through the gap path (an empty gap, the
  same text).
- The Routing API version (`v1`/`v2`) is a **path prefix**; the client owns it as
  `apiVersion` and builds `/${apiVersion}/{routes,areas,info}` from it.

### Library / technical terms

**API client.** [`FitConnectClient`](packages/client/src/client.ts) — the typed wrapper
over the Routing API. Usable as a library independently of the CLI; defaults to
the production routing service and API `v2`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in `http`/`https`;
tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON responses and maps
errors. Sits between the client's methods and the transport.

**Query-string builder.** [`query.ts`](packages/client/src/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, **repeats keys for arrays** (used for the
multi-valued `areaSearchexpression`), and encodes spaces as `%20`. Note the API
**ANDs** repeated `areaSearchexpression` values (every term must match the same
area) and answers `500` when a value contains a space or punctuation such as `(`,
`.` or `-`; the client therefore splits each search term on whitespace and
punctuation into separate values, keeping letters, digits and `*`. The spec
(`routing-api.yaml`) also limits the values to 1..10, each with at least 2
non-wildcard characters, so `areaSearchWords` drops shorter words and rejects the rest.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `FitConnectApiError`
(non-2xx; carries `status`/`detail`/`url`/`body`; `detail` is read from the
RFC 7807 `application/problem+json` body's `detail`/`title`/`message`, followed by
its `violations[]` as `(field: message; …)` — a 400 "Constraint Violation" names the
rejected parameter and rule only there), `FitConnectNetworkError`
(transport failure/timeout; its message names the request, `GET <url> failed: <reason>` with
the userinfo redacted and ` (after N retries)` for a reset that was retried, the original
error as `cause`: a timeout, the size cap, a refused connection, a DNS failure and a reset
alike), `FitConnectParseError` (bad JSON, an empty body, an unknown charset, an inexact
number or a 2xx body without the documented shape; its message names the request the same
way, `GET <url>: …`, userinfo redacted) and `FitConnectValidationError` (every input the library rejects
before a request: client options, `apiVersion`, the leikaKey, selectors, search words,
paging), all extending `FitConnectError`. A `catch (e) { if (e instanceof
FitConnectValidationError) … }` therefore catches every rejected input, never a raw
`TypeError`. A server `detail` in a message is cut at 500 characters (`body` keeps it
all; `cutForMessage`, `MAX_MESSAGE_VALUE_LENGTH`, also for a redirect target and an
unknown response charset), and an echoed input (`Invalid leikaKey "…"`) is cut at 100 characters and quoted
with control characters, every Unicode format character (bidi controls, zero-width
characters, the soft hyphen) and U+2028/U+2029 escaped (`quoteValue`, also for a parameter
name and a wrong-typed string); commander's own echo of a rejected option value gets the same
escapes in `run.ts` (`escapeCommanderError`), so a refused `94<ZWSP>0` reads `94\u200b0`. No cut lands inside a surrogate
pair (`cutText`), so a message stays well-formed.

**Input validation.** [`validate.ts`](packages/client/src/validate.ts): a rule is a pure
`<thing>Problem(value)` function that returns why a value is invalid, or `undefined`.
The library enforces it with `assertValid(name, value, problem)` before any request,
which throws `FitConnectValidationError` (extends `FitConnectError`, exported) with the
message `Invalid <name>: <reason>`; a method that returns a promise rejects with it. The
CLI's option parsers call the same `…Problem` functions, so an input gets the same
outcome on both sides, and `run.ts` reports a `FitConnectValidationError` raised in an
action as a usage error (an `ERROR` record of `fit-connect.cli`, exit `1`).
Every value that goes into a request passes one rule for its kind: a token (the
Leistungsschlüssel, an AGS, an ARS, an area id) `tokenProblem` — not blank, not only invisible
characters or combining marks, no lone surrogate, no control or format character (a zero-width
space, a soft hyphen, ZWJ, a bidi control) — then its digit pattern, and is sent as
`normalizeToken` (trimmed, NFC); a search term `textProblem` — the same, but TAB, LF and CR
are whitespace there (they split words) — then `areaSearchWords`. Unlike the kit's text rule,
`textProblem` refuses ZWJ and ZWNJ too, as no name the API can find needs one. The reasons
quote the value with its invisible characters escaped (`"Frank\u00adfurt" contains an
invisible character (U+00AD).`). All three are exported.

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

Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`fit-connect.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole
seconds, ms under 1 s). Tests: `apps/cli/test/retry-log.test.ts`.

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
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`,
`area-word`, `types`), everything that drives the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation (array repetition, wildcards, spaces).
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, UA fallback — mocked transport.
- **`client.test.ts`** — path/version building, query params, area-selector validation — mocked transport.
- **`validate.test.ts`** — `assertValid` and the `parity()` helper (`apps/cli/test/helpers.ts`), which sends one input through `run()` and through the library, each on a recording mock transport, so a test can assert both give the same outcome.
- **`shared.test.ts`** — option parsing (`parseIntArg`, `parseApiVersion`), `toClientOptions` mapping, and the `JSON.stringify` path `--compact` takes (mocked, so no huge body is built).
- **`parity.test.ts`** — CLI ↔ library parity: one input through `run()` and through the library (`parity()`), asserting the same outcome.
- **`cli.test.ts`** — end-to-end command parsing, rendering, error/exit codes and option flow-through — mocked client.
- **`io.test.ts`** — `handleOutputErrors` (EPIPE on a closed stdout exits 0; on a closed stderr it is ignored, so the run keeps its exit code) — fake streams.
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`types.test.ts`** — a consumer file compiled by `tsc` with `exactOptionalPropertyTypes`
  passes `undefined` for every option (starts a process: 30 s), and every option given as
  `undefined` means its default at run time.
- **`area-word.test.ts`** — the area search wildcard rule (`isAreaSearchWord`) against the spec's
  pattern on every short word, and the timing of the worst-case words (each well under 100 ms).
- **`conformance-p*.test.ts`** — the workspace's shared conformance checks from the 2026-10-05 review:
  P1 credential redaction in CLI output, P2 in library objects, P4 base-URL validation (P19 skipped:
  no environment variable), P5 the transport contract, P6 the retry policy, P7 pipes and exit codes
  (runs the built bin), P8/P9/P13 charset, 2xx shapes and error classes, P10 strict parameters, P20
  the stderr warning for a plain-`http:` base URL (follow-up round 2026-10-06; the environment and
  API-key cases skipped: no variable, no key), P21 README links (a relative link must point at a
  file `files` ships, since npmjs.com shows the README; anything else is an absolute GitHub URL),
  P23 the log on stderr (records with timestamp, level and topic; `--log-format text|jsonl`),
  P24 the input corpus (every corpus value through the area search and the four tokens —
  leikaKey, `--ags`, `--ars`, `--area-id` — on the CLI and in the library, is refused before
  any request or sent canonical: the search trimmed in NFKC, a token trimmed in NFC; a blank,
  invisible, control or half character is refused with the character shown escaped; no list
  option, so its list cases have nothing to run), P25 the response corpus (a number a
  double can't carry exactly, a subnormal that prints changed, and an empty answer, are parse
  errors naming the request), P26 output integrity (the CLI has no `-o`, so only its stdout
  case runs, `HAS_OUTPUT_OPTION = false`: stdout redirected to a file and cut short by a
  file-size limit exits 1 with an ERROR record of `fit-connect.output`), P27 big and odd answers
  (a large flat answer and 20 MB of DEL print within a small heap, 90 MB of DEL is a clean
  ERROR record, a lone surrogate or invalid bytes become U+FFFD with a WARN).
  Copied across the `*-cli` repos; only the adapter block at the top differs.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches
  `apps/cli/package.json`, test, generate the CycloneDX SBOMs (scoped to the `apps/cli`
  workspace), then `npm pack --workspace apps/cli`, and create a GitHub Release.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/fit-connect-cli/> in English and
<https://maschinenlesbar.org/fit-connect-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` (which
also says where the published manifest and the built program are: `manifest:
apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/fit-connect-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `fit-connect.<area>`. `--log-format text` (the
default) writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages and the help it shows
after one, the notes on left-out search words, unexpected errors), `api` (the API's
answers, and a WARN through the engine's `onWarning` when invalid text in one was replaced
with U+FFFD), `http` (the connection, the cleartext warning) and `output` (a stdout write
error, an answer too deeply nested or too large to print). A malformed answer (a `FitConnectParseError`: bad JSON, the wrong shape, an HTML
page answered with 200, an unknown charset) is an `api` record too, as the API's answer
it is. Code logs through
`logOf(deps)` and never writes diagnostics with `io.err` directly. `run()` builds the
logger from argv before commander parses it (`logFormatFromArgv`, used only for the
records of a parse error: the first `--log-format` counts, and the value of one of the
program's own value options is skipped, as commander reads it; a `preAction` hook then sets the format
commander parsed, so `--user-agent --log-format=jsonl` logs text), so commander's own
usage errors are records too: its `error: …` an ERROR of `cli` (a `(Did you mean …?)` line joined to it), the help
it shows after one an INFO record per line, and a run with global options but no command
an ERROR "missing command: `fit-connect <subcommand>`" before that help, so every failed run
has an ERROR record (`writeCommanderErr`); that run exits 1, like every usage error.
`run.ts` replaces commander's built-in `help [command]` with its own `help [command...]`
(`addHelpCommand`, in `configureTree`, so the tree the website documents is unchanged): it
walks every name, and an unknown one is reported like `fit-connect nope` (`error: unknown
command 'nope'`) and exits 1 as well, where the built-in one showed the root help and said nothing. The log
is built with the run's redaction, which replaces a secret in the message before the
record is formatted, so a secret is kept out of the log in either format and the frame
is never touched. Node's own process warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`) are WARN
records of `fit-connect.cli` too: the bin shim installs `installWarningLog`, which removes
Node's default `warning` listener and logs `(node) <name>: <message>` through
`processLogger(argv)`. In `defaultIO` a record waits for stdout (`stderrAfterStdout`): it
is held while stdout has a backlog and written, in order, once it is gone, so with
`2>&1 |` and a slow reader it never lands inside the data. `CliDeps.now` makes the
timestamps testable. stdout carries data only. A
stdout write error other than a closed pipe (EBADF, EIO; and when stdout is a regular file,
`> out.json`, a write cut short by a file-size limit or a full disk, EFBIG or ENOSPC:
`stdoutWriter` writes every byte with `writeSync` in a loop, where Node's stream ignored a short
count and exited 0) is an ERROR record of `fit-connect.output` too, `Could not write to stdout: …` (`handleOutputErrors`, which the
bin shim installs outside any run with `processLogger(argv)`: the format argv asks for,
the run's redaction), and exits 1; a reader that stops early (EPIPE, ENOTCONN) exits 0
quietly. Conformance test P23 checks all of this, and its body is shared across the
*-cli repos.
