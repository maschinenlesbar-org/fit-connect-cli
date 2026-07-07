// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { FitConnectApiError, FitConnectError, FitConnectParseError, redactUrl } from "./errors.js";

export const DEFAULT_BASE_URL = "https://routing-api-prod.fit-connect.fitko.net";
const DEFAULT_USER_AGENT = "fit-connect-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to the production routing service. */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. The Routing API applies bot detection to the
   *  User-Agent: the default is accepted, but some UA strings are blocked with a
   *  403. An empty or whitespace-only value falls back to the default. */
  userAgent?: string;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds. Grows linearly per attempt,
   * unless the response carries a `Retry-After` header, which takes precedence.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Strip control characters out of a string that originates in an
 * attacker-controllable response — the RFC 7807 error `detail`/`title`/`message`.
 * `JSON.parse` decodes an escaped ESC in an error body into a real ESC byte, so
 * without this a hostile or MITM'd endpoint could drive ANSI/OSC escape sequences
 * into the user's terminal (display spoofing, title changes) when the resulting
 * `Error.message` is printed raw to stderr by `run.ts`. The success path is already
 * safe (`JSON.stringify` re-escapes control chars), so this only needs to cover
 * text that flows into an error message. Removes all C0/C1 controls plus DEL.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate the configured base URL up front. Without this the only scheme check
 * lived in the transport, which rejects the *fully built* request URL — so a bad
 * `--base-url ftp://x` produced a message echoing `ftp://x/v2/...` rather than the
 * value the user passed. Throwing here keeps the message about the base URL itself.
 */
function assertValidBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new FitConnectError(`Invalid base URL "${redactUrl(baseUrl)}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FitConnectError(
      `Unsupported base URL scheme "${parsed.protocol}" in "${redactUrl(baseUrl)}"; only http and https are supported.`,
    );
  }
}

/**
 * Parse a `Retry-After` header into a delay in milliseconds, supporting both
 * the delta-seconds form (`Retry-After: 120`) and the HTTP-date form
 * (`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`). Returns `undefined` when the
 * header is absent or unparseable so the caller can fall back to its own backoff.
 */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // Use `||` (not `??`) for the string options so that an empty string — which
    // commander can hand us from `--base-url ""` / `--user-agent ""` — falls back
    // to the default rather than producing an invalid URL or a blank UA header
    // (the latter would trip the Routing API's bot detection and 403).
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    assertValidBaseUrl(this.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    // Fall back to the default for an empty OR whitespace-only UA: a blank
    // User-Agent is semantically equivalent to none, so " " should not be sent
    // verbatim as if it were a real header value.
    this.userAgent = options.userAgent && options.userAgent.trim() !== "" ? options.userAgent : DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    // The Routing API serves the /areas success body as `application/problem+json`
    // (not `application/json`); we don't gate on content-type, only on parseability.
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new FitConnectParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): FitConnectApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      // RFC 7807 problem+json carries human-readable text in `detail` (and a
      // short `title`); fall back to `message` for non-standard error bodies.
      const parsed = JSON.parse(text) as { detail?: unknown; title?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.title === "string") detail = parsed.title;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new FitConnectApiError({ status, url, method, body: text, detail });
  }
}
