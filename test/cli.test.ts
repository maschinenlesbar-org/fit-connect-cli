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
  // The message names CLI flags, not the internal method/param names.
  assert.match(cli.err.join("\n"), /--ags, --ars or --area-id/);
  assert.doesNotMatch(cli.err.join("\n"), /routes\(\)/);
});

test("routes with two area selectors is an error naming both flags (no request)", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(
    ["routes", "99123456760610", "--ags", "16051000", "--ars", "064350014014"],
    cli.deps,
  );
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /--ags, --ars/);
});

test("areas passes every search term as a repeated query param", async () => {
  const cli = makeCli(() => jsonResponse(AREA_BODY));
  const code = await run(["areas", "Halle", "Magdeburg"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, "/v2/areas");
  assert.deepEqual(url.searchParams.getAll("areaSearchexpression"), ["Halle", "Magdeburg"]);
});

test("areas sends a decomposed umlaut composed (the API 500s on the NFD form)", async () => {
  const cli = makeCli(() => jsonResponse({ count: 0, offset: 0, totalCount: 0, areas: [] }));
  assert.equal(await run(["--compact", "areas", "Ko\u0308ln"], cli.deps), 0);
  assert.match(cli.mt.last().url, /areaSearchexpression=K%C3%B6ln$/);
});

test("areas notes on stderr which too-short words it left out", async () => {
  const cli = makeCli(() => jsonResponse({ count: 0, offset: 0, totalCount: 0, areas: [] }));
  const code = await run(["--compact", "areas", "Frankfurt a. M."], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(new URL(cli.mt.last().url).searchParams.getAll("areaSearchexpression"), ["Frankfurt"]);
  assert.deepEqual(cli.err, [
    'Note: left out search words shorter than 2 characters (the API rejects them): "a", "M".',
  ]);
});

test("areas sends a quoted official name with parentheses as its bare words", async () => {
  const cli = makeCli(() => jsonResponse(AREA_BODY));
  const code = await run(["areas", "Halle (Westf.)"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(new URL(cli.mt.last().url).searchParams.getAll("areaSearchexpression"), ["Halle", "Westf"]);
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = {
    ...AREA_BODY,
    areas: [{ id: "1024", name: `Halle${controls}`, type: String.fromCharCode(0x1b) + "[31m" }],
  };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "areas", "Halle"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Halle\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
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

test("a malformed --ags is rejected client-side (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(["routes", "99123456760610", "--ags", "1234"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /2, 3, 5 or 8 digits/);
});

test("Land/Kreis-level --ags and --ars keys are sent as given (the API accepts them)", async () => {
  for (const [flag, value] of [
    ["--ags", "16"],
    ["--ags", "064"],
    ["--ags", "06435"],
    ["--ars", "16"],
    ["--ars", "06435"],
    ["--ars", "064350014"],
  ] as const) {
    const cli = makeCli(() => jsonResponse(ROUTE_BODY));
    const code = await run(["routes", "99123456760610", flag, value], cli.deps);
    assert.equal(code, 0, `${flag} ${value}`);
    assert.equal(new URL(cli.mt.last().url).searchParams.get(flag.slice(2)), value);
  }
});

test("a whitespace-only --ags reports a malformed value, not 'no selector'", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(["routes", "99123456760610", "--ags", "   "], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /2, 3, 5 or 8 digits/);
  // The runtime "got none" selector error (which this used to produce) must not fire.
  assert.doesNotMatch(cli.err.join("\n"), /got none/);
});

test("a malformed leikaKey is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(["routes", "12345", "--ars", "064350014014"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid leikaKey/);
});

test("a --user-agent with CR/LF is rejected, not an unexpected crash", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--user-agent", "bad\r\nInjected: x", "info"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Control characters/);
  assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
});

test("an invalid --timeout is a usage error (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--timeout", "1e3", "info"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({ version: { major: 2, minor: 0, patch: 0 } }));
  assert.equal(await run(["--timeout", "2147483647", "info"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--timeout", "2147483648", "info"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /between 0 and 2147483647/);
});

test("a non-http(s) or malformed --base-url is a usage error (non-zero, no request)", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl", "http://h/echo?token=abc", "http://h/echo#x", "http://h/?"]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["--base-url", bad, "info"], cli.deps);
    assert.notEqual(code, 0, bad);
    assert.equal(cli.mt.calls.length, 0, bad);
    assert.match(cli.err.join("\n"), /--base-url/, bad);
  }
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

test("a blank id or query value is rejected before any request (non-zero exit)", async () => {
  // A blank value (often an unset shell variable) must never be sent as an empty
  // parameter (`areaId=`) alongside a valid selector, nor run unfiltered.
  const cases: { name: string; argv: string[] }[] = [];
  for (const blank of ["", "   "]) {
    const label = JSON.stringify(blank);
    cases.push(
      { name: `--area-id ${label} with --ars`, argv: ["routes", "99123456760610", "--ars", "064350014014", "--area-id", blank] },
      { name: `--area-id ${label} with --ags`, argv: ["routes", "99123456760610", "--ags", "16051000", "--area-id", blank] },
      { name: `--area-id ${label} alone`, argv: ["routes", "99123456760610", "--area-id", blank] },
      { name: `--ars ${label}`, argv: ["routes", "99123456760610", "--ars", blank] },
      { name: `leikaKey ${label}`, argv: ["routes", blank, "--ars", "064350014014"] },
      { name: `areas query ${label}`, argv: ["areas", blank] },
    );
  }
  for (const { name, argv } of cases) {
    const cli = makeCli(() => jsonResponse(ROUTE_BODY));
    const code = await run(argv, cli.deps);
    assert.notEqual(code, 0, `${name} should exit non-zero`);
    assert.equal(cli.mt.calls.length, 0, `${name} should not send a request`);
  }
});

test("a blank --area-id is a usage error naming the flag", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(["routes", "99123456760610", "--ars", "064350014014", "--area-id", ""], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /--area-id/);
  assert.match(cli.err.join("\n"), /must not be blank/);
});

test("--area-id is trimmed before it is sent", async () => {
  const cli = makeCli(() => jsonResponse(ROUTE_BODY));
  const code = await run(["routes", "99123456760610", "--area-id", " 1024 "], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("areaId"), "1024");
});
