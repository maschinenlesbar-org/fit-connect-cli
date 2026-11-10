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
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * A scheme WHATWG parses as special (`ftp`, `file`, `http(s)`, `ws(s)`) at the start of a value,
 * with the slashes and backslashes it skips after it (`http:`, `http:///`, `https:\\` all start
 * the authority): a special scheme's authority starts after them, and also ends at a backslash.
 */
const SPECIAL_SCHEME = /^(?:ftp|file|https?|wss?):[/\\]*/i;

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme counts (`^[A-Za-z][A-Za-z0-9+.-]*://`, or a special one such as `http:` with
 * any slashes or backslashes after it, as WHATWG reads `http:///alice:pw@host` and
 * `http:alice:pw@host`): a bare `a:b@c` is a file name, a search text or a User-Agent as often
 * as a credential, and the base URL always has a scheme. It works on URLs that don't parse
 * too: the userinfo is everything between the scheme's slashes and the last `@` before the
 * host. Used to redact those exact strings from text that echoes the value (usage errors,
 * help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  // WHATWG skips any number of "/" and "\" after a special scheme, so its userinfo starts after them.
  const special = SPECIAL_SCHEME.exec(value);
  const scheme = special ?? /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#", and for a special scheme such as http(s) a "\", where WHATWG ends
  // it too: `https://u:pw@a.example\@b.example` sends `u:pw` to a.example); in one that doesn't,
  // at the last "@" of the value.
  const end = special !== null ? /[/?#\\]|$/ : /[/?#]|$/;
  const authority = parses ? rest.slice(0, rest.search(end)) : rest;
  const at = authority.lastIndexOf("@");
  return at > 0 ? [rest.slice(0, at)] : [];
}

/**
 * The userinfo of a value meant as a URL (a base URL, a request URL), however its scheme is
 * typed: as `credentialsIn` reads it when the value has a scheme; else as if it had `http://`
 * (`user:password@host`, `TOKEN:@host`); else, for a scheme mistyped before slashes
 * (`http//user:pw@host` with the colon left out, `http/…`, `htp:/…`), everything between the
 * first run of slashes or backslashes and the last `@`, as `credentialsIn` reads a URL that
 * doesn't parse. Such a value is refused, but the refusal (commander's, the transport's) quotes
 * it, so its userinfo has to be found to be redacted. Only for a value known to be a URL: in
 * other text a bare `a/b@c` is no credential.
 */
export function typedUrlCredentials(value: string): string[] {
  if (value === "" || credentialsIn(value).length > 0 || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return credentialsIn(value);
  const prefixed = credentialsIn(`http://${value}`);
  if (prefixed.length > 0) return prefixed;
  const slashes = /[/\\]+/.exec(value);
  const at = value.lastIndexOf("@");
  if (slashes === null || slashes.index + slashes[0].length >= at) return [];
  return [value.slice(slashes.index + slashes[0].length, at)];
}

/** A scheme character (RFC 3986: letters, digits, `+`, `.`, `-`). */
function isSchemeChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2e || code === 0x2d;
}

/** An ASCII letter, with which a scheme starts. */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * Where the scheme of the `://` at `at` starts: the first letter of the run of scheme characters
 * before it, looking back no further than `from`; -1 when there is none (`1://`, ` ://`). A run
 * led by other scheme characters (`-https://`) starts at its first letter.
 */
function schemeStart(text: string, at: number, from: number): number {
  let start = at;
  while (start > from && isSchemeChar(text.charCodeAt(start - 1))) start--;
  while (start < at && !isLetter(text.charCodeAt(start))) start++;
  return start < at ? start : -1;
}

/**
 * `text` with the userinfo of every URL in it replaced by `***` (`https://user:secret@host`
 * becomes `https://***@host`): the pattern backstop for text no exact secret matches. Text-based,
 * so it also covers a URL that does not parse; the userinfo ends at the last `@` before the first
 * whitespace, `/`, `?`, `#` or `'` after `://`. Linear in `text`, however many URLs it holds: each
 * `://` is found with `indexOf`, its scheme by walking back no further than the previous `://`,
 * and the search goes on right after each `://`, not after the authority it read: a URL glued
 * onto the one before it (`https://host://u:p@h`, `https://u:p@x://v:q@w`) starts inside that
 * authority, which ends at its `/`. An authority holds no `/`, so no `://` lies wholly inside one,
 * and every character is read a bounded number of times: by the authority loop and `indexOf`
 * forwards, by `schemeStart` backwards. The regex it replaces tried a scheme at every
 * word start and scanned a run of scheme characters (`a.a.a.…`) to its end each time: quadratic,
 * seconds on an 80 KB answer the CLI printed.
 */
export function redactUrlUserinfo(text: string): string {
  const parts = new TextBuilder();
  let copied = 0;
  let from = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", from)) {
    const begin = at + 3;
    let end = begin;
    let lastAt = -1;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x27 || /\s/.test(text[end] as string)) break;
      if (c === 0x40) lastAt = end;
    }
    if (lastAt !== -1 && schemeStart(text, at, from) !== -1) {
      parts.push(text.slice(copied, begin), "***");
      copied = lastAt;
    }
    from = begin;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.toString();
}

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces (slices of a text and their replacements), joined in
 * batches of BUILDER_BATCH into flat strings, so memory stays proportional to the text, not to
 * the number of pieces: one `+=` per piece made a rope node each, and one array of every piece a
 * slot each.
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body, in this order: the
 * `Authorization: Basic` value (base64 of the decoded `user:password`, UTF-8 as Node sends it
 * for a URL with userinfo), the decoded `user:password` itself, and the secret alone when it
 * is at least 4 characters long. The secret is the password; in a userinfo without one
 * (`TOKEN@host`, `TOKEN:@host`) it is the user name, a token, which Node sends as Basic
 * `TOKEN:`. `[]` for an empty userinfo. None of them has an `@` to anchor on, so they are
 * replaced as exact strings ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const password = colon < 0 ? "" : decode(userinfo.slice(colon + 1));
  const secret = password === "" ? user : password;
  if (secret === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (secret.length >= 4) forms.push(secret);
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
  /**
   * The body as the server sent it, the base URL's credentials scrubbed. A JSON body that spells
   * one with escapes (`\"`, `\u00e4`) is kept as its decoded JSON written again, scrubbed;
   * a body too large to be a string, or too deeply nested to write again, is left out ("").
   */
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
