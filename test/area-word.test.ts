// The per-word wildcard check of the area search (result 01 Bug 1 / result 06 of the
// 2026-10-05 review): a linear scan that accepts exactly what the Routing API's spec
// pattern accepts, and finishes at once on the inputs that made the regex backtrack.

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { FitConnectClient, areaSearchWords, isAreaSearchWord } from "../src/client/client.js";
import { FitConnectValidationError } from "../src/client/errors.js";
import { constantJson } from "./helpers.js";

/** The spec's pattern (`routing-api.yaml`), used here only as the reference on short inputs. */
const SPEC_PATTERN = /^(\*?([^*]{2,})\*?)*$/u;

function* allWords(alphabet: string[], maxLength: number): Generator<string> {
  let level: string[] = [""];
  yield "";
  for (let len = 1; len <= maxLength; len++) {
    const next: string[] = [];
    for (const prefix of level) for (const c of alphabet) next.push(prefix + c);
    yield* next;
    level = next;
  }
}

test("isAreaSearchWord accepts and rejects exactly what the spec's pattern does", () => {
  let checked = 0;
  // Every word of up to 10 characters over "a", "b" and "*", and of up to 7 with an
  // astral letter (one code point, two UTF-16 units) in the mix.
  for (const [alphabet, max] of [[["a", "b", "*"], 10], [["a", "\u{20000}", "*"], 7]] as const) {
    for (const word of allWords([...alphabet], max)) {
      assert.equal(isAreaSearchWord(word), SPEC_PATTERN.test(word), JSON.stringify(word));
      checked++;
    }
  }
  assert.ok(checked > 80_000);
  for (const ok of ["Mag*", "*burg", "*ab*", "ab*cd", "ab**cd", "Hanau", "Kö*", "60311"]) assert.equal(isAreaSearchWord(ok), true, ok);
  for (const bad of ["Ma*g", "**ab", "ab**", "ab***cd", "*", "a", "a*b"]) assert.equal(isAreaSearchWord(bad), false, bad);
});

/** The worst cases of result 06, each followed by a wildcard that leaves fewer than 2 characters. */
const WORST_CASES = [
  "Donaudampfschifffahrtsgesellschaftskapitaen*X",
  `${"a".repeat(36)}*b`,
  `${"a".repeat(46)}*b`,
  `${"a".repeat(48)}*b`,
  `${"a".repeat(62)}*b`,
  `${"ä".repeat(34)}*b`,
  `*${"a".repeat(34)}*b`,
  `${"a".repeat(34)}**`,
  `${"60311".repeat(6)}*1`,
  "Schwarzwaldbaarkreisverwaltung*n",
  `${"a".repeat(100_000)}*b`,
];

test("the worst-case words of result 06 are rejected in well under 100 ms each", async () => {
  // A warm-up call, as a long-running service would have made.
  areaSearchWords("Hanau");
  for (const word of WORST_CASES) {
    const start = performance.now();
    assert.throws(() => areaSearchWords(word), FitConnectValidationError, word.slice(0, 50));
    const ms = performance.now() - start;
    assert.ok(ms < 100, `${word.slice(0, 50)}… took ${ms.toFixed(1)} ms`);
  }
  // Through the client too (a form field passed to areas()), as the 10th of 10 words.
  const client = new FitConnectClient({ transport: constantJson({ count: 0, offset: 0, totalCount: 0, areas: [] }).transport });
  for (const word of WORST_CASES) {
    const start = performance.now();
    await assert.rejects(client.areas({ search: ["aa bb cc dd ee ff gg hh ii", word] }), FitConnectValidationError);
    const ms = performance.now() - start;
    assert.ok(ms < 100, `areas(): ${word.slice(0, 50)}… took ${ms.toFixed(1)} ms`);
  }
});

test("long passing words stay fast and are sent", () => {
  const long = `${"a".repeat(5000)}*`;
  const start = performance.now();
  assert.deepEqual(areaSearchWords(long).words, [long]);
  assert.ok(performance.now() - start < 100);
});
