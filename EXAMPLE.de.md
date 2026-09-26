# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `fit-connect`, eines pro Skill: eine
Anfrage, die `fit-connect`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `fit-connect` 0.0.5 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [fit-connect-area-lookup](#fit-connect-area-lookup) · [fit-connect-find-authority](#fit-connect-find-authority) · [fit-connect-service-briefing](#fit-connect-service-briefing)

## fit-connect-area-lookup

> Welche FIT-Connect-Gebiets-ID hat Halle? Gemeint ist die Stadt in Westfalen, PLZ 33790.

```bash
fit-connect --compact areas "Halle"
fit-connect --compact areas 33790
fit-connect --compact areas "Halle (Westf.)"      # 0.0.5: Exit 1, HTTP 500; seit 0.0.6: 1 Treffer, ID 44466
```

„Halle" ergab 50 Gebiete, alle auf der ersten Seite. Die Suche nach der Postleitzahl lieferte genau
ein Gebiet und bestätigte damit den richtigen Ort. Mit 0.0.5 schlug die Suche mit dem exakten Namen,
den die API gerade geliefert hatte, fehl: Die CLI schickte die Satzzeichen von `(Westf.)` mit, und die
API meldete einen Fehler. Seit 0.0.6 sendet die CLI die reinen Wörter `Halle` + `Westf`; am
26. September 2026 nachgeprüft, liefert die Suche genau ein Gebiet, `44466 Halle (Westf.)` (Stadt).
Die Einträge enthalten nur `id`, `name` und `type` – keinen AGS oder ARS.

```
„Halle" → 50 Treffer:
  • 44466  Halle (Westf.)                  (Stadt)               ← der gesuchte Ort, bestätigt über PLZ 33790
  • 16688  Halle (Saale)                   (kreisfreie Stadt)    + 43 Ortsteile „Halle (Saale) - OT …"
  • 28415  Halle (Niedersachsen, 37620)    (Mitgliedsgemeinde)   + Halle - OT Halle, Halle - OT Kreipke
  • 31927  Halle (Niedersachsen, 49843)    (Mitgliedsgemeinde)
  • 27393  Raddestorf - OT Halle           (Gemeindeteil)

Gebiets-ID für eine Routing-Abfrage: 44466
  fit-connect routes <Leistungsschlüssel> --area-id 44466
```

Als Nächstes angeboten: mit fit-connect-find-authority die zuständige Behörde für eine Leistung dort finden.

## fit-connect-find-authority

> Briefwahl in Schwerin: Welche Stelle stellt den Wahlschein aus, und wie ist sie erreichbar?

```bash
fim-portal --compact service-profiles search --fts-query "Wahlschein" --sprache Deutsch --limit 20   # Schlüssel nachschlagen
fit-connect --compact areas "Schwerin"
fit-connect --compact routes 99128009012000 --area-id 4378
fit-connect --compact areas "Mecklenburg*"
fit-connect --compact routes 99128009012000 --area-id 3512       # größer: das Bundesland
fit-connect --compact routes 99128009012000 --ags 13004000
```

FIT-Connect kann keinen Leistungsschlüssel nachschlagen, deshalb holte der Skill ihn über die CLI
`fim-portal`: `99128009012000`, „Wahlschein Ausstellung" („Briefwahl beantragen"). Es gibt zwei Gebiete
namens Schwerin; der Skill wählte die Landeshauptstadt und nannte das andere. Jede Routing-Abfrage
ergab `count: 0`. Keine der 62 Routing-Abfragen in dieser Sitzung lieferte einen Zustellpunkt (13
Leistungen in 15 Gebieten, darunter Wohngeld, Gewerbeanmeldung und Hundesteuer) – ein leeres Ergebnis
ist derzeit der Normalfall.

```
Für „Wahlschein Ausstellung" (99128009012000) ist in Schwerin kein FIT-Connect-Zustellpunkt registriert.

  Ort:      4378  Schwerin (Mecklenburg-Vorpommern, 190..), kreisfreie Stadt
            (nicht 8592 Schwerin (Brandenburg, 15755), Gemeinde)
  Geprüft:  die Stadt über Gebiets-ID 4378 und über AGS 13004000   → 0 Routen
            Bundesland Mecklenburg-Vorpommern (Gebiets-ID 3512)    → 0 Routen

Der Routingdienst kennt hier keinen elektronischen Zustellpunkt für diese Leistung und kann daher
weder die Stelle noch ihre Kontaktdaten nennen. Das heißt nicht, dass niemand zuständig ist.
```

Als Nächstes angeboten: den Leistungsschlüssel prüfen oder mit `fim-portal` den FIM-Text zur Leistung
lesen, um zu sehen, wie der Antrag funktioniert.

## fit-connect-service-briefing

> Was wird für einen Wohngeldantrag in Halle (Saale) gebraucht, und wie lange dauert die Bearbeitung?

```bash
fim-portal --compact service-profiles search --fts-query "Wohngeld" --sprache Deutsch --limit 8     # Schlüssel nachschlagen
fit-connect --compact areas "Halle"
fit-connect --compact routes 99107023037000 --area-id 16688     # count 0
```

Der Schlüssel kam aus `fim-portal`: `99107023037000`, „Wohngeld Feststellung" („Wohngeld erstmalig oder
neu beantragen"). Das Gebiet ist der Stadteintrag 16688 (kreisfreie Stadt), keiner der 43 Ortsteile.
Bei `count: 0` meldet der Skill das und hört auf, wie vorgesehen. Unterlagen, Rechtsgrundlage und
Bearbeitungsdauer gibt es nur innerhalb einer Route.

```
Wohngeld Feststellung (99107023037000), Halle (Saale)

Keine Übersicht möglich: Der FIT-Connect-Routingdienst hat für diese Leistung in Halle (Saale)
keinen Zustellpunkt registriert (Gebiet 16688, 0 Routen). Unterlagen, Rechtsgrundlage, Fristen
und Bearbeitungsdauer stammen aus dieser Route – es gibt also noch nichts zusammenzufassen.
Es wurde nichts eingereicht; diese CLI liest nur Routing-Daten.
```

Als Nächstes angeboten: die FIM-Beschreibung der Leistung (Unterlagen, Rechtsgrundlage) über die CLI
`fim-portal`, die nicht von einer registrierten Route abhängt.
