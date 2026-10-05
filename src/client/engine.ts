// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { assertValid, baseUrlProblem, headerValueProblem, intRangeProblem } from "./validate.js";
import { FitConnectApiError, FitConnectParseError } from "./errors.js";

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
   *  403. An empty or whitespace-only value falls back to the default; a value
   *  with a control character other than tab or a code unit above U+00FF (checked
   *  before the fallback, so "\n" or U+3000 too) is a `FitConnectValidationError`
   *  (see `resolveUserAgent`). */
  userAgent?: string;
  /** Time limit per request in milliseconds, covering the whole response body, not
   *  only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables.
   *  Defaults to 30000. Any other value is a `FitConnectValidationError`. */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, an integer
   * 0..`MAX_RETRIES` (10); defaults to 2. Each waits the response's `Retry-After`,
   * or without one its `RateLimit-Reset` (up to `MAX_RETRY_AFTER_MS`; a longer wait
   * is not retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds, a non-negative integer; defaults
   * to 200. Grows linearly per attempt, unless the response carries a usable
   * `Retry-After` header, which takes precedence.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI (the sleep is not bounded by
 * `timeoutMs`).
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Upper bound for `maxRetries` / `--max-retries` (each retry may wait up to `MAX_RETRY_AFTER_MS`). */
export const MAX_RETRIES = 10;

/**
 * A numeric engine option: `fallback` when undefined, else an integer in 0..max,
 * or a FitConnectValidationError (`Invalid <name>: ...`). A negative, NaN or
 * fractional value would otherwise silently disable the timeout or the size cap
 * (both are off only for `> 0` tests), and an unbounded maxRetries keeps retrying.
 */
export function intOption(name: string, value: number | undefined, max: number, fallback: number): number {
  return value === undefined ? fallback : assertValid(name, value, intRangeProblem(0, max));
}

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controllable response — the RFC
 * 7807 error `detail`/`title`/`message`, a violation's field and message — safe to
 * print into an error message on stderr:
 *
 * - C0 and C1 controls and DEL are dropped. `JSON.parse` decodes an escaped ESC in
 *   an error body into a real ESC byte; printed raw, a hostile or MITM'd endpoint
 *   could drive ANSI/OSC sequences into the terminal (display spoofing, title
 *   changes).
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge a line of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts). Written as a char-code filter so no raw control byte appears in
 * this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Summarise the `violations[]` a Routing API 400 carries next to its bare
 * "Constraint Violation" detail — `[{"field":"route.areaId","message":"must match
 * \"^\\d{1,}\""}]` — as `route.areaId: must match "^\d{1,}"`, joined with "; ".
 * They name the rejected parameter and the rule, which the detail alone does not.
 * Entries without a string `message` are skipped; every part is server text and
 * goes through `sanitizeServerText`. Undefined when there is nothing to show.
 */
function describeViolations(violations: unknown): string | undefined {
  if (!Array.isArray(violations)) return undefined;
  const parts: string[] = [];
  for (const v of violations as unknown[]) {
    if (v === null || typeof v !== "object") continue;
    const { field, message } = v as { field?: unknown; message?: unknown };
    if (typeof message !== "string" || sanitizeServerText(message) === "") continue;
    const name = typeof field === "string" ? sanitizeServerText(field) : "";
    parts.push(name ? `${name}: ${sanitizeServerText(message)}` : sanitizeServerText(message));
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * The User-Agent the engine sends for `value`: the raw value is checked first
 * (`headerValueProblem`: no control character other than tab, nothing above
 * U+00FF), so `"\n"` or `"\u3000"` is a FitConnectValidationError
 * (`Invalid userAgent: ...`) even though `trim()` would blank it. Then undefined,
 * an empty or a whitespace-only value falls back to the default: a blank
 * User-Agent is semantically equivalent to none and would trip the Routing API's
 * bot detection (403). The CLI's `--user-agent` parser applies the same rule.
 */
export function resolveUserAgent(value: string | undefined): string {
  if (value === undefined) return DEFAULT_USER_AGENT;
  assertValid("userAgent", value, headerValueProblem);
  return value.trim() === "" ? DEFAULT_USER_AGENT : value;
}

/**
 * Decode a response body by the Content-Type's `charset` (default UTF-8) with
 * TextDecoder, which — unlike Buffer#toString — drops a leading byte-order mark,
 * so a BOM-prefixed JSON body parses. An unknown charset label is a
 * `FitConnectParseError`. The Routing API sends UTF-8; this matters for proxies and
 * mirrors that re-encode or prepend a BOM.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new FitConnectParseError(`Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`);
  }
  return decoder.decode(body);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), any other date format — so the caller falls back to its own
 * backoff. The strict patterns matter: `Date.parse` alone would read `"1.5"` as a
 * date in 2001 and retry at once. The value is not clamped; the engine does not
 * retry at all when it exceeds `MAX_RETRY_AFTER_MS`.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * A `RateLimit-Reset` value at or above this is read as a Unix timestamp in
 * seconds (2001-09-09 onwards), anything below as delta-seconds: no rate-limit
 * window lasts 31 years, and no timestamp is that small.
 */
const UNIX_TIMESTAMP_FLOOR = 1_000_000_000;

/**
 * Parse a `RateLimit-Reset` header into a delay in milliseconds. The Routing API
 * documents it (`routing-api.yaml`) as the backoff signal of a 429 — "Auswertung
 * der RateLimit-Headers erforderlich" — and sends no `Retry-After`. Its spec calls
 * the value "the point in time, in seconds, at which the current window ends",
 * which reads as either delta-seconds (the IETF RateLimit draft) or a Unix
 * timestamp, so both are accepted: digits only; a value of at least 10^9 is a
 * timestamp (time left from `now`, 0 if past), a smaller one delta-seconds.
 * Anything else (`"-1"`, `"1.5"`, a date) → `undefined`, as in `parseRetryAfter`.
 * The engine uses it only when there is no usable `Retry-After`, with the same
 * `MAX_RETRY_AFTER_MS` rule.
 */
export function parseRateLimitReset(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return seconds >= UNIX_TIMESTAMP_FLOOR ? Math.max(0, seconds * 1000 - now) : seconds * 1000;
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
    // Only `undefined` selects the default base URL (`??`, not `||`): an explicit
    // "" is rejected like "  ", as the CLI rejects `--base-url ""`, rather than
    // quietly sending the request to the production host.
    // The raw value is checked (baseUrlProblem: an http(s) URL, no query, fragment,
    // surrounding whitespace or malformed "%" in the userinfo) before the trailing
    // slashes are dropped; the message never repeats the value.
    this.baseUrl = assertValid("baseUrl", options.baseUrl ?? DEFAULT_BASE_URL, baseUrlProblem).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    // The one string option where blank means "default" (see resolveUserAgent).
    this.userAgent = resolveUserAgent(options.userAgent);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, 30_000);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, Number.MAX_SAFE_INTEGER, 200);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
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
        // Honour Retry-After, else the RateLimit-Reset the Routing API documents for
        // a 429; without either, back off linearly. A wait beyond MAX_RETRY_AFTER_MS
        // is not retried: the error below surfaces at once.
        const retryAfter =
          parseRetryAfter(response.headers["retry-after"]) ??
          parseRateLimitReset(response.headers["ratelimit-reset"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
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
    const text = decodeBody(res.data, res.contentType, path);
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
      const parsed = JSON.parse(text) as {
        detail?: unknown;
        title?: unknown;
        message?: unknown;
        violations?: unknown;
      };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.title === "string") detail = parsed.title;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
      // `detail` came from the response body; strip control characters so a hostile
      // endpoint cannot inject terminal escape sequences via the stderr error message.
      if (detail !== undefined) detail = sanitizeServerText(detail);
      const violations = describeViolations(parsed?.violations);
      if (violations !== undefined) detail = detail ? `${detail} (${violations})` : violations;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    return new FitConnectApiError({ status, url, method, body: text, detail });
  }
}
