import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseAgs, parseArs, parseIntArg, parseLimit, renderJson } from "../shared.js";

export function registerRoutesCommand(program: Command, deps: CliDeps): void {
  program
    .command("routes <leikaKey>")
    .description(
      "Find the responsible authority (Zustellpunkt) for a public service in an area. " +
        "Provide exactly one area selector: --ags, --ars or --area-id.",
    )
    .option("--ags <ags>", "Amtlicher Gemeindeschlüssel of the place (8 digits)", parseAgs)
    .option("--ars <ars>", "Amtlicher Regionalschlüssel of the area (12 digits)", parseArs)
    .option("--area-id <id>", "Area id (from `fit-connect areas`)")
    .option("--offset <n>", "start offset into the result set (default 0)", parseIntArg)
    .option("--limit <n>", "page size, 1..500 (default 100)", parseLimit)
    .action(
      action(deps, async ({ client, global, opts }, [leikaKey]) => {
        const result = await client.routes({
          leikaKey: leikaKey!,
          ags: opts["ags"] as string | undefined,
          ars: opts["ars"] as string | undefined,
          areaId: opts["areaId"] as string | undefined,
          offset: opts["offset"] as number | undefined,
          limit: opts["limit"] as number | undefined,
        });
        renderJson(deps, global, result);
      }),
    );
}
