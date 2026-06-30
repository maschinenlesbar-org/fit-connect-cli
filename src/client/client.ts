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

export interface FitConnectClientOptions extends EngineOptions {
  /** Routing API major version to target (path prefix). Defaults to "v2". */
  apiVersion?: ApiVersion;
}

/** Parameters for {@link FitConnectClient.routes}. */
export interface RouteQuery {
  /** Leistungsschlüssel (formerly LeiKa key) of the public service. Required. */
  leikaKey: string;
  /** Amtlicher Gemeindeschlüssel — provide exactly one area selector. */
  ags?: string;
  /** Amtlicher Regionalschlüssel — provide exactly one area selector. */
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
   * supported, e.g. `"Mag*"`. At least one non-empty term is required.
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

  /** Search for areas by name and/or postal code. */
  async areas(params: AreaQuery): Promise<AreaResult> {
    // Split each term on internal whitespace into separate areaSearchexpression
    // values. The API ANDs the expressions and 500s on a space inside a single
    // expression, so a quoted multi-word place like "Frankfurt am Main" must be
    // sent as three expressions — identical to passing the words as separate args.
    const terms = (Array.isArray(params.search) ? params.search : [params.search])
      .flatMap((t) => (typeof t === "string" ? t.trim().split(/\s+/) : []))
      .filter((t) => t !== "");
    if (terms.length === 0) {
      throw new FitConnectError("areas() needs at least one non-empty search term");
    }

    const query: QueryParams = {
      areaSearchexpression: terms,
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

/** Reject empty / whitespace-only required values up front with a clear message. */
function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FitConnectError(`Invalid ${name}: must be a non-empty string`);
  }
  return value.trim();
}
