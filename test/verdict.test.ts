import { test } from "node:test";
import assert from "node:assert/strict";
import { declareDiscoveryExtension } from "@x402-avm/extensions";
import { REASONS, exampleKeys, expectedKeys, judgeDelivery, type Declaration } from "../src/verdict.js";
import { declarationFrom, outputSchemaFrom } from "../src/declaration.js";

const decl: Declaration = {
  description: "forecast",
  outputExample: { forecast: "sunny", temperature: 21 },
  outputSchema: { type: "object", properties: { forecast: {}, temperature: {} }, required: ["forecast", "temperature"] },
};
const ok = (body: unknown, status = 200) => ({ status, contentType: "application/json", bodyText: JSON.stringify(body) });

test("reason words are the fixed machine-readable set", () => {
  assert.deepEqual([...REASONS].sort(), [
    "cap_check_unavailable", "daily_cap_reached", "delivered", "delivery_missing_keys", "empty_body", "http_error", "invalid_target",
    "no_supported_accept", "not_json", "not_x402", "payment_failed", "price_changed", "price_over_cap", "probe_error", "requirements_body_only", "self_dealing",
  ]);
  for (const r of REASONS) assert.match(r, /^[a-z0-9_]+$/);
});

test("expectedKeys (promise) is schema.required only; example/properties are hints", () => {
  assert.deepEqual(expectedKeys(decl), ["forecast", "temperature"]);
  assert.deepEqual(exampleKeys(decl), []);
  assert.deepEqual(expectedKeys({ outputSchema: { properties: { a: {}, b: {} } } }), []);
  assert.deepEqual(exampleKeys({ outputSchema: { properties: { a: {}, b: {} } } }), ["a", "b"]);
  assert.deepEqual(expectedKeys({ outputExample: { x: 1 } }), []);
  assert.deepEqual(exampleKeys({ outputExample: { x: 1 } }), ["x"]);
  assert.deepEqual(exampleKeys({ outputSchema: { properties: { a: {} } }, outputExample: { a: 1, b: 2 } }), ["a", "b"]);
  assert.deepEqual(expectedKeys({ outputSchema: { required: [] }, outputExample: { x: 1 } }), []);
  assert.deepEqual(expectedKeys({}), []);
  assert.deepEqual(exampleKeys({ outputExample: [1, 2] }), []);
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

test("a required key that is present with null or blank value counts as present", () => {
  const j = judgeDelivery(decl, ok({ forecast: null, temperature: "  " }));
  assert.equal(j.verdict, "ALLOW");
  assert.equal(j.reason, "delivered");
  assert.deepEqual(j.missingKeys, []);
});

test("delivery_missing_keys lists only the required keys that are absent", () => {
  const j = judgeDelivery(decl, ok({ temperature: 0 }));
  assert.equal(j.reason, "delivery_missing_keys");
  assert.deepEqual(j.missingKeys, ["forecast"]);
});

test("required keys are own keys, not inherited ones", () => {
  const j = judgeDelivery({ outputSchema: { required: ["constructor", "toString"] } }, ok({ a: 1 }));
  assert.equal(j.reason, "delivery_missing_keys");
  assert.deepEqual(j.missingKeys, ["constructor", "toString"]);
});

test("example-only declaration: missing example keys are noted on an ALLOW, never refused", () => {
  const exOnly: Declaration = { outputExample: { status: "success", data: {}, meta: {} } };
  const j = judgeDelivery(exOnly, ok({ status: "success", data: { a: 1 } }));
  assert.equal(j.verdict, "ALLOW");
  assert.equal(j.reason, "delivered");
  assert.deepEqual(j.missingKeys, []);
  assert.deepEqual(j.unseenExampleKeys, ["meta"]);
  assert.equal(j.note, "example keys not seen: meta");
});

test("example key present with null (e.g. winner:null) is seen", () => {
  const j = judgeDelivery({ outputExample: { winner: "0xabc", round: 3 } }, ok({ winner: null, round: 3 }));
  assert.equal(j.reason, "delivered");
  assert.deepEqual(j.unseenExampleKeys, []);
  assert.equal(j.note, undefined);
});

test("properties without required are hints, not promises", () => {
  const j = judgeDelivery({ outputSchema: { type: "object", properties: { a: {}, b: {} } } }, ok({ a: 1 }));
  assert.equal(j.verdict, "ALLOW");
  assert.equal(j.note, "example keys not seen: b");
});

test("example-only declaration: a non-object delivery has none of the example keys, so it is REFUSE", () => {
  const j = judgeDelivery({ outputExample: { a: 1 } }, ok([1, 2]));
  assert.equal(j.reason, "delivery_missing_keys");
});

test("example-only declaration: some example keys missing is ALLOW with a note", () => {
  const j = judgeDelivery({ outputExample: { a: 1, b: 2 } }, ok({ a: 3 }));
  assert.equal(j.reason, "delivered");
  assert.equal(j.note, "example keys not seen: b");
});

test("declarationFrom reads the output schema where declareDiscoveryExtension puts it", () => {
  const ext = declareDiscoveryExtension({
    output: {
      example: { forecast: "sunny", temperature: 21, extra: 1 },
      schema: { type: "object", properties: { forecast: { type: "string" }, temperature: { type: "number" } }, required: ["forecast", "temperature"] },
    },
  } as never) as Record<string, unknown>;
  const d = declarationFrom({ x402Version: 2, accepts: [], extensions: ext });
  assert.deepEqual(expectedKeys(d), ["forecast", "temperature"]);
  assert.deepEqual(d.outputExample, { forecast: "sunny", temperature: 21, extra: 1 });
});

test("outputSchemaFrom: info.output.schema wins, then bazaar.schema…output.properties.example, else none", () => {
  const std = { schema: { properties: { output: { properties: { example: { required: ["b"] } } } } } };
  assert.deepEqual(outputSchemaFrom({ info: { output: { schema: { required: ["a"] } } }, ...std }), { required: ["a"] });
  assert.deepEqual(outputSchemaFrom({ info: { output: { example: {} } }, ...std }), { required: ["b"] });
  // example-only seller (the extension schema describes info, not the output): no output requirements
  assert.deepEqual(outputSchemaFrom({ schema: { properties: { output: { properties: { example: { type: "object" } } } } } }), { type: "object" });
  assert.deepEqual(expectedKeys({ outputSchema: outputSchemaFrom({ schema: { properties: { output: { properties: { example: { type: "object" } } } } } }) }), []);
  for (const bad of [undefined, null, 1, [], { schema: [] }, { schema: { properties: { output: { properties: { example: [] } } } } }]) {
    assert.equal(outputSchemaFrom(bad), undefined);
  }
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

test("example-only seller: a 200 JSON with none of the example keys is REFUSE", () => {
  const decl = { description: "d", mimeType: "application/json", outputExample: { price: 1, symbol: "X" } } as any;
  const v = judgeDelivery(decl, { status: 200, contentType: "application/json", bodyText: JSON.stringify({ error: "rate limited" }) } as any);
  assert.equal(v.verdict, "REFUSE");
  assert.equal(v.reason, "delivery_missing_keys");
  const ok = judgeDelivery(decl, { status: 200, contentType: "application/json", bodyText: JSON.stringify({ price: 2 }) } as any);
  assert.equal(ok.verdict, "ALLOW");
});
