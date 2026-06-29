// Public entry point for the API client library.

export { FitConnectClient, DEFAULT_API_VERSION } from "./client.js";
export type {
  ApiVersion,
  FitConnectClientOptions,
  RouteQuery,
  AreaQuery,
} from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, parseRetryAfter } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { nodeHttpTransport } from "./http.js";
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
