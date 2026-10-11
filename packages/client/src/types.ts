// Domain types for the FIT-Connect Routing API (routing-api 2.0.0).
//
// The list/search envelopes and the lighter objects (Area, ContactPerson,
// Address, Info) are typed precisely. The richer, loosely-specified parts of a
// route result (the localized text blocks and the open-ended customParameters)
// are kept as faithful raw JSON rather than partially-guessed types.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * A localized text block. The API nests human text under `description` as a
 * map of language tag -> (possibly HTML) string, e.g. `{ de: "...", en: "..." }`.
 */
export interface LocalizedText {
  description?: Record<string, string>;
}

/** A contact person for the responsible authority. */
export interface ContactPerson {
  name?: string;
  tel?: string;
  fax?: string;
  email?: string;
}

/** A street / postal address of the responsible authority. */
export interface Address {
  street?: string;
  houseNumber?: string;
  additional?: string;
  zip?: string;
  city?: string;
}

/** A post-office-box address of the responsible authority. */
export interface PostOfficeBox {
  postOfficeBox?: string;
  zip?: string;
  city?: string;
}

/** Processing-duration hint for a public service. */
export interface ProcessingDuration {
  minDuration?: number;
  maxDuration?: number;
  unit?: "year" | "month" | "week" | "day" | "workday" | "hour" | "minute" | "second";
}

/**
 * A single routing result — one FIT-Connect Zustellpunkt (delivery point) — with
 * technical addressing (`destinationId` + `destinationSignature`) plus
 * human-readable information about the responsible authority and the service.
 *
 * `destinationId` and `destinationSignature` are always present; everything else
 * is optional and populated per service/region.
 */
export interface Route {
  /** UUID of the FIT-Connect destination (submit applications here). */
  destinationId: string;
  /** JWS over the FIT-Connect addressing information (RFC 7515). */
  destinationSignature: string;
  /** Full name of the responsible authority, including its hierarchy. */
  destinationName?: string;
  /** Short name of the responsible authority. */
  destinationShortName?: string;
  /** URL of the authority's logo. */
  destinationLogo?: string;
  contactPersons?: ContactPerson[];
  address?: Address;
  postalAddress?: Address;
  postOfficeBox?: PostOfficeBox;
  /** URL to the region-specific privacy policy. */
  privacyPolicyUrl?: string;
  /** URL to the region-specific imprint (Impressum). */
  imprintUrl?: string;
  /** URL to the region-specific accessibility statement. */
  accessibilityUrl?: string;
  /** URL to the authority's contact form. */
  contactFormUrl?: string;
  /** Further information about the service (localized, may contain HTML). */
  furtherInformation?: LocalizedText;
  /** Documents required for the service (localized, may contain HTML). */
  requiredDocuments?: LocalizedText;
  /** Legal basis for the service (localized, may contain HTML). */
  legalBasis?: LocalizedText;
  /** Deadline notes for the service (localized, may contain HTML). */
  deadline?: LocalizedText;
  processingDuration?: ProcessingDuration;
  /** Open-ended, service-specific parameters (non-standardised). */
  customParameters?: JsonObject;
  /** Source system of the routing info, e.g. "PVOG". */
  origin?: string;
}

/** Response of `GET /{v}/routes`. */
export interface RouteResult {
  /** Number of results returned in this page. */
  count: number;
  /** Offset into the total result set. */
  offset: number;
  /** Total number of results available. */
  totalCount: number;
  routes: Route[];
}

/** A geographic area (Bundesland, Landkreis, Kreisfreie Stadt, ...). */
export interface Area {
  /** Numeric area id; pass as `areaId` to `GET /{v}/routes`. */
  id: string;
  /** Name of the area, e.g. "Halle (Saale)". */
  name: string;
  /** Type of the area, e.g. "Kreisfreie Stadt". */
  type: string;
}

/** Response of `GET /{v}/areas`. */
export interface AreaResult {
  count: number;
  offset: number;
  totalCount: number;
  areas: Area[];
}

/** Semantic version of the Routing API instance. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Response of `GET /{v}/info`. */
export interface Info {
  version: Version;
}
