# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `fit-connect`, eines pro Skill: eine
Anfrage, die `fit-connect`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `fit-connect` 0.2.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [fit-connect-area-lookup](#fit-connect-area-lookup) · [fit-connect-find-authority](#fit-connect-find-authority) · [fit-connect-service-briefing](#fit-connect-service-briefing)

## fit-connect-area-lookup

> Welche FIT-Connect-Gebiets-ID hat Halle? Gemeint ist die Stadt in Westfalen, PLZ 33790.

```bash
fit-connect --compact areas "Halle"
fit-connect --compact areas 33790
fit-connect --compact areas "Halle (Westf.)"      # gesendet als die Wörter Halle + Westf: 1 Treffer
```

„Halle" ergab 50 Gebiete, alle auf der ersten Seite. Die Suche nach der Postleitzahl lieferte genau
ein Gebiet, `44466 Halle (Westf.)` (Stadt), und bestätigte damit den richtigen Ort; die Suche mit dem
exakten Namen, den die API geliefert hatte, fand dasselbe eine Gebiet: Die CLI sendet die reinen Wörter
`Halle` + `Westf`, ohne die Satzzeichen, die die API nicht verarbeitet. Die Einträge enthalten nur `id`,
`name` und `type` – keinen AGS oder ARS.

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
`fim-portal`: `99128009012000`, „Wahlschein Ausstellung" („Briefwahl beantragen"), der erste von drei
Treffern. „Schwerin" ergab 36 Gebiete: zwei ganze Orte dieses Namens (dazu Alt Schwerin) und 33
Ortsteile. Der Skill wählte die Landeshauptstadt und nannte das andere Schwerin. Die Stadt ergab
`count: 0`; weil eine kreisfreie Stadt zu keinem Kreis gehört, war die nächsthöhere Ebene das Land
Mecklenburg-Vorpommern (Gebiets-ID 3512, gefunden mit `Mecklenburg*`), das ebenfalls `count: 0` ergab,
wie auch der AGS der Stadt. Ein leeres Ergebnis ist der Normalfall: Auch in der Sitzung vom
15. September 2026 lieferte keine der 62 Routing-Abfragen (13 Leistungen in 15 Gebieten) einen
Zustellpunkt.

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
neu beantragen"), unter 18 Treffern (auch Pflegewohngeld und Bildung und Teilhabe). Das Gebiet ist der
Stadteintrag 16688 (kreisfreie Stadt), keiner der 43 Ortsteile.
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
