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
  value.trim() === "" ? "Value must not be blank." : undefined;

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
 * JSON-quoted (C0 controls such as ESC become `\u001b`), with DEL, C1 controls and Unicode
 * format characters (bidi overrides, zero-width characters) escaped as well. A library
 * user who logs the message of a rejected form field gets no raw terminal escapes, and a
 * 20 000-character value doesn't become a 20 KB line.
 */
export function quoteValue(value: string): string {
  const cut = value.length > MAX_ECHO_LENGTH ? `${cutText(value, MAX_ECHO_LENGTH)}…` : value;
  return JSON.stringify(cut).replace(/[\u007f-\u009f]|\p{Cf}/gu, (ch) =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
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
 * has five digits or fewer. Checked on the trimmed value; a blank one is
 * `nonBlankProblem`'s.
 */
export const areaIdProblem: Problem = (value) => {
  const id = value.trim();
  if (id === "") return "Value must not be blank.";
  if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > MAX_AREA_ID) {
    return `Expected an area id as \`fit-connect areas\` lists it: a positive whole number without leading zeros, at most ${MAX_AREA_ID}.`;
  }
  return undefined;
};
