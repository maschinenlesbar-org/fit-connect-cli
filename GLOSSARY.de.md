# Glossar

Alle Befehle, Optionen, Antwortfelder und Fachbegriffe von `fit-connect`.
Rezepte finden Sie in **[Usage.md](Usage.md)**, die Nutzung als Bibliothek in **[DEVELOPING.md](DEVELOPING.md)**.

## Befehle

| Befehl | Funktion |
| --- | --- |
| `routes <leikaKey>` | Findet die zuständige(n) Behörde(n) (Zustellpunkte) für eine Verwaltungsleistung in einem Gebiet. Benötigt einen `leikaKey` und genau einen Gebietsselektor. |
| `areas <query...>` | Sucht Gebiete nach Name und/oder Postleitzahl. Liefert ID, Name und Typ. |
| `info` | Zeigt die semantische Version der betriebenen Instanz der Routing-API. |

## Fachbegriffe

**FIT-Connect.** Eine von der FITKO betriebene Plattform, über die Anträge und Berichte zwischen
Online-Antragsdiensten („sendende Systeme“) und den empfangenden Systemen der Behörden übermittelt
werden. Sie bietet eine **Routing-API** (nur lesend, hier eingebunden), eine **Submission-API** und
eine **Destination-API** (den Schreibpfad, hier *nicht* eingebunden).

**FITKO.** Föderale IT-Kooperation – die Einrichtung, die FIT-Connect im Auftrag der
IT-Kooperation von Bund und Ländern betreibt.

**Routing-API / Routingdienst.** Der nur lesende FIT-Connect-Dienst, der ermittelt, *welcher*
Zustellpunkt für eine Leistung in einem Gebiet zuständig ist; er stützt sich größtenteils auf
Katalogdaten aus PVOG / XZuFi. Das ist die einzige API, die diese CLI einbindet.

**Zustellpunkt / Destination.** Ein eindeutig adressierbarer Endpoint, über den Anträge für eine
bestimmte Leistung bei einer bestimmten Behörde eingereicht werden. Ein Routing-Ergebnis *ist* ein
Zustellpunkt: eine `destinationId` plus lesbare Angaben zur zuständigen Behörde. (Das eigentliche
*Einreichen* ist Aufgabe der Submission-API – hier nicht abgedeckt.)

**Leistungsschlüssel (`leikaKey`).** Der Schlüssel aus dem FIM-Leistungskatalog (früher
LeiKa-Schlüssel), der eine Verwaltungsleistung identifiziert: eine 14-stellige Zeichenkette nach
dem Muster `^99\d{12}$` (z. B. `99123456760610`). Er bestimmt, *für welche* Leistung Sie routen.
**Über diese CLI nicht auffindbar** – entnehmen Sie ihn dem FIM-Portal /
Leistungskatalog.

**PVOG.** Portalverbund-Online-Gateway – ein bundesweiter Index von Verwaltungsleistungen und
Zuständigkeiten, auf dem ein Großteil der Routing-Daten beruht (`origin: "PVOG"`).

**XZuFi.** Der XÖV-Datenstandard für Kataloge von Verwaltungsleistungen; das Quellformat hinter
den Beschreibungen von Behörden und Leistungen.

**ags – Amtlicher Gemeindeschlüssel.** Die amtliche Kennziffer einer Gemeinde: **8 Ziffern** für
eine Gemeinde oder deren erste **2** (Land), **3** (Regierungsbezirk) oder **5** Ziffern (Kreis)
für die Ebene darüber – die Längen, die die Routing API annimmt. Ein Gebietsselektor für
`routes` (`--ags`).

**ars – Amtlicher Regionalschlüssel.** Die amtliche Kennziffer einer Region (eine Obermenge des
ags mit Hierarchie): **12 Ziffern** für eine Gemeinde, **9** für einen Gemeindeverband oder
**2** / **3** / **5** Ziffern für Land / Regierungsbezirk / Kreis. Ein Gebietsselektor für
`routes` (`--ars`).

**Gebiets-ID.** Die `id`, die `fit-connect areas` zurückgibt. Der dritte Gebietsselektor für
`routes` (`--area-id`).

## Optionen von `routes`

| Option | Bedeutung |
| --- | --- |
| `--ags <ags>` | Amtlicher Gemeindeschlüssel, 2/3/5/8 Ziffern (Land/Regierungsbezirk/Kreis/Gemeinde) – Gebietsselektor (genau einen angeben) |
| `--ars <ars>` | Amtlicher Regionalschlüssel, 2/3/5/9/12 Ziffern (Land/Regierungsbezirk/Kreis/Gemeindeverband/Gemeinde) – Gebietsselektor (genau einen angeben) |
| `--area-id <id>` | Gebiets-ID aus `fit-connect areas` – Gebietsselektor (genau einen angeben) |
| `--offset <n>` | Start-Offset in der Ergebnismenge (Standard `0`) |
| `--limit <n>` | Seitengröße, `1`..`500` (Standard `100`) |

## Optionen von `areas`

| Option | Bedeutung |
| --- | --- |
| `<query...>` | Ein oder mehrere Suchbegriffe (Namen / Postleitzahlen); Platzhalter `*` wird unterstützt. Die Begriffe werden an Leerzeichen und Satzzeichen in Wörter zerlegt, und jedes Wort muss auf dasselbe Gebiet passen (UND). Jedes Wort braucht mindestens 2 Buchstaben oder Ziffern (kürzere werden mit einem Hinweis weggelassen); höchstens 10 Wörter |
| `--offset <n>` | Start-Offset in der Ergebnismenge (Standard `0`) |
| `--limit <n>` | Seitengröße, `1`..`500` (Standard `100`) |

## Globale Optionen

| Option | Bedeutung |
| --- | --- |
| `-v, --version` | Gibt die Version der CLI aus |
| `-h, --help` | Zeigt die Hilfe an |
| `--compact` | JSON in einer Zeile statt formatiert |
| `--base-url <url>` | Basis-URL der API, http(s), Pfad-Präfix erlaubt, aber keine `?query` und kein `#fragment` (Standard `https://routing-api-prod.fit-connect.fitko.net`) |
| `--api-version <version>` | Version der Routing-API, `v1` oder `v2` (Standard `v2`; `v1` ist veraltet) |
| `--timeout <ms>` | Zeitlimit pro Anfrage, einschließlich des Lesens der gesamten Antwort (Standard `30000`; `0` deaktiviert es; höchstens `2147483647`) |
| `--user-agent <ua>` | `User-Agent`-Header (ein leerer Wert fällt auf den Standard zurück; manche Werte blockiert die Bot-Erkennung der API) |
| `--max-retries <n>` | Retries bei vorübergehenden `429`/`503`-Antworten (`0`–`10`, Standard `2`). Jeder Retry wartet das `Retry-After` des Servers ab (bis 30 s; ein längeres wird nicht wiederholt), sonst linearer Backoff |
| `--max-response-bytes <n>` | Obergrenze für die Größe des Antwort-Bodys in Bytes (`0` = unbegrenzt; Standard 100 MiB) |

## Antwortfelder – `routes`

Antwortstruktur: `{ count, offset, totalCount, routes: Route[] }`.

| Feld von `Route` | Bedeutung |
| --- | --- |
| `destinationId` | UUID des FIT-Connect-Zustellpunkts (Ziel für das *Einreichen* eines Antrags) |
| `destinationSignature` | JWS über die Adressierungsinformationen (RFC 7515) |
| `destinationName` | Vollständiger Name der zuständigen Behörde, einschließlich Hierarchie |
| `destinationShortName` | Kurzname der Behörde |
| `destinationLogo` | URL des Logos der Behörde |
| `contactPersons[]` | `name`, `tel`, `fax`, `email` für die Leistung |
| `address` | Hausanschrift – `street`, `houseNumber`, `additional`, `zip`, `city` |
| `postalAddress` | Postanschrift (gleiche Struktur wie `address`) |
| `postOfficeBox` | Postfachanschrift – `postOfficeBox`, `zip`, `city` |
| `privacyPolicyUrl`, `imprintUrl`, `accessibilityUrl`, `contactFormUrl` | Regionsspezifische Links |
| `furtherInformation`, `requiredDocuments`, `legalBasis`, `deadline` | Lokalisierte Textblöcke: `{ description: { de, en, … } }`, können HTML enthalten |
| `processingDuration` | `{ minDuration, maxDuration, unit }` (`unit`: year/month/week/day/workday/hour/minute/second) |
| `customParameters` | Offene, leistungsspezifische Parameter (z. B. Gebühren, Varianten) |
| `origin` | Quellsystem der Routing-Angaben (z. B. `PVOG`) |

Nur `destinationId` und `destinationSignature` sind garantiert vorhanden; alles andere hängt
von Leistung und Region ab.

> **Die Prüfung der Signatur ist Sache der nutzenden Anwendung.** Dieses Tool reicht
> `destinationSignature` als **opake, ungeprüfte Zeichenkette** durch – es nimmt keinerlei
> JWS-, JWK- oder kryptografische Validierung vor. Bevor Sie sich beim Einreichen eines Antrags auf
> `destinationId` verlassen, prüfen Sie die JWS gemäß der FIT-Connect-Spezifikation gegen die von
> der FITKO veröffentlichten FIT-Connect-Schlüssel. Eine gefälschte oder per Man-in-the-Middle
> manipulierte Routing-Antwort könnte eine Einreichung sonst an einen vom Angreifer kontrollierten
> Zustellpunkt umleiten.

## Antwortfelder – `areas`

Antwortstruktur: `{ count, offset, totalCount, areas: Area[] }`.

| Feld von `Area` | Bedeutung |
| --- | --- |
| `id` | Numerische Gebiets-ID – als `--area-id` an `routes` übergeben |
| `name` | Name des Gebiets, z. B. `"Halle (Saale)"` |
| `type` | Gebietstyp; die Werte unterscheiden sich je nach Land, z. B. `"Bundesland"`, `"Landkreis"`, `"kreisfreie Stadt"`, `"Stadt"`, `"Gemeinde"`, `"Amt"`, `"Gemeindeteil"`, `"Ortsteil"` |

## Antwortfelder – `info`

`{ version: { major, minor, patch } }` – die semantische Version der betriebenen Routing-API.

## Exit-Codes

| Code | Bedeutung |
| --- | --- |
| `0` | Erfolg (auch bei `--help` / `--version`; auch bei leerer `routes`/`areas`-Liste) |
| `4` | Nicht gefunden (`404`) |
| `1` | Jeder andere API-, Netzwerk-, Parse-, Validierungs- oder Aufruffehler |
