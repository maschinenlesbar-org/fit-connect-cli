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
import { FitConnectError } from "./errors.js";
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
  /** Start offset into the result set (default 0). */
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
      throw new FitConnectError(`Invalid apiVersion "${this.apiVersion}": expected "v1" or "v2"`);
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
    const leikaKey = requireNonEmpty("leikaKey", params.leikaKey);
    // The Leistungsschlüssel is "99" followed by 12 digits (GLOSSARY: ^99\d{12}$).
    // Validate here so a malformed key is a clear error rather than an opaque
    // upstream HTTP 400.
    if (!/^99\d{12}$/.test(leikaKey)) {
      throw new FitConnectError(
        `Invalid leikaKey "${leikaKey}": expected "99" followed by 12 digits (e.g. 99123456760610).`,
      );
    }

    const selectors = (["ags", "ars", "areaId"] as const).filter(
      (k) => params[k] !== undefined && String(params[k]).trim() !== "",
    );
    if (selectors.length !== 1) {
      throw new FitConnectError(
        `routes() needs exactly one area selector (ags, ars or areaId); got ${
          selectors.length === 0 ? "none" : selectors.join(", ")
        }`,
      );
    }

    const query: QueryParams = {
      leikaKey,
      ags: params.ags,
      ars: params.ars,
      areaId: params.areaId,
      offset: params.offset,
      limit: params.limit,
    };
    return this.engine.getJson<RouteResult>(this.path("routes"), query);
  }

  /**
   * Search for areas by name and/or postal code. The search is turned into words
   * by {@link areaSearchWords}: words shorter than 2 characters are left out, a
   * repeated word is sent once, and a search the API would reject (no usable word,
   * more than {@link MAX_AREA_SEARCH_WORDS} words, a misplaced `*`) throws a
   * `FitConnectError` before any request.
   */
  async areas(params: AreaQuery): Promise<AreaResult> {
    const { words } = areaSearchWords(params.search);
    const query: QueryParams = {
      areaSearchexpression: words,
      offset: params.offset,
      limit: params.limit,
    };
    return this.engine.getJson<AreaResult>(this.path("areas"), query);
  }

  /** Fetch the version of the deployed Routing API instance. */
  info(): Promise<Info> {
    return this.engine.getJson<Info>(this.path("info"));
  }
}

/** The most `areaSearchexpression` values the Routing API accepts (`maxItems: 10`). */
export const MAX_AREA_SEARCH_WORDS = 10;

/**
 * One `areaSearchexpression` value as the Routing API's spec allows it
 * (`^(\*?([^\*]{2,})\*?)*$`): at least 2 non-wildcard characters, with a `*`
 * only at the start or end of such a run.
 */
const AREA_WORD_PATTERN = /^(\*?([^*]{2,})\*?)*$/u;

/** The words {@link areaSearchWords} sends, and the too-short ones it left out. */
export interface AreaSearchWords {
  /** The words to send, one `areaSearchexpression` each (1..10, no duplicates). */
  words: string[];
  /** Words left out because they have fewer than 2 non-wildcard characters. */
  dropped: string[];
}

/**
 * Turn an area search into the words the Routing API accepts.
 *
 * Each term is split on whitespace AND punctuation, keeping letters, digits and
 * the `*` wildcard: the API ANDs the expressions and 500s on a space or on
 * punctuation such as `(`, `)`, `.` or `-` inside one, so "Frankfurt am Main" is
 * sent as three expressions and "Halle (Westf.)" as "Halle" + "Westf".
 *
 * The API then rejects the whole search (HTTP 400 "Constraint Violation") for a
 * word with fewer than 2 non-wildcard characters ("Frankfurt a. M." → "a", "M"; a
 * bare "*"), and for more than 10 words. So a too-short word is left out (it is
 * listed in `dropped`), a word repeated in any letter case is sent once, and the
 * rest throws a `FitConnectError`: no usable word left, more than
 * {@link MAX_AREA_SEARCH_WORDS} words, or a word whose `*` splits it into parts
 * shorter than 2 characters ("a*b").
 */
export function areaSearchWords(search: string | string[]): AreaSearchWords {
  const terms = (Array.isArray(search) ? search : [search]).filter(
    (t): t is string => typeof t === "string",
  );
  const words: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const word of terms.flatMap((t) => t.split(/[^\p{L}\p{M}\p{N}*]+/u))) {
    if (word === "") continue;
    if ([...word.replace(/\*/g, "")].length < 2) {
      dropped.push(word);
      continue;
    }
    if (!AREA_WORD_PATTERN.test(word)) {
      throw new FitConnectError(
        `Invalid search word "${word}": the API needs at least 2 characters between wildcards (e.g. "Mag*", "*burg").`,
      );
    }
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  if (words.length === 0) {
    throw new FitConnectError(
      `No usable search word in ${terms.map((t) => JSON.stringify(t)).join(" ") || "the search"}: ` +
        `every word needs at least 2 letters or digits (a "*" does not count).`,
    );
  }
  if (words.length > MAX_AREA_SEARCH_WORDS) {
    throw new FitConnectError(
      `Too many search words (${words.length}): the API accepts at most ${MAX_AREA_SEARCH_WORDS}. ` +
        "Leave some out — every word must match the same area, so a few distinctive ones are enough.",
    );
  }
  return { words, dropped };
}

/** Reject empty / whitespace-only required values up front with a clear message. */
function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FitConnectError(`Invalid ${name}: must be a non-empty string`);
  }
  return value.trim();
}
