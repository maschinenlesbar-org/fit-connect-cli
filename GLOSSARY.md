# Glossary

Every command, option, response field, and domain term used by `fit-connect`.
For recipes see **[Usage.md](Usage.md)**; for the library see **[DEVELOPING.md](DEVELOPING.md)**.

## Commands

| Command | What it does |
| --- | --- |
| `routes <leikaKey>` | Find the responsible authority(ies) (Zustellpunkte) for a public service in an area. Needs a `leikaKey` and exactly one area selector. |
| `areas <query...>` | Search areas by name and/or postal code. Returns id + name + type. |
| `info` | Show the semantic version of the deployed Routing API instance. |

## Domain terms

**FIT-Connect.** A platform operated by the FITKO for transmitting applications
and reports between online application services ("sendende Systeme") and the
receiving systems at authorities. It exposes a **Routing API** (read-only, wrapped
here), a **Submission API** and a **Destination API** (the write path, *not*
wrapped here).

**FITKO.** Föderale IT-Kooperation — the body operating FIT-Connect on behalf of
the federal and state IT cooperation.

**Routing API / Routingdienst.** The read-only FIT-Connect service that resolves
*which* destination is responsible for a service in an area, drawing largely on
PVOG / XZuFi catalogue data. This is the only API this CLI wraps.

**Zustellpunkt (delivery point) / destination.** A uniquely addressable endpoint
for submitting applications to a specific authority for a specific service. A
routing result *is* a Zustellpunkt: a `destinationId` plus human-readable info
about the responsible authority. (Actually *submitting* to it is the Submission
API's job — out of scope here.)

**Leistungsschlüssel (`leikaKey`).** The FIM service-catalogue key (formerly LeiKa
key) identifying a public administrative service, a 14-digit string matching
`^99\d{12}$` (e.g. `99123456760610`). Identifies *what* service you're routing.
**Not discoverable through this CLI** — bring it from the FIM-Portal /
Leistungskatalog.

**PVOG.** Portalverbund-Online-Gateway — a federal index of administrative
services and responsibilities that backs much of the routing data (`origin: "PVOG"`).

**XZuFi.** The XÖV data standard for administrative-service catalogues; the source
format behind the authority/service descriptions.

**ags — Amtlicher Gemeindeschlüssel.** Official municipality code, **8 digits**.
An area selector for `routes` (`--ags`).

**ars — Amtlicher Regionalschlüssel.** Official regional code (a superset of the
ags with hierarchy), **12 digits**. An area selector for `routes` (`--ars`).

**area id.** The `id` returned by `fit-connect areas`. The third area selector for
`routes` (`--area-id`).

## `routes` options

| Option | Meaning |
| --- | --- |
| `--ags <ags>` | Amtlicher Gemeindeschlüssel, 8 digits — area selector (use exactly one) |
| `--ars <ars>` | Amtlicher Regionalschlüssel, 12 digits — area selector (use exactly one) |
| `--area-id <id>` | Area id from `fit-connect areas` — area selector (use exactly one) |
| `--offset <n>` | Start offset into the result set (default `0`) |
| `--limit <n>` | Page size, `1`..`500` (default `100`) |

## `areas` options

| Option | Meaning |
| --- | --- |
| `<query...>` | One or more search terms (names / postal codes); `*` wildcard supported |
| `--offset <n>` | Start offset into the result set (default `0`) |
| `--limit <n>` | Page size, `1`..`500` (default `100`) |

## Global options

| Option | Meaning |
| --- | --- |
| `-v, --version` | Print the CLI version |
| `-h, --help` | Show help |
| `--compact` | Single-line JSON instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://routing-api-prod.fit-connect.fitko.net`) |
| `--api-version <v1\|v2>` | Routing API version (default `v2`; `v1` is legacy) |
| `--timeout <ms>` | Per-request timeout (default `30000`; `0` disables) |
| `--user-agent <ua>` | `User-Agent` header (blank falls back to default; some values are blocked by the API's bot detection) |
| `--max-retries <n>` | Retries for transient `429`/`503` (default `2`) |
| `--max-response-bytes <n>` | Response body size cap in bytes (`0` = unlimited; default 100 MiB) |

## Response fields — `routes`

Envelope: `{ count, offset, totalCount, routes: Route[] }`.

| `Route` field | Meaning |
| --- | --- |
| `destinationId` | UUID of the FIT-Connect delivery point (target for *submitting* an application) |
| `destinationSignature` | JWS over the addressing information (RFC 7515) |
| `destinationName` | Full name of the responsible authority, incl. hierarchy |
| `destinationShortName` | Short name of the authority |
| `destinationLogo` | URL of the authority's logo |
| `contactPersons[]` | `name`, `tel`, `fax`, `email` for the service |
| `address` | Street address — `street`, `houseNumber`, `additional`, `zip`, `city` |
| `postalAddress` | Postal address (same shape as `address`) |
| `postOfficeBox` | Post-office-box address — `postOfficeBox`, `zip`, `city` |
| `privacyPolicyUrl`, `imprintUrl`, `accessibilityUrl`, `contactFormUrl` | Region-specific links |
| `furtherInformation`, `requiredDocuments`, `legalBasis`, `deadline` | Localized text blocks: `{ description: { de, en, … } }`, may contain HTML |
| `processingDuration` | `{ minDuration, maxDuration, unit }` (`unit`: year/month/week/day/workday/hour/minute/second) |
| `customParameters` | Open-ended, service-specific parameters (e.g. fees, variants) |
| `origin` | Source system of the routing info (e.g. `PVOG`) |

Only `destinationId` and `destinationSignature` are guaranteed present; everything
else varies per service and region.

## Response fields — `areas`

Envelope: `{ count, offset, totalCount, areas: Area[] }`.

| `Area` field | Meaning |
| --- | --- |
| `id` | Numeric area id — pass as `--area-id` to `routes` |
| `name` | Area name, e.g. `"Halle (Saale)"` |
| `type` | Area type, e.g. `"kreisfreie Stadt"`, `"Kreis"`, `"Gemeinde"`, `"Gemeindeteil"` |

## Response fields — `info`

`{ version: { major, minor, patch } }` — the deployed Routing API's semantic version.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`; includes an empty `routes`/`areas` list) |
| `4` | Not found (`404`) |
| `1` | Any other API, network, parse, validation, or usage error |
