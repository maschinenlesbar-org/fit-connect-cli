import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseIntArg, parseLimit, renderJson } from "../shared.js";

export function registerAreasCommand(program: Command, deps: CliDeps): void {
  program
    .command("areas <query...>")
    .description(
      "Search areas by name and/or postal code. Supports the `*` wildcard, e.g. " +
        '`areas "Mag*"`. Use a result\'s id as --area-id for `fit-connect routes`.',
    )
    .option("--offset <n>", "start offset into the result set (default 0)", parseIntArg)
    .option("--limit <n>", "page size, 1..500 (default 100)", parseLimit)
    .action(
      action(deps, async ({ client, global, opts }, positionals) => {
        // A variadic positional (`<query...>`) arrives as a single array argument,
        // so it sits at positionals[0] rather than spread across positionals.
        const search = (positionals[0] ?? []) as unknown as string[];
        const result = await client.areas({
          search,
          offset: opts["offset"] as number | undefined,
          limit: opts["limit"] as number | undefined,
        });
        renderJson(deps, global, result);
      }),
    );
}
