// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { AGS_PATTERN, ARS_PATTERN, MAX_OFFSET } from "../client/client.js";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl } from "../client/engine.js";
import { FitConnectError } from "../client/errors.js";
import { areaIdProblem, baseUrlProblem, headerValueProblem, intRangeProblem, nonBlankProblem } from "../client/validate.js";
import type { ApiVersion, FitConnectClientOptions } from "../client/client.js";

/**
 * Wrap a value-parser so its option may be given only once: commander keeps the last of a
 * repeated option and drops the others without a word (`--area-id 940 --area-id 941`
 * asked for area 941). A repeat is a usage error naming the flag. A fresh program is
 * built per `run()`, so the state lives as long as one parse.
 */
export function once<T>(flag: string, parse: (value: string) => T): (value: string) => T {
  let seen = false;
  return (value: string) => {
    if (seen) throw new InvalidArgumentError(`${flag} was given more than once; give it once.`);
    seen = true;
    return parse(value);
  };
}

/**
 * commander value-parser: a plain non-negative decimal integer in canonical form.
 *
 * Only `0` or a digit string with no leading zero is accepted — this deliberately
 * rejects the empty string, surrounding whitespace, hex (`0x10`), binary (`0b1`),
 * exponent forms (`1e3`), and leading-zero forms (`007`, `00`), all of which
 * `Number()` would otherwise coerce or reinterpret silently.
 */
export function parseIntArg(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer (no leading zeros).");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer (no leading zeros).");
  }
  return n;
}

/**
 * Build a commander value-parser for an integer constrained to [min, max]
 * (a canonical non-negative integer, see {@link parseIntArg}; the range is the
 * library's `intRangeProblem`, which the engine applies to the same options).
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  const problem = intRangeProblem(min, max);
  return (value: string) => {
    const n = parseIntArg(value);
    const reason = problem(n);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return n;
  };
}

/**
 * commander value-parser for `--offset`: 0..2147483647. The API declares `offset`
 * as `int32` and answers a larger value with an HTML 400 that carries no detail. The
 * library also rejects an `offset + limit` above that (the API's sum overflows).
 */
export const parseOffset = parseBoundedInt(0, MAX_OFFSET);

/**
 * commander value-parser for `--limit`: a page size in 1..500, the bound the
 * Routing API documents. Out-of-range values were previously forwarded and the
 * API rejected them with an opaque "HTTP 400 Constraint Violation" that never
 * named the bound; reject them here, before any network call, with a clear message.
 */
export function parseLimit(value: string): number {
  const n = parseIntArg(value);
  if (n < 1 || n > 500) {
    throw new InvalidArgumentError("Expected a page size between 1 and 500.");
  }
  return n;
}

/**
 * commander value-parser for `--ags` (Amtlicher Gemeindeschlüssel): 2, 3, 5 or 8
 * digits — the Land, Regierungsbezirk, Kreis and Gemeinde levels, exactly the
 * lengths the Routing API accepts (`routing-api.yaml`, `^(\d{2}|\d{3}|\d{5}|\d{8})$`).
 * Trims first, then validates, so surrounding whitespace, a length the API rejects,
 * or a whitespace-only value is a clear usage error rather than an opaque API 400 or
 * a misleading "got no selector" error.
 */
export function parseAgs(value: string): string {
  const trimmed = value.trim();
  if (!AGS_PATTERN.test(trimmed)) {
    throw new InvalidArgumentError(
      "Expected an Amtlicher Gemeindeschlüssel (AGS) of 2, 3, 5 or 8 digits (Land, Regierungsbezirk, Kreis or Gemeinde).",
    );
  }
  return trimmed;
}

/**
 * commander value-parser for `--ars` (Amtlicher Regionalschlüssel): 2, 3, 5, 9 or
 * 12 digits — Land, Regierungsbezirk, Kreis, Gemeindeverband and Gemeinde, as the
 * Routing API accepts (`^(\d{2}|\d{3}|\d{5}|\d{9}|\d{12})$`). Trims, then
 * validates — see {@link parseAgs}.
 */
export function parseArs(value: string): string {
  const trimmed = value.trim();
  if (!ARS_PATTERN.test(trimmed)) {
    throw new InvalidArgumentError(
      "Expected an Amtlicher Regionalschlüssel (ARS) of 2, 3, 5, 9 or 12 digits (Land, Regierungsbezirk, Kreis, Gemeindeverband or Gemeinde).",
    );
  }
  return trimmed;
}

/**
 * commander value-parser for a free-form id (`--area-id`): trimmed, and a blank
 * value ("" or whitespace, often an unset shell variable) is a usage error — the
 * library's `nonBlankProblem`, which `routes()` applies to every selector.
 */
export function parseNonEmpty(value: string): string {
  const problem = nonBlankProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value.trim();
}

/**
 * commander value-parser for `--area-id`: trimmed, then the library's `areaIdProblem`
 * (a positive whole number without leading zeros, as `areas` lists it). A blank value
 * is a usage error as before; `0940` or a 20-digit id, which the API answers with HTTP
 * 500, is one too.
 */
export function parseAreaId(value: string): string {
  const problem = areaIdProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value.trim();
}

/** commander value-parser for the Routing API version: "v1" or "v2". */
export function parseApiVersion(value: string): ApiVersion {
  if (value === "v1" || value === "v2") return value;
  throw new InvalidArgumentError('Expected "v1" or "v2".');
}

/**
 * commander value-parser for `--user-agent`: a value Node can send as an HTTP
 * header — the library's `headerValueProblem`, checked on the raw value as
 * `resolveUserAgent` does. Control characters (notably CR/LF; tab is allowed, as in
 * HTTP) and code units above U+00FF are a usage error, which also forecloses header
 * injection via the User-Agent. A blank value is accepted: the engine falls back to
 * its default UA (documented).
 */
export function parseUserAgentArg(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for `--base-url`: the library's `baseUrlProblem` rule (an
 * absolute http(s) URL without a query, fragment, surrounding whitespace or a "%" in the
 * userinfo that isn't an escape), so a bad value is a usage error before any client is
 * built. The reason never repeats the value.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  apiVersion?: ApiVersion;
  compact?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toClientOptions(global: GlobalOptions): FitConnectClientOptions {
  const options: FitConnectClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  if (global.apiVersion !== undefined) options.apiVersion = global.apiVersion;
  return options;
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a
 * FitConnectError so the CLI prints a clear message instead of "Unexpected error:
 * Maximum call stack size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new FitConnectError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toClientOptions(global));
    // One warning per run, before the first request, when the base URL is plain http: to
    // a host other than loopback. Help, version and usage errors never get here.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
