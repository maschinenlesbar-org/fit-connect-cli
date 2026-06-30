# fit-connect-cli

[![CI](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/fit-connect-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/fit-connect-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/fit-connect-cli)

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
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/fit-connect-cli
```

This installs the **`fit-connect`** command. Requires **Node.js 20+**.

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
fit-connect routes 99123456760610 --area-id 940

# Already have the official codes? Skip step 1:
fit-connect routes 99123456760610 --ars 064350014014
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
| `--ags <ags>` | Amtlicher Gemeindeschlüssel of the place |
| `--ars <ars>` | Amtlicher Regionalschlüssel of the area |
| `--area-id <id>` | Area id from `fit-connect areas` |
| `--offset <n>` | Start offset into the result set (default `0`) |
| `--limit <n>` | Page size, `1`..`500` (default `100`) |

A lookup that matches no registered destination is **not** an error — it returns
`{"count":0,…,"routes":[]}` and exits `0`.

### `areas <query...>`

Search areas by name and/or postal code. Supports the `*` wildcard (`"Mag*"`).
Multiple terms are combined with **AND** — every term must match the *same* area,
so extra terms narrow the search (e.g. `areas Frankfurt am Main`) rather than
searching several places at once. Each result has an `id` (use as `--area-id`),
`name`, and `type`. Supports `--offset` / `--limit`.

### `info`

Print the version of the deployed Routing API instance.

## Common tasks

```bash
# Which areas match a name? (a city + its Ortsteile come back)
fit-connect areas "Halle"

# Search by postal code
fit-connect areas 60311

# The responsible authority's name and email (jq)
fit-connect --compact routes 99123456760610 --ars 064350014014 \
  | jq -r '.routes[] | "\(.destinationName)\t\(.contactPersons[0].email // "-")"'

# Use the v1 (legacy) routing service instead of v2
fit-connect --api-version v1 routes 99123456760610 --area-id 940

# How many destinations are registered for a service in an area?
fit-connect --compact routes 99123456760610 --ars 064350014014 | jq '.totalCount'
```

See **[Usage.md](Usage.md)** for the full, use-case-driven cookbook.

## Output & scripting

Every command prints **pretty JSON to stdout**; errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean. Use `--compact` for single-line
JSON. `--compact` is a **global** option and works **before or after** the command.

**Exit codes:**

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`; includes an empty `routes: []`) |
| `4` | Not found — the API returned `404` |
| `1` | Any other API, network, parse, validation, or usage error |

## Troubleshooting

- **`command not found: fit-connect`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/fit-connect-cli …`.
- **`exactly one area selector` error** — `routes` needs precisely one of
  `--ags` / `--ars` / `--area-id`. Zero or two is rejected before any request.
- **Empty `routes: []`** — no FIT-Connect Zustellpunkt is registered for that
  service in that area. This is normal and exits `0`; try a broader area (the
  Kreis or Bundesland) or re-check the Leistungsschlüssel.
- **`403` / bot-detection** — the Routing API filters on the `User-Agent`. The
  CLI's default UA is accepted, but some UA strings are blocked, so a custom
  `--user-agent` can trigger a `403`. A missing or blank UA is *not* itself
  rejected — and the CLI falls back to its default for an empty value anyway.
- **`429` / rate limited** — the CLI retries automatically and honours
  `Retry-After`. Raise `--max-retries` or slow down if it persists.

## Global options

These apply to every command and may go before or after it:

| Option | Description |
| --- | --- |
| `-v, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://routing-api-prod.fit-connect.fitko.net`) |
| `--api-version <v1\|v2>` | Routing API version (default `v2`; `v1` is legacy) |
| `--timeout <ms>` | Per-request timeout in ms (default `30000`; `0` disables) |
| `--user-agent <ua>` | `User-Agent` header value (blank falls back to default; some values are blocked by the API's bot detection) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every command, field, and domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.
- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills bundled with this repo
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
