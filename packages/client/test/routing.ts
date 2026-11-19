// A mock of the FIT-Connect Routing API over recorded answers, for the use cases' tests
// (operations.ts) and the MCP server's. The area answers were recorded from the live API
// (https://routing-api-prod.fit-connect.fitko.net/v2) on 2026-11-19 around 23:10 CET with the
// fit-connect CLI, in full (they are small): "Hanau" (13: the kreisfreie Stadt and 12 parts, some
// of type Gemeindeteil2), "Halle" (50: Halle (Saale), Halle (Westf.), two Mitgliedsgemeinden and 46
// Gemeindeteile), the postal code 60311 (6: Frankfurt am Main and 5 parts), "Köln Bonn" (none: the
// API ANDs the words), the info answer, and the problem answer for an area key the service
// doesn't know (HTTP 400, application/problem+json).
// No live lookup found a route (count 0 for every service and place tried, 2026-09-15 and
// 2026-11-19, the FITKO documentation's examples included), so ROUTE is the OpenAPI spec's
// documented example (routing-api.yaml 2.0.0, its field examples: Musterstadt; the signature, a
// long JWT, cut to a short stand-in), answered here for EXAMPLE_KEY in Hanau (areaId 940).
// The mock answers by path: an area search filters the recorded rows by its words (every word in
// the name, any case, `*` as a wildcard; a postal code by its recording), pages them, and a route
// lookup answers from the routes given for "<leikaKey> <selector>=<value>".

import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { Area, Route } from "../src/types.js";
import { jsonResponse, makeMockTransport, rawResponse, type MockTransport } from "./helpers.js";

const rows = (list: [string, string, string][]): Area[] => list.map(([id, name, type]) => ({ id, name, type }));

/** "Hanau": the kreisfreie Stadt first, then its 12 parts. */
export const AREAS_HANAU: Area[] = rows([
  ["940", "Hanau, Brüder-Grimm-Stadt", "kreisfreie Stadt"],
  ["945", "Hanau, Brüder-Grimm-Stadt - OT Früheres Stadtgebiet", "Gemeindeteil"],
  ["946", "Hanau, Brüder-Grimm-Stadt - OT Früheres Stadtgebiet - OT Mitte", "Gemeindeteil2"],
  ["947", "Hanau, Brüder-Grimm-Stadt - OT Früheres Stadtgebiet - OT Kesselstadt", "Gemeindeteil2"],
  ["948", "Hanau, Brüder-Grimm-Stadt - OT Früheres Stadtgebiet - OT Nordwest", "Gemeindeteil2"],
  ["949", "Hanau, Brüder-Grimm-Stadt - OT Früheres Stadtgebiet - OT Nordost", "Gemeindeteil2"],
  ["950", "Hanau, Brüder-Grimm-Stadt - OT Früheres Stadtgebiet - OT Südost", "Gemeindeteil2"],
  ["941", "Hanau, Brüder-Grimm-Stadt - OT Klein-Auheim", "Gemeindeteil"],
  ["942", "Hanau, Brüder-Grimm-Stadt - OT Mittelbuchen", "Gemeindeteil"],
  ["943", "Hanau, Brüder-Grimm-Stadt - OT Steinheim am Main", "Gemeindeteil"],
  ["944", "Hanau, Brüder-Grimm-Stadt - OT Wolfgang", "Gemeindeteil"],
  ["951", "Hanau, Brüder-Grimm-Stadt - OT Großauheim", "Gemeindeteil"],
  ["952", "Hanau, Brüder-Grimm-Stadt - OT Hohe Tanne (ehemaliger Ortsteil von Wachenbuchen)", "Gemeindeteil"],
]);

/** "Halle": four whole places (two of them Mitgliedsgemeinden in Niedersachsen) and 46 Gemeindeteile. */
export const AREAS_HALLE: Area[] = rows([
  ["16688", "Halle (Saale)", "kreisfreie Stadt"],
  ["16689", "Halle (Saale) - OT Radewell/Osendorf", "Gemeindeteil"],
  ["16690", "Halle (Saale) - OT Reideburg", "Gemeindeteil"],
  ["16691", "Halle (Saale) - OT Saaleaue", "Gemeindeteil"],
  ["16692", "Halle (Saale) - OT Seeben", "Gemeindeteil"],
  ["16693", "Halle (Saale) - OT Ortslage Lettin", "Gemeindeteil"],
  ["16694", "Halle (Saale) - OT Ortslage Trotha", "Gemeindeteil"],
  ["16695", "Halle (Saale) - OT Paulusviertel", "Gemeindeteil"],
  ["16696", "Halle (Saale) - OT Planena", "Gemeindeteil"],
  ["16697", "Halle (Saale) - OT Tornau", "Gemeindeteil"],
  ["16698", "Halle (Saale) - OT Westliche Neustadt", "Gemeindeteil"],
  ["16699", "Halle (Saale) - OT Silberhöhe", "Gemeindeteil"],
  ["16700", "Halle (Saale) - OT Südliche Innenstadt", "Gemeindeteil"],
  ["16701", "Halle (Saale) - OT Südliche Neustadt", "Gemeindeteil"],
  ["16702", "Halle (Saale) - OT Südstadt", "Gemeindeteil"],
  ["16703", "Halle (Saale) - OT Am Wasserturm/Thaerviertel", "Gemeindeteil"],
  ["16704", "Halle (Saale) - OT Böllberg/Wörmlitz", "Gemeindeteil"],
  ["16705", "Halle (Saale) - OT Büschdorf", "Gemeindeteil"],
  ["16706", "Halle (Saale) - OT Damaschkestraße", "Gemeindeteil"],
  ["16707", "Halle (Saale) - OT Altstadt", "Gemeindeteil"],
  ["16708", "Halle (Saale) - OT Dölauer Heide", "Gemeindeteil"],
  ["16709", "Halle (Saale) - OT Freiimfelde/Kanenaer Weg", "Gemeindeteil"],
  ["16710", "Halle (Saale) - OT Frohe Zukunft", "Gemeindeteil"],
  ["16711", "Halle (Saale) - OT Gebiet der Deutschen Reichsbahn", "Gemeindeteil"],
  ["16712", "Halle (Saale) - OT Dautzsch", "Gemeindeteil"],
  ["16713", "Halle (Saale) - OT Diemitz", "Gemeindeteil"],
  ["16714", "Halle (Saale) - OT Dieselstraße", "Gemeindeteil"],
  ["16715", "Halle (Saale) - OT Dölau", "Gemeindeteil"],
  ["16716", "Halle (Saale) - OT Heide-Nord/Blumenau", "Gemeindeteil"],
  ["16717", "Halle (Saale) - OT Heide-Süd", "Gemeindeteil"],
  ["16718", "Halle (Saale) - OT Industriegebiet Nord", "Gemeindeteil"],
  ["16719", "Halle (Saale) - OT Kanena/Bruckdorf", "Gemeindeteil"],
  ["16720", "Halle (Saale) - OT Gesundbrunnen", "Gemeindeteil"],
  ["16721", "Halle (Saale) - OT Gewerbegebiet Neustadt", "Gemeindeteil"],
  ["16722", "Halle (Saale) - OT Giebichenstein", "Gemeindeteil"],
  ["16723", "Halle (Saale) - OT Gottfried-Keller-Siedlung", "Gemeindeteil"],
  ["16724", "Halle (Saale) - OT Nietleben", "Gemeindeteil"],
  ["16725", "Halle (Saale) - OT Nördliche Innenstadt", "Gemeindeteil"],
  ["16726", "Halle (Saale) - OT Nördliche Neustadt", "Gemeindeteil"],
  ["16727", "Halle (Saale) - OT Ortslage Ammendorf/Beesen", "Gemeindeteil"],
  ["16728", "Halle (Saale) - OT Kröllwitz", "Gemeindeteil"],
  ["16729", "Halle (Saale) - OT Landrain", "Gemeindeteil"],
  ["16730", "Halle (Saale) - OT Lutherplatz/Thüringer Bahnhof", "Gemeindeteil"],
  ["16731", "Halle (Saale) - OT Mötzlich", "Gemeindeteil"],
  ["27393", "Raddestorf - OT Halle", "Gemeindeteil"],
  ["28415", "Halle (Niedersachsen, 37620)", "Mitgliedsgemeinde"],
  ["28416", "Halle - OT Halle", "Gemeindeteil"],
  ["28417", "Halle - OT Kreipke", "Gemeindeteil"],
  ["44466", "Halle (Westf.)", "Stadt"],
  ["31927", "Halle (Niedersachsen, 49843)", "Mitgliedsgemeinde"],
]);

/** The postal code 60311: Frankfurt am Main and five of its parts. */
export const AREAS_60311: Area[] = rows([
  ["1099", "Frankfurt am Main", "kreisfreie Stadt"],
  ["1107", "Frankfurt am Main - OT Altstadt", "Gemeindeteil"],
  ["1159", "Frankfurt am Main - OT Nieder-Eschbach", "Gemeindeteil"],
  ["1172", "Frankfurt am Main - OT Nieder-Erlenbach", "Gemeindeteil"],
  ["1175", "Frankfurt am Main - OT Kalbach", "Gemeindeteil"],
  ["1179", "Frankfurt am Main - OT Gallusviertel", "Gemeindeteil"],
]);

/** The info answer. */
export const INFO = { version: { major: 2, minor: 1, patch: 0 } };

/** The problem answer for an ars or ags the routing service doesn't know (HTTP 400). */
export const AREA_NOT_FOUND = {
  detail: "No Area was found with given AreaKey.",
  instance: "/v2/routes",
  status: 400,
  title: "Area not found",
  type: "https://schema.fitko.de/fit-connect/routing-api/problems/area-not-found",
};

/** The OpenAPI spec's example Leistungsschlüssel. */
export const EXAMPLE_KEY = "99123456760610";

/** A route as the OpenAPI spec documents it (its field examples). */
export const ROUTE: Route = {
  destinationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  destinationSignature: "eyJraWQiOiJmT0hzdExPNGJlQnEwcHgtMDFwTEoyUnhQbUJEakNtbEtIQk84ZzVXLVNBIiwidHlwIjoiand0IiwiYWxnIjoiUFM1MTIifQ.e30.c2ln",
  destinationName: "Stadtverwaltung Musterstadt - Dezernat II - Einwohner:innenmeldeamt",
  destinationShortName: "Einwohner:innenmeldeamt Musterstadt",
  destinationLogo: "https://efadante.hessen.de/ressources/framework/pics/Bundesland-HE.svg",
  contactPersons: [{ name: "Dr. Erika Muster", tel: "+496990009123", fax: "+496990009124", email: "mail@example.org" }],
  address: { street: "Am Alten Stadtschloss", houseNumber: "13 A", additional: "Hinterhof, 3. Aufgang, Haus A", zip: "11011", city: "Berlin (Mahzahn)" },
  postalAddress: { street: "Am Alten Stadtschloss", houseNumber: "13 A", additional: "Hinterhof, 3. Aufgang, Haus A", zip: "11011", city: "Berlin (Mahzahn)" },
  postOfficeBox: { postOfficeBox: "Postfach 8 15", zip: "11011", city: "Berlin (Mahzahn)" },
  privacyPolicyUrl: "https://www.fitko.de/datenschutz",
  imprintUrl: "https://www.fitko.de/impressum",
  accessibilityUrl: "https://www.fitko.de/barrierefreiheitserklaerung",
  contactFormUrl: "https://zustaendige-fachbehoerde.example.org/contactform",
  furtherInformation: { description: { de: "<p>Dies sind weiterführende Infos zur Leistung.</p>", en: "<p>This is further information about the public service.</p>" } },
  requiredDocuments: { description: { de: "<p>Dies ist die Beschreibung aller erforderlicher Unterlagen.</p>", en: "<p>This is the description of all required documents.</p>" } },
  legalBasis: { description: { de: "<p>Dies ist die Beschreibung der Rechtsgrundlage.</p>", en: "<p>This is the legal basis description.</p>" } },
  deadline: {
    description: {
      de: "<p>Die Anmeldung eines Straßenfestes muss mind. zwei Wochen vor dem Straßenfest erfolgen.</p>",
      en: "<p>The registration of a street party must be made at least two weeks before the street party.</p>",
    },
  },
  processingDuration: { minDuration: 1, maxDuration: 4, unit: "week" },
  customParameters: { hunderasse: 3, geschaeftsstelle: 3, prozessvariante: "lieferant", mahnfrist: 14, mahngebuehr: 10.99 },
  origin: "PVOG",
};

/** `base` with `changes` laid over it. */
export function variant<T extends object>(base: T, changes: Partial<T> | Record<string, unknown>): T {
  return { ...base, ...changes } as T;
}

/** What the mock answers: the area rows searched by name, the rows per postal code, the routes per lookup. */
export interface RoutingFixture {
  /** Every area a name search can find (default: Hanau's and Halle's). */
  areas?: Area[];
  /** Rows per postal code (default: 60311's). */
  postalCodes?: Record<string, Area[]>;
  /** Routes per "<leikaKey> <selector>=<value>" (default: ROUTE for EXAMPLE_KEY in areaId 940). */
  routes?: Record<string, Route[]>;
  /** Area keys the service doesn't know: "ars=…" or "ags=…" (default: ars=120645410). */
  unknownKeys?: string[];
}

/** The mock's answer to `request`. */
export function routingAnswer(request: HttpRequest, fixture: RoutingFixture = {}): HttpResponse {
  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const page = <T>(key: string, list: T[]) => {
    const slice = list.slice(offset, offset + limit);
    return jsonResponse({ count: slice.length, offset, totalCount: list.length, [key]: slice });
  };
  if (url.pathname.endsWith("/info")) return jsonResponse(INFO);
  if (url.pathname.endsWith("/areas")) {
    const words = url.searchParams.getAll("areaSearchexpression");
    const postal = fixture.postalCodes ?? { "60311": AREAS_60311 };
    if (words.length === 1 && /^\d+$/.test(words[0] as string)) return page("areas", postal[words[0] as string] ?? []);
    const pool = fixture.areas ?? [...AREAS_HANAU, ...AREAS_HALLE];
    const patterns = words.map((w) => new RegExp(w.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i"));
    return page("areas", pool.filter((area) => patterns.every((p) => p.test(area.name))));
  }
  if (url.pathname.endsWith("/routes")) {
    const key = url.searchParams.get("leikaKey");
    const selector = (["ags", "ars", "areaId"] as const).map((k) => [k, url.searchParams.get(k)] as const).find(([, v]) => v !== null);
    const where = selector === undefined ? "" : `${selector[0]}=${selector[1]}`;
    if ((fixture.unknownKeys ?? ["ars=120645410"]).includes(where)) return rawResponse(JSON.stringify(AREA_NOT_FOUND), "application/problem+json", 400);
    const routes = fixture.routes ?? { [`${EXAMPLE_KEY} areaId=940`]: [ROUTE] };
    return page("routes", routes[`${key} ${where}`] ?? []);
  }
  return jsonResponse({ title: "Not Found", status: 404 }, 404);
}

/** A mock transport over the recorded answers (or `fixture`'s), recording every request. */
export function routingApi(fixture: RoutingFixture = {}): MockTransport {
  return makeMockTransport((request) => routingAnswer(request, fixture));
}
