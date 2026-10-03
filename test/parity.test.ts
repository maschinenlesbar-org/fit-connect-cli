// CLI <-> library parity: the same input through run() and through the library, each
// on a recording mock transport, must give the same outcome — both reject without a
// request, or both send the same request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FitConnectClient } from "../src/client/client.js";
import { jsonResponse, parity } from "./helpers.js";

const ROUTES = () => jsonResponse({ count: 0, offset: 0, totalCount: 0, routes: [] });

test("routes: a blank selector next to a real one is rejected by the CLI and the library", async () => {
  const cases: [string[], Record<string, string>][] = [
    [["--ags", "", "--ars", "064350014014"], { ags: "", ars: "064350014014" }],
    [["--ars", "   ", "--ags", "06435014"], { ars: "   ", ags: "06435014" }],
    [["--area-id", "", "--ags", "06435014"], { areaId: "", ags: "06435014" }],
    [["--area-id", "  ", "--ars", "064350014014"], { areaId: "  ", ars: "064350014014" }],
  ];
  for (const [flags, selectors] of cases) {
    const { cli, lib } = await parity(
      ["routes", "99123456760610", ...flags],
      (transport) => new FitConnectClient({ transport }).routes({ leikaKey: "99123456760610", ...selectors }),
      ROUTES,
    );
    assert.equal(cli.code, 1, flags.join(" "));
    assert.equal(cli.requests.length, 0);
    assert.equal(lib.ok, false, JSON.stringify(selectors));
    assert.equal(lib.error?.name, "FitConnectValidationError");
    assert.match(lib.error?.message ?? "", /^Invalid (ags|ars|areaId): Value must not be blank\.$/);
    assert.equal(lib.requests.length, 0);
  }
});

test("routes: a padded selector is trimmed and sent the same way by the CLI and the library", async () => {
  const { cli, lib } = await parity(
    ["routes", "99123456760610", "--ags", " 06435014 "],
    (transport) => new FitConnectClient({ transport }).routes({ leikaKey: "99123456760610", ags: " 06435014 " }),
    ROUTES,
  );
  assert.equal(cli.code, 0);
  assert.equal(lib.ok, true);
  assert.deepEqual(
    cli.requests.map((r) => r.url),
    lib.requests.map((r) => r.url),
  );
});
