import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";

export function registerInfoCommand(program: Command, deps: CliDeps): void {
  program
    .command("info")
    .description("Show the version of the deployed Routing API instance")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.info());
      }),
    );
}
