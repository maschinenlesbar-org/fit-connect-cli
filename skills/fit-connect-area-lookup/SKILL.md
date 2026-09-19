---
name: fit-connect-area-lookup
description: >
  Resolve a German place name or postal code to its FIT-Connect area entries —
  the area ids used for routing — using the fit-connect-cli. Trigger when the
  user asks "what's the FIT-Connect area id for a place?", "look up an Ort / a PLZ
  in FIT-Connect", "which areas match a name?", or needs to disambiguate a place
  before a routing lookup. Searches by name (with `*` wildcard) or postal code and
  returns typed candidates (id, name, type); it does not return
  Gemeindeschlüssel or Regionalschlüssel codes.
compatibility: >
  Requires the `fit-connect` CLI (npm package
  @maschinenlesbar.org/fit-connect-cli) on PATH, installed by the user; the
  skill never installs it. Network access to
  routing-api-prod.fit-connect.fitko.net.
---

# FIT-Connect — Area Lookup

Turn a place the user names ("Hanau", "Halle", "60311", "Mag*") into the concrete
**area entries** FIT-Connect knows — each with an `id`, a `name`, and a `type`
(`Bundesland`, `Landkreis`, `kreisfreie Stadt`, `Stadt`, `Gemeinde`, `Gemeindeteil`,
…; see below). The `id` is what you pass as `--area-id` to a routing lookup. The
response has no `ags`/`ars` fields.

## Tooling

This skill drives the `fit-connect` command. **Before anything else, validate it is available** — run `command -v fit-connect` (or `fit-connect --version`). If it is not on your PATH, STOP and inform the user that the `fit-connect` CLI (`@maschinenlesbar.org/fit-connect-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The data is the open FIT-Connect Routing API — read-only, no API key. Always pass
`--compact`.

## Searching

```bash
fit-connect --compact areas "Hanau"          # by name
fit-connect --compact areas 60311            # by postal code
fit-connect --compact areas "Mag*"           # wildcard: matches Magdeburg, ...
fit-connect --compact areas Frankfurt am Main   # several words, all must match
```

Notes on the search expression:
- The wildcard `*` matches a prefix/suffix of a word (`"Mag*"` → Magdeburg).
- The words are sent as separate search expressions and the API **ANDs** them:
  every word must match the *same* area. Extra words narrow the search; they don't
  search for several places. `areas Köln Bonn` returns `count: 0`, so run one call
  per place.
- Each word must be at least two non-wildcard characters.
- The CLI splits terms on spaces and punctuation, so an official name like
  `"Halle (Westf.)"` or `"Baden-Baden"` is sent as its bare words. Older CLI versions
  (0.0.5 and earlier) sent punctuation along, and the API answered `HTTP 500`
  ("AreaService resulted in an exception", exit `1`). If you see that error, retry
  with the bare words (`areas Halle Westf`) or the postal code (`areas 33790`).

The response is `{ count, offset, totalCount, areas: [{ id, name, type }] }`. Use
`--limit` / `--offset` to page when `totalCount` exceeds the page (default 100,
max 500).

## Picking the right entry

A single city commonly returns **many** rows — the city itself plus its
districts. The `type` values differ by Land; ones seen live include:

| Kind | `type` values |
|---|---|
| district of a place — collapse these | `Gemeindeteil`, `Ortsteil` (Schwerin) |
| a whole town or municipality | `kreisfreie Stadt`, `Stadtkreis`, `Stadt`, `große Kreisstadt`, `Gemeinde`, `Kreisangehörige Gemeinde`, `Amtsangehörige Gemeinde`, `Mitgliedsgemeinde` |
| an administrative grouping | `Amt`, `Verwaltungsgemeinschaft`, `Landkreis`, `Bundesland` |

When the user wants "the city", choose a whole-place entry, not a `Gemeindeteil` or
`Ortsteil`. Don't filter on one type: Halle (Westf.) is a `Stadt` (id 44466), not a
`kreisfreie Stadt`, and a name can match several whole places (`areas Halle` returns
Halle (Saale), Halle (Westf.) and two `Mitgliedsgemeinde` entries). Surface the
distinction:

```
"Hanau" → 13 matches:
  • 940  Hanau, Brüder-Grimm-Stadt            (kreisfreie Stadt)   ← the city
  • 941  Hanau … OT Klein-Auheim              (Gemeindeteil)
  • …    (11 more Ortsteile)
```

Rules:
- Lead with the whole-place entry and call it out; collapse the `Gemeindeteil` /
  `Ortsteil` rows into a count unless the user asked for a specific district. If
  several whole places share the name, list them and ask which one.
- If nothing matches, say so and suggest a wildcard or the postal code.
- If the user's end goal is "who is responsible for <service> here", hand the
  chosen `id` straight to the **fit-connect-find-authority** skill
  (`fit-connect routes <leikaKey> --area-id <id>`).
- `ags`/`ars` vs `area-id`: this endpoint returns only an `id` (use as
  `--area-id`), never an `ags` or `ars`. If the user already has an official `ags`
  (Gemeindeschlüssel, 8 digits) or `ars` (Regionalschlüssel, 12 digits), they can
  route directly with `--ags`/`--ars` and skip this lookup entirely.
