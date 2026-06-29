---
name: fit-connect-area-lookup
description: >
  Resolve a German place name or postal code to its FIT-Connect area entries —
  ids and the ags/ars codes used for routing — using the fit-connect-cli. Trigger
  when the user asks "what's the area id / Gemeindeschlüssel / Regionalschlüssel
  for a place?", "look up an Ort / a PLZ in FIT-Connect", "which areas match
  a name?", or needs to disambiguate a place before a routing lookup. Searches by
  name (with `*` wildcard) or postal code and returns ranked, typed candidates.
version: 1.0.0
userInvocable: true
---

# FIT-Connect — Area Lookup

Turn a place the user names ("Hanau", "Halle", "60311", "Mag*") into the concrete
**area entries** FIT-Connect knows — each with an `id`, a `name`, and a `type`
(Bundesland / Kreis / kreisfreie Stadt / Gemeinde / Gemeindeteil). The `id` is
what you pass as `--area-id` to a routing lookup.

## Tooling

This skill drives the `fit-connect` command. **Before anything else, validate it is available** — run `command -v fit-connect` (or `fit-connect --version`). If it is not on your PATH, STOP and inform the user that the `fit-connect` CLI (`@maschinenlesbar.org/fit-connect-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The data is the open FIT-Connect Routing API — read-only, no API key. Always pass
`--compact`.

## Searching

```bash
fit-connect --compact areas "Hanau"          # by name
fit-connect --compact areas 60311            # by postal code
fit-connect --compact areas "Mag*"           # wildcard: matches Magdeburg, ...
fit-connect --compact areas Köln Bonn        # several terms at once
```

Notes on the search expression:
- The wildcard `*` matches a prefix/suffix of a word (`"Mag*"` → Magdeburg).
- Each positional term is sent as a separate search expression; pass several to
  search for several places in one call.
- Each term must be at least two non-wildcard characters.

The response is `{ count, offset, totalCount, areas: [{ id, name, type }] }`. Use
`--limit` / `--offset` to page when `totalCount` exceeds the page (default 100,
max 500).

## Picking the right entry

A single city commonly returns **many** rows — the city itself plus its
Ortsteile (`type: "Gemeindeteil"`). When the user wants "the city", choose the
top-level entry (e.g. `type: "kreisfreie Stadt"` / `"Kreis"` / `"Gemeinde"`), not
a Gemeindeteil. Surface the distinction:

```
"Hanau" → 13 matches:
  • 940  Hanau, Brüder-Grimm-Stadt            (kreisfreie Stadt)   ← the city
  • 941  Hanau … OT Klein-Auheim              (Gemeindeteil)
  • …    (11 more Ortsteile)
```

Rules:
- Lead with the whole-place entry and call it out; collapse the Ortsteile into a
  count unless the user asked for a specific district.
- If nothing matches, say so and suggest a wildcard or the postal code.
- If the user's end goal is "who is responsible for <service> here", hand the
  chosen `id` straight to the **fit-connect-find-authority** skill
  (`fit-connect routes <leikaKey> --area-id <id>`).
- `ags`/`ars` vs `area-id`: this endpoint returns an `id` (use as `--area-id`).
  If the user already has an official `ags` (Gemeindeschlüssel) or `ars`
  (Regionalschlüssel), they can route directly with `--ags`/`--ars` and skip this
  lookup entirely.
