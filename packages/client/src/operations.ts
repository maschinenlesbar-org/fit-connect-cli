// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the CLI, the MCP server's tools, a
// library user) has to know them:
// - findArea (fit-connect-area-lookup): a place or postal code to its area, the whole place first;
// - findAuthority (fit-connect-find-authority): a service in a place to the responsible
//   authority (Zustellpunkt), or plainly none registered, the usual answer;
// - getServiceBriefing (fit-connect-service-briefing): a service in a place as a "how to apply"
//   briefing from the route's region-specific texts;
// and the area search as it is, a page at a time (searchAreas), for what those don't reach.
//
// The rules they keep: ambiguity is reported, never guessed (several whole places are
// `ambiguous`, with the candidates); no bare "not found" (an empty answer says what was searched
// and what to change); each answer is a named type (public API of the CLI package: a changed
// shape is a `feat(client)!:` commit).

import { AGS_PATTERN, ARS_PATTERN, MAX_LIMIT, areaSearchWords, type FitConnectClient } from "./client.js";
import { FitConnectApiError, FitConnectValidationError } from "./errors.js";
import type { Address, Area, ContactPerson, JsonObject, LocalizedText, PostOfficeBox, ProcessingDuration, Route } from "./types.js";
import { areaIdProblem, assertValid, quoteValue } from "./validate.js";

// ---- areas ----------------------------------------------------------------------------------

/** What an area entry is: a whole town or municipality, a part of one, or an administrative grouping. */
export type AreaKind = "place" | "district" | "grouping" | "other";

/** The area types seen live (2026-09 to 2026-11), by kind; compared without case. */
const PLACE_TYPES = ["kreisfreie stadt", "stadtkreis", "stadt", "große kreisstadt", "gemeinde", "kreisangehörige gemeinde", "amtsangehörige gemeinde", "mitgliedsgemeinde", "ortsgemeinde", "markt", "einheitsgemeinde"];
const GROUPING_TYPES = ["amt", "verwaltungsgemeinschaft", "verbandsgemeinde", "samtgemeinde", "verwaltungsverband", "gemeindeverwaltungsverband", "landkreis", "kreis", "regierungsbezirk", "bundesland", "land", "staat"];

/**
 * The kind of an area `type`: a district (Gemeindeteil, Gemeindeteil2, Ortsteil: collapse these),
 * a place (a whole town or municipality), a grouping (Amt, Landkreis, Bundesland, …), else other.
 * The values differ by Land, so a type not seen yet is `other`, never dropped.
 */
export function areaKind(type: string): AreaKind {
  const t = type.trim().normalize("NFC").toLocaleLowerCase("de");
  if (/^(gemeindeteil|ortsteil|stadtteil|ortschaft)/.test(t)) return "district";
  if (PLACE_TYPES.includes(t)) return "place";
  if (GROUPING_TYPES.includes(t)) return "grouping";
  return "other";
}

/** An area entry with its kind. */
export interface AreaEntry extends Area {
  kind: AreaKind;
}

/** The input of {@link findArea}. */
export interface FindAreaInput {
  /** A place name ("Hanau", "Frankfurt am Main", "Mag*") or a postal code ("60311"). */
  place: string;
  /** List every district (Gemeindeteil, Ortsteil) instead of the first 10 (default false). */
  allDistricts?: boolean | undefined;
  /** The most pages of 500 rows the search reads (1–100, default {@link DEFAULT_MAX_PAGES}). */
  maxPages?: number | undefined;
}

/** How many pages of 500 rows a use case reads at most, unless told otherwise. */
export const DEFAULT_MAX_PAGES = 10;

/** `maxPages` checked: a whole number 1–100, or the default. */
function maxPagesOf(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_PAGES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new FitConnectValidationError(`Invalid maxPages ${quoteValue(String(value))}: expected a whole number from 1 to 100.`);
  }
  return value;
}

/**
 * Every row of a list, a page of {@link MAX_LIMIT} at a time, until the API's total is read, a
 * page comes back empty, or `maxPages` pages were read. The first page is asked without an
 * offset, the next ones from the rows read so far.
 */
async function readPages<T>(maxPages: number, page: (offset: number | undefined) => Promise<{ rows: T[]; total: number }>): Promise<{ rows: T[]; total: number }> {
  const rows: T[] = [];
  let total = 0;
  for (let n = 0; n < maxPages; n += 1) {
    const answer = await page(n === 0 ? undefined : rows.length);
    total = answer.total;
    rows.push(...answer.rows);
    if (answer.rows.length === 0 || rows.length >= total) break;
  }
  return { rows, total };
}

/** What {@link findArea} searched: the input, the words sent, and the words left out. */
export interface AreaSearched {
  place: string;
  words: string[];
  /** Words shorter than 2 letters or digits, which the API can't search (left out). */
  dropped: string[];
}

/** The rows of an area search, grouped by kind. */
export interface AreaGroups {
  /** Whole towns and municipalities (and types not seen yet). */
  places: AreaEntry[];
  /** Administrative groupings: Amt, Landkreis, Bundesland, … */
  groupings: AreaEntry[];
  /** Districts of a place: how many, and the first 10 (all with allDistricts). */
  districts: { count: number; listed: AreaEntry[] };
  /** Rows the API found (totalCount). */
  total: number;
  /** False when the API found more rows than were read (maxPages pages of 500): narrow the words. */
  complete: boolean;
}

/** The answer of {@link findArea}. */
export type AreaLookup =
  | ({ status: "ok"; searched: AreaSearched; area: AreaEntry; notes: string[] } & AreaGroups)
  | ({ status: "ambiguous"; searched: AreaSearched; candidates: AreaEntry[]; reason: string; notes: string[] } & AreaGroups)
  | { status: "empty"; searched: AreaSearched; reason: string; notes: string[] };

const DISTRICTS_LISTED = 10;

/**
 * A place or postal code to its area entry, the id a route lookup takes (areaId). The API ANDs the
 * words: every word must match the same area, so one place per call. A city comes with its
 * districts: the whole place leads (status ok), the districts are counted. Several whole places
 * (Halle: Halle (Saale), Halle (Westf.), two Mitgliedsgemeinden) are `ambiguous`, unless exactly
 * one is named just what was searched (München beside Grafing b.München: the others in a note), or,
 * failing that, exactly one is so named before an addition after a comma (Hamburg, Freie und
 * Hansestadt beside Wentorf bei Hamburg); with no whole
 * place, one grouping (a Landkreis, a Bundesland) or one row is the answer. None is `empty`, with
 * what to try. More rows than were read (`maxPages` pages of 500) are `ambiguous`, whatever the
 * part read holds: the place meant may come later. The areas carry no ags or ars.
 */
export async function findArea(client: FitConnectClient, input: FindAreaInput): Promise<AreaLookup> {
  const { searched, groups } = await searchGrouped(client, input);
  const notes = searchNotes(searched);
  if (groups.total === 0) {
    return {
      status: "empty",
      searched,
      reason:
        `No area matches all of the words ${quoteWords(searched.words)}. The API ANDs the words (one place per call: "Köln Bonn" finds nothing); ` +
        'try fewer words, a wildcard ("Mag*"), or the postal code.',
      notes,
    };
  }
  const { places, groupings, districts } = groups;
  if (!groups.complete) {
    // A part of the rows can't settle which place was meant: the one named just that may come later.
    const read = places.length + groupings.length + districts.count;
    return {
      status: "ambiguous",
      searched,
      candidates: places.length > 0 ? [...places, ...groupings] : groupings.length > 0 ? groupings : districts.listed,
      reason:
        `The search found ${groups.total} areas and only the first ${read} were read (pages of 500, up to maxPages): the place meant may be among the rest. ` +
        "Give more distinctive words or the postal code, or ask whether one of these is meant.",
      ...groups,
      notes,
    };
  }
  // Several whole places but exactly one named just what was searched ("München" beside "Grafing
  // b.München"): that one; else exactly one so named before an addition after a comma ("Hamburg,
  // Freie und Hansestadt" beside "Wentorf bei Hamburg", "Hanau, Brüder-Grimm-Stadt"). Halle (Saale)
  // and Halle (Westf.) are named neither way "Halle".
  const wanted = fold(searched.place);
  const exact = places.filter((p) => fold(p.name) === wanted);
  const named = places.filter((p) => fold(p.name.split(",")[0] ?? "") === wanted);
  const namesake = exact.length === 1 ? exact[0] : exact.length === 0 && named.length === 1 ? named[0] : undefined;
  const place = places.length === 1 ? places[0] : namesake;
  const one =
    place ?? (places.length === 0 && groupings.length === 1 ? groupings[0] : groups.total === 1 && groups.complete ? districts.listed[0] : undefined);
  if (one !== undefined) {
    const others = places.filter((p) => p !== one);
    if (place !== undefined && others.length > 0) {
      notes.push(`${others.length} other ${others.length === 1 ? "place contains" : "places contain"} the words (${others.map((p) => p.name).join("; ")}): ask if the user meant one of them.`);
    }
    if (place !== undefined && groupings.length > 0) notes.push(`Also matched ${groupings.length === 1 ? "a grouping" : `${groupings.length} groupings`} (${groupings.map((g) => `${g.name}, ${g.type}`).join("; ")}): ask if the user meant that.`);
    return { status: "ok", searched, area: one, ...groups, notes };
  }
  const candidates = places.length > 0 ? [...places, ...groupings] : groupings.length > 0 ? groupings : districts.listed;
  return {
    status: "ambiguous",
    searched,
    candidates,
    reason:
      places.length > 1
        ? `${places.length} whole places match: ask which one (the type and the name's addition tell them apart), then use its id.`
        : places.length === 0 && groupings.length > 1
          ? `${groupings.length} groupings match and no whole place: ask which one.`
          : `Only districts match (${districts.count}): ask which one, or search the place they belong to.`,
    ...groups,
    notes,
  };
}

/** The area search, every row up to the API's page maximum, grouped by kind. */
async function searchGrouped(client: FitConnectClient, input: FindAreaInput): Promise<{ searched: AreaSearched; groups: AreaGroups }> {
  const place = typeof input.place === "string" ? input.place.trim().normalize("NFC") : input.place;
  const { words, dropped } = areaSearchWords(place);
  const searched: AreaSearched = { place, words, dropped };
  const maxPages = maxPagesOf(input.maxPages);
  const answer = await readPages(maxPages, async (offset) => {
    const page = await client.areas({ search: words, offset, limit: MAX_LIMIT });
    return { rows: page.areas, total: page.totalCount };
  });
  const entries = answer.rows.map((area) => ({ id: area.id, name: area.name, type: area.type, kind: areaKind(area.type ?? "") }));
  const districts = entries.filter((e) => e.kind === "district");
  return {
    searched,
    groups: {
      places: entries.filter((e) => e.kind === "place" || e.kind === "other"),
      groupings: entries.filter((e) => e.kind === "grouping"),
      districts: { count: districts.length, listed: input.allDistricts === true ? districts : districts.slice(0, DISTRICTS_LISTED) },
      total: answer.total,
      complete: answer.total <= entries.length,
    },
  };
}

/** What a model should say about how the search was made. */
function searchNotes(searched: AreaSearched): string[] {
  const notes: string[] = [];
  if (searched.dropped.length > 0) {
    notes.push(`Left out ${quoteWords(searched.dropped)}: the API needs at least 2 letters or digits per word, so the search was wider than asked.`);
  }
  if (searched.words.length > 1) notes.push("All the words must match the same area (the API ANDs them).");
  return notes;
}

const quoteWords = (words: readonly string[]): string => words.map((w) => quoteValue(w)).join(", ");

/** Folded for comparing names: NFC, case, inner whitespace. */
const fold = (text: string): string => text.normalize("NFC").toLocaleLowerCase("de").replace(/\s+/g, " ").trim();

/** The input of {@link searchAreas}. */
export interface SearchAreasInput {
  /** A place name or postal code, as for findArea. */
  place: string;
  /** Where the page starts (default 0). */
  offset?: number | undefined;
  /** Rows per page (1–500, default 100). */
  limit?: number | undefined;
}

/** The answer of {@link searchAreas}. */
export type AreaSearch =
  | { status: "ok"; searched: AreaSearched; total: number; offset: number; areas: AreaEntry[]; nextOffset?: number; notes: string[] }
  | { status: "empty"; searched: AreaSearched; total: number; offset: number; areas: AreaEntry[]; reason: string; notes: string[] };

/** One page of the area search as the API orders it, every row with its kind. */
export async function searchAreas(client: FitConnectClient, input: SearchAreasInput): Promise<AreaSearch> {
  const place = typeof input.place === "string" ? input.place.trim().normalize("NFC") : input.place;
  const { words, dropped } = areaSearchWords(place);
  const searched: AreaSearched = { place, words, dropped };
  const offset = input.offset ?? 0;
  const answer = await client.areas({ search: words, offset, limit: input.limit });
  const areas = answer.areas.map((area) => ({ id: area.id, name: area.name, type: area.type, kind: areaKind(area.type ?? "") }));
  const notes = searchNotes(searched);
  if (areas.length === 0) {
    const reason =
      answer.totalCount > 0
        ? `The search found ${answer.totalCount} areas; offset ${offset} is past the end.`
        : `No area matches all of the words ${quoteWords(words)}; try fewer words, a wildcard ("Mag*"), or the postal code.`;
    return { status: "empty", searched, total: answer.totalCount, offset, areas, reason, notes };
  }
  const next = offset + areas.length;
  return { status: "ok", searched, total: answer.totalCount, offset, areas, ...(next < answer.totalCount ? { nextOffset: next } : {}), notes };
}

// ---- routes ---------------------------------------------------------------------------------

/** A Leistungsschlüssel: "99" and 12 digits. */
const LEIKA_KEY = /^99\d{12}$/;

/** Where a route lookup is made: a place by name (resolved with findArea) or one of the API's selectors. */
export interface RouteWhere {
  /** A Leistungsschlüssel ("99" and 12 digits): the service. */
  leikaKey: string;
  /** A place name or postal code, resolved to its area first. */
  place?: string | undefined;
  /** Amtlicher Gemeindeschlüssel: 8 digits (2, 3, 5 for Land, Regierungsbezirk, Kreis). */
  ags?: string | undefined;
  /** Amtlicher Regionalschlüssel: 12 digits (9 for a Gemeindeverband; 2, 3, 5 as for ags). */
  ars?: string | undefined;
  /** An area id from findArea. */
  areaId?: string | undefined;
  /** The most pages of 500 rows the place's area search and the route lookup each read (1–100, default {@link DEFAULT_MAX_PAGES}). */
  maxPages?: number | undefined;
}

/** Where a route lookup was made. */
export interface RouteSearched {
  leikaKey: string;
  place?: string;
  ags?: string;
  ars?: string;
  areaId?: string;
  /** The area the place was resolved to. */
  area?: AreaEntry;
}

/** A contact person, with the fields the API gave. */
export type Contact = ContactPerson;

/** The responsible authority of a route, only the fields the API gave. */
export interface Authority {
  name?: string;
  shortName?: string;
  contacts?: Contact[];
  address?: Address;
  postalAddress?: Address;
  postOfficeBox?: PostOfficeBox;
  contactFormUrl?: string;
  privacyPolicyUrl?: string;
  imprintUrl?: string;
  accessibilityUrl?: string;
  /** The FIT-Connect delivery point: addressing for sending an application (not done here). */
  destinationId: string;
  /** The source system of the routing information (PVOG, …). */
  origin?: string;
}

/** A lookup that found no route: the reason, and where else to look. */
interface NoRoute {
  status: "empty";
  searched: RouteSearched;
  reason: string;
  /** For an ags or ars: the Land's key, the broader area to try. */
  broader?: { ars?: string; ags?: string };
  /** For a place given by name: which area it was resolved to, and what else matched. */
  notes?: string[];
}

/** The input of {@link findAuthority}. */
export type FindAuthorityInput = RouteWhere;

/** The answer of {@link findAuthority}. */
export type AuthorityLookup =
  | { status: "ok"; searched: RouteSearched; total: number; authorities: Authority[]; notes: string[] }
  | { status: "ambiguous"; searched: RouteSearched; candidates: AreaEntry[]; reason: string }
  | NoRoute;

/**
 * The authority responsible for a service (Leistungsschlüssel) in a place: the routes' Zustellpunkte
 * with name, contacts, addresses and links, only the fields given. No route is the usual answer
 * (routing data is sparse: 62 lookups of 13 common services in 15 places found none, 2026-09-15):
 * `empty`, saying that FIT-Connect has none registered there, not that no authority is responsible,
 * and what to try. A place by name that fits several areas is `ambiguous`.
 */
export async function findAuthority(client: FitConnectClient, input: FindAuthorityInput): Promise<AuthorityLookup> {
  const routed = await routeFor(client, input);
  if (routed.status === "empty") return withoutFlag(routed);
  if (routed.status !== "ok") return routed;
  const notes = routed.notes;
  return { status: "ok", searched: routed.searched, total: routed.total, authorities: routed.routes.map(authorityOf), notes };
}

/** The input of {@link getServiceBriefing}. */
export interface ServiceBriefingInput extends RouteWhere {
  /** The language of the texts: de (default) or en; the other one stands in where one is missing. */
  language?: "de" | "en" | undefined;
}

/** One text of a briefing, plain, in the language it is in. */
export interface BriefingText {
  text: string;
  language: string;
}

/** A route as a briefing: only the sections the data has. */
export interface Briefing {
  authority: Authority;
  about?: BriefingText;
  requiredDocuments?: BriefingText;
  legalBasis?: BriefingText;
  deadline?: BriefingText;
  processing?: { minDuration?: number; maxDuration?: number; unit?: string; text: string };
  customParameters?: JsonObject;
}

/** The answer of {@link getServiceBriefing}. */
export type ServiceBriefing =
  | { status: "ok"; searched: RouteSearched; total: number; briefings: Briefing[]; notes: string[] }
  | { status: "ambiguous"; searched: RouteSearched; candidates: AreaEntry[]; reason: string }
  | NoRoute;

/**
 * A "how to apply" briefing for a service in a place, from the region-specific information its
 * route carries: what it is about, the documents needed, the legal basis, deadlines, the processing
 * time as a range, service-specific parameters, and the authority. HTML is plain text, lists kept;
 * a section the data doesn't have is left out. No route means nothing to brief: `empty`, as for
 * findAuthority.
 */
export async function getServiceBriefing(client: FitConnectClient, input: ServiceBriefingInput): Promise<ServiceBriefing> {
  const language = input.language ?? "de";
  if (language !== "de" && language !== "en") throw new FitConnectValidationError(`Invalid language ${quoteValue(String(language))}: expected "de" or "en".`);
  const routed = await routeFor(client, input);
  if (routed.status !== "ok") {
    if (routed.status === "empty" && routed.noRoute) {
      return {
        ...withoutFlag(routed),
        reason: `${routed.reason} There is nothing to brief. The FIM Portal's service texts (the fim-portal tools, by this Leistungsschlüssel) describe the service without a route: say the text is from the FIM Portal, not FIT-Connect.`,
      };
    }
    return routed.status === "empty" ? withoutFlag(routed) : routed;
  }
  const briefings = routed.routes.map((route) => briefingOf(route, language));
  const notes = [...routed.notes];
  routed.routes.forEach((route, i) => {
    const duration = route.processingDuration;
    const problem = duration !== undefined && duration !== null && typeof duration === "object" ? processingProblem(duration) : undefined;
    if (problem !== undefined) notes.push(`The processing time of ${briefings[i]?.authority.name ?? `route ${i + 1}`} was left out: ${problem}.`);
  });
  return { status: "ok", searched: routed.searched, total: routed.total, briefings, notes };
}

const withoutFlag = ({ noRoute: _noRoute, ...rest }: NoRoute & { noRoute: boolean }): NoRoute => rest;

/** The routes of a lookup, after resolving a place, or why there are none. */
type Routed =
  | { status: "ok"; searched: RouteSearched; total: number; routes: Route[]; notes: string[] }
  | { status: "ambiguous"; searched: RouteSearched; candidates: AreaEntry[]; reason: string }
  | (NoRoute & { noRoute: boolean });

/** Checks the input, resolves a place to its area, and asks for the routes. */
async function routeFor(client: FitConnectClient, input: RouteWhere): Promise<Routed> {
  const leikaKey = typeof input.leikaKey === "string" ? input.leikaKey.trim() : input.leikaKey;
  if (typeof leikaKey !== "string" || !LEIKA_KEY.test(leikaKey)) {
    throw new FitConnectValidationError(
      `Invalid leikaKey ${typeof leikaKey === "string" ? quoteValue(leikaKey) : String(leikaKey)}: expected "99" followed by 12 digits (99123456760610). ` +
        "It is not discoverable here: the FIM Portal resolves a service name to its key. Never invent one.",
    );
  }
  const given = (["place", "ags", "ars", "areaId"] as const).filter((k) => input[k] !== undefined);
  if (given.length !== 1) {
    throw new FitConnectValidationError(`Give exactly one of place, ags, ars or areaId; got ${given.length === 0 ? "none" : given.join(", ")}.`);
  }
  const maxPages = maxPagesOf(input.maxPages);
  const which = given[0] as "place" | "ags" | "ars" | "areaId";
  const value = String(input[which]).trim();
  if (which === "ags" && !AGS_PATTERN.test(value)) throw new FitConnectValidationError(`Invalid ags ${quoteValue(value)}: expected 8 digits (2, 3 or 5 for Land, Regierungsbezirk, Kreis).`);
  if (which === "ars" && !ARS_PATTERN.test(value)) throw new FitConnectValidationError(`Invalid ars ${quoteValue(value)}: expected 12 digits (9 for a Gemeindeverband; 2, 3 or 5 for Land, Regierungsbezirk, Kreis).`);
  if (which === "areaId") assertValid("areaId", value, areaIdProblem);
  const searched: RouteSearched = { leikaKey, [which]: value };
  const notes: string[] = [];
  let selector: { ags?: string; ars?: string; areaId?: string } = { [which]: value };
  if (which === "place") {
    const found = await findArea(client, { place: value, maxPages });
    if (found.status === "empty") return { status: "empty", searched, reason: found.reason, noRoute: false };
    if (found.status === "ambiguous") {
      return { status: "ambiguous", searched, candidates: found.candidates, reason: `${found.reason} Then call again with its areaId.` };
    }
    searched.area = found.area;
    notes.push(`The place was resolved to ${found.area.name} (${found.area.type}, areaId ${found.area.id}).`, ...found.notes);
    selector = { areaId: found.area.id };
  }
  let answer;
  try {
    answer = await readPages(maxPages, async (offset) => {
      const page = await client.routes({ leikaKey, ...selector, offset, limit: MAX_LIMIT });
      return { rows: page.routes, total: page.totalCount };
    });
  } catch (err) {
    if (err instanceof FitConnectApiError && err.status === 400 && /no area was found/i.test(err.detail ?? "")) {
      return {
        status: "empty",
        searched,
        reason: `The routing service knows no area with ${which} ${value} (a kreisfreie Stadt has no Kreis key, for one). Give the place by name instead, or the Land's key.`,
        ...broaderOf(which, value),
        noRoute: false,
      };
    }
    throw err;
  }
  if (answer.rows.length === 0) {
    const where = searched.area !== undefined ? `${searched.area.name} (areaId ${searched.area.id})` : `${which} ${value}`;
    return {
      status: "empty",
      searched,
      reason:
        `No FIT-Connect Zustellpunkt is registered for service ${leikaKey} in ${where}. That is the usual answer: routing data is sparse. ` +
        "It does not mean no authority is responsible, only that FIT-Connect can't name it. A broader area (the Landkreis or Bundesland) or a re-checked " +
        "Leistungsschlüssel is cheap to try but rarely changes this; point the user to the place's own administration website or the state's service portal.",
      ...broaderOf(which, value),
      ...(notes.length > 0 ? { notes } : {}),
      noRoute: true,
    };
  }
  if (answer.total > answer.rows.length) notes.push(`${answer.total} routes, the first ${answer.rows.length} listed (pages of 500, up to maxPages): say that more are registered.`);
  return { status: "ok", searched, total: answer.total, routes: answer.rows, notes };
}

/** For an ags or ars of a place below the Land: the Land's key (always one the service knows). */
function broaderOf(which: string, value: string): { broader?: { ars?: string; ags?: string } } {
  if ((which !== "ags" && which !== "ars") || value.length <= 2) return {};
  return { broader: { [which]: value.slice(0, 2) } };
}

/** A route's authority, only the fields given (no signature: it is addressing for sending). */
export function authorityOf(route: Route): Authority {
  const contacts = (route.contactPersons ?? []).map((c) => compact(c)).filter((c) => Object.keys(c).length > 0);
  const authority: Authority = {
    ...given("name", route.destinationName),
    ...given("shortName", route.destinationShortName),
    ...(contacts.length > 0 ? { contacts } : {}),
    ...givenObject("address", route.address),
    ...givenObject("postalAddress", route.postalAddress),
    ...givenObject("postOfficeBox", route.postOfficeBox),
    ...given("contactFormUrl", route.contactFormUrl),
    ...given("privacyPolicyUrl", route.privacyPolicyUrl),
    ...given("imprintUrl", route.imprintUrl),
    ...given("accessibilityUrl", route.accessibilityUrl),
    destinationId: route.destinationId,
    ...given("origin", route.origin),
  };
  return authority;
}

/** A route as a briefing in `language` (the other one where it is missing). */
export function briefingOf(route: Route, language: "de" | "en"): Briefing {
  const text = (block: LocalizedText | undefined): BriefingText | undefined => localized(block, language);
  const about = text(route.furtherInformation);
  const requiredDocuments = text(route.requiredDocuments);
  const legalBasis = text(route.legalBasis);
  const deadline = text(route.deadline);
  const processing = processingOf(route.processingDuration);
  const custom = route.customParameters;
  return {
    authority: authorityOf(route),
    ...(about === undefined ? {} : { about }),
    ...(requiredDocuments === undefined ? {} : { requiredDocuments }),
    ...(legalBasis === undefined ? {} : { legalBasis }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(processing === undefined ? {} : { processing }),
    ...(custom !== undefined && custom !== null && typeof custom === "object" && Object.keys(custom).length > 0 ? { customParameters: custom } : {}),
  };
}

/** A localized block as plain text in `language`, else in the other language, else in any; undefined when blank. */
function localized(block: LocalizedText | undefined, language: "de" | "en"): BriefingText | undefined {
  const texts = block?.description;
  if (texts === undefined || texts === null || typeof texts !== "object") return undefined;
  const order = [language, language === "de" ? "en" : "de", ...Object.keys(texts)];
  for (const lang of order) {
    const raw = texts[lang];
    if (typeof raw !== "string") continue;
    const text = plainText(raw);
    if (text !== "") return { text, language: lang };
  }
  return undefined;
}

const UNITS: Record<string, [string, string]> = {
  year: ["year", "years"],
  month: ["month", "months"],
  week: ["week", "weeks"],
  day: ["day", "days"],
  workday: ["working day", "working days"],
  hour: ["hour", "hours"],
  minute: ["minute", "minutes"],
  second: ["second", "seconds"],
};

/**
 * The processing time as a range ("1–4 weeks", "up to 4 weeks", "at least 1 week"); undefined
 * without a bound, and when the bounds can't be a range (see {@link processingProblem}): a text
 * a model quotes to a citizen is never made from them. A unit the API doesn't document is named
 * as such.
 */
export function processingOf(duration: ProcessingDuration | undefined): Briefing["processing"] {
  if (duration === undefined || duration === null || typeof duration !== "object") return undefined;
  if (processingProblem(duration) !== undefined) return undefined;
  const min = duration.minDuration ?? undefined;
  const max = duration.maxDuration ?? undefined;
  if (min === undefined && max === undefined) return undefined;
  const names = duration.unit === undefined ? undefined : UNITS[duration.unit];
  const unit = (n: number): string =>
    names !== undefined ? (n === 1 ? names[0] : names[1]) : duration.unit === undefined ? "(no unit given)" : `(unit ${quoteValue(String(duration.unit))}, not one the API documents)`;
  const text =
    min !== undefined && max !== undefined
      ? min === max
        ? `${min} ${unit(min)}`
        : `${min}–${max} ${unit(max)}`
      : max !== undefined
        ? `up to ${max} ${unit(max)}`
        : `at least ${min} ${unit(min as number)}`;
  return { ...(min === undefined ? {} : { minDuration: min }), ...(max === undefined ? {} : { maxDuration: max }), ...(duration.unit === undefined ? {} : { unit: duration.unit }), text };
}

/**
 * Why a processing duration's bounds can't be stated as a range (a bound that is not a number,
 * a negative one, the minimum over the maximum), or undefined when they can.
 */
export function processingProblem(duration: ProcessingDuration): string | undefined {
  const bounds = [duration.minDuration, duration.maxDuration];
  const unit = typeof duration.unit === "string" ? ` ${duration.unit}` : "";
  const shown = bounds.map((b) => (b === undefined || b === null ? "?" : typeof b === "number" ? String(b) : quoteValue(String(b)))).join(" to ");
  if (bounds.some((b) => b !== undefined && b !== null && (typeof b !== "number" || !Number.isFinite(b) || b < 0))) return `the route gives ${shown}${unit}, and a bound is not a number of 0 or more`;
  const [min, max] = bounds;
  if (typeof min === "number" && typeof max === "number" && min > max) return `the route gives ${shown}${unit}, the minimum over the maximum`;
  return undefined;
}

/** `{ [key]: value }` when value is a non-blank string, else nothing. */
function given<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return typeof value === "string" && value.trim() !== "" ? ({ [key]: value.trim() } as { [P in K]?: string }) : {};
}

/** `{ [key]: object }` with its non-blank string fields, when there is one. */
function givenObject<K extends string, T extends object>(key: K, value: T | undefined): { [P in K]?: T } {
  if (value === undefined || value === null || typeof value !== "object") return {};
  const kept = compact(value);
  return Object.keys(kept).length > 0 ? ({ [key]: kept } as { [P in K]?: T }) : {};
}

/** An object with only its non-blank string fields, trimmed. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => typeof v === "string" && v.trim() !== "")
      .map(([k, v]) => [k, (v as string).trim()]),
  ) as T;
}

/** Elements whose content is code, not text: dropped with their tags. */
const RAW_TEXT = new Set(["script", "style"]);
/** Elements whose end is a new line. */
const BLOCK_ENDS = new Set(["p", "div", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr"]);
/**
 * The HTML elements a text escaped twice ("&lt;b&gt;") carries: after the entities are decoded,
 * these are dropped as tags too, while any other bracketed word ("<Vorname>") stays text.
 */
const HTML_ELEMENTS = new Set([
  "a", "abbr", "b", "blockquote", "body", "br", "caption", "center", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "hr", "html", "i", "iframe", "img", "ins", "li", "link", "mark", "meta", "ol", "p", "pre", "q", "s", "script", "section", "small", "span", "strong", "style", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "u", "ul",
]);

/** A tag found at a "<": its name (lower case; "!" for a comment or declaration), whether it closes, and where it ends. */
interface Tag {
  name: string;
  closing: boolean;
  end: number;
}

/**
 * The tags dropped, a list item's start as "- ", a line break and a block's end as a new line, the
 * cells of a table row apart (" | "), and the content of script and style left out. A tag starts
 * at "<" followed by a letter, "/" or "!" (else the "<" is text: "Kosten < 5 Euro") and ends at
 * the first ">" outside its quoted attribute values, before the next "<"; a "<" without such an
 * end is text. With `known`, only the HTML elements of HTML_ELEMENTS (and comments) are tags.
 * One pass: every search moves forward, and a search that found nothing is not repeated (a
 * regular expression tried at every "<" read to the end of the text each time: quadratic).
 */
function withoutTags(html: string, known = false): string {
  let out = "";
  let at = 0;
  let cell = false;
  let noCommentEnd = false;
  const rawEnd = /<\s*\/\s*(script|style)\b[^<>]*>/gi;
  for (let open = html.indexOf("<"); open >= 0; open = html.indexOf("<", at)) {
    let tag = tagAt(html, open);
    if (tag !== undefined && tag.name === "!" && html.startsWith("<!--", open) && !noCommentEnd) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) noCommentEnd = true;
      else tag = { name: "!", closing: false, end: end + 3 };
    }
    if (tag === undefined || (known && tag.name !== "!" && !HTML_ELEMENTS.has(tag.name))) {
      out += html.slice(at, open + 1);
      at = open + 1;
      continue;
    }
    out += html.slice(at, open);
    at = tag.end;
    if (tag.name === "li" && !tag.closing) out += "\n- ";
    else if (tag.name === "br") out += "\n";
    else if (tag.closing && BLOCK_ENDS.has(tag.name)) out += "\n";
    if (tag.name === "tr" || tag.name === "table") cell = false;
    else if ((tag.name === "td" || tag.name === "th") && !tag.closing) {
      if (cell) out += " | ";
      cell = true;
    }
    if (RAW_TEXT.has(tag.name) && !tag.closing) {
      rawEnd.lastIndex = at;
      let found: RegExpExecArray | null;
      while ((found = rawEnd.exec(html)) !== null && found[1]?.toLowerCase() !== tag.name);
      at = found === null ? html.length : rawEnd.lastIndex;
    }
  }
  return out + html.slice(at);
}

/** The tag starting at the "<" at `open`, or undefined when that "<" starts none. */
function tagAt(html: string, open: number): Tag | undefined {
  let i = open + 1;
  while (i < html.length && /\s/.test(html[i] as string)) i += 1;
  let closing = false;
  if (html[i] === "/") {
    closing = true;
    i += 1;
    while (i < html.length && /\s/.test(html[i] as string)) i += 1;
  }
  let name: string;
  if (!closing && html[i] === "!") {
    name = "!";
  } else {
    const start = i;
    while (i < html.length && /[A-Za-z0-9-]/.test(html[i] as string)) i += 1;
    name = html.slice(start, i).toLowerCase();
    if (!/^[a-z]/.test(name)) return undefined;
  }
  const next = html.indexOf("<", i);
  const limit = next < 0 ? html.length : next;
  let quote: string | undefined;
  let firstGt = -1;
  for (let j = i; j < limit; j += 1) {
    const c = html[j];
    if (c === ">" && firstGt < 0) firstGt = j;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return { name, closing, end: j + 1 };
    }
  }
  return firstGt < 0 ? undefined : { name, closing, end: firstGt + 1 };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Plain text of the HTML the route's texts may carry: tags dropped, block ends and line breaks as
 * new lines, list items as "- ", entities decoded, blank runs collapsed. Nothing is reworded.
 */
export function plainText(html: string | null | undefined): string {
  if (html === null || html === undefined) return "";
  const decoded = withoutTags(html).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
  return withoutTags(decoded, true)
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, lines) => line !== "" || (i > 0 && lines[i - 1] !== ""))
    .join("\n")
    .trim();
}
