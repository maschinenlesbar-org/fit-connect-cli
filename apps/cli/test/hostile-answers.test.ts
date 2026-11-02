// A hostile error answer ends in one clean record within memory, never a heap crash (security
// audit 2026-10-27, class C; the case of the kit's P28 that concerns this, until P28 is rolled
// out).
// - Server text bound for a message (the `detail`, a violation's field and message) is cut
//   before it is cleaned: one `+=` per character over a 16 MB error detail exhausted a small
//   heap before the cut to 500 characters.
// The memory cases run the built bin in a child process with --max-old-space-size.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
/** CLI argv (after the global options) for one GET. */
const call = ["info"];

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Serve `status` and `body` to one run of the bin with a heap of `heapMb`, then stop. */
async function runWithAnswer(status: number, body: Buffer, heapMb: number): Promise<Run> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/problem+json");
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await new Promise<Run>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, BIN, "--base-url", base, "--max-retries", "0", ...call],
        { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** No crash: no V8 out-of-memory report, no abort, no stack. */
function noCrash(run: Run, label: string): void {
  assert.notEqual(run.signal, "SIGABRT", `${label}: aborted`);
  assert.ok(run.code !== null && run.code !== 134, `${label}: exit ${run.code} ${run.signal}`);
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, `${label}: ${run.stderr.slice(0, 500)}`);
}

test("a 16 MB error detail or violation ends in one ERROR record within a small heap", STARTS_A_PROCESS, async () => {
  const big = "x ".repeat(8_000_000);
  const bodies: Array<[string, unknown]> = [
    ["detail", { detail: big }],
    ["violation", { detail: "Constraint Violation", violations: [{ field: big, message: big }] }],
  ];
  for (const [label, body] of bodies) {
    const run = await runWithAnswer(400, Buffer.from(JSON.stringify(body)), 128);
    noCrash(run, label);
    assert.equal(run.code, 1, run.stderr.slice(0, 500));
    assert.equal(run.stdout, "");
    const records = run.stderr.trim().split("\n");
    assert.equal(records.length, 1, `${label}: ${run.stderr.slice(0, 500)}`);
    assert.match(records[0] ?? "", /ERROR \[fit-connect\.api\] HTTP 400 /);
    assert.ok((records[0] ?? "").length < 5000, `${label}: the record is cut`);
  }
});
