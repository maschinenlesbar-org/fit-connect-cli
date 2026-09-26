// Public entry point for the API client library.

export {
  FitConnectClient,
  DEFAULT_API_VERSION,
  AGS_PATTERN,
  ARS_PATTERN,
  MAX_AREA_SEARCH_WORDS,
  MAX_OFFSET,
  areaSearchWords,
} from "./client.js";
export type {
  ApiVersion,
  FitConnectClientOptions,
  RouteQuery,
  AreaQuery,
  AreaSearchWords,
} from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRateLimitReset,
  parseRetryAfter,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  FitConnectError,
  FitConnectApiError,
  FitConnectNetworkError,
  FitConnectParseError,
} from "./errors.js";

export * from "./types.js";
