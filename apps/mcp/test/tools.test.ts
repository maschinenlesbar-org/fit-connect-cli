// This server's tools against a mock of the FIT-Connect Routing API (the client's live area
// answers of 2026-11-19 and the route the OpenAPI spec documents), with the skills' traps as
// cases: each tool answers through the protocol (its structuredContent checked by the SDK against
// its output schema), a place is resolved before its route and named in the source, several whole
// places are ambiguous, no route is the usual empty answer, the briefing has only the sections
// given, the area search pages, and every result names its requests and the provider's terms.
// The rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { serverTransport } from "../src/mcp/api.js";
import { TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { EXAMPLE_KEY, ROUTE, routingApi } from "./helpers.js";

const API = "https://routing-api-prod.fit-connect.fitko.net/v2";

test("four tools: the three use cases, then the area search", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findAuthority", "getServiceBriefing", "findArea", "searchAreas"]);
});

test("findAuthority: a place by name is resolved, then routed; the source names both requests; the terms", async () => {
  const transport = routingApi();
  const connection = await connect({ transport });
  const result = await connection.call("findAuthority", { leikaKey: EXAMPLE_KEY, place: "Hanau" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  const [authority] = content["authorities"] as { name: string; contacts: unknown[]; destinationSignature?: string }[];
  assert.equal(authority?.name, ROUTE.destinationName);
  assert.equal(authority?.destinationSignature, undefined);
  assert.equal(content["source"], `${API}/{areas?areaSearchexpression=Hanau&limit=500,routes?leikaKey=${EXAMPLE_KEY}&areaId=940&limit=500}`);
  assert.deepEqual(transport.calls.map((c) => c.url), [`${API}/areas?areaSearchexpression=Hanau&limit=500`, `${API}/routes?leikaKey=${EXAMPLE_KEY}&areaId=940&limit=500`]);
  assert.match(String(content["licence"]), /^Quelle: FIT-Connect Routingdienst, FITKO.*No open-data licence is declared.*DATA_LICENSE\.md$/);
  await connection.close();
});

test("findAuthority: no route is empty, the usual answer, with the Land's key; several places are ambiguous and ask for no route", async () => {
  const transport = routingApi();
  const connection = await connect({ transport });
  const empty = (await connection.call("findAuthority", { leikaKey: "99050012104000", ags: "06435014" })).structuredContent ?? {};
  assert.equal(empty["status"], "empty");
  assert.match(String(empty["reason"]), /No FIT-Connect Zustellpunkt is registered.*usual answer/);
  assert.deepEqual(empty["broader"], { ags: "06" });
  assert.equal(empty["source"], `${API}/routes?leikaKey=99050012104000&ags=06435014&limit=500`);
  const before = transport.calls.length;
  const ambiguous = (await connection.call("findAuthority", { leikaKey: EXAMPLE_KEY, place: "Halle" })).structuredContent ?? {};
  assert.equal(ambiguous["status"], "ambiguous");
  assert.equal((ambiguous["candidates"] as unknown[]).length, 4);
  assert.equal(transport.calls.length, before + 1, "no route is asked for");
  assert.equal(ambiguous["source"], `${API}/areas?areaSearchexpression=Halle&limit=500`);
  const twoSelectors = await connection.call("findAuthority", { leikaKey: EXAMPLE_KEY, place: "Hanau", areaId: "940" });
  assert.equal(twoSelectors.isError, true);
  assert.match(twoSelectors.content[0]?.text ?? "", /exactly one of place, ags, ars or areaId/);
  await connection.close();
});

test("getServiceBriefing: the sections in English as plain text, the processing range; no route points to the FIM Portal", async () => {
  const connection = await connect({ transport: routingApi() });
  const content = (await connection.call("getServiceBriefing", { leikaKey: EXAMPLE_KEY, areaId: "940", language: "en" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const [briefing] = content["briefings"] as { requiredDocuments: { text: string; language: string }; processing: { text: string } }[];
  assert.deepEqual(briefing?.requiredDocuments, { text: "This is the description of all required documents.", language: "en" });
  assert.equal(briefing?.processing.text, "1–4 weeks");
  assert.equal(content["source"], `${API}/routes?leikaKey=${EXAMPLE_KEY}&areaId=940&limit=500`);
  const none = (await connection.call("getServiceBriefing", { leikaKey: "99050012104000", areaId: "940" })).structuredContent ?? {};
  assert.equal(none["status"], "empty");
  assert.match(String(none["reason"]), /nothing to brief.*FIM Portal/);
  await connection.close();
});

test("findArea: the whole place with its districts counted; short words left out with a note; the source", async () => {
  const connection = await connect({ transport: routingApi() });
  const content = (await connection.call("findArea", { place: "Hanau" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal((content["area"] as { id: string }).id, "940");
  assert.equal((content["districts"] as { count: number }).count, 12);
  assert.equal(content["source"], `${API}/areas?areaSearchexpression=Hanau&limit=500`);
  const short = (await connection.call("findArea", { place: "Halle a" })).structuredContent ?? {};
  assert.equal(short["status"], "ambiguous");
  assert.match((short["notes"] as string[]).join(" "), /Left out "a"/);
  assert.equal(short["source"], `${API}/areas?areaSearchexpression=Halle&limit=500`);
  await connection.close();
});

test("searchAreas: a page with nextOffset; the source is the request", async () => {
  const transport = routingApi();
  const connection = await connect({ transport });
  const content = (await connection.call("searchAreas", { place: "Halle", offset: 40, limit: 5 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal((content["areas"] as unknown[]).length, 5);
  assert.equal(content["nextOffset"], 45);
  assert.equal(content["total"], 50);
  assert.equal(content["source"], `${API}/areas?areaSearchexpression=Halle&offset=40&limit=5`);
  assert.equal(content["source"], transport.last().url);
  await connection.close();
});

test("the server's transport keeps to the API's 5 requests a second", async () => {
  let sent = 0;
  const waits: number[] = [];
  const base = () => {
    sent += 1;
    return Promise.resolve({ status: 200, headers: {}, body: Buffer.from("{}") });
  };
  const transport = serverTransport(base, { now: () => 0, sleep: async (ms) => void waits.push(ms) });
  const request = { method: "GET", url: `${API}/info`, headers: {} };
  for (let i = 0; i < 6; i += 1) await transport(request);
  assert.equal(sent, 6);
  assert.deepEqual(waits, [1000], "the 6th waits for the next second");
});

test("an areaId the input schema allows is one the tools take; the error for one they refuse names no CLI command", async () => {
  const { areaIdProblem } = await import("@maschinenlesbar.org/fit-connect-client/internal/validate");
  const schema = (TOOLS.find((t) => t.name === "findAuthority")?.inputSchema as { properties: Record<string, { pattern: string; maxLength: number }> }).properties["areaId"];
  const pattern = new RegExp(schema?.pattern ?? "");
  for (const id of ["1", "940", "999999999", "2147483647", "9999999999"]) {
    if (pattern.test(id) && id.length <= (schema?.maxLength ?? 0)) assert.equal(areaIdProblem(id), undefined, `the schema takes ${id}, so the tool must`);
  }
  const transport = routingApi();
  const connection = await connect({ transport });
  const refused = await connection.call("findAuthority", { leikaKey: EXAMPLE_KEY, areaId: "9999999999" });
  assert.equal(refused.isError, true);
  assert.doesNotMatch(refused.content[0]?.text ?? "", /fit-connect areas/, "a command the model can't run");
  assert.equal(transport.calls.length, 0);
  await connection.close();
  assert.doesNotMatch(areaIdProblem("0940") ?? "", /fit-connect/);
});

test("--max-pages: findArea and a route lookup by place read on, a page of 500 at a time, up to that many pages; the source names each page", async () => {
  const areas = [{ id: "1", name: "Neuort", type: "Gemeinde" }, ...Array.from({ length: 1199 }, (_, i) => ({ id: String(i + 2), name: `Neuort - OT Teil ${i + 1}`, type: "Gemeindeteil" }))];
  const transport = routingApi({ areas });
  const connection = await connect({ transport });
  const found = (await connection.call("findArea", { place: "Neuort" })).structuredContent ?? {};
  assert.equal(found["status"], "ok");
  assert.equal((found["districts"] as { count: number }).count, 1199, "every district counted, not those of the first page");
  assert.equal(found["complete"], true);
  const pages = [`${API}/areas?areaSearchexpression=Neuort&limit=500`, `${API}/areas?areaSearchexpression=Neuort&offset=500&limit=500`, `${API}/areas?areaSearchexpression=Neuort&offset=1000&limit=500`];
  assert.deepEqual(transport.calls.map((c) => c.url), pages);
  assert.equal(found["source"], `${API}/{${pages.map((p) => p.slice(API.length + 1)).join(",")}}`);
  const routed = (await connection.call("findAuthority", { leikaKey: EXAMPLE_KEY, place: "Neuort" })).structuredContent ?? {};
  assert.equal(routed["source"], `${API}/{${pages.map((p) => p.slice(API.length + 1)).join(",")},routes?leikaKey=${EXAMPLE_KEY}&areaId=1&limit=500}`);
  await connection.close();

  const one = routingApi({ areas });
  const narrow = await connect({ transport: one, config: { maxPages: 1 } });
  const first = (await narrow.call("findArea", { place: "Neuort" })).structuredContent ?? {};
  assert.equal(one.calls.length, 1);
  assert.equal(first["complete"], false);
  assert.equal(first["source"], `${API}/areas?areaSearchexpression=Neuort&limit=500`);
  await narrow.close();
});

test("--max-pages: route pages are read on too, and the source names each", async () => {
  const route = (i: number) => ({ destinationId: `d${i}`, destinationSignature: "s" });
  const transport = routingApi({ routes: { [`${EXAMPLE_KEY} areaId=940`]: Array.from({ length: 600 }, (_, i) => route(i)) } });
  const connection = await connect({ transport });
  const content = (await connection.call("findAuthority", { leikaKey: EXAMPLE_KEY, areaId: "940" })).structuredContent ?? {};
  assert.equal((content["authorities"] as unknown[]).length, 600);
  assert.equal(content["source"], `${API}/{routes?leikaKey=${EXAMPLE_KEY}&areaId=940&limit=500,routes?leikaKey=${EXAMPLE_KEY}&areaId=940&offset=500&limit=500}`);
  await connection.close();
});

test("findArea München: no district of Bad Berka counted as München's; they come apart in otherDistricts, within the output schema", async () => {
  const connection = await connect({ transport: routingApi() });
  const result = await connection.call("findArea", { place: "München" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal((content["districts"] as { count: number }).count, 0);
  assert.deepEqual((content["otherDistricts"] as { listed: { partOf: string }[] }).listed.map((d) => d.partOf), ["Bad Berka", "Uebigau-Wahrenbrück"]);
  await connection.close();
});

test("the deadline's and the size cap's advice fit every tool: each option they name comes with the tools that take it", async () => {
  const { DEADLINE_HINT, SIZE_HINT } = await import("../src/mcp/tools.js");
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  for (const text of [DEADLINE_HINT, SIZE_HINT]) {
    const pairs = [...text.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
    assert.ok(pairs.length >= 2, text);
    for (const [, options, tools] of pairs) {
      for (const tool of (tools as string).split(", ")) {
        assert.ok(schemas.has(tool), `no tool ${tool}: ${text}`);
        for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${text}`);
      }
    }
    const named = new Set(pairs.flatMap(([, options]) => (options as string).split(" or ")));
    for (const option of ["offset", "limit", "areaId", "allDistricts", "place"]) {
      assert.ok(!new RegExp(`\\b${option}\\b`).test(text) || named.has(option), `${option} named without its tools: ${text}`);
    }
  }
});
