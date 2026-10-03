import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, nonBlankProblem, type Problem } from "../src/client/validate.js";
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
