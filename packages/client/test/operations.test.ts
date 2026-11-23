// The use cases (operations.ts) against the recorded answers (routing.ts), with the skills' traps
// as cases: a city comes with its districts, a name can fit several whole places, the words are
// ANDed, short words are left out, routing data is sparse (no route is the usual answer, not an
// error), an unknown area key is an HTTP 400, the Leistungsschlüssel is never guessed, and a
// briefing has only the sections the data has.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FitConnectClient } from "../src/client.js";
import { FitConnectValidationError } from "../src/errors.js";
import { areaKind, findArea, findAuthority, getServiceBriefing, plainText, processingOf, searchAreas } from "../src/operations.js";
import type { HttpRequest } from "../src/http.js";
import type { ProcessingDuration } from "../src/types.js";
import { AREAS_HALLE, AREAS_HANAU, EXAMPLE_KEY, ROUTE, routingApi, variant } from "./routing.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

const clientOf = (mock: ReturnType<typeof routingApi>) => new FitConnectClient({ transport: mock.transport, maxRetries: 0 });
const params = (request: HttpRequest | undefined) => new URL(request?.url ?? "http://x/").searchParams;

// ---- areas ----------------------------------------------------------------------------------

test("a city comes with its districts: the whole place is the answer, the districts are counted, ten listed", async () => {
  const mock = routingApi();
  const answer = await findArea(clientOf(mock), { place: " Hanau " });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.deepEqual(answer.area, { id: "940", name: "Hanau, Brüder-Grimm-Stadt", type: "kreisfreie Stadt", kind: "place" });
  assert.equal(answer.districts.count, 12, "Gemeindeteil and Gemeindeteil2 are districts");
  assert.equal(answer.districts.listed.length, 10);
  assert.equal(answer.total, 13);
  assert.equal(answer.complete, true);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(params(mock.calls[0]).getAll("areaSearchexpression"), ["Hanau"]);
  assert.equal(params(mock.calls[0]).get("limit"), "500", "every row in one request, so the grouping sees them all");
  const all = await findArea(clientOf(routingApi()), { place: "Hanau", allDistricts: true });
  assert.equal(all.status === "ok" ? all.districts.listed.length : 0, 12);
});

test("a name that fits several whole places is ambiguous: all of them, of every whole-place type, never one picked", async () => {
  const answer = await findArea(clientOf(routingApi()), { place: "Halle" });
  assert.equal(answer.status, "ambiguous");
  if (answer.status !== "ambiguous") return;
  assert.deepEqual(
    answer.candidates.map((c) => [c.id, c.type]),
    [["16688", "kreisfreie Stadt"], ["28415", "Mitgliedsgemeinde"], ["44466", "Stadt"], ["31927", "Mitgliedsgemeinde"]],
    "Halle (Westf.) is a Stadt, not a kreisfreie Stadt: filtering on one type would lose it",
  );
  assert.equal(answer.districts.count, 46);
  assert.match(answer.reason, /4 whole places match: ask which one/);
});

test("a postal code finds its place", async () => {
  const answer = await findArea(clientOf(routingApi()), { place: "60311" });
  assert.equal(answer.status === "ok" ? answer.area.id : undefined, "1099");
});

test("the API ANDs the words: two places in one search find nothing, and the reason says to search one place per call", async () => {
  const mock = routingApi();
  const answer = await findArea(clientOf(mock), { place: "Köln Bonn" });
  assert.equal(answer.status, "empty");
  assert.deepEqual(params(mock.calls[0]).getAll("areaSearchexpression"), ["Köln", "Bonn"]);
  assert.match(answer.status === "empty" ? answer.reason : "", /ANDs the words \(one place per call/);
});

test("words shorter than two characters are left out, and the answer says the search was wider", async () => {
  const areas = [
    { id: "1099", name: "Frankfurt am Main", type: "kreisfreie Stadt" },
    { id: "3001", name: "Frankfurt (Oder)", type: "kreisfreie Stadt" },
  ];
  const mock = routingApi({ areas });
  const answer = await findArea(clientOf(mock), { place: "Frankfurt a. M." });
  assert.deepEqual(answer.searched, { place: "Frankfurt a. M.", words: ["Frankfurt"], dropped: ["a", "M"] });
  assert.equal(answer.status, "ambiguous", "Frankfurt (Oder) matches too");
  assert.match(answer.notes.join(" "), /Left out "a", "M"/);
});

test("a letter the API can't search is refused before any request, naming it", async () => {
  const mock = routingApi();
  await assert.rejects(findArea(clientOf(mock), { place: "Éttal" }), (err: Error) => err instanceof FitConnectValidationError && /"É"/.test(err.message));
  assert.equal(mock.calls.length, 0);
});

test("only a district matches: that row is the answer; only groupings: one is the answer, several ambiguous", async () => {
  const district = await findArea(clientOf(routingApi()), { place: "Klein-Auheim" });
  assert.equal(district.status === "ok" ? district.area.id : undefined, "941");
  const lk = { id: "500", name: "Landkreis Musterkreis", type: "Landkreis" };
  const one = await findArea(clientOf(routingApi({ areas: [lk] })), { place: "Musterkreis" });
  assert.equal(one.status === "ok" ? one.area.kind : undefined, "grouping");
  const two = await findArea(clientOf(routingApi({ areas: [lk, { id: "501", name: "Amt Musterkreis-Nord", type: "Amt" }] })), { place: "Musterkreis" });
  assert.equal(two.status, "ambiguous");
});

test("one whole place and a grouping of the same name: the place, with a note naming the grouping", async () => {
  const areas = [
    { id: "7001", name: "München, Landeshauptstadt", type: "kreisfreie Stadt" },
    { id: "7002", name: "München", type: "Landkreis" },
  ];
  const answer = await findArea(clientOf(routingApi({ areas })), { place: "München" });
  assert.equal(answer.status === "ok" ? answer.area.id : undefined, "7001");
  assert.match(answer.notes.join(" "), /Also matched a grouping \(München, Landkreis\)/);
});

test("several whole places but exactly one named just that: that one, the others and the grouping in notes (München, live)", async () => {
  const answer = await findArea(clientOf(routingApi()), { place: "münchen" });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.deepEqual(answer.area, { id: "46018", name: "München", type: "kreisfreie Stadt", kind: "place" });
  assert.equal(answer.places.length, 4, "Grafing, Garching and Kirchheim b.München are still listed");
  assert.match(answer.notes.join(" "), /3 other places contain the words \(Grafing b\.München, St; Garching b\.München, St; Kirchheim b\.München\)/);
  assert.match(answer.notes.join(" "), /Also matched a grouping \(München, Landkreis\)/);
  const halle = await findArea(clientOf(routingApi()), { place: "Halle" });
  assert.equal(halle.status, "ambiguous", "Halle (Saale) and Halle (Westf.) are not named just Halle: no namesake, still ambiguous");
});

test("area types by kind: the Länder's variants; a type not seen yet is other and stays with the places", async () => {
  const kinds = Object.fromEntries(["Gemeindeteil", "Gemeindeteil2", "Ortsteil", "kreisfreie Stadt", "Stadt", "große Kreisstadt", "Amtsangehörige Gemeinde", "Mitgliedsgemeinde", "Amt", "Verwaltungsgemeinschaft", "Landkreis", "Bundesland", "Weiler"].map((t) => [t, areaKind(t)]));
  assert.deepEqual(kinds, {
    Gemeindeteil: "district",
    Gemeindeteil2: "district",
    Ortsteil: "district",
    "kreisfreie Stadt": "place",
    Stadt: "place",
    "große Kreisstadt": "place",
    "Amtsangehörige Gemeinde": "place",
    Mitgliedsgemeinde: "place",
    Amt: "grouping",
    Verwaltungsgemeinschaft: "grouping",
    Landkreis: "grouping",
    Bundesland: "grouping",
    Weiler: "other",
  });
  const answer = await findArea(clientOf(routingApi({ areas: [{ id: "1", name: "Musterweiler", type: "Weiler" }] })), { place: "Musterweiler" });
  assert.equal(answer.status === "ok" ? answer.area.kind : undefined, "other");
});

test("searchAreas pages the API's rows with their kinds, says where the next page starts, and when an offset is past the end", async () => {
  const mock = routingApi();
  const page = await searchAreas(clientOf(mock), { place: "Halle", offset: 10, limit: 20 });
  assert.equal(page.status, "ok");
  assert.equal(page.areas.length, 20);
  assert.equal(page.total, AREAS_HALLE.length);
  assert.equal(page.status === "ok" ? page.nextOffset : undefined, 30);
  assert.equal(page.areas[0]?.kind, "district");
  assert.equal(params(mock.calls[0]).get("offset"), "10");
  const past = await searchAreas(clientOf(routingApi()), { place: "Halle", offset: 60 });
  assert.equal(past.status, "empty");
  assert.match(past.status === "empty" ? past.reason : "", /found 50 areas; offset 60 is past the end/);
  const last = await searchAreas(clientOf(routingApi()), { place: "Hanau" });
  assert.equal("nextOffset" in last, false);
  assert.equal(last.areas.length, AREAS_HANAU.length);
});

// ---- routes ---------------------------------------------------------------------------------

test("findAuthority: the route's authority with its contacts, addresses and links, without the signature", async () => {
  const mock = routingApi();
  const answer = await findAuthority(clientOf(mock), { leikaKey: EXAMPLE_KEY, areaId: "940" });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  const [authority] = answer.authorities;
  assert.equal(authority?.name, ROUTE.destinationName);
  assert.deepEqual(authority?.contacts, ROUTE.contactPersons);
  assert.equal(authority?.contactFormUrl, ROUTE.contactFormUrl);
  assert.equal(authority?.destinationId, ROUTE.destinationId);
  assert.equal("destinationSignature" in (authority ?? {}), false, "addressing material for sending, not for a reader");
  assert.equal(params(mock.calls[0]).get("areaId"), "940");
});

test("findAuthority leaves out what is blank: an empty contact, a blank phone, an empty address", async () => {
  const route = variant(ROUTE, { contactPersons: [{ name: "Amt", tel: " ", email: "amt@example.org" }, { tel: "" }], address: { street: "" }, postalAddress: undefined, imprintUrl: "" });
  const answer = await findAuthority(clientOf(routingApi({ routes: { [`${EXAMPLE_KEY} areaId=940`]: [route] } })), { leikaKey: EXAMPLE_KEY, areaId: "940" });
  const authority = answer.status === "ok" ? answer.authorities[0] : undefined;
  assert.deepEqual(authority?.contacts, [{ name: "Amt", email: "amt@example.org" }]);
  assert.equal("address" in (authority ?? {}), false);
  assert.equal("postalAddress" in (authority ?? {}), false);
  assert.equal("imprintUrl" in (authority ?? {}), false);
});

test("no route is the usual answer: empty, saying FIT-Connect has none registered, not that no authority is responsible", async () => {
  const answer = await findAuthority(clientOf(routingApi()), { leikaKey: "99050012104000", ars: "064350014014" });
  assert.equal(answer.status, "empty");
  if (answer.status !== "empty") return;
  assert.match(answer.reason, /No FIT-Connect Zustellpunkt is registered for service 99050012104000 in ars 064350014014\. That is the usual answer/);
  assert.match(answer.reason, /does not mean no authority is responsible/);
  assert.deepEqual(answer.broader, { ars: "06" }, "the Land's key: the broader area the service always knows");
  assert.deepEqual(Object.keys(answer), ["status", "searched", "reason", "broader"], "nothing internal");
});

test("a place by name is resolved first, then routed by its area id; the answer says which area it took", async () => {
  const mock = routingApi();
  const answer = await findAuthority(clientOf(mock), { leikaKey: EXAMPLE_KEY, place: "Hanau" });
  assert.equal(answer.status, "ok");
  assert.equal(mock.calls.length, 2);
  assert.equal(params(mock.calls[1]).get("areaId"), "940");
  assert.equal(answer.searched.area?.id, "940");
  assert.match(answer.status === "ok" ? answer.notes.join(" ") : "", /resolved to Hanau, Brüder-Grimm-Stadt \(kreisfreie Stadt, areaId 940\)/);
});

test("no route for a place given by name: the answer still says which area it took and what else matched", async () => {
  const answer = await findAuthority(clientOf(routingApi()), { leikaKey: "99050012104000", place: "München" });
  assert.equal(answer.status, "empty");
  if (answer.status !== "empty") return;
  assert.equal(answer.searched.area?.id, "46018");
  assert.match(answer.notes?.join(" ") ?? "", /resolved to München \(kreisfreie Stadt, areaId 46018\).*3 other places contain the words/);
  const byKey = await findAuthority(clientOf(routingApi()), { leikaKey: "99050012104000", ars: "064350014014" });
  assert.equal("notes" in byKey, false, "nothing to say for a key");
});

test("a place that fits several areas is ambiguous, and no route is asked for", async () => {
  const mock = routingApi();
  const answer = await findAuthority(clientOf(mock), { leikaKey: EXAMPLE_KEY, place: "Halle" });
  assert.equal(answer.status, "ambiguous");
  assert.equal(answer.status === "ambiguous" ? answer.candidates.length : 0, 4);
  assert.match(answer.status === "ambiguous" ? answer.reason : "", /call again with its areaId/);
  assert.equal(mock.calls.length, 1);
});

test("an area key the routing service doesn't know (its HTTP 400) is empty with what to give instead", async () => {
  const answer = await findAuthority(clientOf(routingApi()), { leikaKey: EXAMPLE_KEY, ars: "120645410" });
  assert.equal(answer.status, "empty");
  assert.match(answer.status === "empty" ? answer.reason : "", /knows no area with ars 120645410.*Give the place by name instead/);
  assert.deepEqual(answer.status === "empty" ? answer.broader : undefined, { ars: "12" });
});

test("the Leistungsschlüssel is checked and never guessed; exactly one place selector; malformed keys refused before any request", async () => {
  const mock = routingApi();
  const client = clientOf(mock);
  await assert.rejects(findAuthority(client, { leikaKey: "Personalausweis", place: "Hanau" }), /expected "99" followed by 12 digits.*FIM Portal resolves a service name to its key/);
  await assert.rejects(findAuthority(client, { leikaKey: EXAMPLE_KEY }), /exactly one of place, ags, ars or areaId; got none/);
  await assert.rejects(findAuthority(client, { leikaKey: EXAMPLE_KEY, ags: "06435014", areaId: "940" }), /got ags, areaId/);
  await assert.rejects(findAuthority(client, { leikaKey: EXAMPLE_KEY, ags: "0643501" }), /Invalid ags "0643501"/);
  await assert.rejects(findAuthority(client, { leikaKey: EXAMPLE_KEY, ars: "1234567" }), /Invalid ars/);
  await assert.rejects(findAuthority(client, { leikaKey: EXAMPLE_KEY, areaId: "x9" }), FitConnectValidationError);
  assert.equal(mock.calls.length, 0);
});

// ---- briefing -------------------------------------------------------------------------------

test("a briefing: the texts as plain text in German, the processing time as a range, the service's parameters, the authority", async () => {
  const answer = await getServiceBriefing(clientOf(routingApi()), { leikaKey: EXAMPLE_KEY, areaId: "940" });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  const [briefing] = answer.briefings;
  assert.deepEqual(briefing?.about, { text: "Dies sind weiterführende Infos zur Leistung.", language: "de" });
  assert.equal(briefing?.deadline?.text, "Die Anmeldung eines Straßenfestes muss mind. zwei Wochen vor dem Straßenfest erfolgen.");
  assert.deepEqual(briefing?.processing, { minDuration: 1, maxDuration: 4, unit: "week", text: "1–4 weeks" });
  assert.equal(briefing?.customParameters?.["mahngebuehr"], 10.99);
  assert.equal(briefing?.authority.name, ROUTE.destinationName);
});

test("a briefing in English takes the en texts, and the German one where en is missing, saying which", async () => {
  const route = variant(ROUTE, { legalBasis: { description: { de: "<p>§ 1 <b>Muster</b>gesetz</p>" } } });
  const answer = await getServiceBriefing(clientOf(routingApi({ routes: { [`${EXAMPLE_KEY} areaId=940`]: [route] } })), { leikaKey: EXAMPLE_KEY, areaId: "940", language: "en" });
  const briefing = answer.status === "ok" ? answer.briefings[0] : undefined;
  assert.deepEqual(briefing?.about, { text: "This is further information about the public service.", language: "en" });
  assert.deepEqual(briefing?.legalBasis, { text: "§ 1 Mustergesetz", language: "de" });
});

test("a briefing has only the sections the data has: no heading for a missing or blank one", async () => {
  const route = { destinationId: "d1", destinationSignature: "s", destinationName: "Amt", requiredDocuments: { description: { de: "<p> </p>" } } };
  const answer = await getServiceBriefing(clientOf(routingApi({ routes: { [`${EXAMPLE_KEY} areaId=940`]: [route] } })), { leikaKey: EXAMPLE_KEY, areaId: "940" });
  assert.deepEqual(answer.status === "ok" ? Object.keys(answer.briefings[0] ?? {}) : [], ["authority"]);
});

test("no route means nothing to brief: empty, pointing to the FIM Portal's service texts; a wrong language is refused", async () => {
  const answer = await getServiceBriefing(clientOf(routingApi()), { leikaKey: "99050012104000", areaId: "940" });
  assert.equal(answer.status, "empty");
  assert.match(answer.status === "empty" ? answer.reason : "", /nothing to brief.*FIM Portal's service texts/);
  await assert.rejects(getServiceBriefing(clientOf(routingApi()), { leikaKey: EXAMPLE_KEY, areaId: "940", language: "fr" as "de" }), /expected "de" or "en"/);
});

test("the processing time as a human range, from either bound", () => {
  assert.equal(processingOf({ maxDuration: 4, unit: "week" })?.text, "up to 4 weeks");
  assert.equal(processingOf({ minDuration: 1, unit: "week" })?.text, "at least 1 week");
  assert.equal(processingOf({ minDuration: 3, maxDuration: 3, unit: "workday" })?.text, "3 working days");
  assert.equal(processingOf({ minDuration: 1, maxDuration: 2 })?.text, "1–2 (no unit given)");
  assert.equal(processingOf({ unit: "day" }), undefined);
});

test("plainText drops the tags, keeps lists as lists and decodes entities", () => {
  assert.equal(plainText("<p>Unterlagen:</p><ul><li>Pass &amp; Foto</li><li>Nachweis&nbsp;A</li></ul>Ende<br>&#x2713;"), "Unterlagen:\n\n- Pass & Foto\n- Nachweis A\nEnde\n✓");
});

test("plainText is linear: an opening bracket with no closing one never rescans the rest of the text", () => {
  // `/<[^>]*>/` and `/<\s*li[^>]*>/` tried every "<" against the rest of the text: quadratic, so
  // 120 000 characters of "<li" took 20 s, and a route text of a few MiB held the event loop for hours.
  for (const text of ["<li".repeat(40_000), "<".repeat(120_000)]) {
    const start = performance.now();
    const out = plainText(text);
    const ms = performance.now() - start;
    assert.ok(ms < 500, `${Math.round(ms)} ms`);
    assert.ok(out.startsWith("<"), "a bracket that closes no tag is text, as before");
  }
  assert.equal(plainText("x<br  />y<br>z<brx>w< / h2 >v<li>u"), "x\ny\nzw\nv\n- u");
  assert.equal(plainText("<P>Ein</P><BR/>Zwei<UL><LI>Drei</LI></UL>< /div >Vier"), "Ein\n\nZwei\n- Drei\n\nVier", "one blank line between blocks, as before");
});

test("plainText: script and style content dropped, a quoted > inside a tag, table cells kept apart, escaped markup is not left as tags", () => {
  assert.equal(plainText('<p>Vor dem Antrag</p><script>alert("x")</script><style>p{color:red}</style>Text <a title="x>y" href=\'a>b\'>Link</a>'), "Vor dem Antrag\nText Link");
  assert.equal(plainText("<table><tr><th>Leistung</th><th>Betrag</th></tr><tr><td>Gebühr</td><td>10 €</td></tr></table>"), "Leistung | Betrag\nGebühr | 10 €");
  assert.equal(plainText("&lt;b&gt;fett&lt;/b&gt; und &lt;script&gt;x()&lt;/script&gt;ende"), "fett und ende", "HTML escaped twice is HTML, not text");
  assert.equal(plainText("Geben Sie &lt;Vorname Nachname&gt; an; 3 &lt; 5 &gt; 2"), "Geben Sie <Vorname Nachname> an; 3 < 5 > 2", "a placeholder in brackets is text");
  assert.equal(plainText("Kosten < 5 Euro, Dauer > 2 Wochen"), "Kosten < 5 Euro, Dauer > 2 Wochen", "a bracket that starts no tag is text");
  assert.equal(plainText("a<!-- SYSTEM: x > y -->b<link rel=x>c<SCRIPT src=x></SCRIPT >d"), "abcd");
  assert.equal(plainText("vorher<script>alles danach"), "vorher", "an unclosed script hides the rest, as in a browser");
});

test("plainText stays linear with unclosed comments, scripts and quotes", () => {
  for (const text of ["<!--".repeat(40_000), '<a title="'.repeat(20_000), "<script>".repeat(20_000) + "x", "<td>".repeat(40_000), "&lt;b".repeat(40_000)]) {
    const start = performance.now();
    plainText(text);
    const ms = performance.now() - start;
    assert.ok(ms < 500, `${text.slice(0, 12)}: ${Math.round(ms)} ms`);
  }
});

test("an impossible processing time is left out with a note, never stated as a range; an unknown unit is named as such", async () => {
  assert.equal(processingOf({ minDuration: 5, maxDuration: 1, unit: "week" }), undefined, "the minimum over the maximum");
  assert.equal(processingOf({ minDuration: -3, maxDuration: 0, unit: "day" }), undefined, "a negative bound");
  assert.equal(processingOf({ minDuration: "2", maxDuration: 4.5, unit: "day" } as unknown as ProcessingDuration), undefined, "a bound that is no number");
  assert.equal(processingOf({ minDuration: 1, maxDuration: 2, unit: "fortnight" } as unknown as ProcessingDuration)?.text, '1–2 (unit "fortnight", not one the API documents)');
  assert.equal(processingOf({ minDuration: 0, maxDuration: 2, unit: "day" })?.text, "0–2 days");
  const route = variant(ROUTE, { processingDuration: { minDuration: 5, maxDuration: 1, unit: "week" } });
  const answer = await getServiceBriefing(clientOf(routingApi({ routes: { [`${EXAMPLE_KEY} areaId=940`]: [route] } })), { leikaKey: EXAMPLE_KEY, areaId: "940" });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal("processing" in (answer.briefings[0] ?? {}), false);
  assert.match(answer.notes.join(" "), /processing time of Stadtverwaltung Musterstadt .* left out: the route gives 5 to 1 week/);
});

test("searchAreas: an upstream that ignores the offset is an error, not a second page of the same rows", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: String(i + 1), name: `Drift ${i + 1}`, type: "Gemeindeteil" }));
  const mock = makeMockTransport(() => jsonResponse({ count: 100, offset: 0, totalCount: 250, areas: rows.slice(0, 100) }));
  const client = new FitConnectClient({ transport: mock.transport, maxRetries: 0 });
  const first = await searchAreas(client, { place: "Drift", limit: 100 });
  assert.equal(first.status === "ok" ? first.nextOffset : undefined, 100);
  await assert.rejects(searchAreas(client, { place: "Drift", offset: 100, limit: 100 }), /starts at offset 0, not at the 100 asked/);
});

test("maxPages: a whole number from 1 to 100, checked before any request; the default reads on past 500 rows", async () => {
  const mock = routingApi();
  for (const maxPages of [0, 101, 1.5, Number.NaN]) {
    await assert.rejects(findArea(clientOf(mock), { place: "Hanau", maxPages }), /Invalid maxPages .*expected a whole number from 1 to 100/);
    await assert.rejects(findAuthority(clientOf(mock), { leikaKey: EXAMPLE_KEY, place: "Hanau", maxPages }), /Invalid maxPages/);
  }
  assert.equal(mock.calls.length, 0);
  const areas = Array.from({ length: 501 }, (_, i) => ({ id: String(i + 1), name: `Weit ${i}`, type: "Gemeindeteil" }));
  const wide = routingApi({ areas });
  const answer = await findArea(clientOf(wide), { place: "Weit" });
  assert.equal(answer.status === "empty" ? 0 : answer.districts.count, 501);
  assert.deepEqual(wide.calls.map((c) => params(c).get("offset")), [null, "500"]);
});

test("a search with more rows than were read is never answered ok from the part read: ambiguous, saying how much was read", async () => {
  const areas = [
    { id: "5", name: "Altort (Rhein)", type: "Stadt" },
    ...Array.from({ length: 520 }, (_, i) => ({ id: String(100 + i), name: `Altort (Rhein) - OT Teil ${i}`, type: "Gemeindeteil" })),
    { id: "7", name: "Altort", type: "kreisfreie Stadt" },
  ];
  const part = await findArea(clientOf(routingApi({ areas })), { place: "Altort", maxPages: 1 });
  assert.equal(part.status, "ambiguous");
  if (part.status !== "ambiguous") return;
  assert.equal(part.complete, false);
  assert.match(part.reason, /found 522 areas and only the first 500 were read/);
  assert.deepEqual(part.candidates.map((c) => c.id), ["5"]);
  const routed = routingApi({ areas });
  const lookup = await findAuthority(clientOf(routed), { leikaKey: EXAMPLE_KEY, place: "Altort", maxPages: 1 });
  assert.equal(lookup.status, "ambiguous", "no route asked for a place picked from a part");
  assert.equal(routed.calls.length, 1);
  const whole = await findArea(clientOf(routingApi({ areas })), { place: "Altort" });
  assert.equal(whole.status === "ok" ? whole.area.id : undefined, "7", "read to the end, the place named just that");
});

test("a route page that counts routes but holds none is an error, not the usual 'no Zustellpunkt'; both lookups say how many routes they list", async () => {
  const drift = makeMockTransport(() => jsonResponse({ count: 0, offset: 0, totalCount: 3, routes: [] }));
  const client = new FitConnectClient({ transport: drift.transport, maxRetries: 0 });
  await assert.rejects(findAuthority(client, { leikaKey: EXAMPLE_KEY, areaId: "940" }), /holds no rows, though the total is 3/);
  await assert.rejects(getServiceBriefing(client, { leikaKey: EXAMPLE_KEY, areaId: "940" }), /holds no rows, though the total is 3/);
  const routes = Array.from({ length: 501 }, (_, i) => ({ destinationId: `d${i}`, destinationSignature: "s" }));
  const many = () => clientOf(routingApi({ routes: { [`${EXAMPLE_KEY} areaId=940`]: routes } }));
  const authority = await findAuthority(many(), { leikaKey: EXAMPLE_KEY, areaId: "940", maxPages: 1 });
  const briefing = await getServiceBriefing(many(), { leikaKey: EXAMPLE_KEY, areaId: "940", maxPages: 1 });
  for (const answer of [authority, briefing]) {
    assert.equal(answer.status, "ok");
    assert.match(answer.status === "ok" ? answer.notes.join(" ") : "", /501 routes, the first 500 listed/);
  }
  const all = await getServiceBriefing(many(), { leikaKey: EXAMPLE_KEY, areaId: "940" });
  assert.equal(all.status === "ok" ? all.briefings.length : 0, 501);
  assert.doesNotMatch(all.status === "ok" ? all.notes.join(" ") : "", /listed/);
});
