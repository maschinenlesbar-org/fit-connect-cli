import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  headerValueProblem,
  intRangeProblem,
  nonBlankProblem,
  type Problem,
} from "../src/client/validate.js";
import { resolveUserAgent } from "../src/client/engine.js";
import { FitConnectError, FitConnectValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { FitConnectClient } from "../src/client/client.js";
import { jsonResponse, parity } from "./helpers.js";

const nonEmpty: Problem = (value) => (value.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("name", "x", nonEmpty), "x");
});

test("assertValid throws FitConnectValidationError with 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("areaId", " ", nonEmpty),
    (err: unknown) =>
      err instanceof FitConnectValidationError &&
      err instanceof FitConnectError &&
      err.name === "FitConnectValidationError" &&
      err.message === "Invalid areaId: Expected a non-empty value.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (value: string): Promise<string> => assertValid("q", value, nonEmpty);
  const pending = method("");
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, FitConnectValidationError);
});

test("the library root exports the validation layer", () => {
  assert.equal(library.FitConnectValidationError, FitConnectValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("parity() runs one input through run() and the library on recording transports", async () => {
  const { cli, lib } = await parity(
    ["--compact", "info"],
    (transport) => new FitConnectClient({ transport }).info(),
    () => jsonResponse({ version: "2.1.0" }),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, '{"version":"2.1.0"}');
  assert.deepEqual(lib, { ok: true, value: { version: "2.1.0" }, requests: lib.requests });
  assert.deepEqual(
    cli.requests.map((r) => r.url),
    lib.requests.map((r) => r.url),
  );

  const failing = await parity(["info"], () => {
    throw new FitConnectValidationError("Invalid x: y");
  });
  assert.deepEqual(failing.lib, {
    ok: false,
    error: { name: "FitConnectValidationError", message: "Invalid x: y" },
    requests: [],
  });
});

test("nonBlankProblem rejects an empty or whitespace-only value", () => {
  assert.equal(nonBlankProblem("x"), undefined);
  assert.equal(nonBlankProblem(" 940 "), undefined);
  for (const blank of ["", " ", "\t", "\n "]) assert.equal(nonBlankProblem(blank), "Value must not be blank.");
});

test("intRangeProblem accepts safe integers in min..max only", () => {
  const retries = intRangeProblem(0, 10);
  assert.equal(retries(0), undefined);
  assert.equal(retries(10), undefined);
  for (const bad of [-1, 11, 2.5, NaN, Infinity, -Infinity]) {
    assert.equal(retries(bad), "Expected an integer between 0 and 10.");
  }
  const bytes = intRangeProblem(0, Number.MAX_SAFE_INTEGER);
  assert.equal(bytes(Number.MAX_SAFE_INTEGER), undefined);
  assert.equal(bytes(-1), "Expected a non-negative integer.");
  assert.equal(bytes(Number.MAX_SAFE_INTEGER + 2), "Expected a non-negative integer.");
});

test("headerValueProblem names control characters and code units above U+00FF", () => {
  assert.equal(headerValueProblem("my-tool/2.0"), undefined);
  assert.equal(headerValueProblem("a\tb-ü"), undefined);
  assert.equal(headerValueProblem(""), undefined);
  for (const bad of ["\n", "a\r\nb", "a\u0000b", "a\u007fb"]) {
    assert.equal(headerValueProblem(bad), "Value contains control characters.", JSON.stringify(bad));
  }
  for (const bad of [" ", "﻿", "Mozilla €"]) {
    assert.equal(headerValueProblem(bad), "Value contains characters outside Latin-1 (above U+00FF).", JSON.stringify(bad));
  }
});

test("resolveUserAgent checks the raw value first, then lets a blank one fall back", () => {
  assert.equal(resolveUserAgent(undefined), "fit-connect-cli");
  assert.equal(resolveUserAgent(""), "fit-connect-cli");
  assert.equal(resolveUserAgent(" \t "), "fit-connect-cli");
  assert.equal(resolveUserAgent("my-tool/2.0"), "my-tool/2.0");
  for (const bad of ["\n", " \r\n ", "　"]) {
    assert.throws(() => resolveUserAgent(bad), FitConnectValidationError, JSON.stringify(bad));
  }
  assert.equal(library.resolveUserAgent, resolveUserAgent);
  assert.equal(library.headerValueProblem, headerValueProblem);
});
