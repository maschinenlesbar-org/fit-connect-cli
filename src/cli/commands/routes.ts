import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { FitConnectError } from "../../client/errors.js";
import { action, parseAgs, parseArs, parseIntArg, parseLimit, renderJson } from "../shared.js";

/** Map each selector option (camelCased by commander) to its CLI flag. */
const SELECTOR_FLAGS = { ags: "--ags", ars: "--ars", areaId: "--area-id" } as const;

/**
 * Validate "exactly one area selector" at the CLI layer, in terms of CLI flags.
 * The client enforces the same rule, but its message names the library method and
 * params (`routes()`, `ags/ars/areaId`); pre-checking here lets the user see the
 * actual flags (`--ags`, `--ars`, `--area-id`).
 */
function requireExactlyOneSelector(opts: Record<string, unknown>): void {
  const provided = (Object.keys(SELECTOR_FLAGS) as (keyof typeof SELECTOR_FLAGS)[]).filter(
    (k) => opts[k] !== undefined && String(opts[k]).trim() !== "",
  );
  if (provided.length !== 1) {
    throw new FitConnectError(
      `Provide exactly one area selector: --ags, --ars or --area-id (got ${
        provided.length === 0 ? "none" : provided.map((k) => SELECTOR_FLAGS[k]).join(", ")
      }).`,
    );
  }
}

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
        requireExactlyOneSelector(opts);
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
