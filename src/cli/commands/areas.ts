import type { Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import { areaSearchWords } from "../../client/client.js";
import { FitConnectError } from "../../client/errors.js";
import { action, once, parseLimit, parseOffset, renderJson } from "../shared.js";

export function registerAreasCommand(program: Command, deps: CliDeps): void {
  program
    .command("areas <query...>")
    .description(
      "Search areas by name and/or postal code. Supports the `*` wildcard, e.g. " +
        '`areas "Mag*"`. Terms are split into words on spaces and punctuation, and ' +
        "every word must match the same area. Each word needs at least 2 letters or " +
        "digits (shorter ones are left out), and at most 10 words are allowed. Use a " +
        "result's id as --area-id for `fit-connect routes`.",
    )
    .option("--offset <n>", "start offset into the result set, 0..2147483647 with offset + limit at most 2147483647 (default 0)", once("--offset", parseOffset))
    .option("--limit <n>", "page size, 1..500 (default 100)", once("--limit", parseLimit))
    // A search the API would reject (no usable word, > 10 words, a misplaced `*`)
    // is a usage error with help, like a bad option value — not an API-style
    // "Error:" line naming the library method.
    .hook("preAction", (command) => {
      try {
        areaSearchWords((command.processedArgs[0] ?? []) as string[]);
      } catch (err) {
        if (err instanceof FitConnectError) command.error(`error: ${err.message}`);
        throw err;
      }
    })
    .action(
      action(deps, async ({ client, global, opts }, positionals) => {
        // A variadic positional (`<query...>`) arrives as a single array argument,
        // so it sits at positionals[0] rather than spread across positionals.
        const search = (positionals[0] ?? []) as unknown as string[];
        // The client leaves out words the API rejects (fewer than 2 characters);
        // say so, since they widen the search the user typed.
        const { dropped, separators } = areaSearchWords(search);
        if (dropped.length > 0) {
          logOf(deps).info(
            "cli",
            `left out search words shorter than 2 characters (the API rejects them): ${dropped
              .map((w) => JSON.stringify(w))
              .join(", ")}.`,
          );
        }
        // Likewise the characters the search was split at: "Halle (Saale)" searches
        // "Halle" + "Saale". Shown compactly, each once, the invisible ones as U+XXXX.
        if (separators.length > 0) {
          logOf(deps).info(
            "cli",
            `split the search at characters the API rejects inside a word, and left them out: ${separators
              .map(showChar)
              .join(" ")}`,
          );
        }
        const result = await client.areas({
          search,
          offset: opts["offset"] as number | undefined,
          limit: opts["limit"] as number | undefined,
        });
        renderJson(deps, global, result);
      }),
    );
}

/**
 * A character as the separator note shows it: letters, digits, punctuation and symbols
 * as they are; anything else (spaces, controls, format characters such as bidi
 * overrides) as `U+XXXX`, so nothing invisible or terminal-active reaches stderr.
 */
function showChar(char: string): string {
  if (/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(char)) return char;
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}
