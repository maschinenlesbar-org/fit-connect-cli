// Input validation shared by the library and the CLI. Each rule is a pure
// `<thing>Problem(value)` function that returns the reason a value is invalid, or
// undefined when it is valid. The library enforces a rule with assertValid() before
// any request; the CLI's commander parsers call the same function and turn its reason
// into a usage error, so one input gets one outcome on both sides.

import { FitConnectValidationError, cutText } from "./errors.js";

/** Why `value` is invalid (for example `"Expected a non-empty value."`), or undefined when it is valid. */
export type Problem<T = string> = (value: T) => string | undefined;

/**
 * Return `value` when `problem(value)` finds nothing; otherwise throw a
 * {@link FitConnectValidationError} with the message `Invalid <name>: <reason>`.
 * A client method that returns a promise calls it inside its async body, so a
 * rejected input rejects the promise, and no request is sent.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new FitConnectValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * A value that is not blank: an empty or whitespace-only string (often an unset
 * shell variable) is invalid rather than "not given", so it never silently drops a
 * parameter.
 */
export const nonBlankProblem: Problem = (value) =>
  value.trim() === "" ? BLANK : undefined;

/** The reason for a blank value, whatever made it blank. */
const BLANK = "Value must not be blank.";

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks.
 */
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a search text: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character: a zero-width space, a soft hyphen, ZWJ/ZWNJ, a bidi control, U+FEFF. */
const TEXT_FORMAT = /\p{Cf}/u;

/**
 * Why `value` cannot be sent as search text (a term of the area search), or undefined when it
 * can. Refused, before any request:
 * - a value that is blank, or holds only invisible characters and combining marks (`isBlank`);
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, ZWJ, a bidi control): pasted along from a hyphenated web page, a soft hyphen used to
 *   split "Frankfurt" into "Frank" and "furt", which found nothing.
 * Unlike the kit's text rule this refuses ZWJ and ZWNJ too: the API takes only A–Z, the umlauts
 * and ß, so no name it can find needs a joiner. The reason quotes the value with every invisible
 * character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return BLANK;
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a code the API
 * compares exactly: the Leistungsschlüssel, an AGS, an ARS, an area id. The rules apply to the
 * value with surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank
 * (and not only invisible characters or combining marks), no lone surrogate, and no control or
 * format character at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an
 * invisible character in a code only ever makes it match nothing. The reason quotes the value
 * visibly. Each token's own pattern (digits of the right length) is checked after this.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return BLANK;
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * An integer in min..max (a safe integer; NaN, Infinity and fractions are
 * invalid). With min 0 and max Number.MAX_SAFE_INTEGER the reason reads "Expected a
 * non-negative integer.".
 */
export function intRangeProblem(min: number, max: number): Problem<number> {
  const reason =
    min === 0 && max === Number.MAX_SAFE_INTEGER
      ? "Expected a non-negative integer."
      : `Expected an integer between ${min} and ${max}.`;
  return (n) => (typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max ? undefined : reason);
}

/**
 * What makes `value` unsendable as an HTTP header value, or undefined when Node's
 * `validateHeaderValue` would accept it: a control character other than tab
 * (notably CR/LF, which would also allow header injection) or DEL, or a code unit
 * above U+00FF (Node sends header values as Latin-1 and otherwise throws a bare
 * TypeError from inside the transport). Checked by char code so no
 * control-character literal appears in the source.
 */
export const headerValueProblem: Problem = (value) => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return "Value contains control characters.";
    if (code > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * Why `value` cannot be used as the base URL, or undefined when it can. The engine
 * appends every request path to the base URL as a string, so the rules guard the
 * request URL it builds:
 *
 * - it must be a string that parses as an absolute URL with an `http:` or `https:`
 *   scheme (a `file:` or `ftp:` base URL would otherwise reach a custom transport that
 *   does no such check);
 * - no `?` or `#`: either would swallow every path (`http://h/?x=1` requests
 *   `/?x=1/v2/...`, `http://h/#f` requests `/`);
 * - a `%` in the user name or password must start a valid escape (`%25` for a literal
 *   one): Node decodes the userinfo for the Authorization header and fails at request
 *   time;
 * - no surrounding whitespace (U+00A0 included) and no control character anywhere:
 *   `new URL()` trims or drops them silently, but the raw string is what gets sent, so
 *   `"http://h "` would request `http://h /v2/info` and fail with "Invalid URL".
 *
 * The reasons never repeat the value, so a credential in it cannot reach a message.
 * The engine enforces it (as `Invalid baseUrl: <reason>`), and the CLI's `--base-url`
 * parser calls it.
 */
export function baseUrlProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "A base URL cannot contain control characters.";
  }
  return undefined;
}

/** Longest echoed value (in characters) a validation message shows; longer ones end in "…". */
export const MAX_ECHO_LENGTH = 100;

/**
 * `value` quoted for a validation message: cut to MAX_ECHO_LENGTH characters (never inside
 * a surrogate pair), then
 * JSON-quoted (C0 controls such as ESC become `\u001b`), with DEL, C1 controls, Unicode
 * format characters (bidi overrides, zero-width characters, the soft hyphen) and the line and
 * paragraph separators U+2028/U+2029 escaped as well, so a refused value shows what it holds. A library
 * user who logs the message of a rejected form field gets no raw terminal escapes, and a
 * 20 000-character value doesn't become a 20 KB line.
 */
export function quoteValue(value: string): string {
  const cut = value.length > MAX_ECHO_LENGTH ? `${cutText(value, MAX_ECHO_LENGTH)}…` : value;
  return JSON.stringify(cut).replace(/[\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, (ch) =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

/** The most values {@link quoteValues} lists; the rest are counted. */
export const MAX_QUOTED_VALUES = 10;

/**
 * `values` for a message: each distinct value once, quoted with {@link quoteValue}, at most
 * {@link MAX_QUOTED_VALUES} of them joined with `separator`, then `… (N more)` for the
 * rest. A search of 2000 one-letter words lists `"q"` once, not 2000 times, and no list of
 * values makes a message longer than about 1 kB.
 */
export function quoteValues(values: readonly string[], separator = ", "): string {
  const distinct = [...new Set(values)];
  const shown = distinct.slice(0, MAX_QUOTED_VALUES).map(quoteValue).join(separator);
  const more = distinct.length - MAX_QUOTED_VALUES;
  return more > 0 ? `${shown}${separator}… (${more} more)` : shown;
}

/** The largest area id accepted (2^31 - 1): see {@link areaIdProblem}. */
export const MAX_AREA_ID = 2_147_483_647;

/**
 * Why `value` is not an area id the Routing API can look up, or undefined when it is: a
 * positive whole number in ASCII digits, without a leading zero, at most
 * {@link MAX_AREA_ID} — the form `areas` lists ids in (`"940"`, `"21709"`). The spec
 * only says `^\d{1,}`, but the live API answers a leading zero (`0940`, the same number
 * as the documented `940`) and a 20-digit id with HTTP 500 "Calling the third service
 * 'AreaService' resulted in an exception", which reads like an outage. The API has no
 * upper bound of its own to match: live on 2026-10-06 it answered that same 500 for every
 * id it doesn't know — 99999, a 9-digit 123456789, 2147483647 and 2147483648 alike — so
 * the int32 cap (like `offset`) only keeps the value a plain number; every real id seen
 * has five digits or fewer. Checked on the trimmed value, after the {@link tokenProblem} rules
 * (blank, invisible or control characters).
 */
export const areaIdProblem: Problem = (value) => {
  const token = tokenProblem(value);
  if (token !== undefined) return token;
  const id = value.trim();
  if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > MAX_AREA_ID) {
    return `Expected an area id as \`fit-connect areas\` lists it: a positive whole number without leading zeros, at most ${MAX_AREA_ID}.`;
  }
  return undefined;
};
