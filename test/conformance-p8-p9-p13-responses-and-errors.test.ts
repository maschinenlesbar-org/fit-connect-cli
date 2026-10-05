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
