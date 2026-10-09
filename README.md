# fit-connect-cli

[![CI](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/fit-connect-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/fit-connect-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/fit-connect-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/fit-connect-cli/de/) — command reference, guides and API docs

Find out **which German authority is responsible** for a public administrative
service in a given place — straight from your terminal. `fit-connect` is a
command-line tool over the open
[FIT-Connect Routing API](https://docs.fitko.de/fit-connect/docs/apis/routing-api/)
(`routing-api-prod.fit-connect.fitko.net`) operated by the
[FITKO](https://www.fitko.de/) (Föderale IT-Kooperation).

- **Works out of the box** — no account, no API key, no configuration. Install and query.
- **Read-only by design** — this tool wraps **only** the Routing API. It does
  **not** implement the FIT-Connect *Submission* (write) path; it never sends an
  application or any personal data.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Three commands** — `routes` (find the responsible Zustellpunkt), `areas`
  (resolve a place to an area id / codes), and `info` (API version).

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](https://github.com/maschinenlesbar-org/fit-connect-cli/blob/main/DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/fit-connect-cli
```

This installs the **`fit-connect`** command. Requires **Node.js 22.12+**.

Check it works:

```bash
fit-connect --help
```

## Concepts in 30 seconds

A routing lookup answers *"who handles service X in place Y?"* and needs two inputs:

- a **Leistungsschlüssel** (`leikaKey`) — the FIM service-catalogue key for the
  public service, a 14-digit `99…` string. It identifies *what* service. This CLI
  does **not** discover service keys — bring one from the FIM-Portal /
  Leistungskatalog.
- one **area selector** identifying *where*: `--ars` (Regionalschlüssel),
  `--ags` (Gemeindeschlüssel), or `--area-id` (an id from `fit-connect areas`).

The result is one or more **Zustellpunkte** (delivery points): the responsible
authority, its contacts, address, and service-specific notes.

## Quickstart

No setup needed — the API requires no key.

```bash
# 1. Resolve a place to an area id
fit-connect areas Hanau

# 2. Route a service key into that area to find the responsible authority
#    (99123456760610 is an illustrative key with no registered destinations,
#     so these examples return an empty `routes: []` — that is normal, see below)
fit-connect routes 99123456760610 --area-id 940

# Already have the official codes? Skip step 1 (here: Erfurt, by Regionalschlüssel):
fit-connect routes 99123456760610 --ars 160510000000
```

## Commands

```text
routes <leikaKey> --ags|--ars|--area-id <code>   find the responsible authority
areas  <query...>                                 search areas by name / postal code
info                                              show the deployed Routing API version
```

### `routes <leikaKey>`

Find the responsible destination(s) for a public service in an area. Requires a
`leikaKey` and **exactly one** area selector.

| Option | Description |
| --- | --- |
| `--ags <ags>` | Amtlicher Gemeindeschlüssel: 8 digits (Gemeinde), or 2 / 3 / 5 digits (Land / Regierungsbezirk / Kreis) |
| `--ars <ars>` | Amtlicher Regionalschlüssel: 12 digits (Gemeinde), 9 (Gemeindeverband), or 2 / 3 / 5 digits (Land / Regierungsbezirk / Kreis) |
| `--area-id <id>` | Area id from `fit-connect areas`: a positive whole number without leading zeros (`940`, not `0940`, which the API answers with HTTP 500), at most `2147483647`. An id the API doesn't know, of any size, also gets HTTP 500 (`Calling the third service 'AreaService' resulted in an exception`), not a 404 — take ids from `areas` |
| `--offset <n>` | Start offset into the result set, `0`..`2147483647`; `offset + limit` (the limit defaulting to `100`) must not exceed `2147483647`, as the API adds them in a 32-bit integer (default `0`) |
| `--limit <n>` | Page size, `1`..`500` (default `100`) |

A lookup that matches no registered destination is **not** an error — it returns
`{"count":0,…,"routes":[]}` and exits `0`.

> **This tool does not verify `destinationSignature`.** Each route carries a JWS
> (`destinationSignature`, RFC 7515) over its addressing information; the CLI
> returns it as an opaque, **unverified** string and performs no signature/crypto
> validation. Verify the JWS against FITKO's public FIT-Connect keys, per the
> [FIT-Connect spec](https://docs.fitko.de/fit-connect/docs/), before trusting
> `destinationId` to submit an application — otherwise a spoofed or MITM'd routing
> response could misdirect your submission.

### `areas <query...>`

Search areas by name and/or postal code. Supports the `*` wildcard (`"Mag*"`).
Multiple terms are combined with **AND** — every term must match the *same* area,
so extra terms narrow the search (e.g. `areas Frankfurt am Main`) rather than
searching several places at once. Terms are split into words on spaces and
punctuation, so an official name like `"Halle (Westf.)"` works quoted. The API
needs at least 2 letters or digits per word and at most 10 words: shorter words are
left out with a note on stderr (`"Frankfurt a. M."` searches `Frankfurt`), and more
than 10 words, or a bare `*`, is an error before any request. A second note lists the
characters other than a plain space the search was split at, each once (`( . )`;
invisible ones as `U+XXXX`), so you see how the query was changed. The API's matching
treats `ß` and `ss` alike: `areas Giessen` finds the same 45 areas as `areas Gießen`
(checked live on 2026-10-06), so either spelling works. Each result
has an `id` (use as `--area-id`), `name`, and `type`. Supports `--offset` /
`--limit`.

### `info`

Print the version of the deployed Routing API instance.

## Common tasks

```bash
# Which areas match a name? (a city + its Ortsteile come back)
fit-connect areas "Halle"

# Search by postal code
fit-connect areas 60311

# The responsible authority's name and email (jq)
fit-connect --compact routes 99123456760610 --ars 160510000000 \
  | jq -r '.routes[] | "\(.destinationName)\t\(.contactPersons[0].email // "-")"'

# Use the v1 (legacy) routing service instead of v2
fit-connect --api-version v1 routes 99123456760610 --area-id 940

# How many destinations are registered for a service in an area?
fit-connect --compact routes 99123456760610 --ars 160510000000 | jq '.totalCount'
```

> **`jq -r` undoes the CLI's escaping.** The JSON the CLI prints keeps server text inert: control
> characters and the bidi formatting characters (U+061C, U+200E/U+200F, U+202A–U+202E,
> U+2066–U+2069, which reorder the text after them) appear as `\uXXXX` escapes. `jq -r` turns
> them back into the raw characters, so a hostile or broken name can recolour or reorder what
> your terminal shows. Print names to a terminal through a filter that drops them — see
> [Usage.md](https://github.com/maschinenlesbar-org/fit-connect-cli/blob/main/Usage.md#jq--r-turns-escapes-back-into-raw-characters) — or use `jq` without `-r`.

See **[Usage.md](https://github.com/maschinenlesbar-org/fit-connect-cli/blob/main/Usage.md)** for the full, use-case-driven cookbook.

## Output & scripting

Every command prints **pretty JSON to stdout**; errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean. Use `--compact` for single-line
JSON. `--compact` is a **global** option and works **before or after** the command.

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`fit-connect.cli` for usage
errors and notes on the search words, `fit-connect.api` for the API's answers,
`fit-connect.http` for the connection). By default it is written log4j style;
`--log-format jsonl` writes one JSON object per line instead. A record is always one
line: a line break, a control character or a bidi control in a message (a server's text,
a value you typed) is written as an escape (`\n`, `\u001b`, `\u202e`), so it can neither
split a record nor forge another one, nor steer the terminal:

```text
2026-10-09T14:03:12.481Z WARN  [fit-connect.http] requests to mirror.example are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [fit-connect.api] HTTP 404 for GET https://routing-api-prod.fit-connect.fitko.net/v2/routes?…: …
```

```bash
fit-connect --log-format jsonl routes 99123456760610 --area-id 1 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"fit-connect.api","msg":"HTTP 404 …"}
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`; includes an empty `routes: []`) |
| `4` | Not found — the API returned `404` |
| `1` | Any other API, network, parse, validation, or usage error — including a `2xx` answer that isn't the documented shape (`null`, `{}`, an HTML page from a proxy): `Unexpected response from /v2/routes: …` |

## Troubleshooting

- **`command not found: fit-connect`** — the global npm bin directory isn't on
  your `PATH`. Add `$(npm prefix -g)/bin` to it (`npm bin` was removed in npm 9), or run via
  `npx @maschinenlesbar.org/fit-connect-cli …`.
- **`exactly one area selector` error** — `routes` needs precisely one of
  `--ags` / `--ars` / `--area-id`. Zero or two is rejected before any request.
- **Empty `routes: []`** — no FIT-Connect Zustellpunkt is registered for that
  service in that area. This is normal and exits `0`, and it is the usual result:
  routing data is sparse, and many real service keys return no route in large
  cities too. Try a broader area — the Kreis or Land, e.g. `--ars 06435` or
  `--ars 06` — or re-check the Leistungsschlüssel. A kreisfreie Stadt belongs to no
  Kreis: for Erfurt, `--ars 16051` answers `No Area was found with given AreaKey`, so
  the next level up is the Land (`--ars 16`).
- **`403` / bot-detection** — the Routing API filters on the `User-Agent`. The
  CLI's default UA is accepted, but some UA strings are blocked, so a custom
  `--user-agent` can trigger a `403`. A missing or blank UA is *not* itself
  rejected — and the CLI falls back to its default for an empty or
  whitespace-only value anyway (but a value with a line break or a character above
  U+00FF, whitespace or not, is a usage error).
- **`429` / rate limited** — the CLI retries automatically, backing off linearly
  (200 ms, 400 ms, …) or waiting the `Retry-After`, or the `RateLimit-Reset` the
  Routing API sends with a 429, when that is longer (up to 30 s). The message ends
  `(after N retries)` when they ran out: raise `--max-retries` or slow down. When the
  server asks for a longer wait the CLI does not retry at all and says so (`the server
  asked to retry after 120 s, longer than the 30 s the client waits; not retried`):
  wait that long before trying again.

## Global options

These apply to every command and may go before or after it. Every option takes one
value: giving it twice (`--area-id 940 --area-id 941`) is a usage error, not "the last
one wins".

| Option | Description |
| --- | --- |
| `-v, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [fit-connect.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `--base-url <url>` | API base URL, http(s), a path prefix allowed but no `?query`, `#fragment` or surrounding whitespace; a literal `%` in a password is written `%25` (default `https://routing-api-prod.fit-connect.fitko.net`). Plain `http:` to a host other than loopback (`localhost`, `127.0.0.0/8`, `::1`) prints one warning record (`WARN  [fit-connect.http] … sent unencrypted to <host> (http:, not https:)`) on stderr per run, naming a `user:password@` as "the base URL's credentials" (never its value); stdout and the exit code are unchanged |
| `--api-version <version>` | Routing API version, `v1` or `v2` (default `v2`; `v1` is legacy) |
| `--timeout <ms>` | Time limit per request in ms, reading the whole response included (default `30000`; `0` disables; at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value (blank falls back to default; Latin-1 only, no control characters except tab; some values are blocked by the API's bot detection) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`–`10`, default `2`). Each retry backs off linearly (200 ms, 400 ms, …), or waits the server's `Retry-After`, else its `RateLimit-Reset`, when that is longer (up to 30 s; a longer wait is not retried, and the error says so) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](https://github.com/maschinenlesbar-org/fit-connect-cli/blob/main/Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](https://github.com/maschinenlesbar-org/fit-connect-cli/blob/main/GLOSSARY.md)** — every command, field, and domain term explained.
- **[DEVELOPING.md](https://github.com/maschinenlesbar-org/fit-connect-cli/blob/main/DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.
- **[SKILLS.md](https://github.com/maschinenlesbar-org/fit-connect-cli/blob/main/SKILLS.md)** — Claude Code Agent Skills bundled with this repo
  (find authority, area lookup, service briefing), installable as a plugin.

## Scope: read-only routing only

This CLI deliberately wraps **only** the FIT-Connect **Routing API** — the
read-only service that answers "who is responsible?". The FIT-Connect
**Submission/Destination** APIs (the OAuth2-authenticated *write* path that
actually transmits applications) are **out of scope** and not implemented here.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream routing data is governed by the provider's terms, **separately from this
tool's code**. See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **FITKO — FIT-Connect Routingdienst.** No formal open-data license is declared
> on the Routing API (governed by the FIT-Connect terms of service). Crediting
> FITKO / FIT-Connect as the source is the good-faith default.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
