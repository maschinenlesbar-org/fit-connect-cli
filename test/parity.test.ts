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

test("engine limits: an out-of-range timeout, retry count or size cap is rejected by both", async () => {
  const cases: [string[], Record<string, number>, RegExp][] = [
    [["--max-retries", "11"], { maxRetries: 11 }, /^Invalid maxRetries: Expected an integer between 0 and 10\.$/],
    [["--max-retries", "50"], { maxRetries: 50 }, /^Invalid maxRetries: /],
    [["--max-retries", "2.5"], { maxRetries: 2.5 }, /^Invalid maxRetries: /],
    [["--max-retries", "Infinity"], { maxRetries: Infinity }, /^Invalid maxRetries: /],
    [["--max-retries", "-1"], { maxRetries: -1 }, /^Invalid maxRetries: /],
    [["--timeout", "-5"], { timeoutMs: -5 }, /^Invalid timeoutMs: Expected an integer between 0 and 2147483647\.$/],
    [["--timeout", "NaN"], { timeoutMs: NaN }, /^Invalid timeoutMs: /],
    [["--timeout", "2147483648"], { timeoutMs: 2_147_483_648 }, /^Invalid timeoutMs: /],
    [["--max-response-bytes", "-1"], { maxResponseBytes: -1 }, /^Invalid maxResponseBytes: Expected a non-negative integer\.$/],
    [["--max-response-bytes", "NaN"], { maxResponseBytes: NaN }, /^Invalid maxResponseBytes: /],
    [["--max-response-bytes", "1.5"], { maxResponseBytes: 1.5 }, /^Invalid maxResponseBytes: /],
  ];
  for (const [flags, options, message] of cases) {
    const { cli, lib } = await parity(
      [...flags, "info"],
      (transport) => new FitConnectClient({ transport, ...options }).info(),
      () => jsonResponse({ version: "2.1.0" }),
    );
    assert.equal(cli.code, 1, flags.join(" "));
    assert.equal(cli.requests.length, 0);
    assert.equal(lib.ok, false, JSON.stringify(options));
    assert.equal(lib.error?.name, "FitConnectValidationError");
    assert.match(lib.error?.message ?? "", message);
    assert.equal(lib.requests.length, 0);
  }
});

test("engine limits: 0 and the maximum are accepted by both", async () => {
  const cases: [string[], Record<string, number>][] = [
    [["--max-retries", "0"], { maxRetries: 0 }],
    [["--max-retries", "10"], { maxRetries: 10 }],
    [["--timeout", "0"], { timeoutMs: 0 }],
    [["--timeout", "2147483647"], { timeoutMs: 2_147_483_647 }],
    [["--max-response-bytes", "0"], { maxResponseBytes: 0 }],
  ];
  for (const [flags, options] of cases) {
    const { cli, lib } = await parity(
      [...flags, "info"],
      (transport) => new FitConnectClient({ transport, ...options }).info(),
      () => jsonResponse({ version: "2.1.0" }),
    );
    assert.equal(cli.code, 0, flags.join(" "));
    assert.equal(lib.ok, true, JSON.stringify(options));
    assert.deepEqual(cli.requests, lib.requests);
  }
});

test("base URL: an empty or blank baseUrl is rejected by both, not replaced by production", async () => {
  for (const baseUrl of ["", "  ", "\t"]) {
    const { cli, lib } = await parity(
      ["--base-url", baseUrl, "info"],
      (transport) => new FitConnectClient({ transport, baseUrl }).info(),
      () => jsonResponse({ version: "2.1.0" }),
    );
    assert.equal(cli.code, 1, JSON.stringify(baseUrl));
    assert.equal(cli.requests.length, 0);
    assert.equal(lib.ok, false, JSON.stringify(baseUrl));
    assert.equal(lib.error?.name, "FitConnectValidationError");
    assert.equal(lib.error?.message, "Invalid baseUrl: Expected an absolute http(s) URL.");
    assert.equal(lib.requests.length, 0);
  }
  const ok = await parity(
    ["--base-url", "http://mock.local", "info"],
    (transport) => new FitConnectClient({ transport, baseUrl: "http://mock.local" }).info(),
    () => jsonResponse({ version: "2.1.0" }),
  );
  assert.equal(ok.cli.code, 0);
  assert.deepEqual(ok.cli.requests, ok.lib.requests);
});

test("User-Agent: whitespace with CR/LF or above U+00FF is rejected by both", async () => {
  const cases: [string, RegExp][] = [
    ["\n", /^Invalid userAgent: Value contains control characters\.$/],
    [" \r\n ", /^Invalid userAgent: Value contains control characters\.$/],
    [" ", /^Invalid userAgent: Value contains characters outside Latin-1 \(above U\+00FF\)\.$/],
    ["﻿", /^Invalid userAgent: Value contains characters outside Latin-1/],
    ["　", /^Invalid userAgent: Value contains characters outside Latin-1/],
  ];
  for (const [userAgent, message] of cases) {
    const { cli, lib } = await parity(
      ["--user-agent", userAgent, "info"],
      (transport) => new FitConnectClient({ transport, userAgent }).info(),
      () => jsonResponse({ version: "2.1.0" }),
    );
    assert.equal(cli.code, 1, JSON.stringify(userAgent));
    assert.equal(cli.requests.length, 0);
    assert.equal(lib.ok, false, JSON.stringify(userAgent));
    assert.equal(lib.error?.name, "FitConnectValidationError");
    assert.match(lib.error?.message ?? "", message);
    assert.equal(lib.requests.length, 0);
  }
});

test("User-Agent: a blank value falls back to the default UA in both", async () => {
  for (const userAgent of ["", "   ", " \t ", " "]) {
    const { cli, lib } = await parity(
      ["--user-agent", userAgent, "info"],
      (transport) => new FitConnectClient({ transport, userAgent }).info(),
      () => jsonResponse({ version: "2.1.0" }),
    );
    assert.equal(cli.code, 0, JSON.stringify(userAgent));
    assert.equal(lib.ok, true, JSON.stringify(userAgent));
    assert.deepEqual(cli.requests, lib.requests);
    assert.equal(lib.requests[0]?.headers?.["User-Agent"], "fit-connect-cli");
  }
});
