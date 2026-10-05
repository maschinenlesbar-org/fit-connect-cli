// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { FitConnectClient as Client } from "../src/client/client.js";
import {
  FitConnectError as BaseError,
  FitConnectParseError as ParseError,
  FitConnectValidationError as ValidationError,
} from "../src/client/errors.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.areas({ search: "Halle" });
const textBody = (text: string): unknown => ({ count: 1, offset: 0, totalCount: 1, areas: [{ id: "1", name: text, type: "Stadt" }] });
const readText = (result: unknown): string => (result as { areas: Array<{ name: string }> }).areas[0]!.name;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). `{…, areas: []}` is not one: it means "nothing found". */
const malformedBodies: unknown[] = [
  null,
  {},
  "text",
  42,
  [1, 2, 3],
  { error: "boom" },
  { detail: "Not available" },
  { count: 0, offset: 0, totalCount: 0 },
  { count: "1", offset: 0, totalCount: 1, areas: [] },
  { count: 1, offset: 0, totalCount: 1, areas: [null] },
  { count: 1, offset: 0, totalCount: 1, areas: {} },
];
/** Library calls with wrong-typed or out-of-range input. */
const LEIKA = "99123456760610";
const badCalls: Array<[string, () => unknown]> = [
  ["routes()", () => (new Client().routes as (p?: unknown) => unknown)()],
  ["routes(null)", () => new Client().routes(null as never)],
  ["routes bad leikaKey", () => new Client().routes({ leikaKey: "12345", ars: "16" })],
  ["routes blank leikaKey", () => new Client().routes({ leikaKey: " ", ars: "16" })],
  ["routes no selector", () => new Client().routes({ leikaKey: LEIKA })],
  ["routes two selectors", () => new Client().routes({ leikaKey: LEIKA, ars: "16", ags: "16" })],
  ["routes ags length", () => new Client().routes({ leikaKey: LEIKA, ags: "1" })],
  ["routes ars length", () => new Client().routes({ leikaKey: LEIKA, ars: "1234" })],
  ["routes offset -1", () => new Client().routes({ leikaKey: LEIKA, ars: "16", offset: -1 })],
  ["areas()", () => (new Client().areas as (p?: unknown) => unknown)()],
  ["areas no usable word", () => new Client().areas({ search: "a" })],
  ["areas misplaced wildcard", () => new Client().areas({ search: "Ma*g" })],
  ["areas 11 words", () => new Client().areas({ search: "aa bb cc dd ee ff gg hh ii jj kk" })],
  ["areas limit 0", () => new Client().areas({ search: "Hanau", limit: 0 })],
  ["apiVersion: 'v3'", () => new Client({ apiVersion: "v3" as never })],
  ["apiVersion: 2", () => new Client({ apiVersion: 2 as never })],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["retryDelayMs: 3e9", () => new Client({ retryDelayMs: 3_000_000_000 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as unknown as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as unknown as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
