// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { assertValid, baseUrlProblem, headerValueProblem, intRangeProblem } from "./validate.js";
import {
  FitConnectApiError,
  FitConnectError,
  FitConnectNetworkError,
  FitConnectParseError,
  FitConnectValidationError,
  credentialsIn,
  cutForMessage,
  echoedCredentialForms,
  isRedirectStatus,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";

export const DEFAULT_BASE_URL = "https://routing-api-prod.fit-connect.fitko.net";
const DEFAULT_USER_AGENT = "fit-connect-cli";

/** The phrase `cleartextProblem` uses for a base URL's `user:password@`. */
const USERINFO_PHRASE = "the base URL's credentials";

/**
 * Why requests to `baseUrl` would cross the network unencrypted, or `undefined`.
 *
 * Returns `undefined` for an `https:` URL, for one that does not parse, and for the
 * loopback interface (`localhost`, `127.0.0.0/8`, `::1`). For any other plain `http:`
 * URL it returns one sentence naming the host (`url.host`: host and port, never the
 * userinfo) and what secret travels with the requests: `secrets` are noun phrases such
 * as `"the API key"`, and a `user:password@` in the URL adds "the base URL's
 * credentials". The secrets themselves are never in the sentence. Not an error (a
 * mirror on a trusted network is a legitimate setup), so the CLI logs it as a `WARN`
 * record of `fit-connect.http` on stderr (once per run, before the first request).
 *
 * - `requests to <host> are sent unencrypted (http:, not https:)`
 * - `the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 * - `the API key and the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The WHATWG parser normalises IPv4 (`127.1`, `0x7f.0.0.1`) to dotted decimal.
  if (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  const named = [...secrets];
  if (url.username !== "" || url.password !== "") named.push(USERINFO_PHRASE);
  if (named.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const subject =
    named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]!}`;
  const verb = named.length === 1 && named[0] !== USERINFO_PHRASE ? "is" : "are";
  return `${subject} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to the production routing service. */
  baseUrl?: string | undefined;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in
   * any case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and
   * turns whatever it throws into a `FitConnectNetworkError`.
   */
  transport?: Transport | undefined;
  /** Value of the User-Agent header. The Routing API applies bot detection to the
   *  User-Agent: the default is accepted, but some UA strings are blocked with a
   *  403. An empty or whitespace-only value falls back to the default; a value
   *  with a control character other than tab or a code unit above U+00FF (checked
   *  before the fallback, so "\n" or U+3000 too) is a `FitConnectValidationError`
   *  (see `resolveUserAgent`). */
  userAgent?: string | undefined;
  /** Time limit per request in milliseconds, covering the whole response body, not
   *  only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables.
   *  Defaults to 30000. Enforced by the engine for every transport (the request's
   *  `signal` aborts then). Any other value is a `FitConnectValidationError`. */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and reset connections
   * (`ECONNRESET`, `UND_ERR_SOCKET`, …; a refused connection, a DNS failure and a timeout
   * are not retried), an integer 0..`MAX_RETRIES` (10); defaults to 2. Each waits
   * `retryDelayMs * attempt`, or the response's `Retry-After` — without one its
   * `RateLimit-Reset` — when that is longer (up to `MAX_RETRY_AFTER_MS`; a longer wait
   * is not retried, and the `FitConnectApiError` says so).
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly), an integer
   * 0..`MAX_RETRY_AFTER_MS` (30 000); defaults to 200. It is also the floor under a
   * `Retry-After` / `RateLimit-Reset`: the header can lengthen a wait, never shorten it.
   */
  retryDelayMs?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit. Enforced by the engine for every transport.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried status
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `fit-connect.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a 64-bit id). The value of a declared
   * member is delivered as its exact literal, as written, as a JSON string (`"5"`), so its type
   * never depends on its size. A declared member whose value is not a number (a string, `null`,
   * an object) is left as it is. Every undeclared number keeps the rule: exact, or a
   * FitConnectParseError. Matched by name anywhere in a JSON answer, an escaped name included.
   * Defaults to none (the Routing API's numbers are counts, offsets and durations); anything but
   * a set or list of non-empty strings is a FitConnectValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
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
  if (typeof value !== "string") throw new FitConnectValidationError("Invalid userAgent: Expected a string.");
  assertValid("userAgent", value, headerValueProblem);
  return value.trim() === "" ? DEFAULT_USER_AGENT : value;
}

/**
 * Decode a response body by the Content-Type's `charset` (default UTF-8) with
 * TextDecoder, which — unlike Buffer#toString — drops a leading byte-order mark,
 * so a BOM-prefixed JSON body parses. An unknown charset label is a
 * `FitConnectParseError` naming `request` (`GET <url>`). The Routing API sends UTF-8;
 * this matters for proxies and mirrors that re-encode or prepend a BOM. Bytes that are not
 * valid in the charset become U+FFFD, and `replaced` counts them: exactly for UTF-8 and the
 * single-byte charsets; for UTF-16 a U+FFFD the server sent counts too.
 */
function decodeBody(body: Buffer, contentType: string, request: string): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new FitConnectParseError(`${request}: unsupported response charset "${cutForMessage(sanitizeServerText(charset))}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch {
    // Not valid in the charset: decode with replacement, and count what was replaced.
    const text = new TextDecoder(decoder.encoding).decode(body);
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  let out = "";
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out += json.slice(copied, i) + "\\ufffd";
    copied = i + 6;
    replaced++;
    i += 5;
  }
  return replaced === 0 ? { json, replaced } : { json: out + json.slice(copied), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `value` when it is undefined or a function; otherwise a FitConnectValidationError naming the option. */
function optionalFunction<T>(name: string, value: T | undefined): T | undefined {
  if (value !== undefined && typeof value !== "function") {
    throw new FitConnectValidationError(`Invalid ${name}: Expected a function.`);
  }
  return value;
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

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After`, `RateLimit-Reset` or `Content-Type` in any case:
 * the engine then saw none of them (a "wait 120 s" 429 was retried after 200 ms, a
 * Latin-1 body decoded as UTF-8). Such an object (anything with `get` and `forEach`, a
 * `Headers` or a `Map`) is copied into a record; a plain record gets its names
 * lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a FitConnectValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new FitConnectValidationError("Invalid bigIntegerKeys: expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone), longest first, so a password never leaves half
   * of the `user:password` around it.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    // Only `undefined` selects the default base URL (`??`, not `||`): an explicit
    // "" is rejected like "  ", as the CLI rejects `--base-url ""`, rather than
    // quietly sending the request to the production host.
    // The raw value is checked (baseUrlProblem: an http(s) URL, no query, fragment,
    // surrounding whitespace or malformed "%" in the userinfo) before the trailing
    // slashes are dropped; the message never repeats the value.
    this.#baseUrl = assertValid("baseUrl", options.baseUrl ?? DEFAULT_BASE_URL, baseUrlProblem).replace(/\/+$/, "");
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.#echoed = credentialsIn(this.#baseUrl)
      .flatMap(echoedCredentialForms)
      .sort((a, b) => b.length - a.length);
    this.transport = optionalFunction("transport", options.transport) ?? nodeHttpTransport;
    // The one string option where blank means "default" (see resolveUserAgent).
    this.userAgent = resolveUserAgent(options.userAgent);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, 30_000);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    // Bounded like a Retry-After wait: a larger value overflowed Node's timer and fired
    // after 1 ms, a burst rather than a backoff.
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, MAX_RETRY_AFTER_MS, 200);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.sleep = optionalFunction("sleep", options.sleep) ?? realSleep;
    this.onRetry = optionalFunction("onRetry", options.onRetry);
    this.onWarning = optionalFunction("onWarning", options.onWarning);
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, the Authorization header or the decoded `user:password`) and transport
   * text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `FitConnectNetworkError` only; an injected one may throw anything (a
   * string, a `TypeError` from fetch). Every failure becomes a `FitConnectNetworkError`
   * — a `FitConnectError` a caller and the CLI can rely on — that names the request,
   * `<METHOD> <url> failed: <reason>` (userinfo redacted; Node's own text, "connect
   * ECONNREFUSED 127.0.0.1:443", says nothing about which call failed), with the base
   * URL's credentials scrubbed from the reason and the original, scrubbed, as `cause`.
   * Any other `FitConnectError` passes through.
   */
  private transportError(cause: unknown, method: string, url: string, retries: number): FitConnectError {
    if (cause instanceof FitConnectError && !(cause instanceof FitConnectNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const retried = retries > 0 ? ` (after ${retries} ${retries === 1 ? "retry" : "retries"})` : "";
    return new FitConnectNetworkError(this.failed(method, url, `${sanitizeServerText(this.scrub(reason))}${retried}`), {
      cause: this.scrubCause(cause),
    });
  }

  /** `<METHOD> <url> failed: <reason>`, the URL with its userinfo redacted and cut for a message. */
  private failed(method: string, url: string, reason: string): string {
    return `${method} ${cutForMessage(sanitizeServerText(this.scrub(redactUrl(url))))} failed: ${reason}`;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new FitConnectNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * The request URL as error messages show it: absolute (so a message names the host that gave
   * a bad answer, which matters with a mirror as `--base-url`), userinfo redacted, the base URL's
   * credentials scrubbed, control and bidi characters dropped, and cut at
   * MAX_MESSAGE_VALUE_LENGTH characters.
   */
  describeUrl(path: string, query?: QueryParams): string {
    return cutForMessage(sanitizeServerText(this.scrub(redactUrl(this.buildUrl(path, query)))));
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

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset or a 503 may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is retried like a 503, whichever
        // transport reported it (Node's ECONNRESET, fetch's UND_ERR_SOCKET, anywhere in the
        // cause chain). A refused connection, a DNS failure and a timeout are not: a slow
        // or absent upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
          continue;
        }
        throw this.transportError(cause, method, url, attempt);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the FitConnectError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new FitConnectNetworkError(this.failed(method, url, `the transport returned an invalid response (${invalid}).`));
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new FitConnectNetworkError(this.failed(method, url, sizeLimitMessage(this.maxResponseBytes)));
      }
      const retryable = status === 429 || status === 503;
      // Honour Retry-After, else the RateLimit-Reset the Routing API documents for a 429.
      // A wait beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once
      // and names the wait the server asked for.
      const retryAfter = retryable
        ? (parseRetryAfter(responseHeaders["retry-after"]) ?? parseRateLimitReset(responseHeaders["ratelimit-reset"]))
        : undefined;
      const tooLong = retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
      if (idempotent && retryable && !tooLong && attempt < this.maxRetries) {
        attempt += 1;
        // Back off linearly from retryDelayMs. A Retry-After can ask for longer, never for
        // less: `Retry-After: 0` or a date in the past turned the retries into a zero-delay
        // burst against a server that had just asked for less load.
        const backoff = this.retryDelayMs * attempt;
        await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), url, status);
        continue;
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, body, {
          location: responseHeaders["location"],
          retries: attempt,
          ...(tooLong ? { retryAfterMs: retryAfter } : {}),
        });
      }

      return { data: body, contentType, status };
    }
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. An empty (or whitespace-only) body is a
   * FitConnectParseError: every endpoint answers with a JSON document. Every error about the
   * answer names the request (`GET <url>: …`, userinfo redacted), as a network error does.
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    // The Routing API serves the /areas success body as `application/problem+json`
    // (not `application/json`); we don't gate on content-type, only on parseability.
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const request = `GET ${this.describeUrl(path, query)}`;
    const decoded = decodeBody(res.data, res.contentType, request);
    if (decoded.text.trim() === "") {
      // A broken answer, not "no results": printed as nothing with exit 0, it would let a
      // script carry on as if the API had found nothing.
      throw new FitConnectParseError(`${request}: empty response body.`);
    }
    const repaired = wellFormedEscapes(decoded.text);
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      // An HTML maintenance or proxy page is the usual non-JSON answer: name its type, so it
      // reads as an upstream problem rather than a client bug.
      const type = res.contentType.split(";")[0]?.trim() ?? "";
      const hint = type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cutForMessage(sanitizeServerText(type))}")` : "";
      throw new FitConnectParseError(`${request}: the answer is not valid JSON${hint}.`, { cause: this.scrubCause(cause) });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than return
    // a changed value.
    if (inexact !== undefined) {
      throw new FitConnectParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return parsed;
  }

  /**
   * The absolute, printable form of a `Location` header: resolved against the request
   * URL, userinfo redacted (and the base URL's credentials scrubbed wherever they appear),
   * control and bidi characters dropped — it is server text bound for stderr. An
   * unparseable value is shown sanitised as it came; an empty result is undefined.
   */
  private redirectTarget(requestUrl: string, location: string): string | undefined {
    let target: string;
    try {
      target = redactUrl(new URL(location, requestUrl).href);
    } catch {
      target = redactUrl(location);
    }
    const clean = sanitizeServerText(this.scrub(target)).trim();
    return clean === "" ? undefined : clean;
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    retry: { retries: number; retryAfterMs?: number; location?: string | string[] | undefined },
  ): FitConnectApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.scrub(body.toString("utf8"));
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
    // Redirects are not followed; name the target so the user can fix --base-url.
    const location =
      (isRedirectStatus(status) || status === 300) && typeof retry.location === "string"
        ? this.redirectTarget(url, retry.location)
        : undefined;
    return new FitConnectApiError({
      status,
      url,
      method,
      body: text,
      detail,
      ...(location === undefined ? {} : { location }),
      retries: retry.retries,
      ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs, maxRetryAfterMs: MAX_RETRY_AFTER_MS }),
    });
  }
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
export interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"id":
 *   1858054135406919680` becomes `"id":"1858054135406919680"`), so JSON.parse delivers it exactly
 *   as a string, whatever its size. Only a literal the JSON grammar allows is quoted, so a
 *   malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out = (out ?? "") + json.slice(copied, at) + '"' + literal + '"';
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  return { json: out === undefined ? json : out + json.slice(copied), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}
