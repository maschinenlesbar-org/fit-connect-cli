// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
// fit-connect has no filter language: its "filters" are the parameters of routes() — the
// area selectors and paging. The filter-name cases don't apply (empty lists below).
import { run } from "../src/cli/run.js";
import { FitConnectClient as Client } from "../src/client/client.js";
import { FitConnectValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.routes(query as never);
const LEIKA = "99123456760610";
/** A valid query, and what it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { leikaKey: LEIKA, ars: "16" } };
const GOOD_SENT = `?leikaKey=${LEIKA}&ars=16`;
/** What a data request carries (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => new URL(req.url).search;
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { leikaKey: LEIKA, ars: "16", gemeinde: "Erfurt" }],
  ["misspelled key", { leikaKey: LEIKA, ars: "16", areaid: "940" }],
  ["wrong-case key", { leikaKey: LEIKA, ARS: "16" }],
  ["__proto__ key", JSON.parse(`{"leikaKey": "${LEIKA}", "ars": "16", "__proto__": {"areaId": "940"}}`) as Record<string, unknown>],
];
/** Queries whose filter names the API doesn't have: none here (no filter language). */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["number selector next to a string one", { leikaKey: LEIKA, ars: "16", areaId: 940 }],
  ["number selector alone", { leikaKey: LEIKA, ags: 16051000 }],
  ["array selector", { leikaKey: LEIKA, ars: ["16", "06"] }],
  ["object selector", { leikaKey: LEIKA, areaId: { id: "940" } }],
  ["number leikaKey", { leikaKey: 99123456760610, ars: "16" }],
  ["NaN offset", { leikaKey: LEIKA, ars: "16", offset: Number.NaN }],
  ["string limit", { leikaKey: LEIKA, ars: "16", limit: "50" }],
  ["array limit", { leikaKey: LEIKA, ars: "16", limit: [1, 2] }],
];
/** Spelling variants of a filter name: none here (no filter language). */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [];
const UNNORMALISED_POLICY = "reject" as "normalise" | "reject";
/** A selector flag given twice, and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["routes", LEIKA, "--area-id", "940", "--area-id", "941"];
const REPEATED_POLICY = "reject" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["routes", LEIKA, "--ars", "16", "--limit", "1", "--limit", "2"];
const USAGE_EXIT = 1; // fit-connect's usage errors exit 1 (commander's default)
/** True for a request that fetches data (every request here). */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ count: 0, offset: 0, totalCount: 0, routes: [] })),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
