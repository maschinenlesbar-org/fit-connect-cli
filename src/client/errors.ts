// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/** Base class for every error originating from this client. */
export class FitConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential supplied via `--base-url` is never echoed in cleartext. A value that
 * does not parse as a URL (a port typo, an unencoded `#` in the password) has its
 * userinfo cut out by text (`credentialsIn`); a value without userinfo is returned
 * unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body: the `Authorization: Basic`
 * value (base64 of the decoded `user:password`, UTF-8 as Node sends it for a URL with
 * userinfo), the decoded `user:password` itself, and the password alone when it is at
 * least 4 characters long. `[]` for a userinfo without a password. None of them has an
 * `@` to anchor on, so they are replaced as exact strings ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  if (colon < 0) return [];
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(userinfo.slice(0, colon));
  const password = decode(userinfo.slice(colon + 1));
  if (password === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (password.length >= 4) forms.push(password);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit. The CLI also
 * passes the JSON-escaped form of each credential.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * Longest server text (in characters) an error message shows, like a `detail` the API
 * sends. A 200 kB detail from a misbehaving upstream would otherwise become one stderr
 * line. The error's `body` property keeps the full text.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters (never inside a surrogate pair), ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${cutText(text, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present (the Routing API
 * returns RFC 7807 `application/problem+json` error bodies with a `detail` field).
 */
/** True for the statuses that redirect to a `Location`: 301, 302, 303, 307, 308. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class FitConnectApiError extends FitConnectError {
  readonly status: number;
  readonly detail: string | undefined;
  /** The request URL, absolute, with any userinfo redacted (`https://***@host/…`). */
  readonly url: string;
  readonly method: string;
  readonly body: string;
  /** How many times the engine retried the request before giving up (0 when it did not). */
  readonly retries: number;
  /**
   * The wait the server asked for in `Retry-After` / `RateLimit-Reset` (milliseconds) when
   * it was longer than the engine waits (`MAX_RETRY_AFTER_MS`), so the request was not
   * retried; else undefined.
   */
  readonly retryAfterMs: number | undefined;
  /**
   * For a redirect (301, 302, 303, 307, 308, or a 300 that names one), the `Location`
   * target: absolute, userinfo redacted, control and bidi characters dropped. The client
   * does not follow redirects, so this is where the server pointed — usually what to
   * fix in `baseUrl`. Undefined otherwise.
   */
  readonly location: string | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    retries?: number;
    retryAfterMs?: number;
    maxRetryAfterMs?: number;
    location?: string;
  }) {
    const parts: string[] = [];
    if (isRedirectStatus(args.status) || (args.status === 300 && args.location)) {
      parts.push(
        args.location
          ? `redirect to ${cutForMessage(args.location)} not followed`
          : "redirect not followed (no Location header)",
      );
    }
    if (args.detail) parts.push(cutForMessage(args.detail));
    if (args.retryAfterMs !== undefined) {
      // Say why the retries the caller asked for never ran: the server asked for a wait
      // longer than the engine sleeps, and retrying earlier would land inside that window.
      const wait = Math.ceil(args.retryAfterMs / 1000);
      const cap = args.maxRetryAfterMs === undefined ? "" : `, longer than the ${args.maxRetryAfterMs / 1000} s the client waits`;
      parts.push(`the server asked to retry after ${wait} s${cap}; not retried — try again after that`);
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    const retries = args.retries ?? 0;
    // Say that the status persisted through retries, so a user knows whether raising
    // --max-retries could help.
    const retryPart = retries > 0 ? ` (after ${retries} ${retries === 1 ? "retry" : "retries"})` : "";
    super(`HTTP ${args.status} for ${args.method} ${redactUrl(args.url)}${detailPart}${retryPart}`);
    this.status = args.status;
    // Redacted too: structured loggers serialise the error's properties.
    this.url = redactUrl(args.url);
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.retries = retries;
    this.retryAfterMs = args.retryAfterMs;
    this.location = args.location;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * An input the library rejects before sending any request: a client option or a
 * method argument that breaks one of the rules in `validate.ts`. The message reads
 * `Invalid <name>: <reason>`. The CLI reports it as a usage error (exit 1).
 */
export class FitConnectValidationError extends FitConnectError {}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class FitConnectNetworkError extends FitConnectError {}

/** The response body could not be parsed as the expected JSON shape. */
export class FitConnectParseError extends FitConnectError {}
