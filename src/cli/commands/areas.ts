import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { areaSearchWords } from "../../client/client.js";
import { action, parseLimit, parseOffset, renderJson } from "../shared.js";

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
    .option("--offset <n>", "start offset into the result set, 0..2147483647 (default 0)", parseOffset)
    .option("--limit <n>", "page size, 1..500 (default 100)", parseLimit)
    .action(
      action(deps, async ({ client, global, opts }, positionals) => {
        // A variadic positional (`<query...>`) arrives as a single array argument,
        // so it sits at positionals[0] rather than spread across positionals.
        const search = (positionals[0] ?? []) as unknown as string[];
        // The client leaves out words the API rejects (fewer than 2 characters);
        // say so, since they widen the search the user typed.
        const { dropped } = areaSearchWords(search);
        if (dropped.length > 0) {
          deps.io.err(
            `Note: left out search words shorter than 2 characters (the API rejects them): ${dropped
              .map((w) => JSON.stringify(w))
              .join(", ")}.`,
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
