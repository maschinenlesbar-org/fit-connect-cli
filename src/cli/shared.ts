// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { ApiVersion, FitConnectClientOptions } from "../client/client.js";

/**
 * commander value-parser: a plain non-negative decimal integer.
 *
 * Only `^\d+$` is accepted — this deliberately rejects the empty string,
 * surrounding whitespace, hex (`0x10`), binary (`0b1`), and exponent forms
 * (`1e3`), all of which `Number()` would otherwise coerce silently.
 */
export function parseIntArg(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

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
 * commander value-parser for `--ags` (Amtlicher Gemeindeschlüssel): exactly 8
 * digits. Trims first — the value was previously forwarded untrimmed (unlike
 * leikaKey) — then validates, so surrounding whitespace, a wrong length, or a
 * whitespace-only value is a clear usage error rather than an opaque API 400 or a
 * misleading "got no selector" error.
 */
export function parseAgs(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{8}$/.test(trimmed)) {
    throw new InvalidArgumentError("Expected an 8-digit Amtlicher Gemeindeschlüssel (AGS).");
  }
  return trimmed;
}

/**
 * commander value-parser for `--ars` (Amtlicher Regionalschlüssel): exactly 12
 * digits. Trims, then validates — see {@link parseAgs}.
 */
export function parseArs(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{12}$/.test(trimmed)) {
    throw new InvalidArgumentError("Expected a 12-digit Amtlicher Regionalschlüssel (ARS).");
  }
  return trimmed;
}

/** commander value-parser for the Routing API version: "v1" or "v2". */
export function parseApiVersion(value: string): ApiVersion {
  if (value === "v1" || value === "v2") return value;
  throw new InvalidArgumentError('Expected "v1" or "v2".');
}

/**
 * commander value-parser for `--user-agent`. Control characters (notably CR/LF)
 * are illegal in an HTTP header value: Node's http layer throws a low-level
 * TypeError when the request is built, which previously surfaced to the user as
 * an opaque "Unexpected error". Reject them up front as a usage error; this also
 * forecloses header injection via the User-Agent value. Checked by char code so
 * no control-character literal need appear in the source.
 */
export function parseUserAgentArg(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new InvalidArgumentError(
        "Control characters (including CR/LF) are not allowed in --user-agent.",
      );
    }
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

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
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
