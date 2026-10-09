import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { FitConnectClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { FitConnectClientOptions } from "../src/client/client.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { FitConnectNetworkError, FitConnectValidationError, credentialsIn } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, untimed } from "./helpers.js";

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

test("an areas search with no usable word is a usage error with help, naming no library method", async () => {
  for (const query of ["", "&", "*", "a b"]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["areas", query], cli.deps);
    assert.equal(code, 1, query);
    assert.equal(cli.mt.calls.length, 0, query);
    const err = untimed(cli.err.join("\n"));
    assert.match(err, /^ERROR \[fit-connect\.cli\] No usable search word in /, query);
    assert.match(err, /Usage: fit-connect areas/, query);
    assert.doesNotMatch(err, /areas\(\)/, query);
  }
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["areas", "a1 b2 c3 d4 e5 f6 g7 h8 i9 j0 k1"], cli.deps), 1);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[fit-connect\.cli\] Too many search words \(11\)/);
  assert.equal(cli.mt.calls.length, 0);
});

test("areas notes on stderr which too-short words it left out", async () => {
  const cli = makeCli(() => jsonResponse({ count: 0, offset: 0, totalCount: 0, areas: [] }));
  const code = await run(["--compact", "areas", "Frankfurt a. M."], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(new URL(cli.mt.last().url).searchParams.getAll("areaSearchexpression"), ["Frankfurt"]);
  assert.deepEqual(cli.err.map(untimed), [
    'INFO  [fit-connect.cli] left out search words shorter than 2 characters (the API rejects them): "a", "M".',
    "INFO  [fit-connect.cli] split the search at characters the API rejects inside a word, and left them out: .",
  ]);
});

test("the left-out-words note names each word once, at most 10 of them, each cut at 100 characters (B02-1)", async () => {
  const many = makeCli(() => jsonResponse({ count: 0, offset: 0, totalCount: 0, areas: [] }));
  assert.equal(await run(["--compact", "areas", "Hanau", ...Array.from({ length: 2000 }, () => "q")], many.deps), 0);
  assert.deepEqual(many.err.map(untimed), [
    'INFO  [fit-connect.cli] left out search words shorter than 2 characters (the API rejects them): "q".',
  ]);
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const distinct = makeCli(() => jsonResponse({ count: 0, offset: 0, totalCount: 0, areas: [] }));
  assert.equal(await run(["--compact", "areas", "Hanau", ...letters, `x${"*".repeat(5000)}`], distinct.deps), 0);
  assert.equal(distinct.err.length, 1, distinct.err.join("\n"));
  const note = untimed(distinct.err[0] as string);
  assert.match(note, /: "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", … \(17 more\)\.$/);
  assert.ok(note.length < 300, `${note.length}`);
});

test("a search with no usable word names each typed term once, at most 10 of them (B02-1)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["areas", ...Array.from({ length: 2000 }, (_, i) => String.fromCharCode(0x4e00 + i))], cli.deps), 1);
  const first = untimed(cli.err[0] as string);
  assert.match(first, /^ERROR \[fit-connect\.cli\] No usable search word in "一" "丁" .* … \(1990 more\): every word needs/);
  assert.ok(first.length < 400, `${first.length}`);
  const same = makeCli(() => jsonResponse({}));
  assert.equal(await run(["areas", ...Array.from({ length: 2000 }, () => "q")], same.deps), 1);
  assert.match(untimed(same.err[0] as string), /^ERROR \[fit-connect\.cli\] No usable search word in "q": /);
});

test("areas lists the separator characters it left out once each, invisible ones as U+XXXX", async () => {
  const cli = makeCli(() => jsonResponse({ count: 0, offset: 0, totalCount: 0, areas: [] }));
  const code = await run(["--compact", "areas", "Halle (Westf.)", "Bad\u200bOeynhausen\u202e", "Halle-(Saale)"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(new URL(cli.mt.last().url).searchParams.getAll("areaSearchexpression"), [
    "Halle",
    "Westf",
    "Bad",
    "Oeynhausen",
    "Saale",
  ]);
  assert.deepEqual(cli.err.map(untimed), [
    "INFO  [fit-connect.cli] split the search at characters the API rejects inside a word, and left them out: ( . ) U+200B U+202E -",
  ]);
  const plain = makeCli(() => jsonResponse({ count: 0, offset: 0, totalCount: 0, areas: [] }));
  assert.equal(await run(["--compact", "areas", "Frankfurt am Main"], plain.deps), 0);
  assert.deepEqual(plain.err, [], "a plain space is the ordinary separator, not worth a note");
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

test("a deeply nested response fails pretty-printing cleanly and still prints with --compact", async () => {
  const depth = 200_000;
  const head = '{"count":1,"offset":0,"totalCount":1,"areas":[{"id":"1","name":"Halle","type":"Stadt","x":';
  const deepJson = head + "[".repeat(depth) + "]".repeat(depth) + "}]}";
  const deep = () => rawResponse(deepJson, "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run(["areas", "Halle"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(untimed(pretty.err.join("\n")), "ERROR [fit-connect.cli] The response is nested too deeply to pretty-print; try --compact.");

  // Compact serialisation goes much deeper (it prints this one on current Node);
  // should a runtime's stack still be too small, it must fail just as cleanly.
  const compact = makeCli(deep);
  const code = await run(["--compact", "areas", "Halle"], compact.deps);
  if (code === 0) assert.equal(compact.out.join(""), deepJson);
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [fit-connect.cli] The response is nested too deeply to print.");
});

test("bidi formatting characters in server data are escaped in the JSON output", async () => {
  const bidi = String.fromCharCode(0x202e, 0x2066, 0x200f, 0x061c);
  const served = { count: 1, offset: 0, totalCount: 1, areas: [{ id: "1", name: `Halle${bidi}ellah`, type: "Stadt" }] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "areas", "Halle"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.ok(!/[\u202e\u2066\u200f\u061c]/.test(text), format.join(" "));
    assert.match(text, /Halle\\u202e\\u2066\\u200f\\u061cellah/);
    assert.deepEqual(JSON.parse(text), served);
  }
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
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[fit-connect\.api\] HTTP 400/);
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
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[fit-connect\.http\] connect ECONNREFUSED/);
});

test("a parse error (non-JSON body) maps to exit code 1, an ERROR record of fit-connect.api", async () => {
  const cli = makeCli(() => rawResponse("<html>not json</html>", "text/html"));
  const code = await run(["info"], cli.deps);
  assert.equal(code, 1);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[fit-connect\.api\] Failed to parse JSON/);
});

test("whatever a transport throws is reported as a network error, exit 1", async () => {
  const cli = makeCli(() => {
    throw new Error("kaboom");
  });
  const code = await run(["info"], cli.deps);
  assert.equal(code, 1);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[fit-connect\.http\] kaboom$/m);
});

test("an unexpected (non-FitConnect) error maps to exit code 1", async () => {
  const cli = makeCli(() => jsonResponse({}));
  cli.deps.createClient = () => {
    throw new Error("kaboom");
  };
  const code = await run(["info"], cli.deps);
  assert.equal(code, 1);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[fit-connect\.cli\] Unexpected error: kaboom/);
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

test("a non-Latin-1 --user-agent is a usage error, not an unexpected crash; tab and ü pass", async () => {
  for (const ua of ["Mozilla \u20ac", "\u65e5\u672c"]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["--user-agent", ua, "info"], cli.deps);
    assert.equal(code, 1, ua);
    assert.equal(cli.mt.calls.length, 0, ua);
    assert.match(cli.err.join("\n"), /Value contains characters outside Latin-1 \(above U\+00FF\)\./);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
  }
  const cli = makeCli(() => jsonResponse({ version: { major: 2, minor: 0, patch: 0 } }));
  assert.equal(await run(["--user-agent", "a\tb-\u00fc", "info"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "a\tb-\u00fc");
});

test("a --user-agent with CR/LF is rejected, not an unexpected crash", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--user-agent", "bad\r\nInjected: x", "info"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Value contains control characters\./);
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

test("--offset is bounded to the API's int32 range", async () => {
  for (const argv of [
    ["areas", "Hanau", "--offset", "2147483648"],
    ["routes", "99123456760610", "--ags", "16", "--offset", "9007199254740991"],
  ]) {
    const cli = makeCli(() => jsonResponse(ROUTE_BODY));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /between 0 and 2147483647/);
  }
  // The API adds offset and limit in a 32-bit integer (HTTP 500 on overflow): the sum,
  // with the default limit 100, must stay within 2147483647.
  for (const argv of [
    ["areas", "Hanau", "--offset", "2147483647"],
    ["routes", "99123456760610", "--ags", "16", "--offset", "2147483548"],
    ["routes", "99123456760610", "--ags", "16", "--offset", "2147483500", "--limit", "500"],
  ]) {
    const cli = makeCli(() => jsonResponse(ROUTE_BODY));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /offset \+ limit must not exceed 2147483647/);
  }
  const cli = makeCli(() => jsonResponse({ count: 0, offset: 2147483547, totalCount: 0, areas: [] }));
  assert.equal(await run(["areas", "Hanau", "--offset", "2147483547"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("offset"), "2147483547");
  const one = makeCli(() => jsonResponse({ count: 0, offset: 2147483646, totalCount: 0, areas: [] }));
  assert.equal(await run(["areas", "Hanau", "--offset", "2147483646", "--limit", "1"], one.deps), 0);
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["9007199254740991", false]] as const) {
    const cli = makeCli(() => jsonResponse({ version: { major: 2, minor: 0, patch: 0 } }));
    const code = await run(["--max-retries", value, "info"], cli.deps);
    assert.equal(code, ok ? 0 : 1, value);
    if (!ok) {
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), /between 0 and 10/);
    }
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

test("a FitConnectValidationError raised in an action is a usage error: exit 1, an ERROR record", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const client = new FitConnectClient({ transport: makeMockTransport(() => jsonResponse({})).transport });
  client.info = async () => {
    throw new FitConnectValidationError("Invalid areaId: Value must not be blank.");
  };
  const code = await run(["info"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => client,
  });
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err.map(untimed), ["ERROR [fit-connect.cli] Invalid areaId: Value must not be blank."]);
});

test("--base-url with surrounding whitespace is a usage error before any request (P4)", async () => {
  for (const bad of ["http://127.0.0.1:20260 ", "http://alice:s3cret@127.0.0.1:20260 ", "\thttp://h"]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["--base-url", bad, "info"], cli.deps);
    assert.equal(code, 1, bad);
    assert.equal(cli.mt.calls.length, 0, bad);
    assert.match(cli.err.join("\n"), /surrounding whitespace/, bad);
    assert.doesNotMatch(cli.err.join("\n"), /s3cret/, bad);
  }
});

test("an a:b@c argument (here a search word) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() =>
    jsonResponse({ count: 1, offset: 0, totalCount: 1, areas: [{ id: "1", name: "run:2026-10-09@x", type: "Gemeinde" }] }),
  );
  assert.equal(await run(["areas", "Hanau", "run:2026-10-09@x"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"name": "run:2026-10-09@x"/);
  assert.ok(cli.err.some((line) => line.includes(":")), cli.err.join("\n"));
  assert.ok(cli.err.every((line) => !line.includes("***")), cli.err.join("\n"));
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("a run without a command logs an ERROR before the help, exit 2 (L5)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--compact"], cli.deps), 2);
  const records = cli.err.map(untimed);
  assert.match(records[0] ?? "", /^ERROR \[fit-connect\.cli\] missing command: `fit-connect <subcommand>`$/, records.join("\n"));
  assert.ok(records.length > 2, records.join("\n"));
  assert.ok(records.slice(1).every((line) => line.startsWith("INFO  [fit-connect.cli] ") && !line.includes("\\n")), records.join("\n"));
  assert.deepEqual(cli.out, []);
});

test("help for an unknown command reports it like the command itself, exit 2, at every level", async () => {
  for (const [helpArgv, plainArgv] of [
    [["help", "nope"], ["nope"]],
    [["help", "https://alice:s3cret@x.test"], ["https://alice:s3cret@x.test"]],
  ] as const) {
    const viaHelp = makeCli(() => jsonResponse({}));
    const plain = makeCli(() => jsonResponse({}));
    assert.equal(await run([...helpArgv], viaHelp.deps), 2, helpArgv.join(" "));
    await run([...plainArgv], plain.deps);
    assert.match(untimed(viaHelp.err[0] ?? ""), /^ERROR \[fit-connect\.cli\] (unknown command|too many arguments)/, viaHelp.err.join("\n"));
    assert.equal(untimed(viaHelp.err[0] ?? ""), untimed(plain.err[0] ?? ""), helpArgv.join(" "));
    assert.deepEqual(viaHelp.out, []);
    assert.ok(!viaHelp.err.join("\n").includes("s3cret"));
    assert.equal(viaHelp.mt.calls.length, 0);
  }
});

test("help <command> <unknown> on a command without subcommands is an error, not a run of that command", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["help", "areas", "nope"], cli.deps), 2);
  assert.match(untimed(cli.err[0] ?? ""), /^ERROR \[fit-connect\.cli\] unknown command 'nope'$/);
  assert.equal(cli.mt.calls.length, 0);
});

test("help names a command path and shows that command's help on stdout, exit 0", async () => {
  for (const [argv, usage] of [
    [["help"], "Usage: fit-connect [options] [command]"],
    [["help", "areas"], "Usage: fit-connect areas [options] <query...>"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 0, argv.join(" "));
    assert.equal(cli.out.join("\n").split("\n")[0], usage, argv.join(" "));
    assert.deepEqual(cli.err, []);
  }
});

test("a repeated --log-format is reported in the format commander kept, the first (K5, L6)", async () => {
  for (const [argv, jsonl] of [
    [["--log-format", "jsonl", "--log-format", "text", "info"], true],
    [["--log-format", "text", "--log-format", "jsonl", "info"], false],
    [["--log-format", "jsonl", "--log-format=xml", "info"], true],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 1, JSON.stringify(argv));
    const first = cli.err[0] ?? "";
    if (jsonl) assert.equal((JSON.parse(first) as Record<string, unknown>)["level"], "ERROR", first);
    else assert.match(untimed(first), /^ERROR \[fit-connect\.cli\] /);
    assert.match(first, /was given more than once/);
  }
});

test("an option's value that looks like --log-format sets no format, in a parse error too (K5, L6)", async () => {
  // commander takes "--log-format" as the User-Agent (or the timeout) and then fails on the command "jsonl".
  for (const argv of [["--user-agent", "--log-format", "jsonl", "info"]]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 1, JSON.stringify(argv));
    assert.match(untimed(cli.err[0] ?? ""), /^ERROR \[fit-connect\.cli\] unknown command 'jsonl'/, cli.err.join("\n"));
  }
  // commander takes "--log-format=jsonl" as the User-Agent and sends it: the log stays text.
  const ua = makeCli(() => jsonResponse({ detail: "boom" }, 404));
  assert.equal(await run(["--user-agent", "--log-format=jsonl", "info"], ua.deps), 4);
  assert.equal(ua.mt.last().headers?.["User-Agent"], "--log-format=jsonl");
  assert.match(untimed(ua.err[0] ?? ""), /^ERROR \[fit-connect\.api\] /);
});

test("a subcommand's value option does not swallow the program's --log-format, in a parse error too (L6)", async () => {
  // commander takes the program's --log-format out of argv first;  is left without its value.
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["routes", "99123456", "--ags", "--log-format", "jsonl"], cli.deps);
  assert.notEqual(code, 0);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  assert.match((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["msg"] as string, / <[a-z]+>' argument missing/);
});
