// The per-second pace (pace.ts): the MCP server keeps to the Routing API's 5 requests a second,
// holding a request back for its slot instead of letting a burst meet a 429. A fake clock and
// sleep; one real wait of nothing (an abort).

import { test } from "node:test";
import assert from "node:assert/strict";
import { perSecondPace } from "../src/pace.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";

test("perSecondPace starts at most 5 requests in any second; the next waits for its slot, and an abort while waiting rejects", async () => {
  let clock = 0;
  const waits: number[] = [];
  const sent: string[] = [];
  const ok: HttpResponse = { status: 200, headers: {}, body: Buffer.from("{}") };
  const paced = perSecondPace(
    async (request) => {
      sent.push(request.url);
      return ok;
    },
    { now: () => clock, sleep: async (ms) => void waits.push(ms) },
  );
  const request = (n: number, signal?: AbortSignal): HttpRequest => ({ method: "GET", url: `https://x/${n}`, headers: {}, ...(signal === undefined ? {} : { signal }) });
  for (let i = 0; i < 7; i++) await paced(request(i));
  assert.deepEqual(waits, [1000, 1000], "the 6th and 7th wait for the second to pass");
  assert.equal(sent.length, 7);
  clock = 400;
  await paced(request(7));
  assert.deepEqual(waits, [1000, 1000, 600], "the 8th's slot is at 1000 too: the first five started at 0, the second's three then are fine");
  await paced(request(9));
  await paced(request(10));
  await paced(request(11));
  assert.deepEqual(waits, [1000, 1000, 600, 600, 600, 1600], "five start at 1000; the 12th waits for 2000");
  clock = 5000;
  await paced(request(12));
  assert.equal(waits.length, 6, "after a quiet second, no wait");

  const real = perSecondPace(async () => ok, { max: 1 });
  await real(request(0));
  const controller = new AbortController();
  const waiting = real(request(1, controller.signal));
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  assert.throws(() => perSecondPace(async () => ok, { max: 0 }), RangeError);
});
