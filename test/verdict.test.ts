import { test } from "node:test";
import assert from "node:assert/strict";
import { REASONS, expectedKeys, judgeDelivery, type Declaration } from "../src/verdict.js";

const decl: Declaration = {
  description: "forecast",
  outputExample: { forecast: "sunny", temperature: 21 },
  outputSchema: { type: "object", properties: { forecast: {}, temperature: {} }, required: ["forecast", "temperature"] },
};
const ok = (body: unknown, status = 200) => ({ status, contentType: "application/json", bodyText: JSON.stringify(body) });

test("reason words are the fixed machine-readable set", () => {
  assert.deepEqual([...REASONS].sort(), [
    "cap_check_unavailable", "daily_cap_reached", "delivered", "delivery_missing_keys", "empty_body", "http_error", "invalid_target",
    "no_supported_accept", "not_json", "not_x402", "payment_failed", "price_over_cap", "probe_error", "self_dealing",
  ]);
  for (const r of REASONS) assert.match(r, /^[a-z0-9_]+$/);
});

test("expectedKeys: schema.required > schema.properties > example keys", () => {
  assert.deepEqual(expectedKeys(decl), ["forecast", "temperature"]);
  assert.deepEqual(expectedKeys({ outputSchema: { properties: { a: {}, b: {} } } }), ["a", "b"]);
  assert.deepEqual(expectedKeys({ outputExample: { x: 1 } }), ["x"]);
  assert.deepEqual(expectedKeys({}), []);
  assert.deepEqual(expectedKeys({ outputExample: [1, 2] }), []);
});

test("delivered: 200 + JSON + declared keys present + extra keys allowed", () => {
  const j = judgeDelivery(decl, ok({ forecast: "sunny", temperature: 21, city: "Tokyo" }));
  assert.equal(j.verdict, "ALLOW");
  assert.equal(j.reason, "delivered");
  assert.match(j.summary, /forecast:string/);
});

test("delivery_missing_keys when declared keys are absent", () => {
  const j = judgeDelivery(decl, ok({ message: "thanks for paying" }));
  assert.equal(j.verdict, "REFUSE");
  assert.equal(j.reason, "delivery_missing_keys");
  assert.deepEqual(j.missingKeys, ["forecast", "temperature"]);
});

test("delivery_missing_keys when a declared key is null or blank", () => {
  const j = judgeDelivery(decl, ok({ forecast: "  ", temperature: 0 }));
  assert.equal(j.reason, "delivery_missing_keys");
  assert.deepEqual(j.missingKeys, ["forecast"]);
});

test("not_json", () => {
  const j = judgeDelivery(decl, { status: 200, contentType: "text/html", bodyText: "<html>hi</html>" });
  assert.equal(j.verdict, "REFUSE");
  assert.equal(j.reason, "not_json");
});

test("empty_body for {}, [], null, empty string", () => {
  for (const b of [{}, [], null, ""]) assert.equal(judgeDelivery({}, ok(b)).reason, "empty_body");
  assert.equal(judgeDelivery({}, { status: 200, contentType: null, bodyText: "" }).reason, "not_json");
});

test("http_error for non-2xx", () => {
  const j = judgeDelivery(decl, ok({ forecast: "x", temperature: 1 }, 500));
  assert.equal(j.reason, "http_error");
});

test("no declaration: any non-empty JSON is delivered", () => {
  assert.equal(judgeDelivery({}, ok({ anything: 1 })).reason, "delivered");
});

test("summary is bounded", () => {
  const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "v".repeat(100)]));
  assert.ok(judgeDelivery({}, ok(big)).summary.length <= 240);
});
