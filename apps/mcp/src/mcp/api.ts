// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts: the kit, the same in every repository) import the
// client only through this file, under the names below; the names on the right are this
// client's. Per repository, like tools.ts: a client whose names or functions differ adapts here.

import { DEFAULT_API_VERSION, DEFAULT_BASE_URL, nodeHttpTransport as plainTransport, type Transport } from "@maschinenlesbar.org/fit-connect-client";
import { perSecondPace, type PaceOptions } from "@maschinenlesbar.org/fit-connect-client/internal/pace";

export {
  FitConnectClient as Client,
  FitConnectError as ClientError,
  FitConnectNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/fit-connect-client";

/**
 * The server's transport keeps to the Routing API's 5 requests a second (the client's
 * `perSecondPace`; its answers state 5 a second, 120 a minute, 108000 an hour): one server process
 * serves many calls, so the pace is the process's, across every call and client. The kit's limiter
 * (run.ts) wraps this one and keeps to the 120 a minute.
 */
export function serverTransport(base: Transport, options?: PaceOptions): Transport {
  return perSecondPace(base, options);
}

/** The default transport the kit's run.ts uses: node:http(s), at the API's pace. */
export const nodeHttpTransport: Transport = serverTransport(plainTransport);

export { sizeLimitMessage } from "@maschinenlesbar.org/fit-connect-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/fit-connect-client/internal/errors";

/**
 * The API's base as a result's `source` starts with it: the host (`--base-url`, else the default)
 * and the API version's path (/v2), which every request of the client goes to.
 */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/${DEFAULT_API_VERSION}`;
}
