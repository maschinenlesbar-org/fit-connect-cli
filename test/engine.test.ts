import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RequestEngine,
  parseRateLimitReset,
  parseRetryAfter,
  sanitizeServerText,
  MAX_RETRY_AFTER_MS,
} from "../src/client/engine.js";
import { FitConnectApiError, FitConnectError, FitConnectParseError } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("v2/info"), "https://example.test/v2/info");
  assert.equal(
    e.buildUrl("/v2/routes", { leikaKey: "99123456760610", ars: "064350014014" }),
    "https://example.test/v2/routes?leikaKey=99123456760610&ars=064350014014",
  );
});

test("rejects a non-http base URL naming the base URL", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://example.test" }),
    (err: unknown) => {
      assert.ok(err instanceof FitConnectError);
      assert.match(err.message, /ftp:/);
      assert.match(err.message, /example\.test/);
      return true;
    },
  );
});

test("a base URL with a query or fragment is rejected (it would swallow every path)", () => {
  for (const baseUrl of ["http://u:secret@h/echo?token=abc", "http://h/echo#x", "http://h/?"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err: unknown) =>
        err instanceof FitConnectError &&
        /^Base URL must not contain a query or fragment: /.test(err.message) &&
        !err.message.includes("secret"),
      baseUrl,
    );
  }
  // A path prefix (a mirror) still works.
  assert.equal(new RequestEngine({ baseUrl: "http://h/mirror/" }).buildUrl("/v2/info"), "http://h/mirror/v2/info");
});

test("API error messages redact userinfo credentials from the URL", async () => {
  const mt = makeMockTransport(() => jsonResponse({ title: "Bad Request" }, 400));
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://user:secret@example.test" });
  await assert.rejects(
    () => e.getJson("/v2/info"),
    (err: unknown) => {
      assert.ok(err instanceof FitConnectApiError);
      assert.doesNotMatch(err.message, /secret/);
      assert.doesNotMatch(err.message, /user:/);
      return true;
    },
  );
});

test("a whitespace-only User-Agent falls back to the default", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "   " });
  await e.getJson("/v2/info");
  assert.equal(mt.last().headers?.["User-Agent"], "fit-connect-cli");
});

test("a User-Agent Node cannot send is a FitConnectError, not a raw TypeError", () => {
  for (const userAgent of ["x\r\ny: z", "Mozilla \u20ac", "\u65e5\u672c", "a\u007fb"]) {
    assert.throws(
      () => new RequestEngine({ userAgent }),
      (err: unknown) =>
        err instanceof FitConnectError &&
        /^Invalid userAgent: it contains control characters or characters outside Latin-1/.test(err.message),
      JSON.stringify(userAgent),
    );
  }
  assert.doesNotThrow(() => new RequestEngine({ userAgent: "a\tb-\u00fc" }));
});

test("a real User-Agent is sent verbatim", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "my-tool/2.0" });
  await e.getJson("/v2/info");
  assert.equal(mt.last().headers?.["User-Agent"], "my-tool/2.0");
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/v2/info"), { ok: true });
});

test("getJson parses a body with a UTF-8 byte-order mark and honours the charset", async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
  let e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(bom, "application/json")).transport });
  assert.deepEqual(await e.getJson("/v2/info"), { a: 1 });

  const latin1 = Buffer.from('{"name":"K\u00f6ln"}', "latin1");
  e = new RequestEngine({
    transport: makeMockTransport(() => rawResponse(latin1, "application/json; charset=ISO-8859-1")).transport,
  });
  assert.deepEqual(await e.getJson("/v2/areas"), { name: "K\u00f6ln" });

  e = new RequestEngine({
    transport: makeMockTransport(() => rawResponse("{}", "application/json; charset=x-bogus")).transport,
  });
  await assert.rejects(
    () => e.getJson("/v2/info"),
    (err: unknown) =>
      err instanceof FitConnectParseError && err.message === 'Unsupported response charset "x-bogus" from /v2/info.',
  );
});

test("getJson throws FitConnectParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/v2/info"), FitConnectParseError);
});

test("getJson accepts a problem+json content-type on success (used by /areas)", async () => {
  const mt = makeMockTransport(() =>
    rawResponse(JSON.stringify({ count: 0, offset: 0, totalCount: 0, areas: [] }), "application/problem+json"),
  );
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/v2/areas"), { count: 0, offset: 0, totalCount: 0, areas: [] });
});

test("a 503 is retried up to maxRetries then surfaces as FitConnectApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/v2/info"),
    (err) => err instanceof FitConnectApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/v2/info"), { ok: 1 });
  assert.equal(calls, 2);
});

test("a 429 with Retry-After (seconds) waits for that delay", async () => {
  let calls = 0;
  const mt = makeMockTransport((): HttpResponse => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
        body: Buffer.from("{}"),
      };
    }
    return jsonResponse({ ok: 1 });
  });
  const slept: number[] = [];
  const e = new RequestEngine({
    transport: mt.transport,
    retryDelayMs: 200,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.deepEqual(await e.getJson("/v2/info"), { ok: 1 });
  assert.deepEqual(slept, [2000]); // Retry-After wins over the linear default (200)
});

test("falls back to linear backoff when Retry-After is absent", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const slept: number[] = [];
  const e = new RequestEngine({
    transport: mt.transport,
    retryDelayMs: 200,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  await e.getJson("/v2/info");
  assert.deepEqual(slept, [200]);
});

function retryingEngine(retryAfter: string | undefined, maxRetries = 2, extra: Record<string, string> = {}) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
      ...extra,
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof FitConnectApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "-5", "1.5", "soon", "abc", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof FitConnectApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("without Retry-After, a 429 waits the RateLimit-Reset the Routing API documents", async () => {
  // Live 429 shape per routing-api.yaml: RateLimit-* headers, no Retry-After.
  const rl = { "ratelimit-limit": "10", "ratelimit-remaining": "0", "ratelimit-reset": "5" };
  const { engine, mt, delays } = retryingEngine(undefined, 2, rl);
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof FitConnectApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [5000, 5000]);

  // Retry-After wins when both are present.
  const both = retryingEngine("1", 1, rl);
  await assert.rejects(() => both.engine.getJson("/x"));
  assert.deepEqual(both.delays, [1000]);

  // A reset beyond MAX_RETRY_AFTER_MS is not retried; a malformed one backs off linearly.
  const far = retryingEngine(undefined, 2, { "ratelimit-reset": "3600" });
  await assert.rejects(() => far.engine.getJson("/x"));
  assert.equal(far.mt.calls.length, 1);
  assert.deepEqual(far.delays, []);
  const bad = retryingEngine(undefined, 2, { "ratelimit-reset": "1.5" });
  await assert.rejects(() => bad.engine.getJson("/x"));
  assert.deepEqual(bad.delays, [200, 400]);
});

test("parseRateLimitReset reads delta-seconds and Unix timestamps", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRateLimitReset("0", now), 0);
  assert.equal(parseRateLimitReset(" 5 ", now), 5000);
  assert.equal(parseRateLimitReset(["7", "1"], now), 7000);
  assert.equal(parseRateLimitReset(String(now / 1000 + 12), now), 12_000); // timestamp
  assert.equal(parseRateLimitReset(String(now / 1000 - 60), now), 0); // past timestamp
  for (const bad of [undefined, "", "-1", "1.5", "1e3", "soon", "Sat, 26 Sep 2026 10:00:05 GMT"]) {
    assert.equal(parseRateLimitReset(bad, now), undefined, String(bad));
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("an API error surfaces the problem+json detail field in the message", async () => {
  const mt = makeMockTransport(() =>
    rawResponse(JSON.stringify({ type: "about:blank", title: "Bad Request", status: 400, detail: "boom" }), "application/problem+json", 400),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/v2/routes"),
    (err) =>
      err instanceof FitConnectApiError &&
      err.status === 400 &&
      err.detail === "boom" &&
      err.isRetryable === false &&
      /boom/.test(err.message),
  );
});

test("an API error falls back to the problem+json title when detail is absent", async () => {
  const mt = makeMockTransport(() =>
    rawResponse(JSON.stringify({ title: "Bad Request", status: 400 }), "application/problem+json", 400),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/v2/routes"),
    (err) => err instanceof FitConnectApiError && err.detail === "Bad Request",
  );
});

test("an API error strips terminal control characters from the detail (no escape injection)", async () => {
  // Control bytes are constructed via char codes so no raw control byte ever
  // appears in this source file; interleaved with printable text.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const C1 = String.fromCharCode(0x9b); // a C1 control (CSI)
  const evil = `boom${ESC}[31mred${BEL}${C1}2J`;

  const hasControlChars = (s: string): boolean =>
    [...s].some((c) => {
      const n = c.charCodeAt(0);
      return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
    });

  const mt = makeMockTransport(() =>
    rawResponse(JSON.stringify({ detail: evil }), "application/problem+json", 400),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/v2/routes"),
    (err: unknown) => {
      assert.ok(err instanceof FitConnectApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints raw to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("an API error names the problem+json violations[] after the detail", async () => {
  // Live shape (2026-09-26): GET /v2/routes?…&areaId=%20940%20
  const body = {
    detail: "Constraint Violation",
    status: 400,
    title: "Bad Request",
    violations: [
      { field: "route.areaId", message: 'must match "^\\d{1,}"' },
      { field: "route.ags", message: 'must match "^(\\d{2}|\\d{3}|\\d{5}|\\d{8})$"' },
      { field: "ignored" },
      "junk",
    ],
  };
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(body), "application/problem+json", 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/v2/routes"),
    (err: unknown) => {
      assert.ok(err instanceof FitConnectApiError);
      assert.equal(
        err.detail,
        'Constraint Violation (route.areaId: must match "^\\d{1,}"; route.ags: must match "^(\\d{2}|\\d{3}|\\d{5}|\\d{8})$")',
      );
      assert.match(err.message, /: Constraint Violation \(route\.areaId: must match/);
      return true;
    },
  );
});

test("violations[] without a detail become the detail; control characters are stripped", async () => {
  const ESC = String.fromCharCode(0x1b);
  const body = { violations: [{ field: `a${ESC}[2Jb`, message: `bad${ESC}]0;x` }] };
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(body), "application/problem+json", 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/v2/routes"),
    (err: unknown) => err instanceof FitConnectApiError && err.detail === "a[2Jb: bad]0;x",
  );
});

test("error detail loses bidi controls and line breaks, so it cannot reorder or forge lines", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const RLO = String.fromCharCode(0x202e);
  const LRI = String.fromCharCode(0x2066);
  const detail = `bad request ${ESC}]0;PWNED${BEL}\nfit-connect: all good, 3 routes found${RLO}evil\r\nError: forged\u2028x\t ${LRI}y`;
  const mt = makeMockTransport(() => jsonResponse({ detail }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/v2/info"),
    (err: unknown) => {
      assert.ok(err instanceof FitConnectApiError);
      assert.equal(err.detail, "bad request ]0;PWNED fit-connect: all good, 3 routes foundevil Error: forged x y");
      assert.ok(!/[\n\r\u2028\u202e\u2066]/.test(err.message));
      return true;
    },
  );
});

test("sanitizeServerText keeps ordinary text, umlauts and single spaces", () => {
  assert.equal(sanitizeServerText("  No Area  was found. Größe  "), "No Area was found. Größe");
});

test("an API error tolerates a non-JSON body (no detail)", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>oops</html>", "text/html", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/v2/info"),
    (err) => err instanceof FitConnectApiError && err.detail === undefined && err.isRetryable === false,
  );
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/v2/info");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("an empty/blank User-Agent falls back to the default (never blank, to avoid 403)", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "" });
  await e.getJson("/v2/info");
  assert.equal(mt.last().headers?.["User-Agent"], "fit-connect-cli");
});
