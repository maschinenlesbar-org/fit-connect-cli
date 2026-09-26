# Examples

Real examples for the Claude Code skills of the `fit-connect` plugin, one per skill: a request,
the `fit-connect` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `fit-connect` 0.0.5.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [fit-connect-area-lookup](#fit-connect-area-lookup) · [fit-connect-find-authority](#fit-connect-find-authority) · [fit-connect-service-briefing](#fit-connect-service-briefing)

## fit-connect-area-lookup

> What's the FIT-Connect area id for Halle? I mean the town in Westphalia, postcode 33790.

```bash
fit-connect --compact areas "Halle"
fit-connect --compact areas 33790
fit-connect --compact areas "Halle (Westf.)"      # 0.0.5: exit 1, HTTP 500; since 0.0.6: 1 match, id 44466
```

"Halle" matched 50 areas, and every one of them came back on the first page. The postcode search
returned exactly one area, which confirmed the right town. With 0.0.5, searching by the exact name the
API had just returned failed: the CLI sent the `(Westf.)` punctuation along and the API returned an
error. Since 0.0.6 the CLI sends the bare words `Halle` + `Westf`; re-checked on 26 September 2026, the
search returns exactly one area, `44466 Halle (Westf.)` (Stadt).
The entries carry only `id`, `name` and `type`, with no AGS or ARS.

```
"Halle" → 50 matches:
  • 44466  Halle (Westf.)                  (Stadt)               ← your town, confirmed by PLZ 33790
  • 16688  Halle (Saale)                   (kreisfreie Stadt)    + 43 districts "Halle (Saale) - OT …"
  • 28415  Halle (Niedersachsen, 37620)    (Mitgliedsgemeinde)   + Halle - OT Halle, Halle - OT Kreipke
  • 31927  Halle (Niedersachsen, 49843)    (Mitgliedsgemeinde)
  • 27393  Raddestorf - OT Halle           (Gemeindeteil)

Area id for a routing lookup: 44466
  fit-connect routes <Leistungsschlüssel> --area-id 44466
```

Next steps offered: find the responsible authority for a service there with fit-connect-find-authority.

## fit-connect-find-authority

> I want to vote by post in Schwerin. Which office issues the Wahlschein, and how do I reach it?

```bash
fim-portal --compact service-profiles search --fts-query "Wahlschein" --sprache Deutsch --limit 20   # key lookup
fit-connect --compact areas "Schwerin"
fit-connect --compact routes 99128009012000 --area-id 4378
fit-connect --compact areas "Mecklenburg*"
fit-connect --compact routes 99128009012000 --area-id 3512       # broader: the Bundesland
fit-connect --compact routes 99128009012000 --ags 13004000
```

FIT-Connect can't look up a Leistungsschlüssel, so the skill got it from the `fim-portal` CLI:
`99128009012000`, "Wahlschein Ausstellung" ("Briefwahl beantragen"). Two areas called Schwerin exist,
so the skill picked the state capital and named the other one. Every route lookup returned `count: 0`.
None of the 62 route lookups made in this session returned a destination (13 services in 15 areas,
including Wohngeld, Gewerbeanmeldung and Hundesteuer), so an empty result is currently the normal outcome.

```
No FIT-Connect Zustellpunkt is registered for "Wahlschein Ausstellung" (99128009012000) in Schwerin.

  Place:    4378  Schwerin (Mecklenburg-Vorpommern, 190..), kreisfreie Stadt
            (not 8592 Schwerin (Brandenburg, 15755), Gemeinde)
  Checked:  the city by area id 4378 and by AGS 13004000       → 0 routes
            Bundesland Mecklenburg-Vorpommern (area id 3512)   → 0 routes

The routing service has no electronic delivery point for this service here, so it can't
name the office or its contact details. This doesn't mean nobody is responsible.
```

Next steps offered: check that the Leistungsschlüssel fits, or read the FIM text for the service
with `fim-portal` to see how to apply.

## fit-connect-service-briefing

> What do I need to apply for Wohngeld in Halle (Saale), and how long does it take?

```bash
fim-portal --compact service-profiles search --fts-query "Wohngeld" --sprache Deutsch --limit 8     # key lookup
fit-connect --compact areas "Halle"
fit-connect --compact routes 99107023037000 --area-id 16688     # count 0
```

The key came from `fim-portal`: `99107023037000`, "Wohngeld Feststellung" ("Wohngeld erstmalig oder
neu beantragen"). The area is the city entry 16688 (kreisfreie Stadt), not one of its 43 districts.
With `count: 0`, the skill reports that and stops, as it is written to do. Required documents,
legal basis and processing time only exist inside a route.

```
Wohngeld Feststellung (99107023037000), Halle (Saale)

No briefing available: the FIT-Connect Routingdienst has no registered destination for this
service in Halle (Saale) (area 16688, 0 routes). The documents, legal basis, deadlines and
processing time come from that route, so there is nothing to summarise yet.
Nothing was submitted. This CLI only reads routing data.
```

Next steps offered: the FIM description of the service (documents, legal basis) through the
`fim-portal` CLI, which doesn't depend on a registered route.
