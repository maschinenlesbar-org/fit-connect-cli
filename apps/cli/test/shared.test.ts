import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidArgumentError } from "commander";
import {
  parseAgs,
  parseApiVersion,
  parseArs,
  parseIntArg,
  parseLimit,
  renderJson,
  toClientOptions,
} from "../src/cli/shared.js";
import type { CliDeps } from "../src/cli/io.js";

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

test("parseAgs accepts 2, 3, 5 and 8 digits and trims surrounding whitespace", () => {
  assert.equal(parseAgs("11000000"), "11000000");
  assert.equal(parseAgs("16"), "16");
  assert.equal(parseAgs("064"), "064");
  assert.equal(parseAgs("06435"), "06435");
  assert.equal(parseAgs("  16051000  "), "16051000");
});

test("parseAgs rejects wrong length, non-digits and whitespace-only", () => {
  assert.throws(() => parseAgs("1"), InvalidArgumentError); // 1 digit
  assert.throws(() => parseAgs("1234"), InvalidArgumentError); // 4 digits
  assert.throws(() => parseAgs("1234567"), InvalidArgumentError); // 7 digits
  assert.throws(() => parseAgs("123456789"), InvalidArgumentError); // 9 digits
  assert.throws(() => parseAgs("1100000a"), InvalidArgumentError);
  assert.throws(() => parseAgs("   "), InvalidArgumentError);
});

test("parseArs accepts 2, 3, 5, 9 and 12 digits and trims; rejects other lengths", () => {
  assert.equal(parseArs("064350014014"), "064350014014");
  assert.equal(parseArs("16"), "16");
  assert.equal(parseArs("064"), "064");
  assert.equal(parseArs("06435"), "06435");
  assert.equal(parseArs("064350014"), "064350014");
  assert.throws(() => parseArs("1234567890"), InvalidArgumentError); // 10 digits
  assert.throws(() => parseArs("   "), InvalidArgumentError);
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

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise (K4)", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const out: string[] = [];
  const deps = { io: { out: (s: string) => out.push(s), err: () => {} }, createClient: () => { throw new Error("unused"); } } as unknown as CliDeps;
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Halle"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7, Bug 6)", (t) => {
  const deps = { io: { out: () => {}, err: () => {} }, createClient: () => { throw new Error("unused"); } } as unknown as CliDeps;
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7, Bug 5)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const out: string[] = [];
  const deps = { io: { out: (s: string) => out.push(s), err: () => {} }, createClient: () => { throw new Error("unused"); } } as unknown as CliDeps;
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});
