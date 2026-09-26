// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { AGS_PATTERN, ARS_PATTERN, MAX_OFFSET } from "../client/client.js";
import type { ApiVersion, FitConnectClientOptions } from "../client/client.js";

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
 * (a canonical non-negative integer, see {@link parseIntArg}).
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min || n > max) {
      throw new InvalidArgumentError(`Expected an integer between ${min} and ${max}.`);
    }
    return n;
  };
}

/**
 * commander value-parser for `--offset`: 0..2147483647. The API declares `offset`
 * as `int32` and answers a larger value with an HTML 400 that carries no detail.
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
 * value ("" or whitespace, often an unset shell variable) is a usage error. It was
 * previously forwarded as an empty `areaId=` parameter next to another selector,
 * so the command ran and exited 0. The CLI counterpart of the client's
 * `requireNonEmpty`.
 */
export function parseNonEmpty(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new InvalidArgumentError("Value must not be blank.");
  }
  return trimmed;
}

/** commander value-parser for the Routing API version: "v1" or "v2". */
export function parseApiVersion(value: string): ApiVersion {
  if (value === "v1" || value === "v2") return value;
  throw new InvalidArgumentError('Expected "v1" or "v2".');
}

/**
 * commander value-parser for `--user-agent`: a value Node can send as an HTTP
 * header. Control characters (notably CR/LF; tab is allowed, as in HTTP) and code
 * units above U+00FF make Node's http layer throw a low-level TypeError when the
 * request is built, which surfaced as an opaque "Unexpected error". Reject them up
 * front as a usage error; this also forecloses header injection via the
 * User-Agent. A blank value is accepted: the engine falls back to its default UA
 * (documented). Checked by char code so no control-character literal need appear
 * in the source.
 */
export function parseUserAgentArg(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(`Value contains ${problem}.`);
  return value;
}

/**
 * What makes `value` unsendable as an HTTP header value, or undefined when Node's
 * `validateHeaderValue` would accept it: a control character other than tab, or a
 * code unit above U+00FF (Node sends header values as Latin-1).
 */
export function headerValueProblem(value: string): string | undefined {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return "control characters";
    if (code > 0xff) return "characters outside Latin-1 (above U+00FF)";
  }
  return undefined;
}

/**
 * commander value-parser for `--base-url`: an absolute http(s) URL. The client
 * already rejects any other scheme, but only at runtime; checking here makes a
 * `file:`, `ftp:` or malformed value a usage error before any client is built.
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(
      `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`,
    );
  }
  // Paths are appended to the base URL as a string, so a query or fragment would
  // swallow every request path ("http://h/#f" requests "/" for every command).
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
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
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
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
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
