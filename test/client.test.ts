import { test } from "node:test";
import assert from "node:assert/strict";
import { FitConnectClient, areaSearchWords } from "../src/client/client.js";
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

test("areas() splits a quoted multi-word term into separate expressions", async () => {
  const mt = constantJson({ count: 0, offset: 0, totalCount: 0, areas: [] });
  await clientWith(mt).areas({ search: "Frankfurt am Main" });
  assert.deepEqual(
    new URL(mt.last().url).searchParams.getAll("areaSearchexpression"),
    ["Frankfurt", "am", "Main"],
  );
});

test("areas() splits on punctuation the API can't parse, keeping letters, digits and *", async () => {
  const mt = constantJson({ count: 0, offset: 0, totalCount: 0, areas: [] });
  const sent = async (search: string | string[]) => {
    await clientWith(mt).areas({ search });
    return new URL(mt.last().url).searchParams.getAll("areaSearchexpression");
  };
  assert.deepEqual(await sent("Halle (Westf.)"), ["Halle", "Westf"]);
  assert.deepEqual(await sent("Baden-Baden"), ["Baden"]); // a repeated word is sent once
  assert.deepEqual(await sent(["Mülheim an der Ruhr", "Mag*", "33790"]), ["Mülheim", "an", "der", "Ruhr", "Mag*", "33790"]);
});

test("routes() trims selectors and never sends a blank one", async () => {
  const mt = constantJson({ count: 0, offset: 0, totalCount: 0, routes: [] });
  await clientWith(mt).routes({ leikaKey: "99123456760610", ags: "12345678", ars: "" });
  let url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("ags"), "12345678");
  assert.equal(url.searchParams.has("ars"), false);
  await clientWith(mt).routes({ leikaKey: "99123456760610", areaId: " 940 ", ags: "  " });
  url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("areaId"), "940");
  assert.equal(url.searchParams.has("ags"), false);
});

test("routes() and areas() validate ags/ars and offset/limit before any request", async () => {
  const mt = constantJson({});
  const c = clientWith(mt);
  const cases: [() => Promise<unknown>, RegExp][] = [
    [() => c.routes({ leikaKey: "99123456760610", ags: "1" }), /^Invalid ags "1": expected 2, 3, 5 or 8 digits\.$/],
    [() => c.routes({ leikaKey: "99123456760610", ars: "1234567890" }), /^Invalid ars "1234567890"/],
    [() => c.routes({ leikaKey: "99123456760610", ags: "16", offset: -1 }), /^Invalid offset: expected an integer from 0 to 2147483647, got -1\.$/],
    [() => c.routes({ leikaKey: "99123456760610", ags: "16", limit: NaN }), /^Invalid limit: expected an integer from 1 to 500, got NaN\.$/],
    [() => c.areas({ search: "Köln", limit: 0 }), /^Invalid limit: expected an integer from 1 to 500, got 0\.$/],
    [() => c.areas({ search: "Köln", offset: 2147483648 }), /^Invalid offset/],
    [() => c.areas({ search: "Köln", offset: 1.5 }), /^Invalid offset/],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call, (err: unknown) => err instanceof FitConnectError && message.test(err.message));
  }
  assert.equal(mt.calls.length, 0);
  await c.routes({ leikaKey: "99123456760610", ars: "06435", offset: 0, limit: 500 });
  assert.equal(mt.calls.length, 1);
});

test("areaSearchWords() drops one-letter words and duplicates, as the API rejects them", () => {
  assert.deepEqual(areaSearchWords("Frankfurt a. M."), { words: ["Frankfurt"], dropped: ["a", "M"] });
  assert.deepEqual(areaSearchWords("Horschbach - OT Elzweiler Straße 1"), {
    words: ["Horschbach", "OT", "Elzweiler", "Straße"],
    dropped: ["1"],
  });
  assert.deepEqual(areaSearchWords(["OT Sarrod", "ot Rabenstein", "a*"]), {
    words: ["OT", "Sarrod", "Rabenstein"],
    dropped: ["a*"],
  });
  assert.deepEqual(areaSearchWords(["Mag*", "*burg", "*ab*", "ab*cd"]).words, ["Mag*", "*burg", "*ab*", "ab*cd"]);
});

test("areaSearchWords() normalises to NFKC (decomposed umlauts, fullwidth digits)", () => {
  assert.deepEqual(areaSearchWords("Ko\u0308ln").words, ["K\u00f6ln"]);
  assert.deepEqual(areaSearchWords("\uff16\uff10\uff13\uff11\uff11").words, ["60311"]);
  assert.deepEqual(areaSearchWords(["Mu\u0308nchen", "M\u00fcnchen"]).words, ["M\u00fcnchen"]);
});

test("areaSearchWords() rejects what the API would reject: no usable word, > 10 words, a split wildcard", () => {
  assert.throws(() => areaSearchWords("*"), /No usable search word in "\*": every word needs at least 2/);
  assert.throws(() => areaSearchWords(["a", "M"]), /No usable search word/);
  assert.throws(
    () =>
      areaSearchWords(
        "Steinau an der Straße, Brüder-Grimm-Stadt - OT Sarrod - OT Rabenstein (ehemaliger Wohnplatz)",
      ),
    /Too many search words \(12\): the API accepts at most 10/,
  );
  assert.equal(areaSearchWords("a1 b2 c3 d4 e5 f6 g7 h8 i9 j0").words.length, 10);
  assert.throws(() => areaSearchWords("a*bc"), /Invalid search word "a\*bc"/);
  assert.throws(() => areaSearchWords("**ab"), /Invalid search word/);
});

test("areas() sends only the usable words and never a request for an unusable search", async () => {
  const mt = constantJson({ count: 0, offset: 0, totalCount: 0, areas: [] });
  await clientWith(mt).areas({ search: "Frankfurt a. M." });
  assert.deepEqual(new URL(mt.last().url).searchParams.getAll("areaSearchexpression"), ["Frankfurt"]);
  const calls = mt.calls.length;
  for (const search of ["*", "a b c d e f g h i j k l", "ab cd ef gh ij kl mn op qr st uv"]) {
    await assert.rejects(() => clientWith(mt).areas({ search }), FitConnectError);
  }
  assert.equal(mt.calls.length, calls);
});

test("areas() rejects a punctuation-only search before any request", async () => {
  const mt = constantJson({});
  await assert.rejects(() => clientWith(mt).areas({ search: ["(.)", " - "] }), FitConnectError);
  assert.equal(mt.calls.length, 0);
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
