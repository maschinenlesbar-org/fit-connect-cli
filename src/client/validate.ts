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
