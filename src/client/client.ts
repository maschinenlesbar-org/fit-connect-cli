// FitConnectClient — a typed client over the open (no-auth) FIT-Connect Routing
// API. The Routing API resolves the responsible authority (Zustellpunkt) for a
// public service in a given area, and searches areas by name / postal code.
//
//   client.routes({ leikaKey: "99...", ars: "064350014014" })
//   client.areas({ search: "Hanau" })
//   client.info()
//
// This client deliberately wraps ONLY the read-only Routing API. It does not
// implement the FIT-Connect Submission/Destination (write) path.

import { RequestEngine, type EngineOptions } from "./engine.js";
import { FitConnectParseError, FitConnectValidationError, cutText } from "./errors.js";
import { areaIdProblem, assertValid, nonBlankProblem, quoteValue, quoteValues } from "./validate.js";
import type { QueryParams } from "./query.js";
import type { AreaResult, Info, RouteResult } from "./types.js";

/** Routing API major version. v2 is current; v1 is legacy. */
export type ApiVersion = "v1" | "v2";

export const DEFAULT_API_VERSION: ApiVersion = "v2";

/**
 * The Amtlicher Gemeindeschlüssel lengths the Routing API accepts: 2 (Land),
 * 3 (Regierungsbezirk), 5 (Kreis) or 8 digits (Gemeinde) — `routing-api.yaml`.
 */
export const AGS_PATTERN = /^(\d{2}|\d{3}|\d{5}|\d{8})$/;

/**
 * The Amtlicher Regionalschlüssel lengths the Routing API accepts: 2 (Land),
 * 3 (Regierungsbezirk), 5 (Kreis), 9 (Gemeindeverband) or 12 digits (Gemeinde).
 */
export const ARS_PATTERN = /^(\d{2}|\d{3}|\d{5}|\d{9}|\d{12})$/;

export interface FitConnectClientOptions extends EngineOptions {
  /** Routing API major version to target (path prefix). Defaults to "v2". */
  apiVersion?: ApiVersion;
}

/** Parameters for {@link FitConnectClient.routes}. */
export interface RouteQuery {
  /** Leistungsschlüssel (formerly LeiKa key) of the public service. Required. */
  leikaKey: string;
  /** Amtlicher Gemeindeschlüssel, 2/3/5/8 digits ({@link AGS_PATTERN}) — provide exactly one area selector. */
  ags?: string;
  /** Amtlicher Regionalschlüssel, 2/3/5/9/12 digits ({@link ARS_PATTERN}) — provide exactly one area selector. */
  ars?: string;
  /** Area id from {@link FitConnectClient.areas} — provide exactly one area selector. */
  areaId?: string;
  /** Start offset into the result set (0..2147483647, default 0). */
  offset?: number;
  /** Page size (1..500, default 100). */
  limit?: number;
}

/** Parameters for {@link FitConnectClient.areas}. */
export interface AreaQuery {
  /**
   * One or more search terms (names and/or postal codes). The wildcard `*` is
   * supported, e.g. `"Mag*"`. Terms are split into words on whitespace and
   * punctuation (`"Halle (Westf.)"` → `Halle`, `Westf`), and every word must
   * match the same area. Words shorter than 2 characters are left out; 1..10
   * words must remain (see {@link areaSearchWords}).
   */
  search: string | string[];
  /** Start offset into the result set (default 0). */
  offset?: number;
  /** Page size (1..500, default 100). */
  limit?: number;
}

export class FitConnectClient {
  private readonly engine: RequestEngine;
  readonly apiVersion: ApiVersion;

  constructor(options: FitConnectClientOptions = {}) {
    const { apiVersion, ...engineOptions } = options;
    this.apiVersion = apiVersion ?? DEFAULT_API_VERSION;
    if (this.apiVersion !== "v1" && this.apiVersion !== "v2") {
      const got = typeof this.apiVersion === "string" ? quoteValue(this.apiVersion) : describeValue(this.apiVersion);
      throw new FitConnectValidationError(`Invalid apiVersion ${got}: expected "v1" or "v2"`);
    }
    this.engine = new RequestEngine(engineOptions);
  }

  private path(resource: string): string {
    return `/${this.apiVersion}/${resource}`;
  }

  /**
   * Resolve the responsible destination(s) (Zustellpunkte) for a public service
   * in an area. Requires a `leikaKey` and exactly one of `ags` / `ars` / `areaId`.
   */
  async routes(params: RouteQuery): Promise<RouteResult> {
    checkParams("routes", params, ROUTE_PARAMS);
    const leikaKey = requireNonEmpty("leikaKey", params.leikaKey);
    // The Leistungsschlüssel is "99" followed by 12 digits (GLOSSARY: ^99\d{12}$).
    // Validate here so a malformed key is a clear error rather than an opaque
    // upstream HTTP 400.
    if (!/^99\d{12}$/.test(leikaKey)) {
      throw new FitConnectValidationError(
        `Invalid leikaKey ${quoteValue(leikaKey)}: expected "99" followed by 12 digits (e.g. 99123456760610).`,
      );
    }

    // Trim each selector (a padded `areaId=%20940%20` is an API 400) and reject a
    // blank one before any request: dropping it would let a second selector pass the
    // exactly-one rule, and sending it as an empty `ars=` is an API 400.
    const ags = optionalNonBlank("ags", params.ags);
    const ars = optionalNonBlank("ars", params.ars);
    const areaId = optionalNonBlank("areaId", params.areaId);
    if (areaId !== undefined) assertValid("areaId", areaId, areaIdProblem);
    const given = { ags, ars, areaId };
    const selectors = (["ags", "ars", "areaId"] as const).filter((k) => given[k] !== undefined);
    if (selectors.length !== 1) {
      throw new FitConnectValidationError(
        `routes() needs exactly one area selector (ags, ars or areaId); got ${
          selectors.length === 0 ? "none" : selectors.join(", ")
        }`,
      );
    }
    if (ags !== undefined && !AGS_PATTERN.test(ags)) {
      throw new FitConnectValidationError(`Invalid ags ${quoteValue(ags)}: expected 2, 3, 5 or 8 digits.`);
    }
    if (ars !== undefined && !ARS_PATTERN.test(ars)) {
      throw new FitConnectValidationError(`Invalid ars ${quoteValue(ars)}: expected 2, 3, 5, 9 or 12 digits.`);
    }

    const query: QueryParams = {
      leikaKey,
      ags,
      ars,
      areaId,
      ...paging(params.offset, params.limit),
    };
    return expectShape(this.path("routes"), await this.engine.getJson<unknown>(this.path("routes"), query), listProblem("routes"));
  }

  /**
   * Search for areas by name and/or postal code. The search is turned into words
   * by {@link areaSearchWords}: words shorter than 2 characters are left out, a
   * repeated word is sent once, and a search the API would reject (no usable word,
   * more than {@link MAX_AREA_SEARCH_WORDS} words, a misplaced `*`) throws a
   * `FitConnectValidationError` before any request.
   */
  async areas(params: AreaQuery): Promise<AreaResult> {
    checkParams("areas", params, AREA_PARAMS);
    const { words } = areaSearchWords(params.search);
    const query: QueryParams = {
      areaSearchexpression: words,
      ...paging(params.offset, params.limit),
    };
    return expectShape(this.path("areas"), await this.engine.getJson<unknown>(this.path("areas"), query), listProblem("areas"));
  }

  /** Fetch the version of the deployed Routing API instance. */
  async info(): Promise<Info> {
    return expectShape(this.path("info"), await this.engine.getJson<unknown>(this.path("info")), infoProblem);
  }
}

/** A plain JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why `value` is not the documented page envelope of `/routes` or `/areas` —
 * `{ count, offset, totalCount, <key>: [object, …] }` with integer counts — or undefined
 * when it is. A proxy, captive portal or misconfigured `--base-url` answering 200 with
 * `null`, `{}`, an array or a string would otherwise read as an answer (`count`
 * undefined, exit 0), and the skills treat `count: 0` as a valid "nothing registered".
 */
function listProblem(key: "routes" | "areas"): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "not a JSON object";
    for (const field of ["count", "offset", "totalCount"]) {
      if (!Number.isInteger(value[field])) return `"${field}" is not an integer`;
    }
    const list = value[key];
    if (!Array.isArray(list)) return `"${key}" is not an array`;
    if (!list.every(isObject)) return `"${key}" holds a value that is not an object`;
    return undefined;
  };
}

/** Why `value` is not the `/info` answer `{ version: { major, minor, patch } }`, or undefined. */
function infoProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "not a JSON object";
  const version = value["version"];
  if (!isObject(version)) return '"version" is not an object';
  for (const field of ["major", "minor", "patch"]) {
    if (!Number.isInteger(version[field])) return `"version.${field}" is not an integer`;
  }
  return undefined;
}

/**
 * `value` typed as `T` when `problem` finds nothing; otherwise a `FitConnectParseError`
 * naming the path and what is wrong (the body itself is not echoed).
 */
function expectShape<T>(path: string, value: unknown, problem: (value: unknown) => string | undefined): T {
  const reason = problem(value);
  if (reason !== undefined) {
    throw new FitConnectParseError(`Unexpected response from ${path}: ${reason}, not the documented shape.`);
  }
  return value as T;
}

/**
 * The largest `offset` the Routing API declares (`int32`, `routing-api.yaml`). The API
 * also adds `offset` and `limit` in a 32-bit integer, so `offset + limit` (the limit
 * defaulting to {@link DEFAULT_LIMIT}) must not exceed it either: see {@link paging}.
 */
export const MAX_OFFSET = 2_147_483_647;

/** The largest page size (`limit`) the Routing API accepts. */
export const MAX_LIMIT = 500;

/** The page size the Routing API uses when no `limit` is sent. */
export const DEFAULT_LIMIT = 100;

/**
 * The `offset` / `limit` query parameters, validated: `offset` 0..{@link MAX_OFFSET},
 * `limit` 1..{@link MAX_LIMIT}, and their sum (with the API's default limit of 100 when
 * none is given) at most {@link MAX_OFFSET}. The API sums them in a 32-bit integer and
 * answers an overflow with HTTP 500 and no detail (`routes … --offset 2147483548` failed,
 * `2147483547` worked), so such a page is a FitConnectValidationError before any request.
 */
function paging(offsetValue: unknown, limitValue: unknown): { offset: number | undefined; limit: number | undefined } {
  const offset = checkPaging("offset", offsetValue, 0, MAX_OFFSET);
  const limit = checkPaging("limit", limitValue, 1, MAX_LIMIT);
  if (offset !== undefined && offset + (limit ?? DEFAULT_LIMIT) > MAX_OFFSET) {
    throw new FitConnectValidationError(
      `Invalid offset: offset + limit must not exceed ${MAX_OFFSET} (the API adds them as a 32-bit integer); ` +
        `got offset ${offset} with ${limit === undefined ? `the default limit ${DEFAULT_LIMIT}` : `limit ${limit}`}.`,
    );
  }
  return { offset, limit };
}

/** The most `areaSearchexpression` values the Routing API accepts (`maxItems: 10`). */
export const MAX_AREA_SEARCH_WORDS = 10;

/**
 * True when `word` is one `areaSearchexpression` value as the Routing API's spec
 * allows it (`^(\*?([^\*]{2,})\*?)*$`), decided by one linear scan.
 *
 * That pattern reads: the word is a sequence of runs of at least 2 non-wildcard
 * characters (code points), each with an optional `*` before and after it. Taken by
 * maximal runs, that is: every run of non-wildcard characters has at least 2 of them;
 * at most one `*` before the first run and at most one after the last; one or two
 * `*` between two runs. So `Mag*`, `*burg`, `*ab*`, `ab*cd` and `ab**cd` pass, and
 * `Ma*g`, `**ab`, `ab***cd` and `*` don't. (The empty word matches the pattern too;
 * it never reaches this check.)
 *
 * The spec's pattern is not used as a regex: its nested quantifiers backtrack
 * exponentially when a long run is followed by a misplaced `*` — a 45-character
 * `Donaudampfschifffahrtsgesellschaftskapitaen*X` took 57 s in the CLI and blocked a
 * service's event loop for as long. This scan takes linear time for any input.
 */
export function isAreaSearchWord(word: string): boolean {
  const chars = [...word];
  const n = chars.length;
  let i = 0;
  let stars = 0;
  while (i < n && chars[i] === "*") {
    stars += 1;
    i += 1;
  }
  if (i === n) return n === 0;
  if (stars > 1) return false;
  for (;;) {
    let run = 0;
    while (i < n && chars[i] !== "*") {
      run += 1;
      i += 1;
    }
    if (run < 2) return false;
    stars = 0;
    while (i < n && chars[i] === "*") {
      stars += 1;
      i += 1;
    }
    if (i === n) return stars <= 1;
    if (stars > 2) return false;
  }
}

/** The words {@link areaSearchWords} sends, and the too-short ones it left out. */
export interface AreaSearchWords {
  /** The words to send, one `areaSearchexpression` each (1..10, no duplicates). */
  words: string[];
  /** Words left out because they have fewer than 2 non-wildcard characters. */
  dropped: string[];
  /**
   * The characters the search was split at and that were left out (punctuation such as
   * `(`, `.`, `-`, and whitespace other than a plain space), each once, in the order they
   * first occur. A plain space, the ordinary word separator, is not listed.
   */
  separators: string[];
}

/**
 * Turn an area search into the words the Routing API accepts.
 *
 * Each term is normalised to NFKC (composed umlauts, ASCII digits for fullwidth
 * ones), then split on whitespace AND punctuation, keeping letters, digits and
 * the `*` wildcard: the API ANDs the expressions and 500s on a space or on
 * punctuation such as `(`, `)`, `.` or `-` inside one, so "Frankfurt am Main" is
 * sent as three expressions and "Halle (Westf.)" as "Halle" + "Westf".
 *
 * The API then rejects the whole search (HTTP 400 "Constraint Violation") for a
 * word with fewer than 2 non-wildcard characters ("Frankfurt a. M." → "a", "M"; a
 * bare "*"), and for more than 10 words. So a too-short word is left out (it is
 * listed in `dropped`, and the characters split at in `separators`), a word repeated
 * in any letter case is sent once, and the
 * rest throws a `FitConnectValidationError`: no usable word left, more than
 * {@link MAX_AREA_SEARCH_WORDS} words, or a word whose `*` splits it into parts
 * shorter than 2 characters ("a*b").
 */
export function areaSearchWords(search: string | string[]): AreaSearchWords {
  // A non-string term was dropped silently: `["Frankfurt", 60311]` searched only
  // "Frankfurt", a wider search than asked for.
  const given: unknown[] = Array.isArray(search) ? search : [search];
  for (const term of given) {
    if (typeof term !== "string") {
      throw new FitConnectValidationError(
        `Invalid search: expected a string or an array of strings, got ${
          Array.isArray(search) ? `${describeValue(term)} in the array` : describeValue(term)
        }.`,
      );
    }
  }
  const terms = given as string[];
  const words: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  // NFKC first: the API answers HTTP 500 for a decomposed umlaut ("Ko" + U+0308,
  // as pasted from macOS file names) and for fullwidth digits (IME input), both of
  // which look identical to the composed / ASCII text it does find. A combining mark
  // NFKC leaves over (a doubled diaeresis in "Kö" + U+0308 + "ln", or marks with no
  // letter at all) gets the same 500, so it is dropped: "Kö̈ln" searches "Köln", and a
  // term of marks alone has no usable word. German place names need no combining
  // mark once composed.
  const normalised = terms.map((t) => stripMarks(t.normalize("NFKC")));
  const separators = [...new Set(normalised.join(" ").match(/[^\p{L}\p{N}* ]/gu) ?? [])];
  for (const word of normalised.flatMap((t) => t.split(/[^\p{L}\p{N}*]+/u))) {
    if (word === "") continue;
    if ([...word.replace(/\*/g, "")].length < 2) {
      dropped.push(word);
      continue;
    }
    if (!isAreaSearchWord(word)) {
      throw new FitConnectValidationError(
        `Invalid search word ${quoteValue(word)}: the API needs at least 2 characters between wildcards (e.g. "Mag*", "*burg").`,
      );
    }
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  if (words.length === 0) {
    throw new FitConnectValidationError(
      `No usable search word in ${quoteValues(terms, " ") || "the search"}: ` +
        `every word needs at least 2 letters or digits (a "*" does not count).`,
    );
  }
  if (words.length > MAX_AREA_SEARCH_WORDS) {
    throw new FitConnectValidationError(
      `Too many search words (${words.length}): the API accepts at most ${MAX_AREA_SEARCH_WORDS}. ` +
        "Leave some out — every word must match the same area, so a few distinctive ones are enough.",
    );
  }
  return { words, dropped, separators };
}

/** The parameters {@link FitConnectClient.routes} takes. */
const ROUTE_PARAMS = ["leikaKey", "ags", "ars", "areaId", "offset", "limit"] as const;

/** The parameters {@link FitConnectClient.areas} takes. */
const AREA_PARAMS = ["search", "offset", "limit"] as const;

/**
 * How a wrong-typed value reads in a message: `the string "50"`, `a number`, `an
 * array`, `null`. A string is quoted (cut to 50 characters) so `got 50` can't be mistaken
 * for the number.
 */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `the string ${JSON.stringify(value.length > 50 ? `${cutText(value, 50)}…` : value)}`;
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * Reject a parameter object the method can't read: not an object, or with a key it
 * doesn't take. A misspelled key (`areaid`, `ARS`), or one that arrives from JSON as
 * `__proto__`, was dropped without a word, so `routes({ ars: "16", areaid: "940" })`
 * answered for the whole Land. The message names the key and the keys allowed.
 */
function checkParams(method: string, params: unknown, allowed: readonly string[]): void {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new FitConnectValidationError(`Invalid ${method}() parameters: expected an object, got ${describeValue(params)}.`);
  }
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new FitConnectValidationError(
        `Invalid ${method}() parameter ${JSON.stringify(key)}: expected one of ${allowed.join(", ")}.`,
      );
    }
  }
}

/** `text` without combining marks (`\p{M}`), as left over after NFKC composition. */
function stripMarks(text: string): string {
  return text.replace(/\p{M}/gu, "");
}

/**
 * Trim an optional string parameter: undefined → undefined; any other non-string is a
 * FitConnectValidationError (`Invalid areaId: expected a string, got 940.`) rather
 * than "not given" — `routes({ ars: "16", areaId: 940 })` used to answer for the Land —
 * and a blank string is one too (`Invalid <name>: Value must not be blank.`).
 */
function optionalNonBlank(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new FitConnectValidationError(`Invalid ${name}: expected a string, got ${describeValue(value)}.`);
  }
  return assertValid(name, value, nonBlankProblem).trim();
}

/**
 * Validate an optional `offset`/`limit` against the API's documented range: anything
 * but a safe integer in range (a string, NaN, an array) is a FitConnectValidationError.
 */
function checkPaging(name: string, value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new FitConnectValidationError(
      `Invalid ${name}: expected an integer from ${min} to ${max}, got ${describeValue(value)}.`,
    );
  }
  return value;
}

/** Reject a non-string, empty or whitespace-only required value up front with a clear message. */
function requireNonEmpty(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new FitConnectValidationError(`Invalid ${name}: expected a string, got ${describeValue(value)}.`);
  }
  if (value.trim() === "") {
    throw new FitConnectValidationError(`Invalid ${name}: must be a non-empty string`);
  }
  return value.trim();
}
