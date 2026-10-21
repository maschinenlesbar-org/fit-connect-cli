import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  headerValueProblem,
  intRangeProblem,
  nonBlankProblem,
  normalizeToken,
  textProblem,
  tokenProblem,
  type Problem,
} from "@maschinenlesbar.org/fit-connect-client/internal/validate";
import { resolveUserAgent } from "@maschinenlesbar.org/fit-connect-client/internal/engine";
import { FitConnectError, FitConnectValidationError } from "@maschinenlesbar.org/fit-connect-client/internal/errors";
import * as library from "../src/index.js";
import { FitConnectClient } from "@maschinenlesbar.org/fit-connect-client/internal/client";
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
    () => jsonResponse({ version: { major: 2, minor: 1, patch: 0 } }),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, '{"version":{"major":2,"minor":1,"patch":0}}');
  assert.deepEqual(lib, { ok: true, value: { version: { major: 2, minor: 1, patch: 0 } }, requests: lib.requests });
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

test("tokenProblem refuses blank, invisible, control and half characters, quoting the value visibly; normalizeToken trims and composes (D8)", () => {
  assert.equal(tokenProblem(" 940 "), undefined);
  assert.equal(normalizeToken(" 940 "), "940");
  assert.equal(normalizeToken("e\u0301"), "\u00e9");
  for (const blank of ["", " ", "\u200b", "\u0301\u0308", " \u200b "]) assert.equal(tokenProblem(blank), "Value must not be blank.", JSON.stringify(blank));
  assert.equal(tokenProblem("94\u200b0"), '"94\\u200b0" contains an invisible or control character (U+200B).');
  assert.equal(tokenProblem("94\u00ad0"), '"94\\u00ad0" contains an invisible or control character (U+00AD).');
  assert.equal(tokenProblem("9\u00004"), '"9\\u00004" contains an invisible or control character (U+0000).');
  assert.equal(tokenProblem("94\ud800"), '"94\\ud800" contains half of a character (a lone surrogate).');
});

test("textProblem (the area search) refuses invisible and control characters, ZWJ/ZWNJ included, and half characters (D8, Bug 1)", () => {
  assert.equal(textProblem("Frankfurt am Main"), undefined);
  assert.equal(textProblem("Bad\tOeynhausen\n"), undefined);
  assert.equal(textProblem("\u200b"), "Value must not be blank.");
  for (const [ch, code] of [["\u00ad", "00AD"], ["\u200b", "200B"], ["\u200d", "200D"], ["\u200c", "200C"], ["\ufeff", "FEFF"]] as const) {
    assert.equal(textProblem(`Frank${ch}furt`), `"Frank\\u${code.toLowerCase()}furt" contains an invisible character (U+${code}).`);
  }
  assert.equal(textProblem("a\u001bb"), '"a\\u001bb" contains a control character (U+001B).');
  assert.equal(textProblem("a\u0085b"), '"a\\u0085b" contains a control character (U+0085).');
  assert.equal(textProblem("x\ud83d"), '"x\\ud83d" contains half of a character (a lone surrogate).');
});
