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
  maxRetries: 2,              // 429 / 503 are retried (honours Retry-After, else linear backoff)
  maxResponseBytes: 100 << 20,// abort responses larger than 100 MiB (0 = unlimited)
  userAgent: "my-app/1.0",    // default is accepted; some UA strings are blocked by bot detection
  transport: customTransport, // inject your own HTTP transport
});
```

### Client surface

- `routes({ leikaKey, ags? , ars?, areaId?, offset?, limit? })` → `RouteResult`.
  Requires `leikaKey` and **exactly one** of `ags` / `ars` / `areaId`; both rules
  are enforced client-side (a `FitConnectError` rejection) before any request.
- `areas({ search, offset?, limit? })` → `AreaResult`. `search` is a string or
  string array; blank terms are trimmed/dropped, and an all-blank search rejects.
- `info()` → `Info` (the deployed API's semantic version).
- `client.apiVersion` reflects the configured version.

## Authentication internals

The FIT-Connect **Routing API requires no authentication and no API key** — it is
the open, read-only routing service. The client attaches no credential headers.

Two non-obvious upstream behaviours the client handles:

- **Bot detection.** The Routing API filters on the `User-Agent`: the default
  (`fit-connect-cli`) is accepted, but some UA strings are blocked with `403`, so
  overriding `--user-agent` may cause failures. A missing or blank UA is *not*
  itself rejected; the client falls back to the default for an empty or
  whitespace-only `--user-agent` regardless.
- **`--base-url` is trusted input**: the CLI fetches whatever host you point it
  at; only `http:`/`https:` URLs are accepted, and redirects are **not** followed
  — a `3xx` surfaces as an error rather than being chased to another host.
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
    errors.ts    # FitConnectError / …ApiError / …NetworkError / …ParseError
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
area); the client splits each search term on whitespace into separate values.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output.

**Error types.** [`errors.ts`](src/client/errors.ts): `FitConnectApiError`
(non-2xx; carries `status`/`detail`/`url`/`body`; `detail` is read from the
RFC 7807 `application/problem+json` body's `detail`/`title`), `FitConnectNetworkError`
(transport failure/timeout), `FitConnectParseError` (bad JSON), all extending
`FitConnectError` (also raised for client-side validation).

**Retry / backoff.** Transient `429` and `503` are retried automatically with
backoff, up to `maxRetries` (default `2`), honouring a `Retry-After` header when
present (both delta-seconds and HTTP-date forms), otherwise linear backoff.
`FitConnectApiError.isRetryable` reflects this.

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
- **`shared.test.ts`** — option parsing (`parseIntArg`, `parseApiVersion`) and `toClientOptions` mapping.
- **`cli.test.ts`** — end-to-end command parsing, rendering, error/exit codes and option flow-through — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, generate CycloneDX SBOMs, and create a GitHub Release.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
