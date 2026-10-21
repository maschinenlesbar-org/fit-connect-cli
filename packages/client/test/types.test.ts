// Compile-time checks of the exported option types, and the runtime rule they rest on:
// an option given as undefined means what an omitted one means.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FitConnectClient } from "../src/index.js";
import { constantJson } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "fit-connect-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { FitConnectClient, type EngineOptions, type FitConnectClientOptions, type RouteQuery, type AreaQuery } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const engine: EngineOptions = allUndefined<EngineOptions>();",
        "export const options: FitConnectClientOptions = allUndefined<FitConnectClientOptions>();",
        "export const route: RouteQuery = { ...allUndefined<Omit<RouteQuery, 'leikaKey'>>(), leikaKey: '99123456760610' };",
        "export const area: AreaQuery = { ...allUndefined<Omit<AreaQuery, 'search'>>(), search: 'Hanau' };",
        "export const client = new FitConnectClient({ baseUrl: process.env.FIT_CONNECT_BASE_URL, timeoutMs: 15_000 });",
        "export const names = async (): Promise<string[]> => (await client.routes({ leikaKey: '99123456760610', ars: process.env.ARS, areaId: undefined })).routes.map((r) => r.destinationId);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const page = { count: 0, offset: 0, totalCount: 0, routes: [] };
  const mt = constantJson(page);
  const client = new FitConnectClient({
    apiVersion: undefined,
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    bigIntegerKeys: undefined,
    onWarning: undefined,
    transport: mt.transport,
  });
  await client.routes({ leikaKey: "99123456760610", ags: undefined, ars: "16", areaId: undefined, offset: undefined, limit: undefined });
  assert.equal(mt.last().url, "https://routing-api-prod.fit-connect.fitko.net/v2/routes?leikaKey=99123456760610&ars=16");
  assert.equal(mt.last().headers?.["User-Agent"], "fit-connect-cli");
  assert.equal(mt.last().timeoutMs, 30_000);
  const areas = constantJson({ count: 0, offset: 0, totalCount: 0, areas: [] });
  await new FitConnectClient({ transport: areas.transport }).areas({ search: "Hanau", offset: undefined, limit: undefined });
  assert.equal(areas.last().url, "https://routing-api-prod.fit-connect.fitko.net/v2/areas?areaSearchexpression=Hanau");
});
