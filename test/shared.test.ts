import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidArgumentError } from "commander";
import {
  parseAgs,
  parseApiVersion,
  parseArs,
  parseIntArg,
  parseLimit,
  toClientOptions,
} from "../src/cli/shared.js";

test("parseIntArg accepts plain non-negative decimal integers", () => {
  assert.equal(parseIntArg("0"), 0);
  assert.equal(parseIntArg("42"), 42);
  assert.equal(parseIntArg("1000"), 1000);
});

test("parseIntArg rejects the empty string", () => {
  assert.throws(() => parseIntArg(""), InvalidArgumentError);
});

test("parseIntArg rejects surrounding whitespace", () => {
  assert.throws(() => parseIntArg(" 5"), InvalidArgumentError);
  assert.throws(() => parseIntArg("5 "), InvalidArgumentError);
  assert.throws(() => parseIntArg("\t5"), InvalidArgumentError);
});

test("parseIntArg rejects hex and binary forms", () => {
  assert.throws(() => parseIntArg("0x10"), InvalidArgumentError);
  assert.throws(() => parseIntArg("0b1"), InvalidArgumentError);
});

test("parseIntArg rejects exponent and float forms", () => {
  assert.throws(() => parseIntArg("1e3"), InvalidArgumentError);
  assert.throws(() => parseIntArg("1.5"), InvalidArgumentError);
});

test("parseIntArg rejects negatives and non-numbers", () => {
  assert.throws(() => parseIntArg("-5"), InvalidArgumentError);
  assert.throws(() => parseIntArg("abc"), InvalidArgumentError);
  assert.throws(() => parseIntArg("+5"), InvalidArgumentError);
});

test("parseIntArg rejects integers beyond the safe range", () => {
  assert.throws(() => parseIntArg("99999999999999999999"), InvalidArgumentError);
});

test("parseIntArg rejects leading-zero forms but accepts a bare 0", () => {
  assert.equal(parseIntArg("0"), 0);
  assert.throws(() => parseIntArg("00"), InvalidArgumentError);
  assert.throws(() => parseIntArg("007"), InvalidArgumentError);
  assert.throws(() => parseIntArg("0123"), InvalidArgumentError);
});

test("parseLimit accepts the 1..500 bounds inclusive", () => {
  assert.equal(parseLimit("1"), 1);
  assert.equal(parseLimit("100"), 100);
  assert.equal(parseLimit("500"), 500);
});

test("parseLimit rejects out-of-range values (0, 501)", () => {
  assert.throws(() => parseLimit("0"), InvalidArgumentError);
  assert.throws(() => parseLimit("501"), InvalidArgumentError);
  assert.throws(() => parseLimit("99999"), InvalidArgumentError);
});

test("parseAgs accepts 8 digits and trims surrounding whitespace", () => {
  assert.equal(parseAgs("11000000"), "11000000");
  assert.equal(parseAgs("  16051000  "), "16051000");
});

test("parseAgs rejects wrong length, non-digits and whitespace-only", () => {
  assert.throws(() => parseAgs("1234567"), InvalidArgumentError); // 7 digits
  assert.throws(() => parseAgs("123456789"), InvalidArgumentError); // 9 digits
  assert.throws(() => parseAgs("1100000a"), InvalidArgumentError);
  assert.throws(() => parseAgs("   "), InvalidArgumentError);
});

test("parseArs accepts 12 digits and trims; rejects wrong length", () => {
  assert.equal(parseArs("064350014014"), "064350014014");
  assert.equal(parseArs(" 160510000000 "), "160510000000");
  assert.throws(() => parseArs("16051000"), InvalidArgumentError); // 8 digits
  assert.throws(() => parseArs("abcdefghijkl"), InvalidArgumentError);
});

test("parseApiVersion accepts v1 and v2", () => {
  assert.equal(parseApiVersion("v1"), "v1");
  assert.equal(parseApiVersion("v2"), "v2");
});

test("parseApiVersion rejects anything else", () => {
  assert.throws(() => parseApiVersion("v3"), InvalidArgumentError);
  assert.throws(() => parseApiVersion("2"), InvalidArgumentError);
  assert.throws(() => parseApiVersion(""), InvalidArgumentError);
});

test("toClientOptions maps only the options that are present", () => {
  assert.deepEqual(toClientOptions({}), {});
  assert.deepEqual(
    toClientOptions({
      baseUrl: "https://example.test",
      timeout: 1000,
      userAgent: "ua/1",
      maxRetries: 3,
      maxResponseBytes: 2048,
      apiVersion: "v1",
      compact: true,
    }),
    {
      baseUrl: "https://example.test",
      timeoutMs: 1000,
      userAgent: "ua/1",
      maxRetries: 3,
      maxResponseBytes: 2048,
      apiVersion: "v1",
    },
  );
});

test("toClientOptions preserves an explicit zero", () => {
  assert.deepEqual(toClientOptions({ timeout: 0, maxResponseBytes: 0 }), {
    timeoutMs: 0,
    maxResponseBytes: 0,
  });
});
