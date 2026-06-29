import { test } from "node:test";
import assert from "node:assert/strict";
import { FitConnectClient } from "../src/client/client.js";
import { FitConnectApiError, FitConnectError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(
  mt: ReturnType<typeof makeMockTransport>,
  apiVersion?: "v1" | "v2",
): FitConnectClient {
  return new FitConnectClient(apiVersion ? { transport: mt.transport, apiVersion } : { transport: mt.transport });
}

test("routes() builds /v2/routes with leikaKey + the single area selector", async () => {
  const mt = constantJson({ count: 1, offset: 0, totalCount: 1, routes: [{ destinationId: "d", destinationSignature: "s" }] });
  const res = await clientWith(mt).routes({ leikaKey: "99123456760610", ars: "064350014014" });
  assert.equal(res.count, 1);
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, "/v2/routes");
  assert.equal(url.searchParams.get("leikaKey"), "99123456760610");
  assert.equal(url.searchParams.get("ars"), "064350014014");
  assert.equal(url.searchParams.get("ags"), null);
  assert.equal(url.searchParams.get("areaId"), null);
});

test("routes() honours the v1 version prefix", async () => {
  const mt = constantJson({ count: 0, offset: 0, totalCount: 0, routes: [] });
  await clientWith(mt, "v1").routes({ leikaKey: "99123456760610", ags: "16051000" });
  assert.equal(new URL(mt.last().url).pathname, "/v1/routes");
});

test("routes() passes offset and limit through", async () => {
  const mt = constantJson({ count: 0, offset: 5, totalCount: 0, routes: [] });
  await clientWith(mt).routes({ leikaKey: "99123456760610", areaId: "1024", offset: 5, limit: 10 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("areaId"), "1024");
  assert.equal(url.searchParams.get("offset"), "5");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("routes() rejects an empty leikaKey before any request", async () => {
  const mt = constantJson({});
  await assert.rejects(
    () => clientWith(mt).routes({ leikaKey: "  ", ars: "064350014014" }),
    FitConnectError,
  );
  assert.equal(mt.calls.length, 0);
});

test("routes() requires exactly one area selector — none is an error", async () => {
  const mt = constantJson({});
  await assert.rejects(
    () => clientWith(mt).routes({ leikaKey: "99123456760610" }),
    (err) => err instanceof FitConnectError && /exactly one area selector/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("routes() requires exactly one area selector — two is an error", async () => {
  const mt = constantJson({});
  await assert.rejects(
    () => clientWith(mt).routes({ leikaKey: "99123456760610", ags: "16051000", ars: "064350014014" }),
    (err) => err instanceof FitConnectError && /exactly one area selector/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("areas() builds /v2/areas with repeated areaSearchexpression terms", async () => {
  const mt = constantJson({ count: 1, offset: 0, totalCount: 1, areas: [{ id: "1024", name: "Halle (Saale)", type: "Kreisfreie Stadt" }] });
  await clientWith(mt).areas({ search: ["Halle", "Magdeburg"] });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, "/v2/areas");
  assert.deepEqual(url.searchParams.getAll("areaSearchexpression"), ["Halle", "Magdeburg"]);
});

test("areas() accepts a single string and trims/drops blanks", async () => {
  const mt = constantJson({ count: 0, offset: 0, totalCount: 0, areas: [] });
  await clientWith(mt).areas({ search: ["  Hanau  ", "", "  "] });
  assert.deepEqual(new URL(mt.last().url).searchParams.getAll("areaSearchexpression"), ["Hanau"]);
});

test("areas() rejects an all-blank search before any request", async () => {
  const mt = constantJson({});
  await assert.rejects(() => clientWith(mt).areas({ search: ["", "  "] }), FitConnectError);
  assert.equal(mt.calls.length, 0);
});

test("info() builds /v2/info", async () => {
  const mt = constantJson({ version: { major: 2, minor: 0, patch: 0 } });
  const info = await clientWith(mt).info();
  assert.deepEqual(info.version, { major: 2, minor: 0, patch: 0 });
  assert.equal(new URL(mt.last().url).pathname, "/v2/info");
});

test("an invalid apiVersion throws on construction", () => {
  assert.throws(
    () => new FitConnectClient({ apiVersion: "v3" as unknown as "v2" }),
    FitConnectError,
  );
});

test("a 400 from the API raises FitConnectApiError with status 400", async () => {
  const mt = makeMockTransport(() => jsonResponse({ title: "Bad Request" }, 400));
  await assert.rejects(
    () => clientWith(mt).routes({ leikaKey: "99123456760610", ars: "064350014014" }),
    (err) => err instanceof FitConnectApiError && err.status === 400,
  );
});
