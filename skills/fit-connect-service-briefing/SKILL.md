---
name: fit-connect-service-briefing
description: >
  Build a citizen-facing briefing for a public administrative service in a given
  place — required documents, legal basis, deadlines, processing time, fees and
  the responsible authority's contacts — using the fit-connect-cli. Trigger when
  the user asks "what do I need to apply for a service in a place?", "how long
  does a Leistung take / what documents are required / what's the legal basis?",
  or wants a "how to apply" summary for a Verwaltungsleistung in a specific
  region. Routes the service to its destination and turns the response's
  localized info blocks into a readable briefing.
version: 1.0.0
userInvocable: true
---

# FIT-Connect — Service Briefing

For a public service in a specific place, produce a short "how to apply"
briefing from the **region-specific** information the routing result carries:
required documents, legal basis, deadlines, processing duration, any
service-specific parameters (fees, variants), and how to reach the authority.

## Tooling

This skill drives the `fit-connect` command. **Before anything else, validate it is available** — run `command -v fit-connect` (or `fit-connect --version`). If it is not on your PATH, STOP and inform the user that the `fit-connect` CLI (`@maschinenlesbar.org/fit-connect-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Read-only, no API key. Use `--compact`.

## Get the route

You need a **Leistungsschlüssel** (`leikaKey`, `^99\d{12}$`) and one area
selector. If the user gives a place by name, resolve it with `fit-connect areas`
first (or via the **fit-connect-area-lookup** skill); if they give a service by
name only, ask for its Leistungsschlüssel — it is not discoverable through this
CLI. Then:

```bash
fit-connect --compact routes 99123456760610 --area-id 940
```

Pick the relevant `route` from `routes[]` (usually the single result). If
`count` is `0`, there is no registered destination for that service in that area
— report that plainly and stop; there is nothing to brief.

## Fields to turn into the briefing

The localized text blocks are objects shaped `{ description: { de: "...", en: "..." } }`
and the HTML values may contain tags — strip them to plain text for the summary.

| Field | Use as |
|---|---|
| `furtherInformation.description.{de,en}` | "About this service" |
| `requiredDocuments.description.{de,en}` | "What you need to bring / attach" |
| `legalBasis.description.{de,en}` | "Legal basis" |
| `deadline.description.{de,en}` | "Deadlines" |
| `processingDuration` | `{ minDuration, maxDuration, unit }` → "Processing time: 1–4 weeks" |
| `customParameters` | Service-specific extras (e.g. `mahngebuehr`, `prozessvariante`) — surface notable ones |
| `destinationName`, `contactPersons[]`, `address`, `contactFormUrl` | "Where / how to apply" |

Prefer the German (`de`) text; offer the English (`en`) variant if the user wants
it or asked in English.

## Brief the user

```
<service> — <place>

About:        <plain-text furtherInformation>
You'll need:  <bulleted requiredDocuments>
Legal basis:  <plain-text legalBasis>
Deadlines:    <plain-text deadline>
Processing:   <minDuration>–<maxDuration> <unit>
Apply to:     <destinationName>
              ☎ <tel>  ✉ <email>  ·  <contactFormUrl>
```

Rules:
- **Only include sections the data actually has.** These fields are optional and
  vary widely by service and region; omit a heading entirely rather than printing
  "not specified" for every empty one.
- Strip HTML tags from the description blocks; keep lists as lists.
- Render `processingDuration` as a human range; if only one bound is present, say
  "up to N <unit>" / "at least N <unit>".
- This briefing describes *how/where to apply*; it does **not** submit anything.
  Submitting an application is the FIT-Connect write path, which this CLI does not
  implement — make that clear if the user expects to file through it.
- Attribute the source as the FIT-Connect Routingdienst when presenting the data.
