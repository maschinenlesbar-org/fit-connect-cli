---
name: fit-connect-find-authority
description: >
  Find the German authority responsible for a public administrative service in a
  specific place, using the fit-connect-cli. Trigger when the user asks "who is
  responsible for a service in a place?", "where do I apply for a Leistung in
  a Stadt?", "which Amt handles a service in an Ort?", "find the Zustellpunkt for this
  Leistungsschlüssel", or wants the contact details / address of the competent
  authority for an Online-Antrag. Resolves the place to an area, then routes the
  service key to the responsible destination and reports its name, contacts and
  addresses.
version: 1.0.0
userInvocable: true
---

# FIT-Connect — Find the Responsible Authority

Given a **public service** and a **place**, return *who is responsible* — the
authority (Zustellpunkt) that handles that service there, with its name, contact
persons, address and the service-specific notes the API carries.

## Tooling

This skill drives the `fit-connect` command. **Before anything else, validate it is available** — run `command -v fit-connect` (or `fit-connect --version`). If it is not on your PATH, STOP and inform the user that the `fit-connect` CLI (`@maschinenlesbar.org/fit-connect-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

All data comes from the open **FIT-Connect Routing API** via this CLI. It is
read-only, needs no API key, and queries the production routing service by
default. Pass `--compact` so each result is one line, easy to pipe into `jq`.
Bump `--timeout 60000` if a call times out.

## Two inputs you must resolve first

A route lookup needs **both**:

1. **A Leistungsschlüssel** (`leikaKey`) — the FIM service-catalogue key for the
   public service, a 14-digit string matching `^99\d{12}$` (e.g. `99123456760610`).
   This is *not* discoverable through this CLI. If the user gives a service by
   name only, ask them for the Leistungsschlüssel, or get it from the
   FIM-Portal / Leistungskatalog (the `fim-portal` CLI, if available, resolves
   service names to keys). Do **not** invent one — a wrong key returns an empty
   or misleading result.
2. **Exactly one area selector** — one of:
   - `--ars <ars>` Amtlicher Regionalschlüssel,
   - `--ags <ags>` Amtlicher Gemeindeschlüssel, or
   - `--area-id <id>` an area id from `fit-connect areas`.

   Passing zero or more than one is an error (exit `1`). When the user gives a
   place by name, resolve it with `fit-connect areas` first (see Step 1).

## Step 1 — Resolve the place to an area

If you don't already have an ags/ars, search by name (or postal code):

```bash
fit-connect --compact areas "Hanau"
```

This returns `{ count, offset, totalCount, areas: [{ id, name, type }] }`. Pick
the entry whose `type` matches what the user means — `"kreisfreie Stadt"`,
`"Kreis"`, `"Gemeinde"`, a `Bundesland`, etc. — and use its `id` as `--area-id`.
If several plausibly match (a city and its Ortsteile, or a name shared by several
places), show the candidates and ask which one, or pick the obvious whole-city
entry and say so. Use the dedicated **fit-connect-area-lookup** skill if the
disambiguation is the hard part.

## Step 2 — Route the service to the responsible authority

```bash
fit-connect --compact routes 99123456760610 --area-id 940
# or, if you already have the codes:
fit-connect --compact routes 99123456760610 --ars 064350014014
fit-connect --compact routes 99123456760610 --ags 16051000
```

The response is `{ count, offset, totalCount, routes: [...] }`. Each `route` is
one Zustellpunkt. The fields worth surfacing:

| Field | Meaning |
|---|---|
| `destinationName` | Full name of the responsible authority (incl. hierarchy) |
| `destinationShortName` | Short name |
| `contactPersons[]` | `name`, `tel`, `fax`, `email` for the service |
| `address` / `postalAddress` / `postOfficeBox` | Where the authority sits / receives post |
| `contactFormUrl`, `privacyPolicyUrl`, `imprintUrl`, `accessibilityUrl` | Region-specific links |
| `destinationId` | UUID of the FIT-Connect delivery point (for *submitting* an application — out of scope here) |
| `origin` | Source system of the routing info, e.g. `PVOG` |

## Step 3 — Report

Lead with the authority name and the one or two contact routes a citizen acts
on (phone, email, or contact form), then the address. Keep it short:

```
Responsible authority for <service> in <place>:

  <destinationName>
  ☎ <tel>   ✉ <email>
  <street houseNumber>, <zip> <city>
  Contact form: <contactFormUrl>
```

Rules:
- **`count: 0` is a valid answer, not an error.** It means no destination is
  registered for that service in that area in the routing service. Say so plainly
  — e.g. "No FIT-Connect Zustellpunkt is registered for this service in <place>"
  — and suggest checking a broader area (the Kreis or Bundesland instead of the
  Gemeinde), or confirming the Leistungsschlüssel.
- **Multiple routes** — list each authority briefly; don't merge them.
- Only surface contact fields that are actually present; omit empties rather than
  printing blanks.
- The `destinationId`/`destinationSignature` are addressing material for *sending*
  an application (a separate, write path this CLI deliberately does not cover).
  Mention the destinationId only if the user explicitly wants the technical target.
- Don't dump raw JSON unless asked; offer it as a follow-up.
