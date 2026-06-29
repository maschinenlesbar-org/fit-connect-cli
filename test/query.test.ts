import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueryString } from "../src/client/query.js";

test("omits undefined and null values", () => {
  assert.equal(buildQueryString({ a: undefined, b: null, c: "x" }), "c=x");
});

test("serialises arrays as repeated keys", () => {
  assert.equal(buildQueryString({ areaSearchexpression: ["a", "b"] }), "areaSearchexpression=a&areaSearchexpression=b");
});

test("serialises booleans and numbers", () => {
  assert.equal(buildQueryString({ a: true, b: false, c: 3 }), "a=true&b=false&c=3");
});

test("encodes spaces as %20 not +", () => {
  assert.equal(buildQueryString({ q: "Halle Saale" }), "q=Halle%20Saale");
});

test("keeps the wildcard asterisk for area search", () => {
  assert.equal(buildQueryString({ areaSearchexpression: "Mag*" }), "areaSearchexpression=Mag*");
});

test("returns an empty string when nothing survives", () => {
  assert.equal(buildQueryString({ a: undefined }), "");
});
