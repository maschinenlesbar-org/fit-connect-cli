// The Routing API's limits per client, as its answers state them (`x-ratelimit-limit-second: 5`,
// `-minute: 120`, `-hour: 108000`, seen 2026-11-19; the OpenAPI spec documents the RateLimit
// headers and the 429 that follows a breach). A long-running process — the MCP server — keeps to
// the tightest one: `perSecondPace` wraps a transport and starts at most 5 requests in any second,
// holding a request back until it may start (never more than a second), instead of letting a burst
// meet a 429. Retries go through the transport too, so each counts. The minute limit is the MCP
// kit's limiter's default (120 a minute); the hour's is above both.

import type { HttpRequest, HttpResponse, Transport } from "./http.js";

/** Requests the Routing API allows per client in any second. */
export const REQUESTS_PER_SECOND = 5;

const SECOND_MS = 1000;

export interface PaceOptions {
  /** Requests started in any second (default REQUESTS_PER_SECOND). */
  max?: number;
  /** The clock (ms); tests inject one. */
  now?: () => number;
  /** Waits `ms`, or rejects when `signal` aborts; tests inject one. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/** `transport`, starting at most `max` requests in any second; a request beyond waits for its slot. */
export function perSecondPace(transport: Transport, options: PaceOptions = {}): Transport {
  const max = options.max ?? REQUESTS_PER_SECOND;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError(`max must be a positive integer, got ${String(max)}.`);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  // The start times given out, in order (some may lie ahead: a slot is reserved when asked for).
  const starts: number[] = [];
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const t = now();
    while (starts.length > 0 && (starts[0] as number) <= t - SECOND_MS) starts.shift();
    const start = starts.length < max ? t : Math.max(t, (starts[starts.length - max] as number) + SECOND_MS);
    starts.push(start);
    if (start > t) await sleep(start - t, request.signal);
    return transport(request);
  };
}

/** setTimeout as a promise that rejects with the signal's reason when it aborts. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
