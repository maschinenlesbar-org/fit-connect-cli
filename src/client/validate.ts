// Input validation shared by the library and the CLI. Each rule is a pure
// `<thing>Problem(value)` function that returns the reason a value is invalid, or
// undefined when it is valid. The library enforces a rule with assertValid() before
// any request; the CLI's commander parsers call the same function and turn its reason
// into a usage error, so one input gets one outcome on both sides.

import { FitConnectValidationError } from "./errors.js";

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
