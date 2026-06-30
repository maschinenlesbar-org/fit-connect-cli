import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { FitConnectClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { FitConnectClientOptions } from "../src/client/client.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { FitConnectNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new FitConnectClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

const ROUTE_BODY = {
  count: 1,
  offset: 0,
  totalCount: 1,
  routes: [{ destinationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", destinationSignature: "a.b.c", destinationName: "Amt" }],
};
const AREA_BODY = {
  count: 1,
  offset: 0,
  totalCount: 1,
  areas: [{ id: "1024", name: "Halle (Saale)", type: "Kreisfreie Stadt" }],
};

test("routes hits /v2/routes and prints the result", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(["routes", "99123456760610", "--ars", "064350014014"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), ROUTE_BODY);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, "/v2/routes");
  assert.equal(url.searchParams.get("leikaKey"), "99123456760610");
  assert.equal(url.searchParams.get("ars"), "064350014014");
});

test("routes without an area selector is an error (exit 1, no request)", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(["routes", "99123456760610"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /exactly one area selector/);
});

test("areas passes every search term as a repeated query param", async () => {
  const cli = makeCli(() => jsonResponse(AREA_BODY));
  const code = await run(["areas", "Halle", "Magdeburg"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, "/v2/areas");
  assert.deepEqual(url.searchParams.getAll("areaSearchexpression"), ["Halle", "Magdeburg"]);
});

test("--api-version v1 switches the path prefix", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  await run(["--api-version", "v1", "routes", "99123456760610", "--ags", "16051000"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, "/v1/routes");
});

test("info hits /v2/info", async () => {
  const cli = makeCli(() => jsonResponse({ version: { major: 2, minor: 0, patch: 0 } }));
  const code = await run(["info"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/v2/info");
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(AREA_BODY));
  await run(["--compact", "areas", "Halle"], cli.deps);
  assert.equal(cli.out.join("\n"), JSON.stringify(AREA_BODY));
});

test("a 400 from the API maps to exit code 1", async () => {
  const cli = makeCli(() => jsonResponse({ title: "Bad Request", detail: "bad leikaKey" }, 400));
  const code = await run(["routes", "99123456760610", "--ars", "064350014014"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: HTTP 400/);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({ title: "Not Found" }, 404));
  const code = await run(["routes", "99123456760610", "--ars", "064350014014"], cli.deps);
  assert.equal(code, 4);
});

test("an unknown command is a usage error (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("a network error maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new FitConnectNetworkError("connect ECONNREFUSED");
  });
  const code = await run(["info"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: connect ECONNREFUSED/);
});

test("a parse error (non-JSON body) maps to exit code 1", async () => {
  const cli = makeCli(() => rawResponse("<html>not json</html>", "text/html"));
  const code = await run(["info"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: Failed to parse JSON/);
});

test("an unexpected (non-FitConnect) error maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new Error("kaboom");
  });
  const code = await run(["info"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Unexpected error: kaboom/);
});

test("--help exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--help"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--version exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("an out-of-range --limit is rejected client-side (non-zero, no request)", async () => {
  for (const bad of ["0", "501"]) {
    const cli = makeCli(() => jsonResponse(AREA_BODY));
    const code = await run(["areas", "Halle", "--limit", bad], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0, `--limit ${bad} should not hit the network`);
    assert.match(cli.err.join("\n"), /between 1 and 500/);
  }
});

test("an invalid --timeout is a usage error (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--timeout", "1e3", "info"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("an invalid --api-version is a usage error (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--api-version", "v9", "info"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("global options flow through to the client", async () => {
  const seen: FitConnectClientOptions[] = [];
  const mt = makeMockTransport(() => jsonResponse({ version: { major: 2, minor: 0, patch: 0 } }));
  const deps: CliDeps = {
    io: { out: () => {}, err: () => {} },
    createClient: (opts) => {
      seen.push(opts);
      return new FitConnectClient({ ...opts, transport: mt.transport });
    },
  };
  const code = await run(
    [
      "--base-url",
      "https://example.test",
      "--api-version",
      "v1",
      "--timeout",
      "5000",
      "--max-retries",
      "1",
      "--max-response-bytes",
      "1024",
      "--user-agent",
      "test/1",
      "info",
    ],
    deps,
  );
  assert.equal(code, 0);
  assert.deepEqual(seen[0], {
    baseUrl: "https://example.test",
    apiVersion: "v1",
    timeoutMs: 5000,
    maxRetries: 1,
    maxResponseBytes: 1024,
    userAgent: "test/1",
  });
  assert.equal(new URL(mt.last().url).origin, "https://example.test");
  assert.equal(new URL(mt.last().url).pathname, "/v1/info");
});
