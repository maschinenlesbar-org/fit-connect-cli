// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { FitConnectClient } from "../client/client.js";
import { DEFAULT_BASE_URL } from "../client/engine.js";
import { parseApiVersion, parseIntArg, parseUserAgentArg } from "./shared.js";
import { registerRoutesCommand } from "./commands/routes.js";
import { registerAreasCommand } from "./commands/areas.js";
import { registerInfoCommand } from "./commands/info.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new FitConnectClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("fit-connect")
    .description(
      "CLI for the open FIT-Connect Routing API - find the responsible authority " +
        "(Zustellpunkt) for a public service in an area, and search areas.",
    )
    .version(VERSION, "-v, --version", "output the version number")
    .option("--base-url <url>", "API base URL", DEFAULT_BASE_URL)
    .option("--api-version <version>", "Routing API version: v1 or v2", parseApiVersion, "v2")
    .option("--timeout <ms>", "per-request timeout in milliseconds (0 disables)", parseIntArg)
    .option(
      "--user-agent <ua>",
      "User-Agent header value (blank falls back to default; some values are blocked by the API)",
      parseUserAgentArg,
    )
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerRoutesCommand(program, deps);
  registerAreasCommand(program, deps);
  registerInfoCommand(program, deps);

  return program;
}
